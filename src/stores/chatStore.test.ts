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
