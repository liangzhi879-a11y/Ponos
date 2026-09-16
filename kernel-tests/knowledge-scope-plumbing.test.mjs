// kernel-tests/knowledge-scope-plumbing.test.mjs
// 会话知识范围的**四跳透传静态守卫**（2026-09-15，待处理清单 P1）。
//
// 为什么用静态断言而不是行为断言：这条链跨了三个进程/包
//   会话字段 → useYFWCLI 的 spawn payload → bridge 的 argv → 内核 CLI 的参数解析
// 任一跳漏登记都是**静默失效**（本仓库已两次踩过：`--spaces` / `--confirm` 漏登记被
// "未知 `--` 参数静默忽略"吞掉）。行为断言只能覆盖链尾（内核真进程测试在
// knowledge-session-spaces.test.mjs 里），链中间几跳的行为需要起 bridge（import 即启服务），
// 故按本仓库既有做法（knowledge-root-consistency.test.mjs）用源码文本断言守住"接线还在"。
//
// 这些断言的失败含义很明确：**有人删/改了透传点** → 关联功能会静默失效，而不是报错。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const optional = (rel) => (existsSync(join(ROOT, rel)) ? read(rel) : null)

test('第 1 跳：内核 CLI 登记 --knowledge-spaces（漏登记 = 被静默忽略）', () => {
  const src = read('kernel/cli.mjs')
  assert.match(src, /case '--knowledge-spaces'/, '必须显式登记 case：本 CLI 对未知 `--` 参数静默忽略')
  assert.match(src, /knowledgeSpaces: null/, '初值要登记（否则 case 写出来的值不在 out 里）')
  // 解析 → 消费四处：范围解析、注入层、工具层、超限丢弃的上报
  assert.match(src, /resolveSessionKnowledgeScope\(\{ configDir, requested: args\.knowledgeSpaces \}\)/)
  assert.match(src, /spaces: knowledgeScope\.spaces,/, '注入层必须传范围（否则 unified 仍按全空间打分）')
  assert.match(src, /knowledgeSpaces: knowledgeScope\.spaces,/, '工具层必须传范围（双层同源）')
  assert.match(src, /knowledge_spaces: knowledgeScope\.spaces,/, 'init 帧回显：让"传到没有"可判定')
  // 「超上限被忽略的库」是"点了关联却没生效"的唯一事后证据：只在单测里给
  // buildKnowledgeInjection 传参会假绿——删掉这行接线时全部测试仍绿（评审抓出的缺口）。
  assert.match(src, /spacesDropped: knowledgeScope\.dropped,/, 'G2 观测量必须真的接到注入层')
  // 范围必须是**始终传数组**：空数组（内置经验库都不存在）= 无可检索库（fail-closed），
  // 若这里写成 `knowledgeScope.spaces || null`，空数组会退回"不限"，范围在最该收紧时失效。
  assert.doesNotMatch(src, /knowledgeSpaces: knowledgeScope\.spaces \|\| null/, '空数组不得退化为"不限"')
  assert.doesNotMatch(src, /spaces: knowledgeScope\.spaces \|\| null/, '同上（注入层）')
})

test('第 2 跳：engine 把 knowledgeSpaces 转发给 createToolRegistry（漏转发 = 工具层永远不限）', () => {
  const src = read('kernel/engine.mjs')
  assert.match(src, /createToolRegistry\(\{[^}]*knowledgeSpaces: opts\.knowledgeSpaces/s,
    'engine 是 cli → tools 的唯一过路点：不转发则 createToolRegistry 恒收 null')
})

test('第 3 跳：bridge 把会话字段转成 --knowledge-spaces（参数名逐字一致）', () => {
  const src = read('server/bridge.mjs')
  assert.match(src, /args\.push\('--knowledge-spaces'/, '参数名必须与内核登记项逐字一致（拼错=静默失效）')
  assert.match(src, /normalizeKnowledgeSpaces\(knowledgeSpaces\)/, '先归一再加参（同一状态只应有一个签名）')
  assert.match(src, /getOrCreateSession\(sid, cwd, resumeId, systemPrompt, model, compactCount, mode = 'task', knowledgeSpaces = null\)/,
    'getOrCreateSession 必须收这个字段（否则前端传了也到不了 argv）')
  assert.match(src, /_spawnKnowledgeSig/, '范围签名：变更后要能触发 --resume 重启内核才生效')
})

test('第 3 跳（前端）：会话字段进 spawn payload（send 与 answer 同源，改一处两条路都通）', () => {
  const src = optional('src/hooks/useYFWCLI.ts')
  if (!src) return   // 纯内核形态（无 GUI）时跳过
  assert.match(src, /conversation\.knowledgeSpaces\?\.length \? \{ knowledgeSpaces: conversation\.knowledgeSpaces \}/,
    '不传该键时 bridge 缺省 = 内置经验类空间；传空数组会造成无谓的签名差异')
})

test('第 4 跳（持久化）：partialize 白名单必须含 knowledgeSpaces（漏了 = 重启即丢失）', () => {
  const src = optional('src/stores/chatStore.ts')
  if (!src) return
  // partialize 是**显式取字段**而非全量展开：漏一个字段不会报错，只会"重启后关联没了"
  const block = src.slice(src.indexOf('partialize: (state) => ({'), src.indexOf('partialize: (state) => ({') + 900)
  assert.match(block, /knowledgeSpaces: c\.knowledgeSpaces/, 'partialize 必须带上该字段')
  assert.match(src, /version: 4/, '字段新增要配一次 version 迁移（v3 行必须能升上来）')
  assert.match(src, /if \(version === 3\)/, 'v3 → v4 分支：只补字段，不重算 messageCount/tokensTotal')
})

test('第 4 跳（模型）：Conversation 类型声明该字段', () => {
  const src = optional('src/types/index.ts')
  if (!src) return
  assert.match(src, /knowledgeSpaces\?: string\[\]/, '类型声明缺失会让透传处被 TS 判为多余属性')
})

test('界面判据与内核常量对齐（镜像值漂移守卫）', () => {
  const gui = optional('src/lib/knowledgeScopeUi.ts')
  if (!gui) return
  const kernel = read('kernel/knowledge.mjs')
  const kmax = Number((kernel.match(/export const MAX_ASSOC_SPACES = (\d+)/) || [])[1])
  const klarge = Number((kernel.match(/export const LARGE_SPACE_DOCS = (\d+)/) || [])[1])
  const gmax = Number((gui.match(/export const MAX_ASSOC_SPACES = (\d+)/) || [])[1])
  const glarge = Number((gui.match(/export const LARGE_SPACE_DOCS = (\d+)/) || [])[1])
  assert.equal(gmax, kmax, '关联上限必须与内核一致（界面放行、内核截断 = 用户看到"点了没生效"）')
  assert.equal(glarge, klarge, '大库阈值必须与内核一致')
})
