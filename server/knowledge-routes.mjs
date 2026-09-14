// server/knowledge-routes.mjs —— /knowledge/* 桥路由
// ---------------------------------------------------------------------------
// 设计（spec §5.7）：读操作一律**薄转发**给内核（`--knowledge <op>`，经 kernel-readonly
// 单飞/超时/限流），server 不复制任何切块/检索逻辑——否则双端漂移无解。
// 唯一例外是"写文档"：内容经 HTTP body 传入，落盘在 server 侧完成（见下方 handleWriteDoc）；
// 落盘后**立即**调内核 `update-doc` 做增量更新（不是"标脏等下次重建"，否则"刚保存就搜不到"）。
//
// 契约与 server/logs-routes.mjs 一致：命中返回 { status, body }，未命中返回 null。
// `callKernel` 可注入（默认 server/kernel-readonly.mjs 的 kernelReadonly）——测试用假实现，
// 绝不起 bridge、不起真实内核子进程。
//
// 2026-09-14 起 `/knowledge/import` 多两条路：`async:true` → 202 + jobId（后台任务，
// 经 `GET /knowledge/import/jobs/:id` 查进度/结果），以及可选的批量上限覆盖。
// **不传 async 时同步路径（含 argv）逐字节不变** —— 既有消费者把它当契约。
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { kernelReadonly } from './kernel-readonly.mjs'
// 2026-09-14：异步导入任务。`spawnKernelStreaming` 只作为**默认实现**注入（测试注入假实现，
// 绝不在路由里直接 spawn —— 本仓库有"测试起进程/起桥误杀运行中应用"的前车之鉴）。
import { spawnKernelStreaming } from './kernel-stream.mjs'
import { startImportJob, getImportJob } from './import-jobs.mjs'
// 导入上限策略（config.json 的 `knowledgeImport`）：只读**带 TTL 的缓存**，让设置改动免重启生效
import { readImportPolicyCached, IMPORT_POLICY_LIMITS } from './knowledge-import-policy.cjs'
import { resolveYfwHome } from './yfw-home.cjs'
import { PACK_ID_RE, compareSemver } from '../shared/knowledge-pack.mjs'
// `isBlockId` 走 shared 中性层：形状判定内核 CLI 用的是同一个函数（server ⊥ kernel
// 双向禁止 import，shared 是唯一不会漂移的落点）。
import { isBlockId } from '../shared/knowledge-core.mjs'
import {
  installPack, uninstallPack, listInstalledPacks, exportSpaceAsPack, readIndex, fetchPackDetail,
  fetchPackArchive, resolveRegistry, packsRoot,
} from './knowledge-pack-install.mjs'

// 单文档体积上限（2MB）：超过即拒，防一次 HTTP 写入把索引/内存打爆
const MAX_DOC_BYTES = 2 * 1024 * 1024
/** 离线 zip 上传上限：与包总解压上限同值（超过连读都别读，先拒） */
const MAX_PACK_ZIP_BYTES = 50 * 1024 * 1024

/** 路径净化：只允许"空间根内的相对 .md 路径"。这是穿越防护的第一、二道。 */
export function safeRelPath(rel) {
  const s = String(rel ?? '').replace(/\\/g, '/').trim()
  if (!s) return null
  if (s.startsWith('/') || /^[a-zA-Z]:/.test(s)) return null          // 绝对路径
  const parts = s.split('/').filter(Boolean)
  if (!parts.length) return null
  if (parts.some((p) => p === '..' || p === '.')) return null          // 上跳
  const last = parts[parts.length - 1]
  if (!/\.md$/i.test(last)) return null                                // 只收 md
  return parts.join('/')
}

const ok = (body) => ({ status: 200, body })

// 内核 stdout 是 JSON（cli 的 --knowledge 短路分支 console.log(JSON.stringify(output))）。
// 非 JSON ⇒ 抛 502（绝不要把垃圾/半截输出透给前端）；内核 exit≠0 由 kernelReadonly reject ⇒ 500。
async function callJson(callKernel, argsList) {
  const raw = await callKernel(argsList)
  try {
    const v = JSON.parse(raw)
    if (v && typeof v === 'object' && v.error && Object.keys(v).length === 1) {
      return { error: v.error }
    }
    return { value: v }
  } catch {
    throw Object.assign(new Error('内核返回非 JSON'), { code: 502 })
  }
}

// 写文档：四重防护 + 落盘 + 触发增量索引。**不复制任何检索/切块逻辑**。
async function handleWriteDoc({ readJsonBody, callKernel }) {
  const body = (await readJsonBody()) || {}
  // 字段名兼容：GET 系列路由一律用 `?space=`，POST 请求体若只认 `spaceId` 就与前者不一致，
  // S2 前端按 GET 的习惯发 `{space}` 会拿到 404「space not found」且难定位（字段名写错
  // 不像路径穿越那样有明确报错）。两者都收，以 `spaceId` 为主（对齐内部 Doc 模型命名）。
  const spaceId = String(body.spaceId ?? body.space ?? '')
  const content = String(body.content ?? '')
  const rel = safeRelPath(body.path)
  if (!rel) return { status: 400, body: { error: 'invalid path（须为空间内相对 .md 路径）' } }
  if (Buffer.byteLength(content, 'utf-8') > MAX_DOC_BYTES) {
    return { status: 413, body: { error: 'document too large（上限 2MB）' } }
  }

  // 空间清单以内核为准（权威来源），server 不自己扫盘
  const sres = await callJson(callKernel, ['--knowledge', 'spaces'])
  const space = (sres.value?.spaces || []).find((s) => s.id === spaceId)
  if (!space) return { status: 404, body: { error: 'space not found' } }
  if (!space.writable) return { status: 403, body: { error: 'space is read-only' } }

  const root = resolve(String(space.root))
  const dest = resolve(root, rel)
  // 第三道：解析后仍在根内（覆盖 root 前缀相同但非子目录的边角，如 /a/notes-x）
  if (dest !== root && !dest.startsWith(root + sep)) {
    return { status: 403, body: { error: 'path escapes space root' } }
  }
  // 第四道：符号链接防护——目标目录的 realpath 必须仍在 realpath(root) 内
  // （前一道只看字符串前缀，空间内的软链可把写入引到根外）
  try {
    const rroot = realpathSync(root)
    mkdirSync(dirname(dest), { recursive: true })
    const rdir = realpathSync(dirname(dest))
    if (rdir !== rroot && !rdir.startsWith(rroot + sep)) {
      return { status: 403, body: { error: 'path escapes space root (symlink)' } }
    }
  } catch { return { status: 500, body: { error: 'space root unreadable' } } }

  writeFileSync(dest, content, 'utf-8')
  const docId = `${spaceId}/${rel}`
  const upd = await callJson(callKernel, ['--knowledge', 'update-doc', '--id', docId])
  return ok({ ok: true, docId, updated: upd.value?.updated ?? false })
}

// ── 知识包生态（S4 Task 4）───────────────────────────────────────────────────
// 全部是新路径（`/knowledge/packs*`），既有读路由的响应逐字节不变。这一层只做
// 「参数校验 + 调 Task 3 引擎 + 折成状态码」，判定规则/安全防护一律在 server/knowledge-pack-install.mjs
// 与 shared/knowledge-pack.mjs —— 路由层复制一份判定必然漂移。

/**
 * 应用版本（版本兼容判定用）。**为什么不是根 `version.mjs` 的 APP_VERSION**：该文件不在
 * `electron-builder.yml` 的 files 里（只收 dist/electron/server/shared/public/package.json），
 * server 侧 import 它在打包后就是 import 失败。`package.json.version` 是打包唯一可见的版本源，
 * 且与 APP_VERSION 由 `scripts/bump-version.mjs` 同步。
 */
function defaultAppVersion() {
  if (process.env.PONOS_APP_VERSION) return process.env.PONOS_APP_VERSION
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'))
    return pkg?.version ? `dev ${pkg.version}` : ''
  } catch { return '' }
}

/** `config` 允许是对象或懒取函数（函数形态让 bridge 不在每个请求上都读 config.json） */
const cfgOf = (config) => (typeof config === 'function' ? (config() || {}) : (config || {}))

/** 已装台账 vs 清单条目：`updateAvailable` 用 semver 比（清单版本更高才算"可更新"） */
function mergeInstalled(item, inst) {
  return {
    ...item,
    installedVersion: inst?.version || '',
    onDisk: !!inst,
    updateAvailable: !!(inst && item.version && compareSemver(item.version, inst.version) === 1),
  }
}

/** 市场列表：清单 ∪ 已装（安装失败/离线装过的包也必须列出来，否则用户看不到自己装了什么） */
async function packsList({ home, fetcher, config, appVersion }) {
  const reg = resolveRegistry({ home, config: cfgOf(config) })
  const idx = await readIndex({ home, fetcher, registry: reg.registry })
  const installed = listInstalledPacks(home)
  const seen = new Set()
  const packs = idx.packs.map((item) => { seen.add(item.id); return mergeInstalled(item, installed.find((i) => i.id === item.id)) })
  for (const inst of installed) {
    if (seen.has(inst.id)) continue
    packs.push(mergeInstalled({ id: inst.id, name: inst.name, description: '', author: '', repo: '', version: inst.version, tags: [], docCount: 0, sizeBytes: 0, official: false }, inst))
  }
  return ok({
    ok: true,
    // 清单拉不到（断网/内网）**不是**请求失败：市场仍要能展示已装列表与"从本地文件安装"
    source: idx.source, registry: reg.registry, registryOrigin: reg.origin, hasLocalIndex: reg.hasLocalIndex,
    updatedAt: idx.updatedAt || null, indexError: idx.ok ? null : idx.error,
    warnings: idx.warnings || [], appVersion: appVersion || defaultAppVersion(), packs,
  })
}

/** 包详情：pack.json + README + 版本兼容判定（离线已装的包也能看：localPath 回落本地目录） */
async function packsDetail({ home, fetcher, config, appVersion, id }) {
  const reg = resolveRegistry({ home, config: cfgOf(config) })
  const idx = await readIndex({ home, fetcher, registry: reg.registry })
  const item = idx.packs.find((p) => p.id === id) || null
  const inst = listInstalledPacks(home).find((p) => p.id === id) || null
  if (!item && !inst) {
    return { status: 404, body: { error: `清单中找不到知识包「${id}」`, errors: [idx.error || '未在清单中找到该 id'] } }
  }
  const localPath = item?.localPath || (inst ? join(packsRoot(home), id) : null)
  const d = await fetchPackDetail({ fetcher, registry: reg.registry, id, appVersion, localPath })
  if (!d.ok) {
    // 版本不兼容（可换版本/需升级应用）≠ 坏包：409 vs 400/502
    const status = d.code === 'needs-higher-app' ? 409 : (d.code === 'invalid-manifest' ? 400 : 502)
    return { status, body: { error: d.error, errors: d.errors || [d.error], code: d.code || 'fetch-failed', version: d.version || null } }
  }
  const installed = inst ? { version: inst.version, files: inst.files, onDisk: inst.onDisk, source: inst.source } : null
  return ok({
    ok: true, pack: d.pack, readme: d.readme, versions: d.versions, version: d.version,
    warnings: d.warnings || [], installed,
    updateAvailable: !!(inst && d.pack.version && compareSemver(d.pack.version, inst.version) === 1),
    registry: reg.registry, registryOrigin: reg.origin, source: idx.source,
  })
}

/** 安装结果 → HTTP 状态码（人类可读的 errors 一律带上，UI 直接显示） */
function packResultToHttp(r) {
  if (r.status === 'installed' || r.status === 'updated' || r.status === 'unchanged' || r.status === 'to-my-space') {
    return ok({ ok: true, ...r })
  }
  const errors = r.errors || []
  if (r.status === 'kept-user-modified') {
    // 403：用户改过包内文件，未指定 mode 前**一个字节都没写**，前端据此弹三选
    return { status: 403, body: { ok: false, error: 'kept-user-modified', ...r } }
  }
  const tooLarge = errors.some((e) => /超过(单文件)?上限|声明解压尺寸|超过上限/.test(e))
  const needsHigherApp = errors.some((e) => e.includes('需要应用版本'))
  if (r.status === 'skipped-empty') return { status: 400, body: { ok: false, error: 'skipped-empty', ...r } }
  return { status: needsHigherApp ? 409 : (tooLarge ? 413 : 400), body: { ok: false, error: errors[0] || 'install rejected', ...r } }
}

/** 安装：`localPath`（离线 zip/目录）优先；否则按 id(+version) 从 registry 下载 */
async function packsInstall({ home, fetcher, config, appVersion, readJsonBody }) {
  const body = (await readJsonBody()) || {}
  const mode = String(body.mode || 'safe')
  const wantId = String(body.id || '')
  const localPath = body.localPath ? String(body.localPath) : ''
  const av = appVersion || defaultAppVersion()
  let archiveBuffer = null
  let srcDir = null
  let source = 'offline'
  let expectId = wantId || null

  if (localPath) {
    // localPath 是用户本机路径（Electron 对话框选的），但仍按**不可信输入**处理：
    // 内容一律走完整校验；这里只做"存在/形态/大小"三道便宜的前置检查。
    if (!existsSync(localPath)) return { status: 400, body: { error: `本地路径不存在：${localPath}` } }
    let st
    try { st = statSync(localPath) } catch (e) { return { status: 400, body: { error: `本地路径不可读：${e?.message || e}` } } }
    if (st.isDirectory()) {
      srcDir = localPath
    } else {
      if (!/\.zip$/i.test(localPath)) return { status: 400, body: { error: '仅支持 .zip 文件或目录' } }
      if (st.size > MAX_PACK_ZIP_BYTES) return { status: 413, body: { error: `zip 体积 ${st.size} 字节，超过上限 ${MAX_PACK_ZIP_BYTES}` } }
      archiveBuffer = readFileSync(localPath)
    }
  } else {
    if (!PACK_ID_RE.test(wantId)) return { status: 400, body: { error: `包 id 不合法：${wantId || '(空)'}` } }
    const reg = resolveRegistry({ home, config: cfgOf(config) })
    const idx = await readIndex({ home, fetcher, registry: reg.registry })
    const item = idx.packs.find((p) => p.id === wantId) || null
    if (!item) {
      return idx.ok
        ? { status: 404, body: { error: `清单中找不到知识包「${wantId}」` } }
        : { status: 502, body: { error: `清单不可用，无法在线安装：${idx.error}` } }
    }
    const version = String(body.version || item.version || '')
    if (!version) return { status: 400, body: { error: '缺少版本号（清单条目无 version，请求也未指定）' } }
    const dl = await fetchPackArchive({ fetcher, registry: reg.registry, id: wantId, version })
    if (!dl.ok) return { status: dl.tooLarge ? 413 : 502, body: { error: dl.error, url: dl.url || null } }
    archiveBuffer = dl.buffer
    source = 'registry'
  }

  const r = installPack({ home, archiveBuffer, srcDir, source, mode, appVersion: av, expectId })
  return packResultToHttp(r)
}

/** 卸载：只删 `packs/<id>` + 清台账（不碰用户空间/备份，见 Task 3） */
async function packsUninstall({ home, readJsonBody }) {
  const body = (await readJsonBody()) || {}
  const id = String(body.id || '')
  if (!PACK_ID_RE.test(id)) return { status: 400, body: { error: `包 id 不合法：${id || '(空)'}` } }
  const r = uninstallPack({ home, packId: id })
  if (!r.ok) return { status: 400, body: { error: r.error } }
  return ok({ ok: true, ...r })
}

/**
 * 文件知识库导入（2026-09-14）：解析 + 落盘全在内核一份实现
 * （kernel/knowledge-import.mjs），这里仍是**薄转发** —— server 不复制白名单/体积/
 * 路径防护/落盘口径，只做"必填字段 + 状态码映射"，与 `/knowledge/append` 同一纪律。
 *
 * 与其它路由的**唯一**实质差别是超时窗口：解析要过 python，PDF 走 OCR 时按分钟计，
 * 60s 默认值在扫描件上必然超时 —— 而超时等于内核子进程被 kill，调用方拿到一个无信息量的
 * 502，却看不到"已经写进去几篇"（部分落盘 + 无解释是最难收拾的状态）。
 * 故给 15 分钟窗口与 32MB stdout 上限；kernelReadonly 的单飞锁让"同一批的并发请求"
 * 复用同一次导入（不会两个进程同时往一个空间写）。
 *
 * 注意：**逐文件失败不是 op 失败**（内核 exit 0 并交出报告），故那条路径返回 200 +
 * `counts/failed[]` 明细；只有整批级错误（空间名非法 / 源不存在 / 超批量上限）才映射 4xx/5xx。
 */
const IMPORT_TIMEOUT_MS = 15 * 60 * 1000
const IMPORT_MAX_BUFFER = 32 * 1024 * 1024
/**
 * 整批级错误码 → HTTP 状态码。**唯一映射表**：stdout 错误体（`{ok:false,error}`）与
 * stderr 前缀（`[knowledge] <code>: <message>`）两条路都查它 —— 分两份写必然漂移，
 * 而这里的漂移是静默的（错误码只是数字，没人会去比对）。
 *
 * 码值取自 `kernel/knowledge-import.mjs` 的 `bad()` 调用点（CLI 走 `importDocuments`，
 * **不**经 `importFiles` 的对外别名层，故线上真实出现的是内部码；别名（`invalid-space-id`/
 * `empty-batch`）也一并认，防将来 CLI 改走别名层时这里静默退化成"未知码 → 400"）。
 * 语义对齐 spec P3-1（非法 id = 400、只读空间 = 403、源不存在 = 404、空批次 = 400）：
 *   · `readonly-space` 必须 403 而非 400：它表示"这个空间只读"（用户改**选择**即可解决），
 *     与 400 的"参数写错了"（改输入才能解决）不是同一件事，调用方要能分开提示。
 *   · `too-many-files`/`batch-too-large` 是 413：处置是"分批重试"，不是"修参数"。
 *   · `target-escape` 是 403：这是**写边界拒绝**（空间目录经 realpath 落在 `knowledge/spaces/`
 *     之外，多半是有人把 `spaces/<id>` 换成了 junction），语义与 P3-1 同族 —— "拒绝写，且一个
 *     字节都没写别处"。它与 `space-create-failed`（=500，mkdir 失败，服务端环境坏了）刻意分开：
 *     前者的处置是"别用这个空间/清掉那个链接"，后者是"去看服务端环境"，合并会让用户白跑一趟。
 *   · `bad-config`/`space-create-failed` 是 500：服务端环境问题（如缺 configDir），
 *     不是调用方的错，标 400 会把用户引向无意义的"改参数"。
 * ⚠️ 实测（2026-09-14，真实内核 argv 同形调用）：
 *   `pack-x` → `[knowledge] readonly-space: space 不得以 "pack-" 开头…`
 *   `a/b`    → `[knowledge] bad-space-id: space 含非法字符…`
 *   501 文件 → `[knowledge] too-many-files: 文件数 501 超出单批上限 500（请分批导入）`
 *   不存在的源 → `[knowledge] not-found: 导入源不存在：…`
 *   四条全部是"exit 1 + stdout 被 kernelReadonly 丢弃"，即**只能**走下面 stderr 那条路。
 *
 * 📋 码覆盖清点（2026-09-14，逐 `bad(`/`return { ok:false }` 调用点核对；本案要求的
 * "不许全落 400 兜底"就是指这一幕）。**只有整批级**的码进本表 —— 它们是"这一批没开始/整批
 * 被拒"，HTTP 状态码是调用方唯一的处置依据：
 *   · `kernel/knowledge-import.mjs`：`bad-config`、`bad-space-id`（`validateSpaceId` 唯一
 *     权威判定，含空/超长/内置重名/非法字符/首尾点/保留设备名）、`readonly-space`、
 *     `not-found`（源不存在）、`bad-source`（非文件非目录/源是符号链接）、`empty-source`、
 *     `too-many-files`、`batch-too-large`；别名层 `importFiles` 另出 `invalid-space-id`、
 *     `empty-batch`（`IMPORT_ERROR_ALIASES`）—— CLI 走的是 `importDocuments`，故线上真实
 *     出现的是前一组，两组都登记是防"将来 CLI 改走别名层"时这里静默退化成兜底 400。
 *   · `kernel/knowledge-cli.mjs`（op=import 的参数归一）：`missing-from`、`bad-max-ocr-pages`。
 *   逐文件码（`unsupported`/`blocked-ext`/`too-large`/`empty`/`unreadable`/`symlink`/
 *   `not-file`/`convert-failed`/`convert-timeout`/`parser-missing`/`render-failed`/
 *   `bad-target`/`write-failed`/逐文件形态的 `target-escape`）**刻意不进本表**：它们随
 *   200 + 报告的 `failed[]/rejected[]` 明细回（内核 exit 0，逐条给 source+原因），本就不经过
 *   这里的状态码映射；把它们塞进表只会让"整批级"与"逐文件级"两档在此处糊成一片。
 */
const IMPORT_ERROR_STATUS = {
  'bad-space-id': 400, 'invalid-space-id': 400, 'bad-source': 400, 'missing-from': 400,
  'bad-max-ocr-pages': 400,
  // 视觉表格提取的两个参数码（2026-09-14）：同为"参数不合规" → 400。
  // 必须显式登记而不是靠兜底 400：兜底会让"内核新增了码、路由没跟上"这件事**看不出来**，
  // 而这里登记后，routes 测试的"码覆盖清点"用例会强制它与内核的校验点同步。
  'bad-vision-tables': 400, 'bad-max-vision-pages': 400,
  'empty-source': 400, 'empty-batch': 400,
  'readonly-space': 403, 'target-escape': 403,
  'not-found': 404,
  'too-many-files': 413, 'batch-too-large': 413,
  'bad-config': 500, 'space-create-failed': 500,
}

/**
 * 从内核错误文本里取错误码（形如 `[knowledge] readonly-space: …` 或 `readonly-space: …`）。
 * 取不到码就退 400 —— `[knowledge]` 前缀的含义就是"这次请求被内核闸门拒了"，
 * 底裤是 400 而**不是** 500（500 会让调用方以为服务崩了，转而去重试/报障）。
 */
function statusOfKnowledgeError(text) {
  const m = /^([a-z0-9-]+)\s*:/.exec(String(text || '').trim())
  return (m && IMPORT_ERROR_STATUS[m[1]]) || 400
}

/**
 * `dryRun` 的宽松解析。严格 `=== true` 的代价**不对称**：GUI 传布尔没问题，但
 * agent/curl 写 `"true"` 时预览会**静默变成真写盘**（用户以为在看报告，文件其实已经进空间）
 * —— 这正是内核点名的最坏一类静默降级（kernel/cli.mjs `--dry-run` 同款警告）。
 * 故：明确的"真"值 = 预览；明确的"假"值/缺失 = 真导入；**其余（含拼错的串、对象、数组）
 * 一律 400 而不是当假值**——拼错 `dryRun` 的直接后果是不可逆的写盘，宁可拒也不能猜。
 */
function parseDryRun(v) {
  if (v === undefined || v === null) return { ok: true, value: false }
  if (v === true || v === false) return { ok: true, value: v }
  const s = typeof v === 'string' ? v.trim().toLowerCase() : (typeof v === 'number' ? String(v) : null)
  if (s === null) return { ok: false }
  if (['true', '1', 'yes', 'on'].includes(s)) return { ok: true, value: true }
  if (['false', '0', 'no', 'off', ''].includes(s)) return { ok: true, value: false }
  return { ok: false }
}

/**
 * 内核失败文本 → HTTP 响应（`{status, body}`）。
 * **同步路径与异步任务共用这一份**：同一个错误，看它从哪条路来就得到两种状态码/两种措辞，
 * 是这类"两条车道"最典型的漂移，而漂移是静默的（码只是数字）。异步任务那边只取
 * `error`/`code` 两个字段（见下方 `importJobFailure`）。
 */
function importFailureResponse(msg) {
  // 与 /knowledge/append 同一约定：内核以**非零退出 + stderr `[knowledge]` 前缀**
  // （kernel/cli.mjs:319）表达"这次请求被拒"，而 kernelReadonly/kernelStreaming 非零退出即
  // reject 并**丢弃 stdout** —— 这条前缀是路由区分"输入不合规"与"内核崩了"的唯一线索。
  // 不认它，bad-space-id 这类 400 级错误会被报成 500，用户完全无从下手。
  // 取**以 `[knowledge] ` 开头的那一行**（kernel/cli.mjs 的失败行），而不是"含该前缀的整段
  // stderr"：kernelReadonly 把 stderr 前 8KB 原样塞进 `e.message`（server/kernel-readonly.mjs:97
  // `new Error(err.trim() || …)`），只要内核在这行前后再写任何一行（第三方库的告警、Node 崩溃
  // 时的 code frame、将来在 `--knowledge` 分支前加的日志），`replace(/^\[knowledge\]/)` 就会把
  // 那些残留原样透给客户端 —— 那正是"把 stderr/traceback 当响应体"。逐行挑 = 只透内核**明确
  // 想给调用方**的那一句（它的 message 由内核自己构造，标题就是"为什么被拒"）。
  const gateLine = String(msg).split('\n').map((l) => l.trim()).find((l) => l.startsWith('[knowledge] '))
  if (gateLine) {
    const text = gateLine.slice('[knowledge] '.length).trim()
    // 一律按**码**定状态码，而不是把这条路上的所有错误压成 400：内核把码原样写在
    // 冒号前面（`readonly-space: …`），丢弃它就会让 403/404/413 三条语义全塌成 400，
    // 与上面的映射表自相矛盾（表里写着 413、实际回 400 —— 调用方按"分批重试"还是
    // "改参数"处置，就取决于这个码）。码信息同时以 `code` 字段回传（GUI 想按码给
    // 针对性提示时不必去解析中文消息）。
    const code = (/^([a-z0-9-]+)\s*:/.exec(text) || [])[1] || ''
    return { status: statusOfKnowledgeError(text), body: { error: text, ...(code ? { code } : {}) } }
  }
  // 非闸门类失败（内核崩溃 / 超时 / stdout 超限）：**不把 stderr 原文透给客户端**。
  // 内核崩溃时 stderr 是 Node 的 code frame + 绝对路径栈（`D:\...\kernel\cli.mjs:123` / `at …`），
  // 那是服务端的实现细节与目录结构：调用方拿它做不了任何处置（它连"该改参数还是该重试"都读不出来），
  // 却把内部路径摊开了。**只有我们自己产生的、形状固定的 harness 消息**是安全且有用的
  // （server/kernel-readonly.mjs 与 server/kernel-stream.mjs 的 timeout/超限/exit 三种，
  // 文本里不含任何路径），逐字放行 —— 两个模块的前缀都登记，否则异步任务的超时会退化成
  // 一句"内核异常退出"，用户分不清"跑太久"与"崩了"。
  const harness = /^\[kernel-(?:readonly|stream)\] (?:timeout \d+ms|stdout 超过上限 \d+B|exit -?\d+)$/.exec(String(msg).trim())
  if (harness) return { status: 500, body: { error: `导入失败：${harness[0]}`, code: 'kernel-failed' } }
  // 其余一律给可读的定式消息；原文只落服务端控制台（排障用），不入响应体。
  console.warn('[knowledge-import] 内核失败（原文只落服务端日志，不返给客户端）:', String(msg).slice(0, 800))
  return { status: 500, body: { error: '导入失败：内核异常退出（详见服务端日志）', code: 'kernel-failed' } }
}

/**
 * 异步任务用：同一张映射表，只取契约 §1 的 `error` / `code` 两字段。
 * （任务查询恒回 200 —— 任务失败是**任务的状态**，不是这次 HTTP 请求的失败。）
 */
export function importJobFailure(msg) {
  const r = importFailureResponse(msg)
  return { error: r.body.error, ...(r.body.code ? { code: r.body.code } : {}) }
}

/**
 * 批量上限覆盖值的解析（`maxFiles` / `maxTotalMb`）——**非法即 400，绝不静默回落**。
 * 为什么不能像 `maxOcrPages` 那样"非法值交内核归一为缺省"：那是**上限**，
 * 静默回落意味着"用户以为放宽到 5000、实际仍按 500 整批拒绝"，而超限报错只说
 * "文件数 1200 超出单批上限 500"——用户会去数文件、怀疑是不是路径写错，永远想不到是
 * 自己的参数被丢了。这与 `dryRun` 那条"宁可拒也不能猜"是同一条纪律。
 * 区间用 `IMPORT_POLICY_LIMITS`（与设置项、GUI 同一组数字，parity 测试钉住）。
 */
function parseImportLimits(body) {
  const out = { maxFiles: null, maxTotalMb: null }
  const raw = (v) => v !== undefined && v !== null && String(v).trim() !== ''
  if (raw(body.maxFiles)) {
    const n = Number(body.maxFiles)
    const { minFiles, maxFiles } = IMPORT_POLICY_LIMITS
    if (!Number.isInteger(n) || n < minFiles || n > maxFiles) {
      return { ok: false, error: `maxFiles 必须是 ${minFiles}–${maxFiles} 的整数（收到 ${JSON.stringify(body.maxFiles)}）` }
    }
    out.maxFiles = n
  }
  if (raw(body.maxTotalMb)) {
    const MB = 1024 * 1024
    const n = Number(body.maxTotalMb)
    const min = IMPORT_POLICY_LIMITS.minTotalBytes / MB
    const max = IMPORT_POLICY_LIMITS.maxTotalBytes / MB
    if (!Number.isFinite(n) || n < min || n > max) {
      return { ok: false, error: `maxTotalMb 必须是 ${min}–${max} 的数值（单位 MB，收到 ${JSON.stringify(body.maxTotalMb)}）` }
    }
    out.maxTotalMb = n
  }
  return { ok: true, ...out }
}

async function handleImport({ readJsonBody, callKernel, spawnStream, home }) {
  const body = (await readJsonBody()) || {}
  // from 可以是字符串，也可以是数组（GUI 多选文件 = 一条请求带多个源）。
  // 全部归一在路由层做完：内核只认"一个 `--src` 一个源"的扁平 argv，别让它去解析 JSON 形状。
  // （内核 flag 叫 `--src` 而不是 `--from`：后者已被内核 CLI 的范围语义占用。）
  const rawFrom = body.from ?? body.path ?? body.sources
  const fromList = (Array.isArray(rawFrom) ? rawFrom : [rawFrom])
    .map((s) => String(s ?? '').trim()).filter(Boolean)
  if (!fromList.length) return { status: 400, body: { error: 'from 必填（要导入的文件或目录路径，可为数组）' } }
  // 字段名兼容与 handleWriteDoc 同理：GET 系列用 `?space=`，POST 体若只认 `spaceId`
  // 就会让前端按 GET 习惯发的 `{space}` 撞 400 且难定位。两者都收。
  const space = String(body.spaceId ?? body.space ?? '').trim()
  const name = String(body.name ?? '').trim()
  if (!space && !name) {
    return { status: 400, body: { error: 'spaceId/space 或 name 必填（目标空间）' } }
  }
  const args = ['--knowledge', 'import']
  for (const f of fromList) args.push('--src', f)
  if (space) args.push('--space', space)
  if (name) args.push('--name', name)
  const dry = parseDryRun(body.dryRun)
  if (!dry.ok) {
    return { status: 400, body: { error: `dryRun 只接受布尔值（收到 ${JSON.stringify(body.dryRun)}）——预览/真写盘不能靠猜` } }
  }
  if (dry.value) args.push('--dry-run')
  const maxOcr = Number(body.maxOcrPages)
  if (Number.isFinite(maxOcr) && maxOcr > 0) args.push('--max-ocr-pages', String(Math.floor(maxOcr)))
  // 视觉表格提取（2026-09-14）：薄转发 —— 取值校验留给内核（唯一权威），
  // 这里只做"字段存在就带上"的搬运；非法值由内核以 bad-vision-tables 回 400。
  // `visionTables` 支持布尔（true/false）与 'auto' 两种形状：前端复选框给布尔、
  // 想表达"跟着配置走"时给 auto。
  const vt = body.visionTables
  if (vt === false || vt === true) args.push('--vision-tables', vt ? 'on' : 'off')
  else if (typeof vt === 'string' && vt.trim()) args.push('--vision-tables', vt.trim())
  // ⚠️ 先显式排除 null/undefined/空串，再 Number()：`Number(null) === 0` 且有限，
  // 而 0 对 `--max-vision-pages` 是**合法值**（= 一页都不交给视觉模型）⇒ 不排除的话
  // "没给这个字段"会被转成 `--max-vision-pages 0`，把用户的默认行为静默改成"关闭视觉"。
  // 这正是 kernel/knowledge-import.mjs 的 `num()` 头注点名的坑（"缺省值被当成合法 0"），
  // 在同一类护栏上第二次踩到 —— 所以判断写在这里而不是省成一行。
  const rawMaxVision = body.maxVisionPages
  if (rawMaxVision !== undefined && rawMaxVision !== null && String(rawMaxVision).trim() !== '') {
    const maxVision = Number(rawMaxVision)
    if (Number.isFinite(maxVision) && maxVision >= 0) args.push('--max-vision-pages', String(Math.floor(maxVision)))
  }

  // ── 批量上限与异步任务（2026-09-14）─────────────────────────────────────────
  // 异步判定用**严格 `=== true`**（契约 §1）：`async: "true"` 之类的模糊值不发车，
  // 否则调用方以为拿到了 jobId 去轮询，实际却收到一份同步报告（字段全 undefined）。
  const asyncMode = body.async === true

  const lim = parseImportLimits(body)
  if (!lim.ok) return { status: 400, body: { error: lim.error } }
  // 上限来源：请求显式覆盖 > config.json 的 `knowledgeImport`（带 TTL 缓存，改设置免重启）。
  // **同步路径一条都不追加**（`asyncMode` 为假时下面两个分支都不进）：既有调用方（curl/agent/
  // 老 GUI）的 argv 是契约的一部分，`knowledge-import-routes.test.mjs` 用逐字段精确断言钉着它；
  // 而内核默认（500 文件/300MB）与策略默认**同值**（parity 测试钉住），故同步路径"不读策略"
  // 不改变任何既有行为，没有兼容性缺口。设置项面向的是新 GUI 的批量异步导入这条路。
  const effMaxFiles = lim.maxFiles ?? (asyncMode ? readImportPolicyCached({ home }).maxFiles : null)
  const effMaxTotalMb = lim.maxTotalMb ?? (asyncMode
    ? Math.floor(readImportPolicyCached({ home }).maxTotalBytes / (1024 * 1024))
    : null)
  if (effMaxFiles !== null) args.push('--max-files', String(effMaxFiles))
  if (effMaxTotalMb !== null) args.push('--max-total-mb', String(effMaxTotalMb))

  if (asyncMode) {
    // 立即 202 + jobId：导入在后台跑，进度经 `GET /knowledge/import/jobs/:id` 查。
    // `--progress` 由 startImportJob 追加（那是异步任务的实现细节，不是路由的 flag 映射）。
    // 超时/缓冲沿用同步路径的两个常数：同一批文件不该"同步能导完、异步却超时"。
    // 32MB stdout 上限对 NDJSON 也够：进度行约 100B/文件，20000 文件 ≈ 2MB。
    const { jobId } = startImportJob({
      args, spawnStream, mapError: importJobFailure,
      timeoutMs: IMPORT_TIMEOUT_MS, maxBuffer: IMPORT_MAX_BUFFER,
    })
    return { status: 202, body: { jobId } }
  }

  let raw
  try {
    raw = await callKernel(args, { timeoutMs: IMPORT_TIMEOUT_MS, maxBuffer: IMPORT_MAX_BUFFER })
  } catch (e) {
    return importFailureResponse(String(e?.message || e))
  }
  let v
  try {
    v = JSON.parse(raw)
  } catch {
    return { status: 502, body: { error: '内核返回非 JSON' } }
  }
  // 第二条车道：内核若将来改成"exit 0 + 错误体"（或某个 op 走这条路），用**同一张表**查码
  // —— 两条车道同口径，才不会出现"同一个错误，看它从哪条路来就有两种状态码"。
  if (v && (v.ok === false || v.error)) {
    const code = IMPORT_ERROR_STATUS[v.error] ?? 400
    return { status: code, body: { error: v.error, message: v.message, code: v.error } }
  }
  return ok(v)
}

/** 导出：**只允许可写空间**（只读的包空间导出无意义：它本身就是别人的包，再导一次只会混淆来源） */
async function packsExport({ home, readJsonBody, callKernel }) {
  const body = (await readJsonBody()) || {}
  const spaceId = String(body.spaceId || '')
  if (!spaceId) return { status: 400, body: { error: '缺少 spaceId' } }
  const sres = await callJson(callKernel, ['--knowledge', 'spaces'])
  const space = (sres.value?.spaces || []).find((s) => s.id === spaceId)
  if (!space) return { status: 404, body: { error: 'space not found' } }
  if (!space.writable) return { status: 403, body: { error: 'space is read-only（只读包空间不能导出）' } }
  const r = exportSpaceAsPack({ home, spaceId, spaceRoot: space.root, meta: body })
  if (!r.ok) return { status: 400, body: { error: r.errors.join('；'), errors: r.errors } }
  return ok({ ok: true, ...r })
}

/**
 * 路由入口。`callKernel` 可注入（测试用假实现，避免起进程）。
 * 返回 { status, body } 或 null（未命中，交后续路由）。
 *
 * S4 Task 4 新增可选参（**只被 `/knowledge/packs*` 消费，既有路由行为逐字节不变**）：
 *   · `home`     —— 数据目录（缺省 `resolveYfwHome()`）。缺省值让生产链路零配置；
 *                   测试注入 `mkdtempSync` 目录，绝不碰真实 `~/.yfworking`。
 *   · `fetcher`  —— 网络出口（缺省 `globalThis.fetch`）。**测试注入假 fetcher**，绝不真联网。
 *   · `config`   —— `config.json` 内容或取它的函数（缺省 `{}`；函数形态让 bridge 能懒读，
 *                   不在高频读路由上白白多一次文件 IO）。
 *   · `appVersion` —— 当前应用版本（版本兼容判定用；缺省走 `defaultAppVersion()`，
 *                   且**懒求值**，不在高频读路由上多一次文件 IO）。
 *   · `spawnStream`（2026-09-14）—— 流式 spawn 实现（缺省 `spawnKernelStreaming`）。
 *                   **只被 `/knowledge/import` 的 `async:true` 消费**，注入点而非在路由里
 *                   直接 spawn：测试注入假实现即可覆盖"进度归约/TTL/淘汰/错误映射"，
 *                   不必真起内核进程（与 callKernel/fetcher 同一纪律）。
 */
export async function handleKnowledgeRoute({
  method = 'GET', pathname = '', searchParams = new URLSearchParams(),
  readJsonBody = async () => ({}), callKernel = kernelReadonly,
  home = resolveYfwHome(), fetcher = globalThis.fetch, config = {}, appVersion = null,
  spawnStream = spawnKernelStreaming,
} = {}) {
  if (!pathname.startsWith('/knowledge')) return null
  const p = pathname.replace(/\/+$/, '') || '/knowledge'
  const q = (name) => String(searchParams.get(name) ?? '')
  const isPost = String(method).toUpperCase() === 'POST'

  try {
    if (!isPost && p === '/knowledge/spaces') return ok((await callJson(callKernel, ['--knowledge', 'spaces'])).value)
    if (!isPost && p === '/knowledge/tree') {
      const args = ['--knowledge', 'tree', '--space', q('space')]
      if (q('path')) args.push('--path', q('path'))
      return ok((await callJson(callKernel, args)).value)
    }
    if (!isPost && p === '/knowledge/doc') return ok((await callJson(callKernel, ['--knowledge', 'doc', '--id', q('id')])).value)
    if (!isPost && p === '/knowledge/entries') return ok((await callJson(callKernel, ['--knowledge', 'entries', '--id', q('id')])).value)
    if (!isPost && p === '/knowledge/links') return ok((await callJson(callKernel, ['--knowledge', 'links', '--id', q('id')])).value)
    // S5 §7.4：关联锚点（`?id=<blockId>&limit=<N>`）。薄转发 + 与 links 同款的错误路径
    // （内核抛错 → 500、非 JSON → 502，都由本函数末尾的 try/catch 兜）。
    // 比 links 多的一道：`id` 形状校验（400）。links 的 id 是 docId，写错最多返回空出/入边；
    // 这里的 id 是 **blockId**，形状错时内核视图同样只给空数组 → 调用方会把"参数写错"读成
    // "这个块没有关联"（假阴性最贵，本项目反复踩的"静默空集"）。**形状缺省即 400，绝不静默**。
    // 形状合法但库里没有的 id：仍按 links 的既有约定 —— 200 + 空数组，**不 404**。
    // 理由：内核视图里"库中没有这个块"与"这个块没有锚点"不可区分，凑 404 得另发一次存在性
    // 查询（两条口径必然漂移），且与 links/entries/graph 的"空集即空集"约定冲突。
    // S5 Task 9（GUI 批量口）：`/knowledge/related?doc=<docId>` —— 一篇文档内所有条目块的
    // 锚点。为什么在**同一个**端点上加参数而不是新开路由：语义仍是"关联锚点查询"，
    // 只是聚合粒度从块变成文档；新开一条路由会让两处的 400/200 约定各写一份（必然漂移）。
    // 形状校验：docId 不得为空、不得含 '#'（含 '#' 是 blockId 的形状 —— 参数用错了要报错，
    // 不能让它在内核里被当成"不存在的文档"静默返回空数组，这正是 §7.4 那条 400 的理由）。
    if (!isPost && p === '/knowledge/related') {
      const docId = String(q('doc') || '').trim()
      const rawId = String(q('id') || '').trim()
      if (docId && !rawId) {
        if (docId.includes('#')) {
          return { status: 400, body: { error: `invalid doc: ${docId}（docId 不含 '#'；blockId 请用 ?id=）` } }
        }
        const docArgs = ['--knowledge', 'related', '--doc', docId]
        if (q('limit')) docArgs.push('--limit', q('limit'))
        return ok((await callJson(callKernel, docArgs)).value)
      }
      const id = rawId
      if (!isBlockId(id)) {
        return { status: 400, body: { error: `invalid id: ${id || '(空)'}（须为 <docId>#<n>；或改用 ?doc=<docId> 取整篇）` } }
      }
      const args = ['--knowledge', 'related', '--id', id]
      // limit 仅在给了的时候透传（同 /knowledge/graph）；非法值由内核 parseArgs 归一为缺省，
      // 不在这一层再写一套数字校验——两套口径必然漂移，而 limit 非法只是"取缺省"而非危险操作。
      if (q('limit')) args.push('--limit', q('limit'))
      return ok((await callJson(callKernel, args)).value)
    }
    if (!isPost && p === '/knowledge/graph') {
      const args = ['--knowledge', 'graph']
      if (q('space')) args.push('--space', q('space'))
      if (q('limit')) args.push('--limit', q('limit'))
      // S5 Task 9：`?related=1` 才附隐式关联层（图谱图层开关，缺省关 —— spec §7.5 的
      // "第一印象不被噪声淹没"）。**逐字判 '1'**：`related=0`/`related=false` 一律视为不带，
      // 免得"关着的图层"因参数写法不同而打开。
      if (q('related') === '1') args.push('--related')
      // S5.1：`?level=entry` 切条目级图。**逐字判 'entry'**（与 `related` 同一纪律：
      // 层级是枚举，非法值落回文档级由内核兜底，路由不做自由透传以免把任意字符串喂进内核）。
      if (q('level') === 'entry') args.push('--level', 'entry')
      return ok((await callJson(callKernel, args)).value)
    }
    if (!isPost && p === '/knowledge/stats') return ok((await callJson(callKernel, ['--knowledge', 'stats'])).value)
    // S6：标签枚举（`{tags:[{tag,count,single,theme}],total,singleCount}`）。
    // 用途是**写前先查**——优先复用已有标签，避免每次造新单例标签（孤立条目的主源）。
    // 与其它 GET 一样是薄转发：枚举口径只在内核写一份，server 不自己扫盘。
    if (!isPost && p === '/knowledge/tags') return ok((await callJson(callKernel, ['--knowledge', 'tags'])).value)
    // 检索：URL 用 `?q=`（避免与内核 flag `--query` 混淆），转发时映射为 `--query`；
    // `spaces` 只取首个（内核 `--space` 是单数，多空间过滤留给 S2 前端逐次请求）。
    if (!isPost && p === '/knowledge/search') {
      const args = ['--knowledge', 'search', '--query', q('q')]
      if (q('keywords')) args.push('--keywords', q('keywords'))
      if (q('topK')) args.push('--topK', q('topK'))
      if (q('mode')) args.push('--mode', q('mode'))
      // `spaces` 是**列表**（HTTP 契约）。原实现取 split(',')[0] 只保留第一个空间，
      // 于是 `?spaces=a,b` 静默只按 a 过滤——调用方以为限定在两个空间，实际少了一半结果。
      // 逗号串原样透传，由内核侧拆分（与 `--keywords` 同约定）。
      if (q('spaces')) args.push('--space', q('spaces'))
      return ok((await callJson(callKernel, args)).value)
    }
    if (isPost && p === '/knowledge/reindex') return ok((await callJson(callKernel, ['--knowledge', 'reindex', '--force'])).value)
    if (isPost && p === '/knowledge/doc') return await handleWriteDoc({ readJsonBody, callKernel })
    // 文件知识库导入（2026-09-14）：`{from, spaceId|space|name, dryRun?, maxOcrPages?}` → 导入报告。
    // 与 /knowledge/doc 的关键差别：内容**不经 HTTP body**，只传源路径，解析与落盘都在内核侧，
    // 所以这一层没有四道路径防护要做（没有"目标路径"参数可被穿越）—— 防护在内核一份。
    // 字段 → argv 的**全量**映射（漏一个就是静默降级，改这里必须同步 server/knowledge-import-routes.test.mjs
    // 的逐字段精确断言）：
    //   from（串|数组）        → `--src <路径>`（每源一次；内核 flag 是 `--src` 不是 `--from`）
    //   spaceId / space        → `--space <id>`
    //   name（空间名）          → `--name <名>`
    //   dryRun（布尔）          → `--dry-run`
    //   maxOcrPages（数字）     → `--max-ocr-pages <n>`
    //   visionTables（布尔|串）  → `--vision-tables on|off|<原样>`（布尔 true/false 翻成 on/off；
    //                             串原样透传，取值合法性由**内核**判，路由不写第二套校验）
    //   maxVisionPages（数字）  → `--max-vision-pages <n>`（0 合法 = 不交给视觉模型）
    //   async（布尔）           → 不发 argv：立即 202 `{jobId}`，导入转后台任务（见下）
    //   maxFiles（int）/ maxTotalMb（number） → `--max-files` / `--max-total-mb`
    //                             （**仅异步任务**会用策略缺省补齐；非法值 400，不静默回落）
    // 超时/缓冲由 handleImport 内的 IMPORT_TIMEOUT_MS / IMPORT_MAX_BUFFER 决定（见那里的理由）。
    if (isPost && p === '/knowledge/import') {
      return await handleImport({ readJsonBody, callKernel, spawnStream, home })
    }
    // 异步导入任务的进度/结果查询（2026-09-14）：`GET /knowledge/import/jobs/:id`。
    // 未命中 → 404：任务记录**过期被回收**（保留 10 分钟）与应用重启是调用方仅靠响应
    // 无法区分的两种情形，但它们与"任务还在跑、只是还没枚举完文件"必须能分开 ——
    // 后者回 `running` + total 0（GUI 据此显示"正在统计文件数…"），把过期也回成 200 空壳
    // 只会让进度条永远不动。故这里宁可 404 也不给假进度。
    if (!isPost && (p === '/knowledge/import/jobs' || p.startsWith('/knowledge/import/jobs/'))) {
      let id = p.slice('/knowledge/import/jobs'.length).replace(/^\/+/, '')
      // 非法百分号编码（`%E4%`）会让 decodeURIComponent 抛错 —— 那是"id 不认识"，
      // 该回 404 而不是让外层折成 500（500 会让调用方去重试/报障，而它改个路径就行了）。
      try { id = decodeURIComponent(id) } catch { /* 原样当作未知 id */ }
      const job = getImportJob(id)
      if (!job) {
        return { status: 404, body: { error: `未知的导入任务：${id || '(空)'}（可能已完成并超过保留期，或服务已重启）` } }
      }
      return ok(job)
    }
    // S6：append-only 写入通道（`{tag?, text, theme?}`）。与 `/knowledge/doc` 的关键差别：
    // 那条是**整体覆盖**（GUI 编辑器语义，需四道路径防护）；这条**只追加一条经验**，
    // 结构上没有覆盖/删除路径 —— 故不需要 `space.writable` 与路径校验那一套（没有"路径"参数，
    // theme 是枚举名、由内核映射文件名），这也正是它比放开 Write 工具更安全的原因。
    // 校验（协议文本/空模板/过短/标签与主题合法性/幂等去重）**全在内核一份**，
    // 这里只做"必填字段"与状态码映射，不复制判据（两套口径必然漂移）。
    if (isPost && p === '/knowledge/append') {
      const body = (await readJsonBody()) || {}
      const text = String(body.text ?? '')
      if (!text.trim()) return { status: 400, body: { error: 'text 必填（经验正文）' } }
      const args = ['--knowledge', 'append', '--text', text]
      if (body.tag != null && String(body.tag)) args.push('--tag', String(body.tag))
      if (body.theme != null && String(body.theme)) args.push('--theme', String(body.theme))
      let r
      try {
        r = await callJson(callKernel, args)
      } catch (e) {
        // 内核以**退出码 1 + stderr `[knowledge] <code>: <message>`** 表达"闸门拒绝"
        //（见 kernel/cli.mjs 的 --knowledge 分支）。kernelReadonly 遇非零退出即 reject 并
        // **丢弃 stdout**，故这里从 stderr 前缀识别，映射成 400（客户端内容不合规），
        // 而不是让它冒泡成 500 —— 调用方必须能区分"我的内容被拒了"与"内核崩了"。
        // 非该前缀的失败（超时/崩溃/非 JSON）原样抛出 → 外层 500/502，不误标为 400。
        const msg = String(e?.message || '')
        if (!msg.startsWith('[knowledge] ')) throw e
        return { status: 400, body: { error: msg.slice('[knowledge] '.length) } }
      }
      // 双保险：若内核将来改为"exit 0 + 错误体"，这里同样映射 400（message 原样带上）。
      if (r.error) return { status: 400, body: { error: r.error } }
      if (r.value && r.value.error) return { status: 400, body: r.value }
      return ok(r.value)
    }

    // ── 知识包生态（S4）：市场列表 / 详情 / 安装 / 卸载 / 导出 ──────────────
    // 纯新增路径，且**只有**这里消费 home/fetcher/config/appVersion 四个新注入点，
    // 既有路由的参数与响应一律不变（server/knowledge-routes.test.mjs 既有用例是这道守卫）。
    if (!isPost && p === '/knowledge/packs') return await packsList({ home, fetcher, config, appVersion })
    if (!isPost && p === '/knowledge/packs/detail') {
      const id = q('id')
      if (!PACK_ID_RE.test(id)) return { status: 400, body: { error: `包 id 不合法：${id || '(空)'}` } }
      return await packsDetail({ home, fetcher, config, appVersion, id })
    }
    if (isPost && p === '/knowledge/packs/install') return await packsInstall({ home, fetcher, config, appVersion, readJsonBody })
    if (isPost && p === '/knowledge/packs/uninstall') return await packsUninstall({ home, readJsonBody })
    if (isPost && p === '/knowledge/packs/export') return await packsExport({ home, readJsonBody, callKernel })
    return null
  } catch (e) {
    if (e?.code === 502) return { status: 502, body: { error: e.message } }
    return { status: 500, body: { error: e?.message || String(e) } }
  }
}
