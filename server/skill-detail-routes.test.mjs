// server/skill-detail-routes.test.mjs
// `/skill-detail` 路由（2026-09-15，P1 批次二 C）。直调纯 handler（不起 bridge / 不起内核子进程）。
//
// 除了常规映射（缺 id → 400、未找到 → 404、正常 → 200），本文件还钉一条**纪律断言**：
// 详情链路是**只读**的（决策 D2：只读展示 + 系统打开文件）。源码级断言"没有写调用"，
// 因为这条纪律一旦被破坏（有人顺手加个"保存"），用户技能文件会被应用改写——
// 而这些文件承载着大量业务内容，格式风险极高，且破坏是**静默**的（用户下次打开才发现文件变了）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { handleSkillDetailRoute } from './skill-detail-routes.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'ponos-skill-detail-route-'))
const call = (ctx) => handleSkillDetailRoute(ctx)
const withId = (id, extra = {}) => ({ method: 'GET', pathname: '/skill-detail', searchParams: new URLSearchParams({ id }), ...extra })

function makeSkill(root, id, frontmatter = '', files = {}) {
  const dir = join(root, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${id}\ndescription: 演示\n${frontmatter}---\n\n正文\n`, 'utf-8')
  for (const [n, b] of Object.entries(files)) writeFileSync(join(dir, n), b, 'utf-8')
  return dir
}

test('路径/方法不匹配 → null（不得吞掉别的请求）', async () => {
  const root = tmp()
  try {
    assert.equal(await call({ method: 'GET', pathname: '/skills', roots: [root] }), null)
    assert.equal(await call(withId('x', { method: 'POST', roots: [root] })), null)
    assert.equal(await call(withId('x', { method: 'DELETE', roots: [root] })), null)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('缺少 id → 400（明确报错，而不是 200 + 空详情）', async () => {
  const root = tmp()
  try {
    const r = await call({ method: 'GET', pathname: '/skill-detail', searchParams: new URLSearchParams(), roots: [root] })
    assert.equal(r.status, 400)
    assert.match(r.body.error, /id/)
    const blank = await call(withId('   ', { roots: [root] }))
    assert.equal(blank.status, 400, '纯空白 id 也应视为缺失')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('技能不存在 → 404（界面据此说明"已在磁盘上不存在"，而不是渲染空白面板）', async () => {
  const root = tmp()
  try {
    const r = await call(withId('ghost', { roots: [root] }))
    assert.equal(r.status, 404)
    assert.match(r.body.error, /ghost/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('正常：200 + 完整详情（含 parent 归因、脚本/文档分流）', async () => {
  const root = tmp()
  try {
    const dir = makeSkill(root, 'demo-skill', 'parent: gxtz-group\ntriggers:\n  - 触发一\n', {
      'run.py': 'print(1)\n', 'notes.md': '# n\n',
    })
    const r = await call(withId('demo-skill', { roots: [root] }))
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)
    assert.equal(r.body.id, 'demo-skill')
    assert.equal(r.body.dir, dir)
    assert.equal(r.body.parent, 'gxtz-group')
    assert.equal(r.body.parentSource, 'explicit')
    assert.deepEqual(r.body.triggers, ['触发一'])
    assert.deepEqual(r.body.scripts.map((s) => s.name), ['run.py'])
    assert.deepEqual(r.body.docs.map((d) => d.name), ['notes.md'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('roots 缺失/为空 → 404（不崩）', async () => {
  assert.equal((await call(withId('x'))).status, 404, 'roots 缺失时应 404，而不是抛错')
  assert.equal((await call(withId('x', { roots: [] }))).status, 404)
})

test('**只读纪律**：详情链路源码内不得出现任何写文件调用（决策 D2）', () => {
  const route = readFileSync(fileURLToPath(new URL('./skill-detail-routes.mjs', import.meta.url)), 'utf8')
  // 路由自身：不得写盘
  assert.doesNotMatch(route, /writeFileSync|appendFileSync|writeFile\(|createWriteStream|rmSync|unlinkSync|renameSync/,
    '详情路由必须只读：用户技能文件承载大量业务内容，任何"应用写入"都是格式风险且静默')
  assert.doesNotMatch(route, /method === 'PUT'|method === 'POST'|method === 'PATCH'|method === 'DELETE'/,
    '不得提供写方法（"管理"= 系统打开文件，不是应用编辑）')

  // 加载器同样只读（它读 SKILL.md，但不写）
  const loader = readFileSync(fileURLToPath(new URL('../kernel/skills.mjs', import.meta.url)), 'utf8')
  const detailFn = loader.slice(loader.indexOf('export function loadSkillDetail'))
  assert.doesNotMatch(detailFn, /writeFileSync|appendFileSync|renameSync|unlinkSync/,
    'loadSkillDetail 必须只读 SKILL.md / 目录')
})

test('**只读纪律**：详情面板组件不得含写文件或保存类调用', () => {
  const panel = readFileSync(fileURLToPath(new URL('../src/components/skills/SkillDetailPanel.tsx', import.meta.url)), 'utf8')
  assert.doesNotMatch(panel, /saveSkill|writeSkill|updateSkill|fetch\([^)]*method:\s*'(PUT|POST|PATCH|DELETE)'/,
    '面板不得有保存/写入路径')
  assert.match(panel, /openInExplorer/, '"管理"必须走系统打开文件（既有 IPC）')
  assert.match(panel, /detailReadOnlyHint|只读/, '界面必须明说这是只读展示（用户才不会以为改不了是 bug）')
})

test('bridge 接线：/skill-detail 接到 handler，且 roots 与 /skills 列表同源', () => {
  const bridge = readFileSync(fileURLToPath(new URL('./bridge.mjs', import.meta.url)), 'utf8')
  assert.match(bridge, /import \{ handleSkillDetailRoute \} from '\.\/skill-detail-routes\.mjs'/)
  assert.match(bridge, /roots: \[findSkillRoot\(\)\]/,
    'roots 必须与 /skills 列表同一个 findSkillRoot()，否则会出现"列表里有、详情说找不到"的矛盾')
  assert.match(bridge, /if \(r\) return reply\(r\.status/)
})
