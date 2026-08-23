// 任务 base 提交的历史内核兼容补丁（仅 ponos 运行前应用）
// ---------------------------------------------------------------------------
// 评测机（Node 24 + DeepSeek Anthropic 端点）上，历史 base 内核有五类运行障碍，
// 均在环境层修复、不改变任务目标缺陷，补丁文件由 result.basePatched 记录；
// 纯环境修复层（engine.mjs / permissions.mjs）从 agent 改动统计中排除，
// api.mjs 虽也打补丁但可能是任务合法目标（T001/T003 均改它），故计入改动：
//
// 1) 工具透传缺失（65fc730 / 7b4d9f1，ee47098 修复）：engine 调 streamMessages
//    漏传 tools → 请求无工具定义 → 模型退化为 XML 文本工具调用。
// 2) 并行工具调用排序违规（全部 base）：内核把每个 tool_result 单独成 user 消息，
//    DeepSeek 端点严格校验 "tool_use 后所有 tool_result 必须紧跟同一 user 消息"；
//    通过 disable_parallel_tool_use 强制单工具回合规避（端点实测遵守）。
// 3) thinking 回传缺失（全部 base）：模型输出 thinking 块后内核不回传给 API，
//    DeepSeek 端点要求 "thinking mode 的 thinking 必须回传"；补累积回传。
// 4) 工具循环上限过低（全部 base）：MAX_TOOL_ITERATIONS=10 远低于真实多步任务
//    （探查→修复→测试需 20+ 次工具调用），模型常在探索中被打断、无法产出最终
//    文本答复；提升至 50（claude/pi/deepseek 无此上限，横向对比才公平）。
// 5) 高危 Bash 命令无头挂死（全部 base）：--dangerously-skip-permissions 只放行
//    低危命令，rm -f 等高危仍发 can_use_tool 挂起等 GUI 审批——无头评测无人
//    应答 → 整轮挂死超时；skipPermissions=true 时高危直接 allow（对齐 claude 等）。
//
// 以上均为历史内核真实短板（平台测出并文档化），不属于任务目标缺陷。
// 补丁逐条独立、幂等：目标形态已含修复时该条自动跳过。
// ---------------------------------------------------------------------------
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 逐条替换：每条独立判断（已存在目标形态/源形态不符则跳过），返回实际改动文件 */
function tryApply(wsPath, file, replacements) {
  const p = join(wsPath, file)
  const raw = readFileSync(p, 'utf8')
  // Windows 工作区 checkout 为 CRLF，补丁模式按 LF 编写——统一归一化再匹配/写回
  const crlf = raw.includes('\r\n')
  let cur = crlf ? raw.replace(/\r\n/g, '\n') : raw
  const touched = []
  for (const [from, to] of replacements) {
    // 幂等：目标形态已存在则跳过（避免"插入点仍匹配源模式"导致重复应用）
    if (!cur.includes(to) && cur.includes(from)) {
      cur = cur.replace(from, to)
      touched.push(file)
    }
  }
  if (touched.length) writeFileSync(p, crlf ? cur.replace(/\n/g, '\r\n') : cur)
  return touched.length ? [...new Set(touched)] : null
}

// —— api.mjs：Anthropic 请求体加 disable_parallel_tool_use（全部任务）——
const API_REPL = [[
  '    messages,\n    stream: true,\n',
  '    messages,\n    stream: true,\n    disable_parallel_tool_use: true,\n',
]]

// —— engine.mjs 通用：工具循环迭代上限（全部 base）——
// 4) MAX_TOOL_ITERATIONS=10 上限过低：真实多步任务（探查→修复→测试）需 20+
//    次工具调用，模型常在探索中被打断、无法产出最终文本答复（claude/pi/
//    deepseek 无此上限，横向对比不公平）。提升至 50（远超真实任务需求，
//    仍受评测整体超时约束）。
const ENGINE_CAP_REPL = [
  ['const MAX_TOOL_ITERATIONS = 10\n', 'const MAX_TOOL_ITERATIONS = 50\n'],
]

// —— permissions.mjs：无头评测高危命令自动放行（全部 base）——
// 6) --dangerously-skip-permissions 只放行低危命令，Bash 高危（rm -f 等）仍
//    发 can_use_tool 挂起等 GUI 审批——无头评测无人应答 → 整轮挂死超时。
//    claude/pi/deepseek 的 skip-permissions 语义是全部自动批准，此处对齐：
//    skipPermissions=true 时高危命令直接 allow。
const PERMISSIONS_SKIP_REPL = [
  ["    if (matchesHighRisk(command)) return { decision: 'ask', reason: `命令为高危操作，需要用户批准：${command.slice(0, 80)}` }",
   "    if (matchesHighRisk(command)) {\n      // 无头评测（--dangerously-skip-permissions）：高危命令自动放行（对齐 claude 等语义）\n      if (skipPermissions) return { decision: 'allow' }\n      return { decision: 'ask', reason: `命令为高危操作，需要用户批准：${command.slice(0, 80)}` }\n    }"],
]

// —— engine.mjs 旧形态（T001/T002）：工具轮 textBuf 未复位（ee47098 修复）——
// 5) 工具轮结束后 textBuf 未清空：下一轮 assistant 历史会带上上一轮全部文本，
//    且随轮次累积——模型在后续请求中反复看到自己的旧输出（"Let me examine..."）
//    以为工具异常，陷入重复探查死循环、无法收敛到最终答复。ee47098 起新增
//    textBuf = ''（HEAD 已含，幂等跳过）。
const ENGINE_TEXTBUF_RESET_REPL = [
  ['      history.push({ role: \'user\', content: toolResults })\n',
   '      history.push({ role: \'user\', content: toolResults })\n      textBuf = \'\'\n'],
]

// —— engine.mjs 旧形态（T001/T002，纯内存 history 数组，8 空格缩进）——
const ENGINE_OLD_REPL = [
  // 1) tools 透传
  ['streamMessages({ model, messages: history, maxTokens, signal })',
   'streamMessages({ model, messages: history, maxTokens, signal, tools: tools.toolSchemas() })'],
  // 2) thinking 累积回传（每轮独立缓冲）
  ["      const blocks = []\n",
   "      const blocks = []\n      const thinkingBlocks = []\n"],
  ["        } else if (chunk.type === 'thinking') {\n          wire.assistant([{ type: 'thinking', thinking: chunk.text }])\n",
   "        } else if (chunk.type === 'thinking') {\n          thinkingBlocks.push({ type: 'thinking', thinking: chunk.text })\n          wire.assistant([{ type: 'thinking', thinking: chunk.text }])\n"],
  ["      const assistantBlocks = [...(textBuf.trim() ? [{ type: 'text', text: textBuf }] : []), ...blocks]\n",
   "      const assistantBlocks = [...thinkingBlocks, ...(textBuf.trim() ? [{ type: 'text', text: textBuf }] : []), ...blocks]\n"],
  // 3) tool_result 合并单条 user 消息（Anthropic 协议；DeepSeek 严格校验）
  ["      // 逐个执行工具，结果回填为 user(tool_result) 消息\n      for (const b of blocks) {\n        const result = await executeToolUse(b)\n        history.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: b.id, content: result.content, is_error: result.isError }] })\n      }\n",
   "      // 执行全部工具后，tool_result 合并为单条 user 消息（Anthropic 协议：\n      // tool_use 后所有 tool_result 须紧跟同一 user 消息；DeepSeek 端点严格校验）\n      const toolResults = []\n      for (const b of blocks) {\n        const result = await executeToolUse(b)\n        toolResults.push({ type: 'tool_result', tool_use_id: b.id, content: result.content, is_error: result.isError })\n      }\n      history.push({ role: 'user', content: toolResults })\n"],
]

// —— engine.mjs 会话形态（T003-T006，session/memory 派生，10 空格缩进）——
const ENGINE_SESSION_REPL = [
  ["      const blocks = []\n",
   "      const blocks = []\n      const thinkingBlocks = []\n"],
  ["          } else if (chunk.type === 'thinking') {\n            wire.assistant([{ type: 'thinking', thinking: chunk.text }])\n",
   "          } else if (chunk.type === 'thinking') {\n            thinkingBlocks.push({ type: 'thinking', thinking: chunk.text })\n            wire.assistant([{ type: 'thinking', thinking: chunk.text }])\n"],
  ["      const assistantBlocks = [...(textBuf.trim() ? [{ type: 'text', text: textBuf }] : []), ...blocks]\n",
   "      const assistantBlocks = [...thinkingBlocks, ...(textBuf.trim() ? [{ type: 'text', text: textBuf }] : []), ...blocks]\n"],
]

// —— engine.mjs 会话形态（T003-T006）：多工具轮 tool_result 合并 ——
// disable_parallel_tool_use 对 DeepSeek 端点实测不可靠（T003-T006 仍发多 tool_use
// 触发 400 "tool_use without tool_result"），必须在协议层合并：同一 assistant 的
// 多个 tool_use 的 tool_result 收集后合并为单条 user 消息（对齐 d739669 真修复）
const ENGINE_SESSION_TOOLRESULTS_REPL = [
  ["      // 逐个执行工具，结果回填为 user(tool_result) 消息（时序：tool_use → tool_result）\n      for (const b of blocks) {\n        const result = await executeToolUse(b)\n        const toolResultMsg = { role: 'user', content: [{ type: 'tool_result', tool_use_id: b.id, content: result.content, is_error: result.isError }] }\n        pushMemory(toolResultMsg)\n        if (session) session.appendToolResult({ toolUseId: b.id, content: result.content, isError: result.isError })\n      }\n",
   "      // 执行全部工具后，tool_result 合并为单条 user 消息（Anthropic 协议：tool_use\n      // 后所有 tool_result 须紧跟同一 user 消息；DeepSeek 端点严格校验，\n      // disable_parallel_tool_use 实测不可靠，须在协议层合并）\n      const toolResults = []\n      for (const b of blocks) {\n        const result = await executeToolUse(b)\n        toolResults.push({ tool_use_id: b.id, content: result.content, is_error: result.isError })\n      }\n      pushMemory({ role: 'user', content: toolResults })\n      if (session) session.appendToolResults(toolResults)\n"],
]

// —— session.mjs 会话形态（T003-T006）：补 appendToolResults/toolResultsEntry ——
// engine 合并补丁依赖 session.appendToolResults（d739669 才加入，历史 base 缺失），
// 一并注入（与 d739669 实现一致，幂等跳过）
const SESSION_TOOLRESULTS_REPL = [
  ["    toolResultEntry({ toolUseId, content, isError }) {\n      return {\n        type: 'user',\n        id: randomUUID(),\n        timestamp: new Date().toISOString(),\n        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: String(content ?? ''), is_error: Boolean(isError) }] },\n      }\n    },\n",
   "    toolResultEntry({ toolUseId, content, isError }) {\n      return {\n        type: 'user',\n        id: randomUUID(),\n        timestamp: new Date().toISOString(),\n        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: String(content ?? ''), is_error: Boolean(isError) }] },\n      }\n    },\n    // 批量 tool_result：合并进同一条 user 消息（Anthropic API 要求同一 assistant\n    // 的多个 tool_use 的 tool_result 紧随其后且在同一条消息内）\n    toolResultsEntry(toolResults) {\n      return {\n        type: 'user',\n        id: randomUUID(),\n        timestamp: new Date().toISOString(),\n        message: {\n          role: 'user',\n          content: (toolResults || []).map((r) => ({\n            type: 'tool_result',\n            tool_use_id: r.tool_use_id,\n            content: String(r.content ?? ''),\n            is_error: Boolean(r.is_error),\n          })),\n        },\n      }\n    },\n"],
  ["    appendToolResult({ toolUseId, content, isError }) {\n      const entry = this.toolResultEntry({ toolUseId, content, isError })\n      return append(baseEntry('user', entry.message, {}))\n    },\n",
   "    appendToolResult({ toolUseId, content, isError }) {\n      const entry = this.toolResultEntry({ toolUseId, content, isError })\n      return append(baseEntry('user', entry.message, {}))\n    },\n    appendToolResults(toolResults) {\n      const entry = this.toolResultsEntry(toolResults)\n      return append(baseEntry('user', entry.message, {}))\n    },\n"],
]

// 任务 id → 补丁序列（逐条独立幂等）
const PATCHES = {
  T001: [['kernel/api.mjs', API_REPL], ['kernel/engine.mjs', [...ENGINE_CAP_REPL, ...ENGINE_TEXTBUF_RESET_REPL, ...ENGINE_OLD_REPL]], ['kernel/permissions.mjs', PERMISSIONS_SKIP_REPL]],
  T002: [['kernel/api.mjs', API_REPL], ['kernel/engine.mjs', [...ENGINE_CAP_REPL, ...ENGINE_TEXTBUF_RESET_REPL, ...ENGINE_OLD_REPL]], ['kernel/permissions.mjs', PERMISSIONS_SKIP_REPL]],
  T003: [['kernel/api.mjs', API_REPL], ['kernel/engine.mjs', [...ENGINE_CAP_REPL, ...ENGINE_SESSION_REPL, ...ENGINE_SESSION_TOOLRESULTS_REPL]], ['kernel/session.mjs', SESSION_TOOLRESULTS_REPL], ['kernel/permissions.mjs', PERMISSIONS_SKIP_REPL]],
  T004: [['kernel/api.mjs', API_REPL], ['kernel/engine.mjs', [...ENGINE_CAP_REPL, ...ENGINE_SESSION_REPL, ...ENGINE_SESSION_TOOLRESULTS_REPL]], ['kernel/session.mjs', SESSION_TOOLRESULTS_REPL], ['kernel/permissions.mjs', PERMISSIONS_SKIP_REPL]],
  T005: [['kernel/api.mjs', API_REPL], ['kernel/engine.mjs', [...ENGINE_CAP_REPL, ...ENGINE_SESSION_REPL, ...ENGINE_SESSION_TOOLRESULTS_REPL]], ['kernel/session.mjs', SESSION_TOOLRESULTS_REPL], ['kernel/permissions.mjs', PERMISSIONS_SKIP_REPL]],
  T006: [['kernel/api.mjs', API_REPL], ['kernel/engine.mjs', [...ENGINE_CAP_REPL, ...ENGINE_SESSION_REPL, ...ENGINE_SESSION_TOOLRESULTS_REPL]], ['kernel/session.mjs', SESSION_TOOLRESULTS_REPL], ['kernel/permissions.mjs', PERMISSIONS_SKIP_REPL]],
}

/** @returns {string[] | null} 实际应用的补丁文件列表（相对仓库根，去重），无补丁为 null */
export function applyBasePatch(taskId, wsPath) {
  const touched = new Set()
  for (const [file, repl] of PATCHES[taskId] || []) {
    const files = tryApply(wsPath, file, repl)
    if (files) files.forEach((f) => touched.add(f))
  }
  return touched.size ? [...touched] : null
}

// 从 agent 改动统计中排除的环境补丁文件（其余补丁文件如 api.mjs 可能是任务
// 合法修改目标，不得排除）。engine.mjs / permissions.mjs 是纯环境修复层，
// agent 任务（fix/feat/test）均不应触碰。
export const EXCLUDED_PATCH_FILES = ['kernel/engine.mjs', 'kernel/permissions.mjs']
