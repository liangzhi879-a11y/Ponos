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
import { stripComments } from './scan.mjs'

/** 发送函数白名单 → 角色（只有 `out` 才进 GUI 出站集合；其余进 excluded）。
 *  ★ 每个模式都要挡住"被别的前缀调用"：`executor.send(` 里也有 `send(`，
 *  用 `B`（负向后顾）而不是 `\b` —— `\b` 在 `.` 与 `s` 之间**成立**，
 *  实测那会把执行器私有消息 `app:exec` 同时算进 GUI 出站集合（双重归因，守恒数也多算）。 */
const SINKS = [
  { re: /(?<![\w.])executor\s*\.\s*send\s*\(/, role: 'executor-protocol' },
  { re: /(?<![\w.])cdp\s*\.\s*sendCommand\s*\(/, role: 'executor-protocol' },
  { re: /(?<![\w.])(?:stdin\.write|writeKernel)\s*\(/, role: 'kernel-stdin' },
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
  'non-message': 'non-message：非消息通道的 type 字面量（文件/条目/内容 kind 等），上下文见文件行',
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

/**
 * 提取 WS 出/入站事件类型。
 * @param {{files?: string[], readTracked?: (file: string) => (string|null)}} p
 * @returns {{out: Set<string>, in: Set<string>, excluded: Array<{literal:string,reason:string,file:string,line:number}>,
 *            rawTypeCount: number}}
 */
export function extractWs({ files = [], readTracked } = {}) {
  if (!Array.isArray(files)) throw new Error('extractWs: files 必须是数组（来自 scan.mjs#trackedFiles）')
  if (typeof readTracked !== 'function') throw new Error('extractWs: readTracked(file) 必须注入')

  const out = new Set()
  const inSet = new Set()
  const excluded = []
  let rawTypeCount = 0

  for (const file of files) {
    if (!inWsDomain(file)) continue
    const text = readTracked(file)
    if (typeof text !== 'string') continue
    const code = stripComments(text)
    const starts = lineMap(code)
    const role = fileRoleOf(file)

    // ① 入站：桥的 ws.on('message') 处理器里的 msg.type 比较
    const range = messageHandlerRange(code)
    if (range) {
      const seg = code.slice(range[0], range[1])
      for (const m of seg.matchAll(/\bmsg\s*\.\s*type\s*(?:===|==)\s*'([^']+)'/g)) inSet.add(m[1])
    }

    // ② sink 调用点 → 出现级归因（含嵌套/子层）
    const covered = []
    for (const sink of SINKS) {
      const re = new RegExp(sink.re.source, 'g')
      let m
      while ((m = re.exec(code))) {
        const open = code.indexOf('(', m.index)
        const arg = argTextOf(code, open)
        const argStart = open + 1
        covered.push([argStart, argStart + arg.length])
        for (const f of typeFieldsIn(arg)) {
          const fileLine = lineAt(starts, argStart + f.at)
          rawTypeCount++
          const effRole = f.subtype ? 'nested-subtype' : f.nested ? 'nested' : (role ? role.role : sink.role)
          if (effRole === 'out') {
            if (f.literal) out.add(f.literal)
          } else {
            excluded.push({
              literal: f.literal,
              reason: role && effRole === role.role ? `${effRole}：${role.why}` : REASON[effRole] || REASON['non-message'],
              file,
              line: fileLine,
            })
          }
        }
      }
    }

    // ③ sink 之外的 `type:` 字面量（消息对象在辅助函数里构造 / 条目 kind 等）
    const inCovered = (idx) => covered.some(([a, b]) => idx >= a && idx < b)
    for (const m of code.matchAll(/(?:^|[^\w.])(sub)?type\s*:\s*'([^']*)'/g)) {
      const idx = m.index + (m[0].length - m[0].trimStart().length)
      if (inCovered(idx)) continue
      if (m[1]) continue          // `subtype:` 只可能在消息对象里，上面 ② 已覆盖 sink 内的；sink 外的 subtype 不是 WS 类型
      rawTypeCount++
      const head = code.slice(Math.max(0, idx - 160), idx)
      const effRole = role
        ? role.role
        : /stdin\.write\(|writeKernel\(|message\s*:\s*\{[^}]*$/s.test(head) ? 'kernel-stdin' : 'non-message'
      excluded.push({
        literal: m[2],
        reason: role && effRole === role.role ? `${effRole}：${role.why}` : REASON[effRole],
        file,
        line: lineAt(starts, idx),
      })
    }
  }

  excluded.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1))
  return { out, in: inSet, excluded, rawTypeCount }
}
