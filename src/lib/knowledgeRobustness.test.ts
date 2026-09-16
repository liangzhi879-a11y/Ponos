// src/lib/knowledgeRobustness.test.ts
// 运行：node --test src/lib/knowledgeRobustness.test.ts（Node 原生 TS 服务）
//
// 批次 4（工程健壮性）里有两处"写错了也不会报错、只会在用户那边表现为功能失效"的接线，
// 它们无法在组件层测（仓库无 DOM 测试环境），但可以用**源码契约扫描**钉死：
//
//   ① `invalidateKnowledge(prefix)` 的实现是 `key.startsWith(prefix)`。漏传参数会变成
//      `startsWith(undefined)` → **一条键都不匹配** → "监听外部改动"这条链路静默什么都不做。
//      所以 `knowledge_changed` 处理里必须显式传**空串**。
//   ② 保存文档后必须失效 `mentions:` / `brokenLinks:` 两个通道，否则"未链接提及/断链"
//      会停在保存前的样子（批次 1 给 indexTags 补失效的同类问题，批次 2 新增这两个视图时漏了）。
//
// 这类断言的价值不在于"检查代码长什么样"，而在于把**一次踩过的坑**变成永久的回归防线：
// 两处都是"静默失效"，靠人工 review 很难发现，靠用户报障代价又太大。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

test('批次4：knowledge_changed 处理必须显式传空串前缀（漏传 = 一条键都不失效）', () => {
  const src = read('../hooks/useYFWCLI.ts')
  assert.ok(src.includes("msg.type === 'knowledge_changed'"), '必须处理 bridge 推来的知识空间变化帧')
  assert.ok(src.includes("invalidateKnowledge('')"),
    "必须写 `invalidateKnowledge('')`：不传参数会变成 startsWith(undefined) → 静默失效")
  // 防止有人"顺手"改成不带参数的形式
  assert.ok(!/invalidateKnowledge\(\s*\)/.test(src),
    '不得出现无参调用 invalidateKnowledge()（它匹配不到任何缓存键）')
})

test('批次4：knowledge_changed 处理要能丢弃乱序旧批次（revision 单调比较）', () => {
  const src = read('../hooks/useYFWCLI.ts')
  assert.ok(src.includes('lastKnowledgeRevision'), '需要模块级 revision 记录')
  assert.ok(/d\.revision\s*<=\s*lastKnowledgeRevision/.test(src),
    '必须比较并丢弃旧批次：WebSocket 不保证顺序，旧批次后到会让新批次被误判为旧')
})

test('批次4：保存/导入后必须失效 mentions: 与 brokenLinks:（批次 2 新增视图的收尾）', () => {
  const src = read('../hooks/useKnowledge.ts')
  // 保存路径
  assert.ok(src.includes("invalidateKnowledge('mentions:')"), '保存后要失效未链接提及')
  assert.ok(src.includes("invalidateKnowledge('brokenLinks:')"), '保存后要失效断链清单')
  // 这两个通道在"保存"与"导入"两条路径上都该出现（导入会一次带进整批引用关系）
  const mentions = src.match(/invalidateKnowledge\('mentions:'\)/g) ?? []
  const broken = src.match(/invalidateKnowledge\('brokenLinks:'\)/g) ?? []
  assert.ok(mentions.length >= 2, `保存 + 导入两条路径都要失效，实际 ${mentions.length} 处`)
  assert.ok(broken.length >= 2, `保存 + 导入两条路径都要失效，实际 ${broken.length} 处`)
})

test('批次4：编辑器保存要带 mtime、且冲突有独立出口（覆盖前备份）', () => {
  const src = read('../components/knowledge/KnowledgeEditorView.tsx')
  assert.ok(/mtime:\s*doc\.mtime/.test(src),
    '保存必须带上加载时的 mtime：服务端据此发现"文件被外部改过"并拒绝覆盖')
  assert.ok(src.includes("kind: 'conflict'"),
    '409 必须是独立状态（不是 failed）：它需要用户二选一，只显示一行红字等于把问题丢回去')
  assert.ok(src.includes('doSave(true)'), '冲突里要能"以我这份覆盖"（服务端会先备份外部版本）')
  // `onClick={doSave}` 会把 MouseEvent 当 force 传进去 → 任何普通保存都变成强制覆盖。
  // 只在**非注释行**上检查：文件里那条解释性注释本身就写着 `onClick={doSave}` 这个反例。
  const codeLines = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  assert.ok(codeLines.some((l) => l.includes('onClick={() => doSave()}')),
    'onClick 必须包一层箭头函数（否则事件对象被当成 force=true）')
  assert.ok(!codeLines.some((l) => /onClick=\{doSave\}/.test(l)),
    'onClick 必须包一层箭头函数：直接传 doSave 会把事件对象当作 force=true')
})

test('批次4：知识库 API 的 409 冲突信息要透出（含磁盘 mtime/size）', () => {
  const src = read('./knowledgeApi.ts')
  assert.ok(src.includes('includeErrorBody'), '409 需要读响应体里的 mtime/size → 需要显式开启')
  assert.ok(/r\.status === 409/.test(src), 'writeDoc 要单独识别 409 并回带 conflict')
  assert.ok(src.includes('conflict'), '上层要能拿到 conflict（否则 UI 无法展示外部版本信息）')
})
