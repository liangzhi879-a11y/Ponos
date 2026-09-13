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
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { kernelReadonly } from './kernel-readonly.mjs'
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
 */
export async function handleKnowledgeRoute({
  method = 'GET', pathname = '', searchParams = new URLSearchParams(),
  readJsonBody = async () => ({}), callKernel = kernelReadonly,
  home = resolveYfwHome(), fetcher = globalThis.fetch, config = {}, appVersion = null,
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
      return ok((await callJson(callKernel, args)).value)
    }
    if (!isPost && p === '/knowledge/stats') return ok((await callJson(callKernel, ['--knowledge', 'stats'])).value)
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
