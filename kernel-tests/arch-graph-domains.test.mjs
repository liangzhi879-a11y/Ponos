// kernel-tests/arch-graph-domains.test.mjs —— 架构图谱的「域分配与归并」规则直测（P2-2）
// ---------------------------------------------------------------------------
// 为什么值得测：P2-2 的域归并（68+ → 52）是一张**手写的映射表**（SRC_DOMAIN_MERGE），
// 它直接决定架构图上"看到几个簇"，但**没有任何类型系统保护**——
//   · 把归并目标写成一个不存在的域 → 该目录的模块在图上会变成"无名域"，静默丢标签；
//   · 写出一条 A→B、B→C 的链 → 因为只应用一层，最终落在 B，与作者意图不符且不易察觉；
//   · 把已归并的目录又当成目标 → 域数悄悄多出来。
// 这些都是"错了但不报错"的形态，正是单测该守的地方。
//
// 本测试只 import 纯函数（生成器已在末尾用 import.meta 守卫，import 不会触发全仓扫描）。
// 运行：node --test kernel-tests/arch-graph-domains.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { domainOf, SRC_DOMAIN_MERGE, SRC_VIEW_DOMAIN } from '../scripts/build-arch-graph.mjs'

test('归并表的每个目标都必须是"有名字的真实域"（否则文档里会出现无名域）', () => {
  for (const [from, to] of Object.entries(SRC_DOMAIN_MERGE)) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(SRC_VIEW_DOMAIN, to),
      `${from} → ${to}：目标域不在 SRC_VIEW_DOMAIN 里（会导致该域没有中文名）`,
    )
  }
})

test('归并表不得出现链式映射（A→B 且 B→C）：只应用一层，链会静默停在中间', () => {
  for (const [from, to] of Object.entries(SRC_DOMAIN_MERGE)) {
    assert.ok(
      !Object.prototype.hasOwnProperty.call(SRC_DOMAIN_MERGE, to),
      `${from} → ${to}：而 ${to} 又是一条归并的来源（链式），最终只会落到 ${to} 而非链尾`,
    )
  }
})

test('归并表不得把"源"写成自己也指向的分支（自身映射是空操作）', () => {
  for (const [from, to] of Object.entries(SRC_DOMAIN_MERGE)) {
    assert.notEqual(from, to, `${from} 映射到了自己（无意义条目）`)
  }
})

test('domainOf 对已归并目录返回归并目标（renderer 侧）', () => {
  // 表格驱动：覆盖 SRC_DOMAIN_MERGE 的每一条，而不是只挑几个样例
  for (const [from, to] of Object.entries(SRC_DOMAIN_MERGE)) {
    const sample = from === 'src-root' ? 'src/App.tsx' : `${from}/sample.tsx`
    assert.equal(domainOf(sample), to, `${sample} 应归入 ${to}`)
  }
})

test('domainOf 不再为任何已归并目录产出独立域（防止域数悄悄涨回去）', () => {
  const mergedAway = new Set(Object.keys(SRC_DOMAIN_MERGE))
  const probes = [
    'src/components/search/x.tsx', 'src/components/vault/x.tsx', 'src/components/worktree/x.tsx',
    'src/components/rail/x.tsx', 'src/components/auth/x.tsx', 'src/hooks/useX.ts', 'src/types/index.ts',
  ]
  for (const p of probes) {
    assert.ok(!mergedAway.has(domainOf(p)), `${p} 归并后不应再产出独立域，实际得到 ${domainOf(p)}`)
  }
})

test('未归并的 renderer 目录仍各自成域（归并没有波及无关目录）', () => {
  assert.equal(domainOf('src/components/chat/ChatView.tsx'), 'src/components/chat')
  assert.equal(domainOf('src/components/knowledge/KnowledgeView.tsx'), 'src/components/knowledge')
  assert.equal(domainOf('src/components/editor/Editor.tsx'), 'src/components/files', 'editor 已归入 files')
  assert.equal(domainOf('src/stores/chatStore.ts'), 'src/stores')
  assert.equal(domainOf('src/lib/api.ts'), 'src/lib')
})

test('后端 kernel/bridge/host 的域不受归并影响（那些是手工策展的语义域）', () => {
  // 归并表只该含 renderer 侧路径与 src-root 伪域（`src/` 根下的文件）；
  // 后端域必须原样走 DOMAINS 表。`src-root` 是 renderer 侧的特殊域 id，不含斜杠，故单独放行。
  for (const from of Object.keys(SRC_DOMAIN_MERGE)) {
    assert.ok(
      from.startsWith('src/') || from === 'src-root',
      `${from} 不是 renderer 侧路径 —— 后端域是手工策展的语义域，不应被卷入自动归并`,
    )
  }
  // 抽样：这些后端文件仍得到各自域的 id（形态 kernel/xxx 而非被并入某 src 域）
  for (const p of ['kernel/cli.mjs', 'server/bridge.mjs', 'shared/protocol.mjs']) {
    const d = domainOf(p)
    assert.ok(typeof d === 'string' && d.length > 0, `${p} 应有域`)
    assert.ok(!d.startsWith('src/'), `${p} 不应被归入 renderer 域（实际 ${d}）`)
  }
})

test('归并确实减少了域数（源条目数 = 减少量，且目标域数不变）', () => {
  const srcCount = Object.keys(SRC_DOMAIN_MERGE).length
  assert.ok(srcCount >= 10, `归并条目 ${srcCount} 条少于预期 —— 请确认是否被误删`)
  // 归并的目标集合与来源集合必须不相交（否则会多减/漏减）
  const froms = new Set(Object.keys(SRC_DOMAIN_MERGE))
  const tos = new Set(Object.values(SRC_DOMAIN_MERGE))
  for (const t of tos) assert.ok(!froms.has(t), `目标 ${t} 同时是来源，域数计算会出错`)
})
