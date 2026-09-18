// kernel/knowledge-import.mjs —— 文件知识库导入（唯一权威实现）
// ---------------------------------------------------------------------------
// 职责：把一批文件（PDF/Word/Excel/PPT/图片/文本）解析成 Markdown 落进
// `<configDir>/knowledge/spaces/<spaceId>/`，随后被既有索引/检索/关联/图谱自动覆盖。
//
// **为什么权威实现放内核而不是 server**：agent 入口是内核工具（只能 import 内核模块），
// server 入口只能经 `--knowledge` 薄转发访问内核。反过来把实现放 server，内核工具就无路可走
// ——两端各写一份解析/落盘口径必然漂移（本项目反复踩的病灶）。
//
// 分层（硬边界）：
//   python（runtime/skills/_common/doc_to_md.py）= 只做"文件 → 结构化 JSON"，**无写盘权限**
//   本模块 = 白名单 / 体积 / 路径防护 / md 组装 / 台账 / 空间创建 / 索引同步
// 这样"解析口径"与"落盘防护"各自只有一份。python 的 JSON 契约见该脚本头注。
//
// 幂等：空间根写 `.import.json` 台账（与 `.space.json` 同风格；`walkMd`/`listTree` 都不收隐藏项），
// 按 `sourceHash` 跳过未变文件 —— 重复导入同一批不产生重复文档、不重复落盘。
// 源文件内容变化（hash 变）→ 重转并覆盖**我们自己的**产物；目标名若与台账无关（用户手工文件）
// 则改用不冲突的名字，绝不静默覆盖用户数据。
import { existsSync, readdirSync, statSync, lstatSync, mkdirSync, rmdirSync, readFileSync, writeFileSync, renameSync, realpathSync, mkdtempSync, rmSync } from 'node:fs'
import { join, relative, sep, basename, extname, dirname, resolve, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { toDocId } from '../shared/knowledge-core.mjs'
// OCR 引擎探测与内核 OCR 工具**同一份实现**（现位于 media-tools.mjs）：探测规则只有一处，
// 否则"工具能找到引擎、导入找不到"这类不一致会随环境差异随机出现。
// childEnv/registerChild 同样是内核既有的两道纪律（env 白名单防子进程窃取宿主密钥、
// 子进程登记以便会话中止时一起 kill），其实现在 exec-base.mjs。
// P2-1：本文件**不再从 tools.mjs 取任何东西**（此前 `tools ↔ knowledge-import` 构成
// 文件级 ESM 环）—— 四项依赖分别直取 media-tools（OCR 探测、视觉调用）与 exec-base
// （子进程登记、env 白名单），环随之消失。
import { findOcrEngine, visionDescribe } from './media-tools.mjs'
import { registerChild, childEnv } from './exec-base.mjs'
// 视觉是否可用：与 Vision 工具**同一份判定**（provider.visionEnv，兼容 PONOS_VISION_*/YFW_VISION_*）。
// 各写一份"读哪个 env"必然漂移 —— 实测就发生过 bridge 注入 YFW_* 而内核只读 PONOS_*，
// 导致用户配好了视觉模型却被判定"未配置"（详见 kernel/provider.mjs 的 visionEnv 注释）。
import { visionAvailable } from './provider.mjs'

/** 台账文件名（空间根）：`walkMd` 只收 .md、`listTree` 只列 dir 与 .md ⇒ 不会进文件树/索引 */
export const LEDGER_NAME = '.import.json'
export const LEDGER_VERSION = 1

/**
 * 可导入的扩展名白名单（纯数据格式）。**对外契约名是 `IMPORT_ALLOW_EXT`**（T3/T4/T5 与
 * agent 工具按这个名字取用，改名前先确认没有第二个消费方）。
 * **白名单而非黑名单**：新增格式必须显式登记，避免"某个可执行扩展名被顺手放进来"。
 *
 * 集合 = spec §6 明列的那批（md/txt/csv/pdf/docx/xlsx/xls/pptx/ppt/png/jpg/jpeg/bmp/tif/tiff/webp）
 * ∪ 解析器 `doc_to_md.py` 的 `TEXT_EXTS` 其余成员（.markdown/.log/.json/.yaml/.yml/.html/.htm）。
 * 后半段的意义是**口径同源**：这些纯文本类 python 侧本来就能转，导入器若拒收就出现
 * "解析器支持、导入器不让导"的假故障（两边各写一份清单必然漂移）。
 *
 * `.doc` / `.ppt` 是必须解释的特例：python 侧**没有** 97-2003 二进制解析器
 * （见 `doc_to_md.py` 的 `_LEGACY_MSG`）。它们**在扫描期放行、转换期逐文件失败**
 * 并给出准确原因（"请另存为 .docx / .pptx"）—— 比在扫描期笼统报"不支持该格式"更能指导用户。
 * （`.ppt` 在 spec §6 明列；`.doc` 不在 §6 列表里，但 T1 解析器为它单独准备了 `_LEGACY_MSG`
 * 引导语，且它与 `.docx` 同属一类 Office 数据格式 —— 放行后失败档给的是**可执行建议**，
 * 而不是"导入器不认这个后缀"。两者必须同口径，否则同一类文件一个扫描期拒、一个转换期失败。）
 */
export const IMPORT_ALLOW_EXT = new Set([
  // spec §6 明列
  '.md', '.txt', '.csv', '.pdf', '.docx', '.xlsx', '.xls', '.pptx', '.ppt',
  '.png', '.jpg', '.jpeg', '.bmp', '.tif', '.tiff', '.webp',
  // 97-2003 遗留二进制格式：扫描期放行，转换期给出"另存为新格式"的准确原因（见上）
  '.doc',
  // 解析器 TEXT_EXTS 的其余纯文本类（见上：口径同源）
  '.markdown', '.log', '.json', '.yaml', '.yml', '.html', '.htm',
])

/** 兼容别名：同一份集合（不是拷贝），早期调用方与测试用的是这个名字。 */
export const ALLOWED_EXTS = IMPORT_ALLOW_EXT

/**
 * 明确拒绝的可执行/脚本类扩展名。**对外契约名 `IMPORT_BLOCK_EXT`**。
 * 白名单已覆盖（不在白名单里的本来就拒），这里只为**给出准确原因**：
 * "这是脚本文件，不允许入库"比"不支持该格式"更能让用户/模型理解边界。
 * 安全模型建立在"知识库内无代码执行面"之上（S4 spec §11.4），故一律拒绝。
 */
export const IMPORT_BLOCK_EXT = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.exe', '.dll', '.so', '.dylib',
  '.bat', '.cmd', '.ps1', '.sh', '.bash', '.py', '.pyc', '.rb', '.pl', '.jar',
  '.vbs', '.wsf', '.scr', '.msi', '.com', '.apk', '.app', '.dmg', '.lnk', '.reg',
])

/** 兼容别名：同一份集合（不是拷贝）。 */
export const BLOCKED_EXTS = IMPORT_BLOCK_EXT

export const IMPORT_LIMITS = {
  maxFileBytes: 50 * 1024 * 1024,      // 单文件 50MB（与知识包 zip 上限同值）
  maxBatchFiles: 500,                  // 整批文件数
  maxBatchBytes: 300 * 1024 * 1024,    // 整批总字节
  maxDocBytes: 2 * 1024 * 1024,        // 单篇输出 md（与 server MAX_DOC_BYTES 同值：超过索引侧会拒）
  maxOcrPages: 200,                    // 扫描件 PDF 的 OCR 页数护栏（超出截断 + 出声）
  maxTableRows: 500,                   // 单表行数护栏（python 侧执行，这里只转发）
  // 视觉模型识别表格的页数护栏（2026-09-14）：视觉调用**按页计费且慢**（每页一次多模态请求），
  // 一个 200 页扫描件的表格提取会变成 200 次请求 —— 用户要的是"能读到表格"，不是账单。
  // 默认 20 页覆盖绝大多数申报材料（营业执照/证书/单张明细表都是 1~2 页），超出会出声。
  maxVisionPages: 20,
}

/** 收集时跳过的目录（与 kernel/knowledge.mjs 的 SKIP_DIRS 同思路：依赖与元数据不属于资料） */
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '.index', '.obsidian',
  '__pycache__', 'dist', 'build', 'release', '.venv', 'venv'])

/** 内置空间 id：与其重名会与内置空间冲突（docId 撞车），必须拒绝 */
const BUILTIN_SPACE_IDS = new Set(['experience', 'session-memory', 'skill-experience'])

const ok = (v) => ({ ok: true, value: v })
const bad = (error, message) => ({ ok: false, error, message })

/**
 * 人类可读体积（B/KB/MB）。**报错里的数字必须可核对**：上限被 override 成 512B 时，
 * "文件过大（1.0KB > 上限 0MB）"这种输出等于没给原因 —— 用户无法判断该压到多小。
 */
function fmtBytes(n) {
  const v = Number(n) || 0
  if (v >= 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)}MB`
  if (v >= 1024) return `${(v / 1024).toFixed(1)}KB`
  return `${v}B`
}

/**
 * 空间 id 合法性：**唯一权威判定**（CLI/工具/路由都经它）。
 * 为什么不用 slug 化（把非法字符替换掉）：用户输入 "研发/资料" 若被静默改成 "研发资料"，
 * 他会以为导入到了自己命名的空间，实际目录名不同 —— 静默改写输入比明确报错贵得多。
 */
export function validateSpaceId(raw) {
  const id = String(raw ?? '').trim()
  if (!id) return bad('bad-space-id', 'space 不能为空')
  if (id.length > 64) return bad('bad-space-id', `space 过长（${id.length} > 64）`)
  if (BUILTIN_SPACE_IDS.has(id)) {
    return bad('bad-space-id', `space 与内置空间重名（${id}）——请换一个名字，避免与内置空间的文档 id 撞车`)
  }
  if (id.startsWith('pack-')) {
    // 只读语义：`pack-` 是知识包的保留前缀（`knowledge/packs/<name>` 在 discoverSpaces 里
    // 恒为 `writable:false`）。错误码刻意用 `readonly-space` 而不是 `bad-space-id`：
    // 它不是"名字打错了"，而是**权限问题**（spec P3-1 的 403 语义）—— 用户的下一步动作完全不同。
    return bad('readonly-space', `space 不得以 "pack-" 开头（那是只读知识包的保留前缀）`)
  }
  // Windows 非法文件名字符 + 路径分隔符 + 控制字符；`.`/`..` 与首尾点/空格同样拒
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(id)) {
    return bad('bad-space-id', `space 含非法字符（\\ / : * ? " < > | 或控制字符）：${id}`)
  }
  if (id === '.' || id === '..' || id.startsWith('.') || id.endsWith('.')) {
    return bad('bad-space-id', `space 不得为 "." / ".." 或以 "." 开头/结尾：${id}`)
  }
  if (id.endsWith(' ')) return bad('bad-space-id', 'space 末尾不得有空格')
  // 保留设备名（Windows）：CON/PRN/AUX/NUL/COM1-9/LPT1-9 建目录会失败或行为诡异
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(id)) {
    return bad('bad-space-id', `space 是系统保留名（${id}）`)
  }
  return ok(id)
}

/** 目标相对路径净化：只允许空间根内的相对 .md 路径（拒绝绝对路径与 `..` 段）。 */
export function safeOutRel(rel) {
  const s = String(rel ?? '').replace(/\\/g, '/').trim()
  if (!s) return null
  if (s.startsWith('/') || /^[a-zA-Z]:/.test(s)) return null
  const parts = s.split('/').filter(Boolean)
  if (!parts.length || parts.some((p) => p === '..' || p === '.')) return null
  if (!/\.md$/i.test(parts[parts.length - 1])) return null
  return parts.join('/')
}

/**
 * realpath 越界校验（spec §6「落盘前 realpath 校验仍在空间根内」）。
 *
 * `safeOutRel` 挡的是**词法**穿越（`..`、绝对路径），挡不住**物理**穿越：空间根里若有一个
 * 指向外部的目录符号链接/junction，`spaceRoot/子目录/x.md` 词法上完全合法，实际却写到空间外面去了
 * （Windows 的 junction 连管理员权限都不需要，是最容易踩的一种）。故落盘前把"目标（或它的父目录）"
 * 与"空间根"都 realpath 一次，要求前者仍在后者之内。语义与 `server/knowledge-routes.mjs` 的
 * `safeRelPath` 同源：那边是"词法"，这边是"词法 + 物理"，判定表必须一致（不一致 = 两处各有一套口径）。
 *
 * @param rootReal 空间根的 realpath（调用方已确认存在）
 * @param abs      目标绝对路径（可尚不存在 → 取其父目录的 realpath）
 * @returns true = 仍在空间根内
 */
export function realpathInside(rootReal, abs) {
  let root
  try { root = realpathSync(rootReal) } catch { return false }
  const target = resolve(abs)
  let real
  try { real = realpathSync(target) } catch {
    try { real = realpathSync(dirname(target)) } catch { return false }
  }
  const rel = relative(root, real)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * 落盘前**逐级**建目录 + 逐级校验（spec §6「落盘前 realpath 校验仍在空间根内」）。
 *
 * 为什么不能"先 `mkdirSync(dirname(outAbs), {recursive:true})` 再校验"：`recursive:true` 会先把
 * 越界的中间目录**真建出来** —— 空间根里有一个指向外部的 junction `outing`，源含
 * `outing/sub/deep/a.docx` 时，空间根外会先长出 `sub/`、`sub/deep/` 两棵空目录树，之后才判越界。
 * 那等于承认"空间根外可以先写点东西"（违反验收 7「导入只写 knowledge/spaces/」：连空目录都不许）。
 * 逐级做则**越界链上的 mkdir 一次都不会发生**：读到哪一级不对就停在哪一级，且此前没建任何东西。
 *
 * 逐级覆盖三条通道：① 中间目录不存在 → 建完立即 realpath 复查（并发/归属异常也能抓住）；
 * ② 中间目录已存在（用户或安装期建的 junction）→ 先 realpath 校验再往下走；
 * ③ 目标文件已存在（用户手工 md / 我方旧产物）→ 文件符号链接同样是越界通道，一并校验。
 *
 * @returns `{ ok:true }` 或 `{ ok:false, error, message }`（error ∈ target-escape|write-failed）
 */
function ensureDirsInside(spaceRoot, outAbs) {
  const root = resolve(spaceRoot)
  const target = resolve(outAbs)
  const relDir = relative(root, dirname(target))
  const parts = relDir && relDir !== '.' ? relDir.split(sep).filter(Boolean) : []
  // 词法上已在根外（`..` / 跨盘）→ 直接拒，不做任何 realpath 猜测（safeOutRel 已挡一层，这里兜底）
  if (isAbsolute(relDir) || parts.some((p) => p === '..')) {
    return { ok: false, error: 'target-escape', message: '目标路径词法上落在空间根之外' }
  }
  let cur = root
  for (const p of parts) {
    cur = join(cur, p)
    if (!existsSync(cur)) {
      try { mkdirSync(cur) } catch (e) {
        // EEXIST = 并发下被别人建好了，继续按"已存在"校验；其余错误如实报
        if (e?.code !== 'EEXIST') return { ok: false, error: 'write-failed', message: `写盘失败：${e?.message || e}` }
      }
    }
    if (!realpathInside(root, cur)) {
      return {
        ok: false, error: 'target-escape',
        message: '目标路径经 realpath 解析后落在空间根之外（空间内是否有指向外部的链接？）',
      }
    }
  }
  if (existsSync(target) && !realpathInside(root, target)) {
    return {
      ok: false, error: 'target-escape',
      message: '目标文件经 realpath 解析后落在空间根之外（是指向外部的文件链接？）',
    }
  }
  return { ok: true }
}

/**
 * 台账键：源文件的**稳定标识**（realpath 规范化后的 sha256 前 16 位）。
 *
 * 为什么不能用「源相对路径」当键：单选文件时 rel = 文件名，两个不同目录里的同名文件会天然撞键 ——
 * 第二次导入被当成"同一源的内容变化"，直接覆盖第一篇产物且零提示（实测：空间里只剩 1 篇 `报告.md`）。
 * realpath 才是物理文件身份：同名不同文件 → 不同键；**同一文件无论"整目录导入"还是"多选导入"
 * → 同一键**（这正是幂等所依赖的，见 collectFiles 的前缀口径）。
 */
function sourceKey(abs) {
  let real = resolve(abs)
  try { real = realpathSync(abs) } catch { /* 极少数读不到 realpath → 退化成绝对路径（同机同文件仍稳定） */ }
  const norm = process.platform === 'win32' ? real.toLowerCase() : real
  return createHash('sha256').update(norm).digest('hex').slice(0, 16)
}

/**
 * 台账记录查找：按稳定键取（见 `sourceKey` 的 why）。
 *
 * 旧台账（键 = rel、记录里没有 `key` 字段）的兼容：**只在内容 hash 完全一致时才认**。
 * 换键后若把旧记录直接认下，"同名不同文件"又会被判成"同一源内容变化"→ 回到静默覆盖那条路；
 * hash 一致 = 确实是同一份内容，就地沿用是安全的（也不会重复产出第二份 md）。
 * 命中旧记录时由调用方迁移到稳定键（见 importDocuments 里的 ledgerTouched）。
 */
function findRecord(ledger, key, rel, hash) {
  const rec = ledger.files[key]
  if (rec && (!rec.key || rec.key === key)) return rec
  const legacy = ledger.files[rel]
  if (legacy && !legacy.key && hash && legacy.hash === hash) return legacy
  return null
}

function sha256File(abs) {
  const h = createHash('sha256')
  h.update(readFileSync(abs))
  return h.digest('hex')
}

/**
 * 批次收集（递归）。返回 `{ files, rejected }`：
 * - files: `[{ abs, rel, size, key }]`（rel 相对导入根、POSIX 分隔符；key = 源文件稳定标识，见 sourceKey）
 * - rejected: `[{ rel, error, message }]`（白名单/体积/符号链接等**逐文件**拒因）
 *
 * 为什么拒因要逐文件收集而不是整体抛错：一批 200 个文件里混一个 `.exe` 就让整批失败，
 * 用户得自己一个个排除 —— 而"部分成功 + 明确拒因"才是可用的语义（spec P1-3）。
 */
export function collectFiles(from, { limits = IMPORT_LIMITS } = {}) {
  const sources = (Array.isArray(from) ? from : [from]).map((s) => String(s ?? '').trim()).filter(Boolean)
  if (!sources.length) return bad('not-found', '导入源为空')
  const multi = sources.length > 1
  const files = []
  const rejected = []
  const usedRel = new Set()
  let sawSingleFile = false
  for (const src of sources) {
    // 多源时给**目录源**的 rel 加 `<源目录名>/` 前缀：否则两个目录里的同名 `a.docx`
    // 会挤在同一个 rel 上——台账互相覆盖、产物互相让位改名，报告也看不出谁是谁。
    // **文件源一律不加前缀**（见 collectOne 里 `pf` 的 why）：多选文件必须与"整目录导入"同口径。
    const prefix = multi ? `${basename(resolve(src))}/` : ''
    const one = collectOne(src, limits, { prefix, usedRel })
    if (!one.ok) {
      // 任一源不存在/是符号链接 → 整批拒。**不**做"跳过坏源继续导好的"：
      // 多选文件时路径来自系统对话框，出现坏路径意味着参数组装出了问题，
      // 静默丢一个源会让用户以为全都导进去了。
      return one
    }
    files.push(...one.value.files)
    rejected.push(...one.value.rejected)
    if (one.value.single) sawSingleFile = true
  }
  files.sort((a, b) => a.rel.localeCompare(b.rel))   // 稳定顺序：同一批两次导入产出同一份报告
  return ok({ files, rejected, single: !multi && sawSingleFile })
}

/** 单源收集（collectFiles 的内核；rel 唯一化在多源场景下必须做） */
function collectOne(from, limits, { prefix = '', usedRel = new Set() } = {}) {
  const files = []
  const rejected = []
  const root = resolve(String(from))
  let st
  try { st = lstatSync(root) } catch { return bad('not-found', `导入源不存在：${root}`) }
  if (st.isSymbolicLink()) return bad('bad-source', '导入源是符号链接（拒绝跟随，防越界读取）')

  // 前缀**只对目录源生效**：文件源平铺（rel = 文件名），与"该文件本来就在源目录根下"完全同口径。
  // 为什么必须这样：多选 2+ 个文件时若按"以文件名建目录"，产物会变成 `报告.docx/报告.md`，
  // 而同一份文件"整目录导入"得到 `报告.md` —— 同一物理文件入库两份、检索双命中，台账键/产物名
  // 也都不一致（第二次导入骗不过幂等）。平铺后两种入口得到同一 rel ⇒ 同一目标 md 名 + 同一台账键。
  const pf = st.isDirectory() ? prefix : ''

  /** rel 去重：先原样，再带"源文件所在目录名"，最后加序号（同一 rel 只会在同名不同源时撞上） */
  const uniq = (abs, rel) => {
    const cand = `${pf}${rel}`
    if (!usedRel.has(cand)) { usedRel.add(cand); return cand }
    // 用**文件所在目录名**消歧（`b/报告.docx`）：比把文件名当目录（`报告.docx/报告.docx`）
    // 或 `报告-2.docx` 更能说明它来自哪里；目录名也撞时才退化成序号。
    const withParent = `${pf}${basename(dirname(abs))}/${basename(rel)}`
    if (!usedRel.has(withParent)) { usedRel.add(withParent); return withParent }
    const ext = extname(rel)
    const stem = basename(rel, ext)
    for (let i = 2; i < 1000; i++) {
      const c = `${pf}${stem}-${i}${ext}`
      if (!usedRel.has(c)) { usedRel.add(c); return c }
    }
    usedRel.add(cand)
    return cand
  }

  const push = (abs, rel) => {
    const ext = extname(abs).toLowerCase()
    const r = uniq(abs, rel.split(sep).join('/'))
    if (BLOCKED_EXTS.has(ext)) {
      rejected.push({ source: r, error: 'blocked-ext', message: `不允许导入可执行/脚本类文件（${ext}）` })
      return
    }
    if (!ALLOWED_EXTS.has(ext)) {
      rejected.push({ source: r, error: 'unsupported', message: `不支持的扩展名：${ext || '(无扩展名)'}` })
      return
    }
    let fst
    try { fst = lstatSync(abs) } catch (e) {
      rejected.push({ source: r, error: 'unreadable', message: String(e?.message || e) })
      return
    }
    if (fst.isSymbolicLink()) {
      rejected.push({ source: r, error: 'symlink', message: '符号链接（拒绝跟随）' })
      return
    }
    if (!fst.isFile()) {
      rejected.push({ source: r, error: 'not-file', message: '不是普通文件' })
      return
    }
    if (fst.size > limits.maxFileBytes) {
      rejected.push({
        source: r, error: 'too-large',
        message: `文件过大（${fmtBytes(fst.size)} > 上限 ${fmtBytes(limits.maxFileBytes)}）`,
      })
      return
    }
    if (fst.size === 0) {
      rejected.push({ source: r, error: 'empty', message: '空文件（0 字节）' })
      return
    }
    files.push({ abs, rel: r, size: fst.size, key: sourceKey(abs) })
  }

  if (st.isFile()) {
    push(root, basename(root))
    return ok({ files, rejected, single: true })
  }
  if (!st.isDirectory()) return bad('bad-source', `导入源既不是文件也不是目录：${root}`)

  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch (e) {
      rejected.push({ source: relative(root, dir).split(sep).join('/') || '.', error: 'unreadable', message: String(e?.message || e) })
      continue
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue          // 隐藏项一律跳过（含 .DS_Store / .gitignore）
      const abs = join(dir, e.name)
      if (e.isSymbolicLink()) {
        rejected.push({ source: relative(root, abs).split(sep).join('/'), error: 'symlink', message: '符号链接（拒绝跟随）' })
        continue
      }
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name.toLowerCase())) continue
        stack.push(abs)
        continue
      }
      push(abs, relative(root, abs))
    }
  }
  return ok({ files, rejected, single: false })
}

/**
 * 输出相对路径：`<原相对目录>/<原名去扩展名>.md`。
 * 名字被占用时（同批撞名 / 磁盘上已有**非我方**文件）递增 `-2`、`-3` 让位 ——
 * 绝不覆盖我们没有写入记录的文件（用户的 md 可能就放在那个空间里）。
 */
export function outRelFor(rel, isTaken = () => false) {
  const dir = dirname(rel)
  const ext = extname(rel)
  const stem = basename(rel, ext)
  const prefix = dir && dir !== '.' ? `${dir.split(sep).join('/')}/` : ''
  const base = safeOutRel(`${prefix}${stem}.md`)
  if (!base) return null
  // 首选项被占时先试"带原扩展名"（`a.docx.md`）—— 比 `a-2.md` 更能说明它来自哪个源文件
  const withExt = safeOutRel(`${prefix}${stem}${ext}.md`)
  const cands = [base, ...(withExt ? [withExt] : [])]
  for (const c of cands) if (!isTaken(c)) return c
  for (let i = 2; i < 1000; i++) {
    const c = safeOutRel(`${prefix}${stem}${ext}-${i}.md`) || safeOutRel(`${prefix}${stem}-${i}.md`)
    if (c && !isTaken(c)) return c
  }
  return null
}

/** frontmatter 标量净化：**必须**去掉换行，否则一行值会被解析成两行、frontmatter 结构倒掉。 */
function yamlScalar(v) {
  return String(v ?? '').replace(/[\r\n]+/g, ' ').trim()
}

/** 单元格 → md 单元格：`|` 与换行会破坏表格结构，必须转义。 */
function mdCell(v) {
  return String(v ?? '').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ').trim()
}

/**
 * sections → Markdown 正文（**唯一渲染器**：PDF 页/Excel 表/PPT 页/Word 标题层级走同一条路）。
 * 标题层级映射 `min(4, level+1)`：section 一级 → `##`（文档标题已占 `#`），二级 → `###`，封顶 `####`。
 */
export function renderBody(sections) {
  const out = []
  for (const s of sections || []) {
    const heading = String(s?.heading ?? '').trim()
    if (heading) out.push(`${'#'.repeat(Math.min(4, Math.max(2, (Number(s.level) || 0) + 1)))} ${heading}`)
    const text = String(s?.text ?? '').trim()
    if (text) out.push(text)
    for (const tbl of s?.tables || []) {
      const rows = (tbl || []).filter((r) => Array.isArray(r) && r.some((c) => String(c ?? '').trim()))
      if (!rows.length) continue
      const width = Math.max(...rows.map((r) => r.length))
      const line = (r) => `| ${Array.from({ length: width }, (_, i) => mdCell(r[i])).join(' | ')} |`
      out.push([line(rows[0]), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`,
        ...rows.slice(1).map(line)].join('\n'))
    }
  }
  return out.join('\n\n').trim()
}

/**
 * 组装单篇 md（frontmatter + 标题 + 正文），并执行**单篇体积护栏**。
 * 超 2MB 时按 section 边界截断并标注 —— 静默截断是禁止的（用户会以为全文都进去了）。
 * @returns {{ content: string, truncated: boolean, sectionsKept: number, totalSections: number }}
 */
export function renderMarkdown({ meta, sections, maxDocBytes = IMPORT_LIMITS.maxDocBytes }) {
  const total = (sections || []).length
  // 首节标题与文档标题同名时**不重复渲染**：docx 的 Title 段落（"XX报告"）会同时成为
  // frontmatter title、正文 `# 标题` 和首节 heading —— 三遍同名标题在检索里就是三条同分命中，
  // 白占召回位（实测：标题行被切成两个重复块）。
  const docTitle = String(meta.title || '').trim()
  const norm = (sections || []).map((s, i) => (
    i === 0 && String(s?.heading ?? '').trim() === docTitle && docTitle
      ? { ...s, heading: null, level: 0 }
      : s
  ))
  const head = (extra = []) => {
    const lines = [
      `title: ${yamlScalar(meta.title)}`,
      `source: ${yamlScalar(meta.source)}`,
      `sourcePath: ${yamlScalar(meta.sourcePath)}`,
      `sourceHash: ${yamlScalar(meta.sourceHash)}`,
      `sourceBytes: ${Number(meta.sourceBytes) || 0}`,
      `converter: ${yamlScalar(meta.converter)}`,
      `convertedAt: ${yamlScalar(meta.convertedAt)}`,
      ...extra,
    ]
    return `---\n${lines.join('\n')}\n---\n\n# ${yamlScalar(meta.title) || yamlScalar(meta.source)}\n`
  }
  const body = renderBody(norm)
  let content = `${head()}\n${body}\n`.replace(/\n{3,}/g, '\n\n')
  if (Buffer.byteLength(content, 'utf-8') <= maxDocBytes) {
    return { content, truncated: false, sectionsKept: total, totalSections: total }
  }
  // 逐节累加直到逼近上限（保留尽可能多的内容，而不是一刀切空文档）
  const kept = []
  for (const s of sections || []) {
    const tryBody = renderBody([...kept, s])
    const tryDoc = `${head(['truncated: true'])}\n${tryBody}\n`.replace(/\n{3,}/g, '\n\n')
    if (Buffer.byteLength(tryDoc, 'utf-8') > maxDocBytes) break
    kept.push(s)
  }
  const note = `> ⚠️ 本文档原文超出单篇 ${(maxDocBytes / 1024 / 1024).toFixed(0)}MB 上限，`
    + `已按小节边界截断：收录前 ${kept.length}/${total} 节。完整内容请查阅源文件。`
  content = `${head(['truncated: true'])}\n${note}\n\n${renderBody(kept)}\n`.replace(/\n{3,}/g, '\n\n')
  return { content, truncated: true, sectionsKept: kept.length, totalSections: total }
}

/**
 * 自带 python 解释器（安装包 `extraResources` 里的 bundled 运行时）。
 * dev = `<repo>/runtime/python/python.exe`；release = `resources/runtime/python/python.exe`。
 */
export function bundledPython() {
  const here = dirname(fileURLToPath(import.meta.url))
  const cands = [
    join(here, '..', 'runtime', 'python', 'python.exe'),
    join(here, '..', 'runtime', 'python', 'bin', 'python3'),
    join(dirname(here), 'resources', 'runtime', 'python', 'python.exe'),
  ]
  return cands.find((p) => existsSync(p)) || null
}

/**
 * python 解释器定位（引擎脚本本身走 kernel/tools.mjs 的同一份探测）。
 * 优先级：显式 `pythonPath` → env（`PONOS_PYTHON`/`YFWORKING_PYTHON`）→ **自带**解释器
 * → PATH 上的 `python`/`python3`。
 *
 * **为什么自带要排在 PATH 之前**：系统 python 通常没装这套解析依赖（pypdf/python-docx/
 * openpyxl/xlrd/PIL/rapidocr），导入会全线报"模块不存在"；而 bundled 那个一定装齐。
 * env 仍排最前 —— 那是运维的显式覆盖，不能被本地约定压掉。
 */
export function resolvePython(pythonPath = null) {
  const explicit = String(pythonPath ?? '').trim()
  if (explicit) return explicit
  const env = String(process.env.PONOS_PYTHON || process.env.YFWORKING_PYTHON || '').trim()
  if (env) return env
  const bundled = bundledPython()
  if (bundled) return bundled
  return process.platform === 'win32' ? 'python' : 'python3'
}

/**
 * 解析器脚本定位。
 *
 * **为什么自己要一份候选列表，而不是"引擎同目录"一把梭**：`findOcrEngine()` 返回的是
 * **第一个存在**的 ocr_engine.py —— 实测开发机上命中的是 `~/.yfw/skills/_common/`，
 * 而新脚本只在仓库 `runtime/skills/_common/` 里（用户技能目录是同步产物、可能滞后）。
 * 只在"引擎同目录"找，会出现"引擎找得到、解析器找不到"的假死。
 * 因此按"最具体 → 最通用"依次探测，任何一处命中即可用。
 *
 * 打包形态核对过（electron-builder.yml）：`resources/kernel/cli.mjs`（bundle）与
 * `resources/runtime/skills/**`（extraResources）在同级，故 `../runtime/skills/...`
 * 在开发与安装版**同时成立**。
 */
export function parserCandidates() {
  const here = dirname(fileURLToPath(import.meta.url))            // <…>/kernel（dev）或 resources/kernel（release）
  const home = process.env.USERPROFILE || process.env.HOME || ''
  const cwdUp2 = dirname(dirname(process.cwd()))
  const out = []
  const push = (p) => { if (p) out.push(p) }
  // env 候选**必须先确认非空**再 join：`join('', '_common', 'doc_to_md.py')` 得到的是
  // **相对路径** `_common/doc_to_md.py`，它的 existsSync 是按 cwd 判定的 —— 谁的工作目录里
  // 恰好有这么一个文件，就会被当成"技能目录里的解析器"用上（静默换实现，最难查的一类故障）。
  const pushEnv = (base, ...rest) => {
    const b = String(base ?? '').trim()
    if (b) push(join(b, ...rest))
  }
  push(process.env.PONOS_DOC_TO_MD)
  push(process.env.YFW_DOC_TO_MD)
  const engine = findOcrEngine()
  if (engine) push(join(dirname(engine), 'doc_to_md.py'))         // 引擎同目录（技能库同步完整时首选）
  push(join(here, '..', 'runtime', 'skills', '_common', 'doc_to_md.py'))
  pushEnv(process.env.PONOS_SKILLS_DIR, '_common', 'doc_to_md.py')
  pushEnv(process.env.PONOS_HOME, 'skills', '_common', 'doc_to_md.py')
  push(join(cwdUp2, 'runtime', 'skills', '_common', 'doc_to_md.py'))
  push(join(cwdUp2, 'resources', 'runtime', 'skills', '_common', 'doc_to_md.py'))
  push(join(home, '.yfw', 'skills', '_common', 'doc_to_md.py'))
  push(join(home, '.ponos', 'skills', '_common', 'doc_to_md.py'))
  return out.filter(Boolean)
}

export function resolveParserScript() {
  return parserCandidates().find((p) => existsSync(p)) || null
}

/**
 * 默认转换器：spawn python 解析器，读回单行 JSON。可注入（测试不依赖真实 python/OCR）。
 *
 * **异步 + registerChild**（而不是 spawnSync）：导入动辄几十秒到几分钟（PDF 走 OCR），
 * 同步阻塞会把内核事件循环整个冻住 —— 会话里的流式输出停摆、Ctrl-C 也传不进来，
 * 表现为"应用卡死"。这与内核 OCR 工具同一取舍（tools.mjs ocrFile）。
 * 登记子进程还让"会话中止 → killActiveChildren"能一起收掉它，不留孤儿 python。
 */
export function defaultConverter({ absPath, rel, limits, timeoutMs = 900_000, pythonPath = null, pageImagesDir = null }) {
  const script = resolveParserScript()
  if (!script) {
    return Promise.resolve(bad('parser-missing', '未找到解析器 doc_to_md.py（确认技能库已安装，或用 YFW_DOC_TO_MD 指定路径）'))
  }
  const args = [script, '--input', absPath, '--project', 'kb-import',
    '--max-ocr-pages', String(limits.maxOcrPages), '--max-table-rows', String(limits.maxTableRows)]
  // 页面图片只在调用方给了目录时才要（不给参数 = 不渲染 = 零额外磁盘/耗时，
  // 见 doc_to_md.py 的 --emit-page-images 头注）；渲染页数受 maxVisionPages 约束。
  if (pageImagesDir) {
    args.push('--emit-page-images', pageImagesDir, '--max-vision-pages', String(limits.maxVisionPages))
  }
  const engine = findOcrEngine()
  if (engine) args.push('--ocr-engine', engine)
  const MAX_OUT = 32 * 1024 * 1024
  return new Promise((resolvePromise) => {
    let child
    try {
      child = registerChild(spawn(resolvePython(pythonPath), args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        // env 走白名单（防子进程拿到宿主密钥）+ 显式钉住 UTF-8：
        // Windows 上 python 默认按控制台代码页写 stdout，中文会变乱码（实测症状）。
        env: { ...childEnv(), PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      }))
    } catch (e) {
      return resolvePromise(bad('convert-failed', `解析器启动失败：${e?.message || e}`))
    }
    let out = ''
    let err = ''
    let settled = false
    let timer = null
    const done = (v) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolvePromise(v)
    }
    const kill = () => { try { child.kill() } catch { /* 已自行退出 */ } }
    timer = setTimeout(() => { kill(); done(bad('convert-timeout', `解析超时（>${Math.round(timeoutMs / 1000)}s）`)) }, timeoutMs)
    child.stdout.on('data', (d) => {
      out += d
      if (out.length > MAX_OUT) { kill(); done(bad('convert-failed', `解析输出超过 ${MAX_OUT / 1024 / 1024}MB 上限（文档过大或解析异常）`)) }
    })
    // 只留前 8KB stderr：错误信息够用即可，不无界增长（同 kernelReadonly 的取舍）
    child.stderr.on('data', (d) => { if (err.length < 8192) err += d })
    child.on('error', (e) => done(bad('convert-failed', `解析器启动失败：${e?.message || e}`)))
    child.on('close', (code) => {
      // JSON 是**最后一个以 { 开头的行**：python 侧日志走 stderr，但第三方库（OCR）可能直写 stdout
      let line = null
      for (const ln of out.split('\n').reverse()) {
        if (ln.trim().startsWith('{')) { line = ln.trim(); break }
      }
      if (!line) {
        return done(bad('convert-failed', `解析器无有效输出（exit ${code}）：${(err || out).trim().slice(0, 400)}`))
      }
      let data
      try { data = JSON.parse(line) } catch (e) {
        return done(bad('convert-failed', `解析器输出非法 JSON：${e?.message || e}`))
      }
      if (!data || data.ok !== true) {
        return done(bad(data?.error || 'convert-failed', data?.message || '解析失败'))
      }
      done(ok(data))
    })
  })
}

// ---------------------------------------------------------------------------
// 视觉模型识别表格（扫描件 PDF / 图片）
// ---------------------------------------------------------------------------
// 为什么需要这条通道（实测事实，2026-09-14）：扫描件没有文本层、页面上只有像素，OCR 只给回
// **一堆文本行、不保留列坐标**；而 `ocr_engine.py` 的表格识别是"文本行启发式"（要求每行含
// ≥2 个数字且以空格分隔单元格）——实测扫描件走引擎 `ocr-table` 的表格数恒为 **0**。
// 于是"扫描件里的表格"在本功能里本来是**读不出来**的（正文能读到，结构丢掉）。
// 多模态模型看图能直接读出行列，这是唯一不需要自研版面分析的路径（用户选定方案）。
//
// 分层：python 只负责**渲染页面图片**（`--emit-page-images`，给我们图），
//      视觉调用与 Markdown 表格解析都在**内核**（模型调用是 API 契约，不该由解析器承担）。
//
// 三条纪律：
//   1. 未配置视觉模型 ⇒ **不发起任何调用**（不浪费 OCR 回退的等待、不产生半点费用），
//      只在报告里给出 `skipped: 'not-configured'`，由 GUI 提示用户去配置。
//   2. 视觉调用失败 ⇒ **不影响导入**：表格是增益，正文（OCR 文本）照常入库，失败只记 warning。
//   3. 用完即清：页面 PNG 是中间产物，落在系统临时目录、每篇一个子目录，**无论成败都删**。
const VISION_TABLE_INSTRUCTION = [
  '你是一名文档表格提取器。请查看这张文档页面图片，只做一件事：把其中的表格转成 GitHub 风格 Markdown 表格。',
  '要求：',
  '1) 原样保留单元格文字与数字（中文照抄，不要翻译、不要改写、不要补全）。',
  '2) 多个表格就依次输出多个 Markdown 表格，表格之间空一行。',
  '3) 跨行/跨列合并的单元格：在其余格子重复该值（Markdown 不支持合并）。',
  '4) 图片里没有表格时，只输出 NONE 四个字符。',
  '5) 不要输出任何解释、前言、标题或代码块围栏，直接输出表格本身。',
].join('\n')

/**
 * 解析模型返回的 Markdown 表格 → `[[行], ...]`（只取表体，丢弃分隔行与空行）。
 *
 * 为什么自己解析而不信模型给 JSON：多模态模型输出 Markdown 表格的稳定性远高于严格 JSON
 * （无需转义、不受引号/换行破坏）；且**任何**非表格文字都会被自然丢弃 —— 模型若多说了
 * 几句解释，表格照样能取出来（容错来自格式本身，而不是靠提示词祈祷）。
 */
export function parseMarkdownTables(md) {
  // 转义竖线（`\|`）先换成占位符再切分：否则"单元格里写了竖线"会被当成列分隔，
  // 一行变三列（实测：`| a\|b | c |` 被切成 `a` / `b` / `c`）。
  const PIPE = '\u0000'
  const out = []
  let cur = null
  for (const raw of String(md ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line.startsWith('|')) { cur = null; continue }
    // 去掉首尾竖线后按 | 切分（转义竖线此刻已是占位符，不会被切开）
    const cells = line.replace(/\\\|/g, PIPE).replace(/^\|/, '').replace(/\|$/, '').split('|')
      .map((c) => c.split(PIPE).join('|').trim())
    // 分隔行（`|---|---|`，也含模型常写的单横线 `|-|-|`）不是数据。
    // 用 `-+` 而非 `-{2,}`：GFM 里单横线就是合法分隔行 —— 只认两横线的话，
    // 模型回 `| - | - |` 时会把 `['-','-']` 当成一行数据塞进表格（用户看到一行莫名其妙的横线）。
    // 误判风险极低：要求**所有**单元格都是横线（数据行里出现一个 "-" 值不会整行皆横线）。
    if (cells.length && cells.every((c) => /^:?-+:?$/.test(c))) continue
    if (!cur) { cur = []; out.push(cur) }
    if (cells.some((c) => c !== '')) cur.push(cells)
  }
  return out.filter((t) => t.length)
}

/**
 * 逐页调视觉模型提取表格，并**并入**对应页的 section。
 *
 * @param data      解析器输出的 JSON（含 sections 与可选 pageImages）
 * @param visionCall `async (imagePath, instruction) => string`（测试注入用；缺省走内核 Vision 同一实现）
 * @param maxPages   页数护栏（默认取 limits.maxVisionPages）
 * @returns 摘要 `{attempted, pages, tables, errors, truncated}`（供报告与 GUI 展示）
 *
 * **为什么按 `第 N 页` 标题回填**：解析器把每页渲成一个 section（`heading: '第 N 页'`），
 * 图片输入的 section 无标题（只有 1 页）——两种形状都要能对上，否则表格会落到别的页上去。
 */
export async function augmentTablesViaVision({
  data, visionCall = null, maxPages = 20, instruction = VISION_TABLE_INSTRUCTION, warnings = [],
} = {}) {
  const images = Array.isArray(data?.pageImages) ? data.pageImages : []
  const sections = Array.isArray(data?.sections) ? data.sections : []
  const summary = { attempted: 0, pages: 0, tables: 0, errors: [], truncated: false, skipped: null }
  if (!images.length) { summary.skipped = 'no-page-images'; return summary }
  const use = images.slice(0, Math.max(0, maxPages))
  if (use.length < images.length) {
    summary.truncated = true
    warnings.push(`视觉表格提取仅处理前 ${use.length}/${images.length} 页（页数上限 maxVisionPages）`)
  }
  const call = visionCall || defaultVisionCall
  for (const img of use) {
    const page = Number(img?.page) || 1
    const path = img?.path
    if (!path || !existsSync(path)) {
      summary.errors.push({ page, message: `页面图片不存在：${path}` })
      continue
    }
    summary.attempted += 1
    let text = ''
    try {
      text = await call(path, instruction)
    } catch (e) {
      summary.errors.push({ page, message: e?.message || String(e) })
      continue
    }
    const tables = parseMarkdownTables(text)
    if (!tables.length) { summary.pages += 1; continue }   // 该页确实没表格（或模型答 NONE）：正常情况
    const target = sections.find((s) => String(s?.heading || '').includes(`第 ${page} 页`))
      || (images.length === 1 ? sections[0] : null)
    if (!target) {
      summary.errors.push({ page, message: `找不到第 ${page} 页对应的章节，表格无处安放` })
      continue
    }
    target.tables = [...(Array.isArray(target.tables) ? target.tables : []), ...tables]
    summary.tables += tables.length
    summary.pages += 1
  }
  return summary
}

/**
 * 缺省的视觉调用：**复用内核 Vision 工具的实现**（`kernel/tools.mjs` 的 `visionDescribe`）。
 *
 * 为什么不在这里自己写一遍 HTTP：那会变成"第二份视觉 API 契约"—— 鉴权头、图片编码、
 * Anthropic/OpenAI 两种 body 形状、错误映射都得同步维护，必然漂移（本项目反复踩的病灶）。
 *
 * 为什么不动态 import 了（P2-1 后）：原先延迟加载是为了躲开"与 tools.mjs 的静态循环依赖
 * 风险"（tools.mjs 又是内核的大模块）。依赖目标已改为 `media-tools.mjs` —— 一个只装载媒体
 * 工具的薄模块，与本文件**无环**，故在文件顶部静态导入即可，无需为躲环付出延迟加载的复杂度。
 */
async function defaultVisionCall(imagePath, instruction) {
  // skipBoundary=true：这些 PNG 是**我们自己**刚渲到系统临时目录的中间产物，
  // 不在用户配置的可读目录白名单里（不是用户的文件，无需边界校验）。
  const r = await visionDescribe(imagePath, null, { instruction }, true)
  if (r?.isError) throw new Error(String(r.content || '视觉模型调用失败').slice(0, 300))
  return String(r?.content || '')
}

/**
 * 安全删除**我们自己建的**临时页面图片目录。
 *
 * 为什么带守卫而不是直接 `rmSync(recursive)`：这个函数删的是目录树，一旦路径被上层传错
 * （比如误传了用户目录），递归删除就是不可逆的数据事故。所以只接受**系统临时目录下、
 * 以 `yfw-kbimg-` 开头**的目录 —— 满足条件才删，其余一律不碰并返回 false。
 * 清理失败（文件被占用等）也不算错误：临时目录由系统回收，不该因此中断导入。
 */
export function safeRmDir(dir) {
  try {
    const abs = resolve(dir)
    const tmp = resolve(tmpdir())
    if (!abs.startsWith(tmp + sep) || !basename(abs).startsWith('yfw-kbimg-')) return false
    rmSync(abs, { recursive: true, force: true })
    return true
  } catch { return false }
}

/** 台账读写（原子替换：写 .tmp → rename，对齐 kernel/graph.mjs 的手法）。 */function readLedger(root) {
  try {
    const j = JSON.parse(readFileSync(join(root, LEDGER_NAME), 'utf-8'))
    if (j && typeof j === 'object' && j.files && typeof j.files === 'object') return j
  } catch { /* 缺失/损坏 → 视作空台账（重新导入会重转，代价可接受，不会误判为"已导入"） */ }
  return { version: LEDGER_VERSION, updatedAt: null, files: {} }
}

function writeLedger(root, ledger) {
  const fp = join(root, LEDGER_NAME)
  const tmp = `${fp}.tmp`
  writeFileSync(tmp, JSON.stringify({ ...ledger, version: LEDGER_VERSION, updatedAt: new Date().toISOString() }, null, 2), 'utf-8')
  renameSync(tmp, fp)
}

function atomicWrite(abs, content) {
  const tmp = `${abs}.tmp`
  writeFileSync(tmp, content, 'utf-8')
  renameSync(tmp, abs)
}

/**
 * 导入主流程。
 *
 * @param configDir 配置根（`knowledge/` 的父目录）
 * @param from      导入源（文件或目录，绝对路径）
 * @param space     空间 id（缺省用 name）
 * @param name      空间显示名（新建空间时写进 .space.json）
 * @param dryRun    true = 只报告不落盘（不建目录、不写 md、不写台账）
 * @param converter 可注入的转换器（缺省 defaultConverter；测试注入假实现）
 * @param pythonPath 注入的 python 解释器路径（透传给 defaultConverter；缺省见 resolvePython）
 * @param knowledgeIndex 内核 KnowledgeStore（可选；传了就在导入后同步索引）
 * @param limits    覆盖 IMPORT_LIMITS
 * @param onProgress 进度回调（可选）：批量导入的可观测性。两次调用形状不同——
 *                   `{phase:'plan', done:0, total:N, totalBytes}` 在**枚举完文件后立即**触发
 *                   （"先查文件数"，GUI 据此算出总步数）；
 *                   `{phase:'process', done:i, total:N, current:相对路径}` 在**每个文件开始处理时**触发
 *                   （done = 已完成数，即循环下标；`total` 恒为计划文件数）。
 *                   ⚠️ 进度按**循环下标**推进，而不是按"成功数"：一个文件可能走
 *                   已导入/跳过/被拒/失败四条路（含多条 `continue`），若按成功数计，
 *                   被跳过的文件会让进度条**永远差一截**（分母对不上的经典 bug）。
 *                   按下标计则恒定收敛到 total。回调抛错不影响导入（见 emitProgress）。
 * @returns 结构化报告（见下方 return 形状）
 *
 * ⚠️ 另有一层**对外主入口** `importFiles(opts)`（本文件末尾）：同一条管线，参数/报告口径按
 * 任务契约（results[].status + summary）。两处共用本函数，不复制任何防护逻辑。
 */
export async function importDocuments({
  configDir, from, space = null, name = null, dryRun = false,
  converter = null, knowledgeIndex = null, limits: limitOverride = null, pythonPath = null,
  visionTables = 'auto', visionCall = null, visionAvailable: visionOverride = null,
  onProgress = null,
} = {}) {
  const limits = { ...IMPORT_LIMITS, ...(limitOverride || {}) }
  // 进度回调的**安全包装**：导入流程不该因为"上报进度时出错"而失败
  //（GUI 关了、消费者崩了都不应影响落盘）。故吞掉异常，只在确实抛错时降级为静默。
  const emitProgress = (evt) => {
    if (typeof onProgress !== 'function') return
    try { onProgress(evt) } catch { /* 进度是旁路，不能反向影响主流程 */ }
  }
  if (!configDir) return { ok: false, error: 'bad-config', message: '缺少 configDir（无法定位知识根）' }
  const wantId = String(space || name || '').trim()
  const idCheck = validateSpaceId(wantId)
  if (!idCheck.ok) return { ok: false, ...idCheck }
  const spaceId = idCheck.value
  const displayName = String(name || spaceId).trim()

  // 只读来源的第二道判定（第一道是 validateSpaceId 的 `pack-` 前缀）：目标 id 虽不以 `pack-`
  // 开头，但 `knowledge/packs/<id>` 已存在（知识包装到本地、用户直接填了包名）——仍是只读，
  // 绝不能因为它"看着像个普通 id"就把产物写进 packs 树里（spec P3-1：绝不静默写到别处）。
  if (existsSync(join(configDir, 'knowledge', 'packs', spaceId))) {
    return {
      ok: false, error: 'readonly-space',
      message: `空间 ${spaceId} 已存在但位于 knowledge/packs/（只读知识包），不能作为导入目标`,
    }
  }

  const collected = collectFiles(from, { limits })
  if (!collected.ok) return { ok: false, error: collected.error, message: collected.message }
  const { files, rejected } = collected.value
  if (!files.length && !rejected.length) {
    return { ok: false, error: 'empty-source', message: `导入源里没有可处理的文件：${from}` }
  }
  if (files.length > limits.maxBatchFiles) {
    return {
      ok: false, error: 'too-many-files',
      message: `文件数 ${files.length} 超出单批上限 ${limits.maxBatchFiles}（请分批导入）`,
    }
  }
  const totalBytes = files.reduce((s, f) => s + f.size, 0)
  if (totalBytes > limits.maxBatchBytes) {
    return {
      ok: false, error: 'batch-too-large',
      message: `整批 ${fmtBytes(totalBytes)} 超出上限 ${fmtBytes(limits.maxBatchBytes)}（请分批导入）`,
    }
  }

  // ① 计划阶段：文件数在此确定 —— 立即上报，让 GUI 不必等第一个文件处理完就能算出总步数。
  // （需求原话："先查文件数，然后根据实时处理的文件数量算进度"。）
  emitProgress({ phase: 'plan', done: 0, total: files.length, totalBytes, rejected: rejected.length })

  const spacesRoot = join(configDir, 'knowledge', 'spaces')
  const spaceRoot = join(spacesRoot, spaceId)
  const existed = existsSync(spaceRoot)
  const ledger = existed ? readLedger(spaceRoot) : { version: LEDGER_VERSION, updatedAt: null, files: {} }
  const conv = converter || defaultConverter
  const now = new Date().toISOString()

  // 视觉表格提取的**开关判定整批只做一次**：未配置视觉模型时，整批既不渲染页面图片、
  // 也不发起任何视觉调用（省磁盘、省时间、零费用），只在报告里留 `not-configured` 让 GUI 提示。
  // `visionAvailable` 参数用于测试/上层显式指定（注入假 visionCall 时不必依赖真实 env）。
  const visionConfigured = visionOverride !== null ? !!visionOverride : visionAvailable()
  // dry-run **不调视觉**：预览的语义是"不产生副作用"，而视觉调用是**花钱且慢**的外部请求
  // （预览一次 = 一次真实计费）。dry-run 报告仍如实给出 `configured` 与 `skipped:'dry-run'`，
  // 用户据此知道"正式导入时表格会不会被提取"。
  const wantVision = !dryRun && visionTables !== false && visionConfigured
  const visionSkipReason = visionTables === false ? 'disabled'
    : (!visionConfigured ? 'not-configured' : (dryRun ? 'dry-run' : null))

  const sourceList = (Array.isArray(from) ? from : [from])
    .map((s) => String(s ?? '').trim()).filter(Boolean)
  const report = {
    // `spaceCreated` 的口径：**本次运行真的把空间建出来了**（延迟创建，见下方 ensureSpace）。
    // 空批次（全批被拒/全部转换失败）时保持 false：不留空空间 + 空 `.space.json`
    // —— 否则 GUI 空间列表会凭空多一个空条目，用户以为"导进去了"而文件树里什么都没有。
    ok: true, spaceId, spaceName: displayName, spaceCreated: false, spaceExisted: existed, dryRun: !!dryRun,
    spaceRoot,
    // 单源保持字符串（既有调用方与 GUI 都按字符串显示），多源给数组 —— 报告里必须能看出
    // "这一批到底来自哪几个地方"，否则多选文件导入后没人能复现它从哪来。
    source: sourceList.length === 1 ? resolve(sourceList[0]) : sourceList.map((s) => resolve(s)),
    sources: sourceList.map((s) => resolve(s)),
    sourceIsDir: !collected.value.single,
    counts: { total: files.length + rejected.length, converted: 0, skipped: 0, failed: rejected.length },
    // `phase` 是**分档依据**（不改变既有字段）：collect = 扫描期就拒（白名单/体积/符号链接等），
    // 其余 = 转换/落盘期失败。`importFiles` 据此把报告分成 `rejected` / `failed` 两档
    // （P1-3 要求"拒收"与"失败"各自明确；两者混成一档，用户分不清"格式不允许"与"这份文件坏了"）。
    converted: [], skipped: [], failed: rejected.map((r) => ({ source: r.source, error: r.error, message: r.message, phase: 'collect' })),
    indexSync: 'none', warnings: [],
    // 视觉表格提取的整批汇总（GUI 提示"要不要去配视觉模型"就靠这个字段）。
    // `configured` **在建报告时就写死**，而不是等结尾再补：本函数有**提前返回**（dry-run
    // 在第 937 行就 return），收尾式赋值在那条路径上根本跑不到 —— 实测症状是 dry-run 报告里
    // `configured:false` 而实际已配置，GUI 于是对着"配好了的"用户提示"未配置"。
    // pages/tables 在逐篇处理中累加，skipped 在结尾定稿（dry-run 另给 'dry-run'）。
    vision: { configured: visionConfigured, skipped: visionSkipReason, used: false, pages: 0, tables: 0 },
  }
  if (dryRun) {
    // dry-run 也要给出"将跳过谁"：只列"将处理"的话，用户看不出幂等是否生效（那是一半的信息）
    for (const f of files) {
      let hash = null
      try { hash = sha256File(f.abs) } catch { /* 读不到 → 留给正式导入报错 */ }
      const rec = findRecord(ledger, f.key || sourceKey(f.abs), f.rel, hash)
      if (hash && rec && rec.hash === hash && rec.out && existsSync(join(spaceRoot, ...String(rec.out).split('/')))) {
        report.skipped.push({ source: f.rel, out: rec.out, reason: 'unchanged' })
        report.counts.skipped += 1
      } else {
        report.converted.push({ source: f.rel, out: rec?.out || null, action: 'convert' })
        report.counts.converted += 1
      }
    }
    report.counts.failed = report.failed.length
    // "将新建"只在**真有东西要落盘**时才是真的：全批被拒却报"将新建"，与正式运行的"未创建"矛盾
    report.spaceCreated = !existed && report.converted.length > 0
    return report
  }

  let spaceReady = !!existed
  let spaceCreatedNow = false
  let visionUsed = false
  let spaceMetaWritten = !existed ? false : existsSync(join(spaceRoot, '.space.json'))
  /**
   * 空间目录**延迟到真有产物要落盘时**才建（而不是开批就建）：
   * 全批被拒/全部转换失败时不留空空间与空 `.space.json`（见 report.spaceCreated 的 why）。
   * @returns null = 已就绪；否则是错误对象（调用方 push 进 report.failed）
   */
  const ensureSpace = () => {
    if (spaceReady) return null
    try { mkdirSync(spaceRoot, { recursive: true }) } catch (e) {
      return { error: 'space-create-failed', message: `创建空间失败：${e?.message || e}` }
    }
    // 边界自检（与落盘前的逐级校验同一条边界）：`spaces/<id>` 若是指向外部的 junction，
    // 往里写等于把"导入只写 knowledge/spaces/"作废 —— 这里连"建出来"的机会都不给。
    if (!realpathInside(spacesRoot, spaceRoot)) {
      return { error: 'target-escape', message: '空间目录经 realpath 解析落在 knowledge/spaces 之外（是指向别处的链接？）' }
    }
    spaceReady = true
    spaceCreatedNow = true
    return null
  }
  /** `.space.json` 在**第一篇产物落盘后**才写：这是"这个空间有内容"的元数据，先写就成了空空间的招牌 */
  const writeSpaceMeta = () => {
    if (spaceMetaWritten) return
    spaceMetaWritten = true
    try {
      // 显示名只在**缺少** .space.json 时写：已存在的空间可能被用户改过名（手工改过要尊重）
      if (!existsSync(join(spaceRoot, '.space.json'))) {
        atomicWrite(join(spaceRoot, '.space.json'), JSON.stringify({
          name: displayName,
          description: `由文件导入创建（${new Date().toISOString().slice(0, 10)}）`,
          createdAt: now,
        }, null, 2))
      }
    } catch (e) {
      report.warnings.push(`写入 .space.json 失败（不影响导入）：${e?.message || e}`)
    }
  }

  const usedOut = new Set(Object.values(ledger.files).map((r) => r.out).filter(Boolean))
  let ledgerTouched = false      // 旧键迁移也会动台账（见下），不能只看 converted
  // ② 逐文件进度：按下标上报（见函数头注释——按"成功数"计会让进度条永远差一截）。
  // 用下标循环而非 `for…of`，就是为了在不侵入四条 `continue` 分支的前提下拿到进度。
  for (let fi = 0; fi < files.length; fi++) {
    const f = files[fi]
    emitProgress({ phase: 'process', done: fi, total: files.length, current: f.rel })
    let hash = null
    try { hash = sha256File(f.abs) } catch (e) {
      report.failed.push({ source: f.rel, error: 'unreadable', message: `读取失败：${e?.message || e}`, phase: 'collect' })
      continue
    }
    const key = f.key || sourceKey(f.abs)
    const rec = findRecord(ledger, key, f.rel, hash)
    // 命中的是旧台账（键 = rel、无 key 字段）→ 落盘/跳过成功后把它迁到稳定键，避免同一空间里
    // 新旧两种键并存（那样同一文件会有两条记录，下次导入又得靠 hash 兜底）
    const legacyKey = rec && !rec.key && ledger.files[f.rel] === rec ? f.rel : null
    const migrateLegacy = () => {
      if (!legacyKey) return
      delete ledger.files[legacyKey]
      ledger.files[key] = { ...rec, key, rel: f.rel }
      ledgerTouched = true
    }
    // 幂等判定：hash 相同 **且** 产物仍在（产物被手工删掉时必须重转，
    // 否则台账会说"已导入"而文件树上什么都没有——最难排查的一类"文件有/没"分裂）
    if (rec && rec.hash === hash && rec.out) {
      const prevAbs = join(spaceRoot, ...String(rec.out).split('/'))
      if (existsSync(prevAbs)) {
        migrateLegacy()
        report.skipped.push({ source: f.rel, out: rec.out, reason: 'unchanged' })
        report.counts.skipped += 1
        continue
      }
    }
    const outAbs0 = rec?.out ? join(spaceRoot, ...String(rec.out).split('/')) : null
    // 重转（源变了）时沿用台账里的产物名：直接覆盖**我们自己的**产物是正确的就地更新；
    // 只有"台账里没有这个源"才需要让位逻辑（防覆盖用户手工放进空间的文件）。
    const isTaken = (cand) => usedOut.has(cand) || existsSync(join(spaceRoot, ...cand.split('/')))
    const preferred = rec?.out && safeOutRel(rec.out) ? rec.out : outRelFor(f.rel, () => false)
    let outRel = rec?.out && safeOutRel(rec.out) ? rec.out : outRelFor(f.rel, isTaken)
    if (!outRel) {
      report.failed.push({ source: f.rel, error: 'bad-target', message: '目标相对路径非法（源文件名含非法字符？）', phase: 'write' })
      continue
    }
    // **非静默**：首选项名被占（用户的 md，或**另一个源文件**的同名产物）→ 产物换了名字。
    // 报告里必须说清"它为什么不叫 报告.md"，否则用户看到两份同源文档会以为导重了。
    const renamedFrom = !rec?.out && preferred && outRel !== preferred ? preferred : null
    const outAbs = outAbs0 || join(spaceRoot, ...outRel.split('/'))
    if (!rec?.out && existsSync(outAbs)) {
      // 目标已存在但**不是我们的产物**（台账里没有该源）→ 不覆盖用户文件，改名让位
      usedOut.add(outRel)
      outRel = outRelFor(`${f.rel}`, (cand) => usedOut.has(cand) || existsSync(join(spaceRoot, ...cand.split('/'))))
      if (!outRel) {
        report.failed.push({ source: f.rel, error: 'bad-target', message: '目标名冲突且无法让位', phase: 'write' })
        continue
      }
    }
    // 页面图片目录：**每篇一个**临时子目录（视觉模型要读图，图必须落盘）。
    // 由**本函数**创建与清理：解析器只负责往里渲图，不掌握生命周期 ——
    // 否则"导入失败时谁删临时图"就没人负责（这类中间产物泄漏一次就常驻磁盘）。
    let imgDir = null
    if (wantVision) {
      try { imgDir = mkdtempSync(join(tmpdir(), 'yfw-kbimg-')) } catch (e) {
        report.warnings.push(`创建页面图片临时目录失败，本篇跳过视觉表格提取：${e?.message || e}`)
        imgDir = null
      }
    }
    let res
    try {
      res = await conv({ absPath: f.abs, rel: f.rel, limits, pythonPath, pageImagesDir: imgDir })
    } finally {
      // 转换阶段就失败时也没白留目录：finally 覆盖"转换抛错/返回失败"两条路径。
      // （视觉识别在下面成功分支里做，用完同样清理 —— 见 visionSummary 之后的 rmSync。）
      if (imgDir && (!res || res.ok !== true)) safeRmDir(imgDir)
    }
    if (!res || res.ok !== true) {
      report.failed.push({
        source: f.rel, error: res?.error || 'convert-failed',
        message: res?.message || '转换失败', phase: 'convert',
      })
      continue
    }
    const data = res.value
    let visionSummary = null
    if (wantVision && Array.isArray(data.pageImages) && data.pageImages.length) {
      // 视觉通道的告警**单独收集再并回 `data.warnings`**：
      // 直接传 `data.warnings || report.warnings` 会把它们丢在一个空的 `data.warnings` 里
      // （空数组是 truthy），报告里就再也看不到"仅处理前 N 页"这类提示 —— 实测踩到过。
      // 并进 data.warnings 与解析器自身的告警同路渲染（逐文件 warnings → 报告的
      // `converted[].warnings`），用户在"这份文档"下面就能看到，不必去翻整批告警。
      const visionWarnings = []
      try {
        visionSummary = await augmentTablesViaVision({
          data, visionCall, maxPages: limits.maxVisionPages, warnings: visionWarnings,
        })
        if (visionSummary.errors?.length) {
          const first = visionSummary.errors[0]
          report.warnings.push(`视觉表格提取有 ${visionSummary.errors.length} 页失败（首条：第 ${first.page} 页 ${first.message}）`)
        }
      } catch (e) {
        // 视觉是**增益**：它炸了不能让整篇导入失败（正文 OCR 文本已经拿到）。
        visionSummary = { attempted: 0, pages: 0, tables: 0, errors: [{ page: null, message: e?.message || String(e) }], skipped: null }
        report.warnings.push(`视觉表格提取异常（不影响文本导入）：${e?.message || e}`)
      } finally {
        if (visionWarnings.length) {
          if (!Array.isArray(data.warnings)) data.warnings = []
          data.warnings.push(...visionWarnings)
        }
        if (imgDir) safeRmDir(imgDir)
      }
    } else if (imgDir) {
      safeRmDir(imgDir)   // 没有页面图片（如文本类文件）也要清：目录已经建了
    }
    const title = String(data.title || '').trim() || basename(f.rel, extname(f.rel))
    let rendered
    try {
      rendered = renderMarkdown({
        meta: {
          title, source: basename(f.rel), sourcePath: f.rel, sourceHash: hash,
          sourceBytes: f.size, converter: data.converter || 'unknown', convertedAt: now,
        },
        sections: data.sections || [],
        maxDocBytes: limits.maxDocBytes,
      })
    } catch (e) {
      report.failed.push({ source: f.rel, error: 'render-failed', message: `组装 Markdown 失败：${e?.message || e}`, phase: 'write' })
      continue
    }
    const spaceErr = ensureSpace()
    if (spaceErr) {
      report.failed.push({ source: f.rel, ...spaceErr, phase: 'write' })
      continue
    }
    // 落盘前**逐级**建目录 + 逐级 realpath 校验（spec §6）：`safeOutRel` 只挡得住**词法**穿越，
    // 挡不住空间根里指向外部的目录符号链接/junction（Windows 上建 junction 不需要管理员权限）。
    // 顺序铁律：**先校验后建**（`mkdirSync(..., {recursive:true})` 会先长出越界目录树，见 ensureDirsInside）。
    // 越界一律拒——绝不"照写"，那等于把"只写 knowledge/spaces/"这条边界作废。
    const made = ensureDirsInside(spaceRoot, outAbs)
    if (!made.ok) {
      report.failed.push({ source: f.rel, error: made.error, message: made.message, phase: 'write' })
      continue
    }
    try {
      atomicWrite(outAbs, rendered.content)
    } catch (e) {
      report.failed.push({ source: f.rel, error: 'write-failed', message: `写盘失败：${e?.message || e}`, phase: 'write' })
      continue
    }
    usedOut.add(outRel)
    writeSpaceMeta()
    const warns = [...(data.warnings || [])]
    if (rendered.truncated) {
      warns.push(`原文超出单篇上限，已截断为前 ${rendered.sectionsKept}/${rendered.totalSections} 节`)
    }
    if (renamedFrom) {
      warns.push(`目标名「${renamedFrom}」已被占用（空间内已有文件或其他源的产物），本次落为「${outRel}」`)
    }
    ledger.files[key] = {
      key, rel: f.rel, realPath: resolve(f.abs), hash, out: outRel,
      converter: data.converter || 'unknown', sourceBytes: f.size,
      convertedAt: now, truncated: rendered.truncated, warnings: warns,
      // 视觉表格提取的结果也入台账：下次幂等跳过时，报告仍能说清"这份文档的表格是怎么来的"
      // （未配置视觉模型时导入的扫描件，后来配好了模型 —— 用户需要知道要重导才会补上表格）。
      ...(visionSummary ? { vision: { tables: visionSummary.tables, pages: visionSummary.pages } } : {}),
    }
    ledgerTouched = true
    report.converted.push({
      source: f.rel, out: outRel, converter: data.converter || 'unknown',
      bytes: Buffer.byteLength(rendered.content, 'utf-8'),
      truncated: rendered.truncated, warnings: warns,
      ...(visionSummary ? { vision: visionSummary } : {}),
    })
    report.counts.converted += 1
    if (visionSummary) {
      visionUsed = true
      report.vision.pages += visionSummary.pages
      report.vision.tables += visionSummary.tables
    }
  }
  // 视觉表格提取的**整批口径**：没配置时 `configured:false` + `skipped` 原因，
  // GUI 据此提示用户去设置里配视觉模型（而不是让用户对着"扫描件没有表格"猜原因）。
  // 收尾只定稿"用没用过"：`configured` 已在建报告时写入（提前返回的路径也要正确）
  report.vision.used = visionUsed
  report.vision.skipped = visionUsed ? null : visionSkipReason
  if (visionTables === true && !visionConfigured) {
    report.warnings.push('未配置视觉模型：扫描件中的表格不会被提取（仅文本层 PDF 的表格可自动识别）')
  }
  report.counts.failed = report.failed.length
  report.spaceCreated = spaceCreatedNow

  // 台账**只在本次真有产物落盘（或迁移了旧键）时**才重写：全批 skipped 时不写。
  // spec P1-2 要求重复导入"台账与 md 均未被重写"——无条件重写会把 `.import.json` 的 mtime
  // 刷成现在（`updatedAt` 也变），从外部看像"又导了一遍"，而幂等的证明恰恰要靠"它没动"。
  if (report.converted.length || ledgerTouched) {
    try {
      writeLedger(spaceRoot, ledger)
    } catch (e) {
      report.warnings.push(`写入台账失败（下次导入可能重复转换）：${e?.message || e}`)
    }
  }
  if (!report.converted.length) {
    // 一个产物都没落成（整批被拒/全部转换失败）：不留空 `.import.json`（空台账 ≠ 有内容），
    // 也不留空空间目录 —— "无产物"必须在报告与文件树上同时成立。
    report.warnings.push(spaceCreatedNow
      ? '本次没有任何文件成功导入，未创建台账'
      : '本次没有任何文件成功导入：未创建空间目录与台账')
  }
  if (spaceCreatedNow && !report.converted.length) {
    // 兜底：空间目录刚才是我们建的（第一篇产物在走盘阶段失败，如写权限/越界），
    // 但最终没有任何 md 落盘 → 把空目录收回去，保持"无产物 ⇒ 无空间"这条不变量。
    // 只动**本次自建**的空目录：用户已有的空间绝不触碰（spaceCreatedNow 为真即代表它是我们建的）。
    try { rmdirSync(spaceRoot) } catch { /* 非空或占用 → 留着，由上面的 warning 说明 */ }
    if (!existsSync(spaceRoot)) report.spaceCreated = false
  }

  // 索引同步（spec §6：导入后**立即**同步；`updateDoc` 优先，not-found 回落 `load({})`）——
  // 照抄 kernel/memory.mjs 的 `syncKnowledgeIndex` 范式，逐篇按 docId 增量更新。
  //
  // **为什么不能只 load({})**：load 会走 loadIndexFromDisk + indexStale，库里已有几千篇时
  // 是一次整库重建 —— 只想让新导入的几篇可检索，却把全库重算一遍。
  // **为什么不能只 updateDoc**：新文档不在索引里，第一次必然 `not-found`（而"导入新文档"
  // 正是主场景）；此时回落到 load({}) 一次把新文件吸收进来，后续几篇就不必再 load。
  // 结论：能增量就增量，增量的 not-found 只触发**一次**整库 load（不是每篇一次）。
  if (knowledgeIndex && report.converted.length) {
    let updated = 0
    let reloaded = false
    let syncError = null
    for (const c of report.converted) {
      try {
        const r = knowledgeIndex.updateDoc(toDocId(spaceId, c.out))
        if (r?.updated) { updated += 1; continue }
        if (!reloaded) { knowledgeIndex.load({}); reloaded = true }
      } catch (e) { syncError = e?.message || String(e); break }
    }
    if (syncError) {
      report.indexSync = 'failed'
      report.warnings.push(`索引同步失败（下次检索会自动重建）：${syncError}`)
    } else {
      // 增量成功 = 库已就地更新；发生过回落 = 整库 load 过。两者对用户都是"立刻能搜到"，
      // 但留痕不同——排查"为什么这次导入慢"时必须能区分。
      report.indexSync = reloaded ? 'reloaded' : 'incremental'
      report.indexSyncDetail = { updated, reloaded }
    }
  }
  // ③ 终态：`done === total`。消费者据此把进度条收到 100%。
  // 即便中途有文件走 skipped/failed 分支，这里也必定等于计划文件数（分母一致性）。
  emitProgress({ phase: 'done', done: files.length, total: files.length })
  return report
}

/** 供 CLI/工具复用的空间 id 推导（space 优先，其次 name）。 */
export function resolveSpaceId({ space = null, name = null } = {}) {
  return String(space || name || '').trim()
}

/**
 * 报告 → 人/模型可读文本（CLI stdout 与 agent 工具共用一份，避免两处措辞漂移）。
 * 三档必须**分列**而不是只报总数：用户最关心的恰恰是"哪几个没进去、为什么"，
 * 只给 "5/6 成功" 等于让他自己去翻文件树对账。
 */
export function renderImportText(r) {
  if (!r?.ok) return `导入失败（${r?.error || 'unknown'}）：${r?.message || '无原因'}\n`
  const src = Array.isArray(r.source) ? `${r.source.length} 个来源` : r.source
  // 空间状态三态如实反映：新建 / 已存在 / **未创建**（本次没有任何产物落盘，见 report.spaceCreated 的 why）。
  // 把"未创建"说成"已存在"会让用户去文件树里找一个并不存在的空间。
  const spaceState = r.spaceCreated
    ? (r.dryRun ? '将新建' : '新建')
    : (r.spaceExisted === false ? (r.dryRun ? '无需新建' : '未创建') : '已存在')
  const head = r.dryRun
    ? `【导入预览】${src} → 空间「${r.spaceName}」（${spaceState}）——未写任何文件`
    : `【导入完成】${src} → 空间「${r.spaceName}」（${spaceState}）`
  const lines = [head]
  if (Array.isArray(r.source) && r.source.length > 1) {
    for (const s of r.source.slice(0, 10)) lines.push(`  · 来源：${s}`)
    if (r.source.length > 10) lines.push(`  · …另有 ${r.source.length - 10} 个来源`)
  }
  const rej = r.failed.filter((f) => f.phase === 'collect')
  const fail = r.failed.filter((f) => f.phase !== 'collect')
  lines.push(rej.length || fail.length
    ? `处理 ${r.counts.total} 个文件：成功 ${r.counts.converted} / 跳过 ${r.counts.skipped} / 被拒 ${rej.length} / 失败 ${fail.length}`
    : `处理 ${r.counts.total} 个文件：成功 ${r.counts.converted} / 跳过 ${r.counts.skipped}`)
  if (r.converted.length) {
    lines.push(r.dryRun ? '将转换：' : '已转换：')
    for (const c of r.converted) {
      lines.push(`  · ${c.source} → ${c.out || '(自动命名)'}${c.converter ? `（${c.converter}，${c.bytes ?? '?'}B）` : ''}`)
    }
  }
  if (r.skipped.length) {
    lines.push('跳过（未变化，已入库过）：')
    for (const s of r.skipped) lines.push(`  · ${s.source} → ${s.out}`)
  }
  // 「被拒」与「失败」分列（同 `importFiles` 的 rejected/failed 两档）：前者是"这条本来就不该进库"
  // （格式/体积/符号链接），后者是"格式没问题但这份没成功"（加密、解析崩溃、写盘失败）——
  // 用户的下一步动作完全不同（换格式 vs 修文件/重试），混在一栏等于让他自己猜。
  if (rej.length) {
    lines.push('被拒（不符合导入规则）：')
    for (const f of rej) lines.push(`  · ${f.source}：${f.message}（${f.error}）`)
  }
  if (fail.length) {
    lines.push('失败：')
    for (const f of fail) lines.push(`  · ${f.source}：${f.message}（${f.error}）`)
  }
  if (r.warnings?.length) {
    lines.push('提示：')
    for (const w of r.warnings) lines.push(`  · ${w}`)
  }
  // 视觉表格提取的结果/缺失原因（用户视角的事实，不是内部日志）：
  // 读了表格要说清是哪来的（"扫描件还能读出表格"是用户会怀疑的事，必须能追溯）；
  // 没读出来则给出**可执行的下一步**（去配视觉模型 + 重导），而不是让用户对着
  // "扫描件里没表格"自己猜 —— 那正是本次要修的用户体验问题。
  if (r.vision?.tables > 0) {
    lines.push(`已用视觉模型从图片/扫描件中提取 ${r.vision.tables} 个表格（${r.vision.pages} 页）。`)
  } else if (r.vision?.skipped === 'not-configured'
    && (r.converted || []).some((c) => String(c.converter || '').startsWith('pdf-ocr') || c.converter === 'ocr')) {
    lines.push('提示：本次有扫描件/图片，但未配置视觉模型 —— **正文已正常导入，其中的表格没有被提取**。'
      + '如需表格，请在设置里配置视觉模型后重新导入这些文件（文本层 PDF 的表格不受影响，已自动识别）。')
  }
  if (!r.dryRun && r.counts.converted > 0) {
    lines.push(r.indexSync === 'reloaded' || r.indexSync === 'incremental'
      ? '内容已进入索引，可直接用 KnowledgeSearch 检索（或知识面板里打开阅读）。'
      : `注意：索引未同步（${r.indexSync}）——下次检索会自动重建。`)
  }
  return lines.join('\n')
}

/**
 * 错误码别名：`importFiles` 的对外契约码 ↔ 内部码。
 *
 * 为什么要映射而不是把内部码改掉：内部码（`bad-space-id` / `empty-source`）已被 CLI 错误输出
 * 与既有单测引用，改名的收益是零、回归面却很大。对外契约要的是**语义精确的四个码**
 * （spec P3-1：非法 id = 400、只读空间 = 403、源不存在 = 404、空批次 = 400），故只在这一层翻。
 */
const IMPORT_ERROR_ALIASES = {
  'bad-space-id': 'invalid-space-id',
  'empty-source': 'empty-batch',
}

/**
 * `importFiles(opts)` —— 内核导入器的**对外主入口**（T3/T4/T5 依赖的名字与形状，勿改名）。
 *
 * 与 `importDocuments` 的关系：**同一条管线**，只是参数名与报告口径不同。
 * `importDocuments` 是 CLI/agent 工具在用的一份报告（counts/converted/skipped/failed，见
 * kernel/knowledge-cli.mjs、kernel/tools.mjs）；本函数把它翻译成任务契约要求的
 * `results[].status` 四态 + `summary`。白名单/体积/路径防护/台账/落盘/索引同步**全部复用**
 * 上面那份实现（另写一份必然漂移，本项目的反复教训）。
 *
 * @param configDir 配置根
 * @param from      文件或目录（可数组）
 * @param space     空间 id（可写空间；`pack-*` → `readonly-space`）
 * @param name      新建空间的显示名（给了就新建 `knowledge/spaces/<id>/`）
 * @param dryRun    true = 只报告不落盘（results 里的 `imported` 表示"将导入"，未写任何文件）
 * @param maxOcrPages  扫描件 PDF 的 OCR 页数护栏（透传）
 * @param pythonPath   注入 python 解释器（缺省见 resolvePython）
 * @param runDocToMd   注入"文件 → 结构化 JSON"实现：`(filePath, opts) => Promise<{ok, ...}>`。
 *                     返回**扁平**结构即可（与 python 单行 JSON 同形）；内部 `{ok, value}` 形状也收。
 * @param maxFileBytes/maxTotalBytes/maxFiles/maxMdBytes 覆盖默认上限（测试用）
 * @param knowledgeIndex 可选内核 store：传了就在导入后立即同步索引
 * @returns `{ ok:true, space, spaceName, spaceCreated, spaceExisted, dryRun, targetDir, results, summary, indexSync, warnings }`
 *          （`spaceCreated` = **本次真的建了空间**；无任何产物落盘时为 false，见 importDocuments 里 ensureSpace 的 why）
 *          或 `{ ok:false, error, message }`（error ∈ invalid-space-id|readonly-space|not-found|
 *          empty-batch|too-many-files|batch-too-large|bad-config|…）
 */
export async function importFiles({
  configDir, from, space = null, name = null, dryRun = false,
  maxOcrPages = null, pythonPath = null, runDocToMd = null,
  maxFileBytes = null, maxTotalBytes = null, maxFiles = null, maxMdBytes = null,
  knowledgeIndex = null, timeoutMs = null,
  visionTables = 'auto', maxVisionPages = null, visionCall = null, visionAvailable: visionOverride = null,
  onProgress = null,
} = {}) {
  const sources = (Array.isArray(from) ? from : [from])
    .map((s) => String(s ?? '').trim()).filter(Boolean)
  if (!sources.length) {
    return { ok: false, error: 'empty-batch', message: '导入源为空：from 必须给出至少一个文件或目录' }
  }
  const limits = {}
  // ⚠️ `null`/`undefined`/`''` 一律视为"未给"：`Number(null) === 0` 且有限，
  // 若按"能转成数就用"，缺省调用会被算成 `maxFileBytes = 0` → **每个文件都被判超限**，
  // 整批变成 rejected。这类"缺省值被当成合法 0"的坑在体积/页数护栏上最致命（全量误拒）。
  const num = (v) => {
    if (v === null || v === undefined || v === '') return null
    const n = Number(v)
    return Number.isFinite(n) ? Math.floor(n) : null
  }
  if (num(maxFileBytes) !== null) limits.maxFileBytes = num(maxFileBytes)
  if (num(maxTotalBytes) !== null) limits.maxBatchBytes = num(maxTotalBytes)
  if (num(maxFiles) !== null) limits.maxBatchFiles = num(maxFiles)
  if (num(maxMdBytes) !== null) limits.maxDocBytes = num(maxMdBytes)
  if (num(maxOcrPages) !== null && num(maxOcrPages) > 0) limits.maxOcrPages = num(maxOcrPages)
  // 视觉页数上限：允许 0（= 显式"一页都不交给视觉模型"，此时正文仍走 OCR）。
  // 用 `>= 0` 而不是 `> 0`：0 是**有意义的**取值（用户想彻底关掉视觉但保留参数形状），
  // 而 `> 0` 会把 0 当成"没给"，静默回落 20 —— 那正是用户明确不想发生的事。
  if (num(maxVisionPages) !== null && num(maxVisionPages) >= 0) limits.maxVisionPages = num(maxVisionPages)

  // 注入点归一：契约是 `(filePath, opts) => {ok, ...}`，内部是 `(o) => {ok, value}`。
  // 两种形状都收（`res.value ?? res`），这样测试 mock 可以直接照 python 的单行 JSON 写。
  const converter = typeof runDocToMd === 'function'
    ? (async (o) => {
      const res = await runDocToMd(o.absPath, { ...o, pythonPath: pythonPath || null })
      return res && res.ok === true && res.value === undefined ? { ok: true, value: res } : res
    })
    : (o) => defaultConverter({
      ...o, pythonPath: pythonPath || null,
      ...(num(timeoutMs) !== null && num(timeoutMs) > 0 ? { timeoutMs: num(timeoutMs) } : {}),
    })

  const report = await importDocuments({
    configDir,
    from: sources.length === 1 ? sources[0] : sources,
    space, name, dryRun, converter, knowledgeIndex,
    limits: Object.keys(limits).length ? limits : null,
    visionTables, visionCall, visionAvailable: visionOverride,
    onProgress,
  })
  if (!report.ok) {
    return {
      ok: false,
      error: IMPORT_ERROR_ALIASES[report.error] || report.error,
      message: report.message,
    }
  }

  // 四态（顺序固定 = 已导入 → 跳过 → 被拒 → 失败）：`rejected` 与 `failed` 必须分开，
  // 前者是"这条**本来就不该**进库"（格式/体积/符号链接），后者是"该进库但**没成功**"
  // （加密 PDF、解析崩溃、写盘失败）。混成一档，用户无法判断"要不要去换格式重试"。
  const results = []
  for (const c of report.converted) {
    results.push({
      source: c.source, rel: c.source, status: 'imported',
      mdRel: c.out ?? null, bytes: c.bytes ?? null, converter: c.converter ?? null,
      truncated: !!c.truncated, warnings: c.warnings || [],
      // 视觉表格提取的逐文件结果（GUI/agent 据此知道"这份扫描件的表格读出来了没"）
      ...(c.vision ? { vision: c.vision } : {}),
    })
  }
  for (const s of report.skipped) {
    results.push({
      source: s.source, rel: s.source, status: 'skipped',
      reason: s.reason || 'unchanged', mdRel: s.out ?? null,
    })
  }
  for (const f of report.failed) {
    results.push({
      source: f.source, rel: f.source,
      status: f.phase === 'collect' ? 'rejected' : 'failed',
      reason: f.error, message: f.message,
    })
  }
  const summary = {
    total: results.length,
    imported: report.converted.length,
    skipped: report.skipped.length,
    rejected: results.filter((x) => x.status === 'rejected').length,
    failed: results.filter((x) => x.status === 'failed').length,
  }
  return {
    ok: true,
    space: report.spaceId,
    spaceName: report.spaceName,
    spaceCreated: report.spaceCreated,
    spaceExisted: report.spaceExisted,
    dryRun: report.dryRun,
    // dryRun 下这不是"已生成的目录"，而是"将写入的位置"（未 mkdir，见 importDocuments 的 dry-run 分支）
    targetDir: report.spaceRoot,
    results, summary,
    indexSync: report.indexSync,
    ...(report.indexSyncDetail ? { indexSyncDetail: report.indexSyncDetail } : {}),
    // 视觉表格提取的整批口径（configured/skipped/pages/tables）：GUI 靠它提示
    // "要不要去配视觉模型"，agent 靠它判断"扫描件的表格有没有读出来"。
    vision: report.vision,
    warnings: report.warnings || [],
  }
}
