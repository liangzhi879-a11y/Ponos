// kit/lib/contract-ws.mjs —— WebSocket 事件提取器（DevKit P1 · T2）
//
// 设计不变量（每条都由 kit/lib/contract-ws.test.mjs 的断言钉住）：
//   I1 **裸抓 `type:` 必错**（D6）：`type:'user'`（内核 stdin）、`type:'mouseMoved'`（CDP）、
//      `event.data.type='system'`（嵌套）都不是 GUI 事件 ⇒ **出站集合只认发送函数白名单**：
//        · `send(msg)`      —— 桥 → 全部 GUI（真形态 `bridge.mjs` 的 `send()`）
//        · `broadcastGui()` —— 同上（真形态 `bridge.mjs:994`）
//        · `sendToThis()`   —— 连接建立后重放未决帧时对**单个**客户端直发（`bridge.mjs:3349`）
//        · `ws.send()`      —— 直发（真形态 `bridge.mjs:3341` 的 `bridge_hello`、`:3695` 的 `pong`）
//   I2 入站集合只认桥的 `ws.on('message')` 处理器里的 `msg.type === '…'` 比较。
//      **方向不能反**：`msg.type === 'milestones'` 在 `isLowPriorityMessage()`（出站判定）里
//      也出现，那不是入站消息（契约表说反话比漏一条更贵）。
//   I3 嵌套 / 子层：`{type:'event', data:{type:'system', subtype:'first_byte_pending'}}` 里
//      `system` 在第二层、`first_byte_pending` 是 `subtype` ⇒ 两者都**不进顶层集合**，
//      但都要在 `excluded` 里逐条留下（"提取不到 ≠ 不存在"）。
//   I4 **提取守恒**：`rawTypeCount`（扫描域内 `type:`/`subtype:` 字面量总出现数）
//      = 归因到 white-list sink 的出现数 + `excluded.length`。域内每条字面量都有归宿。
//   I5 扫描域 = `server/**`（桥与它的路由/宿主模块）+ `electron/browser-executor.cjs`
//      （主进程执行器协议：`cdp.sendCommand({type:'mouseMoved'})` 这类必须显式排除）。
//      域内**反向方向**的脚本（`server/interject.e2e.mjs` 是手工 WS 客户端，它的 `ws.send`
//      是"发给桥"）按文件角色排除，理由写在 `excluded` 里而不是悄悄跳过。
//
// ★ **出站出现数（`outOccurrences`）的口径 —— 38/39 别绕进去**（真仓实测，两棵树同值）：
//   · **修前真值 = 38**：别名 sink（`for (const c of clients) c.send(msg)` + `const msg =
//     JSON.stringify({type:'browser:event'…})`，真形态 `server/browser-routing.mjs:46-47`）**没被识别**，
//     故 `browser:event` 既不在 out、也不在 excluded。
//   · **返工后（`9c8cc3f`）现值 = 39**：别名 sink 认领 `browser:event` ⇒ 它归 `out`，出现数 +1。
//   · 提交 `9c8cc3f` 的信息里写着"报告里的 **39** 更正为 **38**" —— 这句**口径倒挂**（把返工**前**的
//     真值当成了报告的错误值）。事实是：修订前的报告写 39 是**误记**（当时真值就是 38），
//     而**返工后的现值正是 39**（38 + 别名 sink 认领的 1 条）。该提交信息不改（历史如实留痕），
//     但**以本注释为准**：读 39 时问一句"这是哪一版的口径"。
//   · 同一批：域内 `(sub)type:` 字面量独立重数 = **117**（= 101 顶层 + 16 `subtype:`），
//     其中 `outOccurrences + excluded.length == 117`（守恒，见 I4）。
import { stripComments } from './scan.mjs'

/** 换行符常量（源码里写裸转义会被编辑链吃掉，这里显式构造） */
const NL = String.fromCharCode(10)

/** 发送函数白名单 → 角色（只有 `out` 才进 GUI 出站集合；其余进 excluded）。
 *  ★ 每个模式都要挡住"被别的前缀调用"：`executor.send(` 里也有 `send(`，
 *  用 `B`（负向后顾）而不是 `\b` —— `\b` 在 `.` 与 `s` 之间**成立**，
 *  实测那会把执行器私有消息 `app:exec` 同时算进 GUI 出站集合（双重归因，守恒数也多算）。
 *  ★ `stdin.write` 必须**吃下接收者前缀**（`s.proc.stdin.write(`）：写成裸 `stdin\.write\(` 时
 *  后顾 `(?<![\w.])` 会被 `.proc.` 的句点挡掉 ⇒ 这些 `type:` 全落进"无证据"区
 *  （真形态 `bridge.mjs:622/3475/3521`、`workflow-host.mjs:129/331`）。 */
const SINKS = [
  { re: /(?<![\w.])executor\s*\.\s*send\s*\(/, role: 'executor-protocol' },
  { re: /(?<![\w.])cdp\s*\.\s*sendCommand\s*\(/, role: 'executor-protocol' },
  { re: /(?<![\w$])(?:[\w$]+\.)*stdin\s*\.\s*write\s*\(/, role: 'kernel-stdin' },
  { re: /(?<![\w.])writeKernel\s*\(/, role: 'kernel-stdin' },
  { re: /(?<![\w.])(?:send|broadcastGui|sendToThis)\s*\(/, role: 'out' },
  { re: /(?<![\w.])(?:ws|socket)\s*\.\s*send\s*\(/, role: 'out' },
]

/** 文件角色：覆盖 sink 语义（方向相反 / 别的协议栈） */
const FILE_ROLES = [
  { match: (f) => f.endsWith('.e2e.mjs'), role: 'client-harness', why: '手工 WS 客户端脚本：它的 ws.send 是"发给桥"的入站方向，不是桥的广播' },
  { match: (f) => f === 'electron/browser-executor.cjs', role: 'executor-protocol', why: '主进程浏览器执行器：CDP 与执行器私有协议，不经 GUI' },
]

/** 扫描域（`server/**` + 执行器协议文件） */
export function inWsDomain(file) {
  return file.startsWith('server/') || file === 'electron/browser-executor.cjs'
}

const REASON = {
  'kernel-stdin': 'kernel-stdin：写内核 stdin 的消息类型（§3 协议），不是 GUI 出站事件',
  'executor-protocol': 'executor-protocol：桥↔主进程执行器 / CDP 私有协议，不经 GUI',
  'client-harness': 'client-harness：反向方向的客户端脚本（它发给桥，不是桥发给它）',
  nested: 'nested：位于消息对象的第二层（如 event.data.type），不是顶层 WS 类型',
  'nested-subtype': 'nested-subtype：subtype 是消息的子层标识（如 system/subtype=first_byte_pending），不是顶层 WS 类型',
  'subtype-elsewhere': 'subtype-elsewhere：sink 之外的 subtype 字面量（消息子命令/子层标识，真形态 workflow-host/workflow-routes 的 host 请求），不是顶层 WS 类型',
  'entry-kind': 'entry-kind：目录/文件条目 kind（/list-dir、/drives 的 entries[].type），不是消息类型',
  'json-schema': 'json-schema：JSON Schema 的 type 字段（input_schema.type），不是消息类型',
  'packager-manifest': 'packager-manifest：打包清单的条目 kind（skipped[].type），不是 GUI 消息类型',
}

/** 该文件在域内应被当作哪种角色（null = 按 sink 判定） */
function fileRoleOf(file) {
  const hit = FILE_ROLES.find((r) => r.match(file))
  return hit ? { role: hit.role, why: hit.why } : null
}

/** 括号配对：从 `(` 的位置取到配对的 `)`（含内部的字符串跳过） */
function argTextOf(code, openIdx) {
  let depth = 0
  let i = openIdx
  while (i < code.length) {
    const c = code[i]
    if (c === '"' || c === "'" || c === '`') {
      i++
      while (i < code.length && code[i] !== c) {
        if (code[i] === '\\') i++
        i++
      }
    } else if (c === '(') depth++
    else if (c === ')') {
      depth--
      if (depth === 0) return code.slice(openIdx + 1, i)
    }
    i++
  }
  return code.slice(openIdx + 1)
}

/** 行号定位（同 contract-routes：逐行偏移 + 二分） */
function lineMap(code) {
  const starts = [0]
  for (let i = code.indexOf('\n'); i !== -1; i = code.indexOf('\n', i + 1)) starts.push(i + 1)
  return starts
}
function lineAt(starts, idx) {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= idx) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

/** 在一段文本里按**花括号深度**收集 `type:` / `subtype:` 字面量（跳过字符串里的花括号） */
function typeFieldsIn(text) {
  const out = []
  let depth = 0
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === '"' || c === "'" || c === '`') {
      i++
      while (i < text.length && text[i] !== c) {
        if (text[i] === '\\') i++
        i++
      }
      i++
      continue
    }
    if (c === '{') { depth++; i++; continue }
    if (c === '}') { depth--; i++; continue }
    const m = /^(sub)?type\s*:\s*'([^']*)'/.exec(text.slice(i, i + 64))
    if (m) {
      out.push({ literal: m[2], nested: depth > 1, subtype: m[1] === 'sub', at: i + (m[0].indexOf("'") + 1) })
      i += m[0].length
      continue
    }
    i++
  }
  return out
}

/** 桥的 `ws.on('message')` 处理器区间（返回 [start, end) 或 null） */
function messageHandlerRange(code) {
  const m = /(?:ws|socket)\s*\.\s*on\(\s*['"]message['"]/.exec(code)
  if (!m) return null
  const open = code.indexOf('(', m.index)
  let depth = 0
  for (let i = open; i < code.length; i++) {
    const c = code[i]
    if (c === '"' || c === "'" || c === '`') {
      i++
      while (i < code.length && code[i] !== c) {
        if (code[i] === '\\') i++
        i++
      }
      continue
    }
    if (c === '(') depth++
    else if (c === ')') {
      depth--
      if (depth === 0) return [open, i]
    }
  }
  return [open, code.length]
}

/** 括号/花括号配对：返回右配对符的下标（找不到返回 -1）。字符串内的括号跳过。 */
function pairEnd(code, openIdx) {
  const open = code[openIdx]
  const close = open === '(' ? ')' : '}'
  let depth = 0
  for (let i = openIdx; i < code.length; i++) {
    const c = code[i]
    if (c === '"' || c === "'" || c === '`') {
      i++
      while (i < code.length && code[i] !== c) {
        if (code[i] === '\\') i++
        i++
      }
      continue
    }
    if (c === open) depth++
    else if (c === close) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** `<decl> IDENT = { … }` 里对象字面量的起点（允许 `= JSON.stringify({ … })` 这层包装）。
 *  ★ 必须**跳过非对象右值**：真形态 `server/bridge.mjs:3604` 有 `let response = \`用户回答：…\``
 *  （模板串），若只用"`=` 后面第一个 `{`"会取到一个跨越几百行的假跨度（实测踩到）。 */
function objectStartAfterAssign(code, eqIdx) {
  let i = eqIdx
  while (i < code.length && /\s/.test(code[i])) i++
  const call = /^[A-Za-z_$][\w$.]*\s*\(/.exec(code.slice(i, i + 48))
  if (call) {
    i += call[0].length
    while (i < code.length && /\s/.test(code[i])) i++
  }
  return code[i] === '{' ? i : -1
}

/** sink 参数里的标识符 → 它在**同一文件里最近一次**赋值给对象字面量的跨度。
 *  真形态：`const msg = JSON.stringify({ type: 'browser:event', … })` + `c.send(msg)`
 *  （`browser-routing.mjs:46-47`）、`const response = { type: 'control_response', … }` +
 *  `session.proc.stdin.write(JSON.stringify(response) + '\n')`（`bridge.mjs:3660-3675`）。
 *  ★ 不回溯就漏字面量；但回溯必须有据：只认"本文件内、在调用点**之前**的 `<decl> = { … }`"，
 *  且右值确实是对象字面量（`objectStartAfterAssign` 把关）。 */
function varObjects(code, argText, beforeIdx) {
  const spans = []
  for (const m of argText.matchAll(/(?<![\w.$])([A-Za-z_$][\w$]*)\s*(?![(\w$])/g)) {
    const name = m[1]
    if (name === 'true' || name === 'false' || name === 'null' || name === 'undefined') continue
    const declRe = new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=`, 'g')
    let best = -1
    let d
    while ((d = declRe.exec(code))) {
      if (d.index >= beforeIdx) break
      const open = objectStartAfterAssign(code, d.index + d[0].length)
      if (open !== -1) best = open
    }
    if (best === -1) continue
    const end = pairEnd(code, best)
    if (end === -1) continue
    spans.push([best, end + 1])
  }
  return spans
}

/** 迭代**客户端集合**得到的循环变量（`for (const c of clients)`）→ 集合名。
 *  真形态 `server/bridge.mjs:996`（`for (const c of wsClients) c.send(s)`）与
 *  `server/browser-routing.mjs:47`（`for (const c of clients) c.send(msg)`：`clients` 的注释即"GUI 广播目标"）。
 *  ★ 集合名必须命中客户端集合词，**不能**把任意 `for…of` 变量都当广播目标（否则别的协议栈
 *  一发 `x.send(...)` 就污染 GUI 出站集合）。 */
const CLIENT_COLLECTION = /(?:clients|sockets|subscribers|peers|conns|connections)/i
function loopAliases(code) {
  const out = new Map()
  for (const m of code.matchAll(/\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s+of\s+([A-Za-z_$][\w$]*)\s*\)/g)) {
    if (CLIENT_COLLECTION.test(m[2])) out.set(m[1], m[2])
  }
  return out
}

/** 一个文件里的全部 sink 命中点（白名单 + 别名形态） */
function sinkMatches(code) {
  const hits = []
  for (const sink of SINKS) {
    const re = new RegExp(sink.re.source, 'g')
    let m
    while ((m = re.exec(code))) hits.push({ index: m.index, role: sink.role, alias: null })
  }
  for (const [loopVar, coll] of loopAliases(code)) {
    const re = new RegExp(`(?<![\\w.$])${loopVar}\\s*\\.\\s*send\\s*\\(`, 'g')
    let m
    while ((m = re.exec(code))) hits.push({ index: m.index, role: 'out', alias: `${loopVar} of ${coll}` })
  }
  return hits
}

/** 该字面量所在的**对象字面量文本**（最近的一个未闭合 `{` 起到配对 `}`）——
 *  用于"同一对象内的兄弟键"这类证据（`{ name, path, type: 'directory' }`、
 *  `input_schema: { type: 'object', properties: {} }`、`{ type: 'personal', reason: … }`）。 */
function enclosingObject(code, idx) {
  const open = code.lastIndexOf('{', idx)
  if (open === -1) return ''
  const end = pairEnd(code, open)
  return code.slice(open, end === -1 ? code.length : end + 1)
}

/**
 * sink 之外的字面量的**有据**分类。**返回 null = 一条证据都不成立** ⇒ 该字面量没有归宿
 * （调用方必须把它记进 `unattributed` 并让守恒断言红），**绝不许**兜底成"其余全部"。
 * 证据逐条来自真形态，且都能在真仓里指到出处：
 *   ① 文件角色（`interject.e2e.mjs` 反向客户端 / `browser-executor.cjs` 执行器协议）
 *   ② sink 外 subtype → 子命令/子层标识（`workflow-host.mjs:192`、`workflow-routes.mjs:125`）
 *   ③ 内核 stdin 上下文（`stdin.write(` / `message: { …` 形态：`health-anchor.mjs:25`、`loop-translate.mjs:24`）
 *   ④ JSON Schema 的 `type`（`provider-probe.mjs:186` 的 `input_schema.type`）
 *   ⑤ 条目 kind（`files-routes.mjs:61/63`、`host-routes.mjs:223` 的对象含 `name`/`path` 兄弟键）
 *   ⑥ 打包清单条目 kind（`packager.mjs:135/160/167/185/196/221` 的对象含 `reason` 兄弟键）
 */
function classifyExternal({ code, idx, subtype, file, role }) {
  if (role) return { key: role.role, reason: `${role.role}：${role.why}` }
  if (subtype) return { key: 'subtype-elsewhere', reason: REASON['subtype-elsewhere'] }
  const before = code.slice(Math.max(0, idx - 160), idx)
  if (/stdin\.write\(|writeKernel\(/.test(before) || /message\s*:\s*\{[^}]*$/.test(before)) {
    return { key: 'kernel-stdin', reason: REASON['kernel-stdin'] }
  }
  const obj = enclosingObject(code, idx)
  // 内核 stdin 消息的**形状**（§3 协议）：`{type:'user', message:{role:…}}` /
  // `{type:'loop_command', op:…, args:…}` —— 真形态 `server/loop-translate.mjs:24/27`
  // （`translateLoopSend()` 的返回值就是内核 stdin 帧，发送点在 bridge 的 `stdin.write`）
  if (/[{,]\s*(?:op|args)\s*[:,]|\bmessage\s*:\s*\{\s*role\s*:/.test(obj)) {
    return { key: 'kernel-stdin', reason: REASON['kernel-stdin'] }
  }
  if (/(?:^|[\s,{])(?:input_schema|json_schema|schema)\s*[:,]|\bproperties\s*:/.test(obj)) {
    return { key: 'json-schema', reason: REASON['json-schema'] }
  }
  if (/(?:^|[\s,{])(?:name|path)\s*[:,]/.test(obj)) {
    return { key: 'entry-kind', reason: REASON['entry-kind'] }
  }
  if (/(?:^|[\s,{])(?:reason|skipped)\s*[:,]/.test(obj)) {
    return { key: 'packager-manifest', reason: REASON['packager-manifest'] }
  }
  return null
}

/**
 * **独立重数**：域内 `type:` / `subtype:` 字面量的总出现数。
 * ★ 与归因（`extractWs` 里的花括号深度扫描）**刻意走两条不同的代码路径**：这里重新读一遍
 * 文件、用正则扫 raw 文本、自己的注释行过滤。理由是可证伪性：若分母与"命中+排除"在同一遍
 * 循环里累加，守恒等式 `raw = 命中 + 排除` **恒成立、永不红**（审查 M3 用一条
 * `{type:'zzz-typo-probe'}` 坐实过）。两条独立路径 ⇒ 任何一条没归宿的字面量都会让等式崩。
 */
export function countTypeLiterals(files = [], readTracked) {
  let n = 0
  for (const file of files) {
    if (!inWsDomain(file)) continue
    const text = readTracked(file)
    if (typeof text !== 'string') continue
    for (const line of text.split(NL)) {
      if (/^\s*(?:\/\/|\/\*|\*)/.test(line)) continue      // 注释行不是代码（与提取器同一口径）
      n += (line.match(/(?:^|[^\w.$])(?:sub)?type\s*:\s*'/g) || []).length
    }
  }
  return n
}

/**
 * 提取 WS 出/入站事件类型。
 * @param {{files?: string[], readTracked?: (file: string) => (string|null)}} p
 * @returns {{out: Set<string>, in: Set<string>, excluded: Array<{literal:string,reason:string,file:string,line:number}>,
 *            rawTypeCount: number, outOccurrences: number,
 *            unattributed: Array<{literal:string,file:string,line:number}>}}
 *   `rawTypeCount` = **独立重数**（`countTypeLiterals`，不依赖归因那一遍的产物）；
 *   `outOccurrences` = 归因到 out sink 的**出现数**（与 `out.size` 不同：同一类型可多次发出）；
 *   `unattributed` = 一条规则都没认领的字面量（**必须为 0**：守恒断言 `rawTypeCount === outOccurrences + excluded.length` 就是钉它）。
 */
export function extractWs({ files = [], readTracked } = {}) {
  if (!Array.isArray(files)) throw new Error('extractWs: files 必须是数组（来自 scan.mjs#trackedFiles）')
  if (typeof readTracked !== 'function') throw new Error('extractWs: readTracked(file) 必须注入')

  const out = new Set()
  const inSet = new Set()
  const excluded = []
  const unattributed = []
  let outOccurrences = 0

  for (const file of files) {
    if (!inWsDomain(file)) continue
    const text = readTracked(file)
    if (typeof text !== 'string') continue
    const code = stripComments(text)
    const starts = lineMap(code)
    const role = fileRoleOf(file)
    // 第二道注释过滤：stripComments **不认正则字面量**（`/'/` 会开一个伪字符串），
    // 击穿后注释会整段留在代码视图里（真形态 server/bridge.mjs:1716）⇒ raw 行判一次。
    const rawLines = text.split(NL)
    const isComment = (line) => /^\s*(?:\/\/|\/\*|\*)/.test(rawLines[line - 1] || '')

    // ① 入站：桥的 ws.on('message') 处理器里的 msg.type 比较
    const range = messageHandlerRange(code)
    if (range) {
      const seg = code.slice(range[0], range[1])
      for (const m of seg.matchAll(/\bmsg\s*\.\s*type\s*(?:===|==)\s*'([^']+)'/g)) inSet.add(m[1])
    }

    // ② sink 调用点 → 出现级归因（含嵌套/子层、**别名 sink**、**变量回溯**）。
    //   ★ 同一个字面量位置只归因一次（两条 sink 命中同一处时，旧写法会数两遍 —— 守恒数虚高）。
    const covered = []
    const at = new Map()          // 绝对位置 → 归因结果
    const addFields = (text, base, sink) => {
      for (const f of typeFieldsIn(text)) {
        const pos = base + f.at
        const fileLine = lineAt(starts, pos)
        if (isComment(fileLine)) continue      // 注释行上的 type: 不是字面量（也不计入守恒）
        at.set(pos, {
          literal: f.literal,
          effRole: f.subtype ? 'nested-subtype' : f.nested ? 'nested' : (role ? role.role : sink.role),
          fileLine,
        })
      }
    }
    for (const sink of sinkMatches(code)) {
      const open = code.indexOf('(', sink.index)
      const arg = argTextOf(code, open)
      const argStart = open + 1
      covered.push([argStart, argStart + arg.length])
      addFields(arg, argStart, sink)
      // 变量回溯：`c.send(msg)` / `stdin.write(JSON.stringify(response) + '\n')`
      for (const [vs, ve] of varObjects(code, arg, sink.index)) {
        covered.push([vs, ve])
        addFields(code.slice(vs, ve), vs, sink)
      }
    }
    for (const a of at.values()) {
      if (a.effRole === 'out') { if (a.literal) out.add(a.literal); outOccurrences++ }
      else {
        // ★ **不许兜底**（plan §7 反例 ⑥：`excluded` 不得含兜底语义）：
        //   旧写法 `REASON[a.effRole] || REASON['non-message']` 把"没分类的角色"悄悄倒进
        //   `non-message` 兜底桶 —— 该桶当前**不可达**（`effRole` 取自 REASON/role 的有限集合），
        //   于是那行成了死码：它既没有被覆盖，又给后来者留了"随便加个角色也有人接住"的错觉。
        //   现改为：查不到有据分类即**抛错**（这是编程错误：新增 sink / 新角色时必须同时补 REASON）。
        const why = role && a.effRole === role.role ? `${a.effRole}：${role.why}` : REASON[a.effRole]
        if (!why) {
          throw new Error(`extractWs: 未知归因角色 '${a.effRole}'（${file}:${a.fileLine}）`
            + ' —— 新形态必须在 REASON 里补一条有据分类，不许兜底成"其余全部"')
        }
        excluded.push({ literal: a.literal, reason: why, file, line: a.fileLine })
      }
    }

    // ③ sink 之外的 `(sub)type:` 字面量（消息对象在辅助函数/变量里构造、条目 kind 等）。
    //   ★ **没有兜底桶**：证据规则全不成立 ⇒ 进 `unattributed`（= 提取器漏了一类形态），
    //   守恒断言 `rawTypeCount === outOccurrences + excluded.length` 随之为红。
    const inCovered = (idx) => covered.some(([a, b]) => idx >= a && idx < b)
    for (const m of code.matchAll(/(?:^|[^\w.])(sub)?type\s*:\s*'([^']*)'/g)) {
      const idx = m.index + (m[0].length - m[0].trimStart().length)
      if (inCovered(idx)) continue
      const fileLine = lineAt(starts, idx)
      if (isComment(fileLine)) continue
      // ★ `subtype:` 也一样要有归宿（真形态 `server/workflow-host.mjs:192`、
      //   `server/workflow-routes.mjs:125`）：旧写法 `if (m[1]) continue` 把它们整个丢掉 ⇒
      //   rawTypeCount 少算 6 条（域内 117 vs 报告 111），"每条字面量都有归宿"实质缺 6 条。
      const cls = classifyExternal({ code, idx, subtype: Boolean(m[1]), file, role })
      if (cls) excluded.push({ literal: m[2], reason: cls.reason, file, line: fileLine })
      else unattributed.push({ literal: m[2], file, line: fileLine })
    }
  }

  excluded.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1))
  // ★ 分母由**独立一遍**给出（不是归因那一遍的副产品）—— 守恒等式因此可证伪
  const rawTypeCount = countTypeLiterals(files, readTracked)
  return { out, in: inSet, excluded, rawTypeCount, outOccurrences, unattributed }
}
