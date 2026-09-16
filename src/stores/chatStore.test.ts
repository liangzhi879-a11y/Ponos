// src/stores/chatStore.test.ts —— chatStore 的「会话知识范围接线」守卫（2026-09-15，P1）
//
// **本文件为什么用源码断言而不是 import chatStore**：`chatStore.ts` 有 12 处**运行期**别名导入
// （utils/chatParts/config/其它 store），而本仓库的测试跑在 Node 原生 `node --test` 下
// （package.json 的 test 脚本，无 vitest/tsx），别名不可解析 ⇒ 一旦 import 它，整个
// `src/**/*.test.ts` 套件都会挂。故：
//   · 迁移与归一的**行为**测试 → `src/lib/chatScopeMigration.test.ts`（纯函数，可真跑）；
//   · store 侧"确实调了那一份、字段确实进了持久化白名单" → 本文件（源码级断言）。
// 两者合起来才等于"这条链没有静默断点"：单测纯函数证明逻辑对，源码断言证明它被接上了。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = readFileSync(fileURLToPath(new URL('./chatStore.ts', import.meta.url)), 'utf8')

test('迁移与消毒来自可单测的纯模块（而不是本文件内的私有实现）', () => {
  assert.match(src, /import \{ sanitizeConversations, sanitizeKnowledgeSpaces, migrateChatV3 \} from '@\/lib\/chatScopeMigration'/,
    '必须复用纯模块：留在 store 里的实现永远进不了单测（别名不可解析）')
  // 旧的私有实现不得复活（否则两份实现会各自漂移）
  assert.doesNotMatch(src, /^function sanitizeConversations/m, '消毒实现只应存在于 lib/chatScopeMigration.ts 一处')
  assert.doesNotMatch(src, /^function sanitizeKnowledgeSpaces/m, '归一实现只应存在于 lib/chatScopeMigration.ts 一处')
})

test('v3 → v4 迁移分支走 migrateChatV3（只补字段，不重建统计）', () => {
  assert.match(src, /if \(version === 3\) \{\s*return migrateChatV3\(persisted\)/, 'v3 分支必须委派纯模块')
  assert.match(src, /version: 4,/, '新增字段必须配一次版本号提升（v3 行要能升上来）')
})

test('setConversationKnowledgeSpaces 落库时归一，且不触碰 updatedAt/title', () => {
  const i = src.indexOf('setConversationKnowledgeSpaces: (id, spaces)')
  assert.ok(i > 0, '动作必须存在（GUI 的关联开关依赖它）')
  const body = src.slice(i, i + 400)
  assert.match(body, /sanitizeKnowledgeSpaces\(spaces\)/, '写库前归一（同一状态只能有一个签名）')
  assert.doesNotMatch(body, /updatedAt/, '关联知识库不是"切换语境"，不该改排序时间')
  assert.doesNotMatch(body, /title/, '关联知识库不该改标题')
})

test('partialize 白名单包含 knowledgeSpaces（漏了 = 重启后关联静默丢失）', () => {
  const i = src.indexOf('partialize: (state) => ({')
  assert.ok(i > 0)
  assert.match(src.slice(i, i + 1200), /knowledgeSpaces: c\.knowledgeSpaces/,
    'partialize 是显式取字段而非全量展开：漏字段不报错，只表现为"重启后关联没了"')
})

test('getOrCreateAppConversation：幂等（命中 appId 即返回）+ task 模式 + titleAuto:false + appPageId', () => {
  const i = src.indexOf('getOrCreateAppConversation: (appId, appName)')
  assert.ok(i > 0, '动作必须存在（应用页与自动质检依赖它）')
  const body = src.slice(i, i + 1200)
  assert.match(body, /\.find\(c => c\.appId === key\)/, '幂等键必须是 appId')
  assert.match(body, /if \(existing\) return existing\.id/, '已存在必须直接复用，不得新建第二个')
  assert.match(body, /createConversation\(undefined, undefined, 'task'\)/,
    '必须 task 模式：chat 模式 appRoots=[]，应用工具根本不存在')
  assert.match(body, /titleAuto: false/, '否则首条质检提示词会被自动标题改写（用户看不懂）')
  assert.match(body, /appPageId: key/, '应用页作用域必须与 appId 同值（否则工具池不收窄到该应用）')
  assert.match(body, /title: `应用·\$\{name\}`/, '标题要能一眼看出是哪个应用的会话')
})

test('partialize 白名单包含 appId/appPageId（漏了 = 重启后幂等失效 + 工具池失效）', () => {
  const i = src.indexOf('partialize: (state) => ({')
  assert.ok(i > 0)
  const block = src.slice(i, i + 1600)
  assert.match(block, /appId: c\.appId/,
    '漏掉 appId：重启后"一个应用一个会话"的幂等键消失 → 每开一次应用页都新建一条"应用·xxx"')
  assert.match(block, /appPageId: c\.appPageId/,
    '漏掉 appPageId：重启后工具池不再收窄到该应用（应用工具全没了，且不报错）')
})
