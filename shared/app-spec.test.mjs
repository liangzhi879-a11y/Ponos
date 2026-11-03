import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateAppSpec, L2_COMPONENTS, L3_LAYOUTS } from './app-spec.mjs'

/** 一个"全绿"的样板 spec（P5a 验收：手写样板应用，校验器必须全绿） */
const sample = () => ({
  specVersion: 2,
  commands: [{ id: 'version', kind: 'read' }],
  results: { commands: [{ action: 'version', kind: 'read', description: '查看版本' }] },
  selected: { action: 'version' },
  ui: {
    layout: 'list-detail',
    views: [
      {
        id: 'commands',
        component: 'DataTable',
        props: {
          rows: '{{results.commands}}',
          density: 'cozy',
          rowActions: ['run'],
          columns: [
            { key: 'action', label: '命令', wrap: true },
            { key: 'kind', label: '类型', truncate: true },
          ],
        },
      },
      { id: 'detail', component: 'StatCard', props: { label: '选中', value: '{{selected.action}}' } },
    ],
    actions: [{ id: 'run', label: '执行命令', command: 'version', kind: 'read' }],
    states: {
      empty: { component: 'EmptyState', props: { text: '还没有可执行的命令' } },
      error: { component: 'ErrorState', props: { text: '命令执行失败，详情见日志' } },
      loading: { component: 'LoadingState', props: { text: '正在执行命令' } },
    },
  },
})

const codes = (spec) => validateAppSpec(spec).errors.map((e) => e.code)

test('U1–U7：样板 spec 全绿（P5a 验收判据 ①）', () => {
  const r = validateAppSpec(sample())
  assert.deepEqual(r.errors, [])
  assert.equal(r.ok, true)
})

test('U7 结构白名单：未知组件 / className / 未知属性 / 未知版式 全部显式报错', () => {
  const bad = sample()
  bad.ui.layout = 'freeform'
  bad.ui.views[0].component = 'MagicGrid'
  bad.ui.views.push({ id: 'x', component: 'Button', props: { label: 'ok', className: 'text-red-500' } })
  bad.ui.views.push({ id: 'y', component: 'Button', props: { label: 'ok', style: { color: '#fff' } } })
  bad.ui.views.push({ id: 'z', component: 'Button', props: { label: 'ok', unknownProp: 1 } })
  const errs = validateAppSpec(bad).errors
  assert.ok(errs.some((e) => e.path === 'ui.layout' && e.code === 'U7'))
  assert.ok(errs.some((e) => e.message.includes('MagicGrid') && e.code === 'U7'), '未知组件必须显式报错，不许静默丢')
  assert.ok(errs.some((e) => e.path.endsWith('.className')))
  assert.ok(errs.some((e) => e.path.endsWith('.style')))
  assert.ok(errs.some((e) => e.path.endsWith('.unknownProp')))
})

test('U1 色值：硬编码 #fff 红；var(--token) 绿', () => {
  const bad = sample()
  bad.ui.views.push({ id: 'c', component: 'Badge', props: { text: '运行中', tone: '#ff0000' } })
  assert.ok(validateAppSpec(bad).errors.some((e) => e.code === 'U1'))
  const ok = sample()
  ok.ui.views.push({ id: 'c', component: 'Badge', props: { text: '运行中', tone: 'var(--accent)' } })
  assert.equal(validateAppSpec(ok).ok, true)
})

test('U2 档位：size/density 只能是令牌档位', () => {
  const bad = sample()
  bad.ui.views.push({ id: 'b', component: 'Button', props: { label: '跑', size: '13px' } })
  assert.ok(validateAppSpec(bad).errors.some((e) => e.code === 'U2'))
})

test('U3 三态：缺一即红；三态各自的组件必须对得上', () => {
  const missing = sample()
  delete missing.ui.states.loading
  assert.ok(validateAppSpec(missing).errors.some((e) => e.code === 'U3' && e.path === 'ui.states.loading'))
  const wrong = sample()
  wrong.ui.states.error = { component: 'EmptyState', props: { text: '失败了' } }
  assert.ok(validateAppSpec(wrong).errors.some((e) => e.code === 'U3' && e.path === 'ui.states.error.component'))
})

test('U4 密度与宽度：表格列必须显式 wrap/truncate；密度只认令牌', () => {
  const bad = sample()
  delete bad.ui.views[0].props.columns[0].wrap
  bad.ui.views[0].props.density = 'huge'
  const errs = validateAppSpec(bad).errors
  assert.ok(errs.some((e) => e.code === 'U4' && e.path.includes('columns[0]')))
  assert.ok(errs.some((e) => e.code === 'U4' && e.path.endsWith('.density')))
})

test('U5 点击区：按钮显式给的尺寸必须落在令牌档位', () => {
  const bad = sample()
  bad.ui.views.push({ id: 'tiny', component: 'Button', props: { label: '跑', size: '11px' } })
  const errs = validateAppSpec(bad).errors
  assert.ok(errs.some((e) => e.code === 'U5' || e.code === 'U2'), '小于最小点击区的尺寸必须在草稿阶段就红')
})

test('U6 文案：空洞文案红（"加载中"必须说明在做什么）', () => {
  const bad = sample()
  bad.ui.states.loading = { component: 'LoadingState', props: { text: '加载中' } }
  assert.ok(validateAppSpec(bad).errors.some((e) => e.code === 'U6'))
})

test('U7 图标：只能是 lucide 名字，emoji / svg / data: / URL 一律拒', () => {
  for (const icon of ['📊', '<svg viewBox="0 0 1 1"></svg>', 'data:image/png;base64,xx', 'https://x/y.png']) {
    const bad = sample()
    bad.ui.views.push({ id: 'i', component: 'StatCard', props: { label: '数', value: '1', icon } })
    assert.ok(validateAppSpec(bad).errors.some((e) => e.code === 'U7' && e.path.includes('icon')), `图标「${icon}」应被拒`)
  }
  const ok = sample()
  ok.ui.views.push({ id: 'i', component: 'StatCard', props: { label: '数', value: '1', icon: 'chart-bar' } })
  assert.equal(validateAppSpec(ok).ok, true)
})

test('U7 数据绑定：解析不到的路径 / 绑定视图自身 都红', () => {
  const bad = sample()
  bad.ui.views[1].props.value = '{{nope.missing}}'
  bad.ui.views.push({ id: 'self', component: 'Badge', props: { text: '{{ui.views[0].id}}' } })
  const errs = validateAppSpec(bad).errors
  assert.ok(errs.some((e) => e.message.includes('nope.missing')))
  assert.ok(errs.some((e) => e.message.includes('视图自身') || e.message.includes('不许绑定')))
})

test('U7 actions：引用不存在的 action / kind 非 read|write 都红', () => {
  const bad = sample()
  bad.ui.views[0].props.rowActions = ['ghost']
  bad.ui.actions.push({ id: 'del', label: '删除', command: 'x', kind: 'destructive' })
  const errs = validateAppSpec(bad).errors
  assert.ok(errs.some((e) => e.message.includes('ghost')))
  assert.ok(errs.some((e) => e.code === 'U7' && e.path.endsWith('.kind')))
})

test('白名单规模有哨兵：L2 含 6 个新增基元、L3 首批 3 个（防止被悄悄删空）', () => {
  for (const c of ['DataTable', 'FormSection', 'StatCard', 'EmptyState', 'ErrorState', 'LoadingState']) {
    assert.ok(L2_COMPONENTS.includes(c), `${c} 必须在 L2 白名单里`)
  }
  assert.deepEqual([...L3_LAYOUTS], ['list-detail', 'report-table', 'dashboard'])
})

test('specVersion 只认 2；ui 缺失直接判红并短路', () => {
  // 两条都报（版本错 + 缺 ui），且都归 U7：不是"哪条更重要"，是两条都真实存在
  const c1 = codes({ specVersion: 1 })
  assert.deepEqual(c1, ['U7', 'U7'])
  assert.deepEqual(codes({ specVersion: 2 }), ['U7'])
})
