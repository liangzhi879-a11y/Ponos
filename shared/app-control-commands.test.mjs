// 全量控制命令目录 + 覆盖率的回归网（P1「真正 agent 可智控」，2026-09-17）。
// ---------------------------------------------------------------------------
// 本文件是本项**最关键的护栏**：它把"目录里声称的"与"代码里真实的"对账。
//   ① **分母不许缩水**：web=12 / desktop=9 写死断言；desktop 里 uia 的 4 条必须**留在分母**
//      且 `implemented:false` —— 删掉它们就能把 desktop 从 56% 刷成 100%，这是本项最该防的自欺。
//   ② **契约 ⊆ 执行器**：`app-generate.cjs` 的 `actsFor('browser')` 必须 ⊆ `browser-executor.cjs`
//      的 `runAction` case 集合（否则模型能写出、校验放行、运行期抛"未知动作"）。
//   ③ **执行器 ⊆ 契约**（对"控制类"而言）：执行器里除明确排除的编排动作外，不得有"能跑但模型写不出来"
//      的动作 —— 这正是本次补 back/forward/refresh 的依据（补之前此断言必红，是真缺口不是形式）。
//   ④ 排除项必须有据：`EXCLUDED_ORCHESTRATION_ACTS` 每个都必须是执行器里真实存在的 case。
// 运行：node --test shared/app-control-commands.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import {
  CONTROL_COMMANDS, COVERAGE_THRESHOLD, EXCLUDED_ORCHESTRATION_ACTS, classOfDriver, commandI18nKey,
  commandsForClass, coverageForClass, coverageReport, missingIdsText, specCoverage,
} from './app-control-commands.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const require_ = createRequire(import.meta.url)
const gen = require_(join(ROOT, 'electron', 'app-generate.cjs'))

/** 从 browser-executor.cjs 源码里抠出 `runAction` 的 case 集合（真实执行能力，唯一事实来源）。 */
function executorActs() {
  const src = readFileSync(join(ROOT, 'electron', 'browser-executor.cjs'), 'utf8')
  const start = src.indexOf('async runAction')
  assert.ok(start > 0, 'browser-executor.cjs 里找不到 runAction（执行能力取不到，本测试失去意义）')
  // 切到**下一个方法定义**为止。注意：不能只找 `async xxx(` —— runAction 之后紧跟的是
  // **同步**方法 `actionLabel(action, params)`，它内部还有一个 `switch (action)` 的动作中文标签表
  // （比派发表少一个 `js`）。若取窗过宽会把它一起算进来，"派发表少一个 case"这种缺陷就会被掩盖。
  const rest = src.slice(start + 10)
  const next = rest.search(/\n  [a-zA-Z_][a-zA-Z0-9_]*\(/)
  assert.ok(next > 0, 'runAction 之后找不到下一个方法定义（取窗方式需更新，勿放宽断言）')
  const body = rest.slice(0, next)
  const acts = new Set()
  for (const m of body.matchAll(/case '([a-z_]+)':/g)) acts.add(m[1])
  // 取窗内应当**只有派发表这一个 switch**（多一个就说明取窗又宽了）
  assert.equal((body.match(/switch \(/g) || []).length, 1, `取窗内出现了多个 switch，本测试的取窗已不精确：${[...acts]}`)
  return acts
}

const ACTS = executorActs()

test('分母是契约、写死在代码里：web=12 / desktop=9（不许随实现缩水）', () => {
  assert.equal(commandsForClass('web').length, 12, 'web 全量控制命令必须是 12 条')
  assert.equal(commandsForClass('desktop').length, 9, 'desktop 全量控制命令必须是 9 条')
  // id 唯一（重复会让缺失清单与 i18n key 撞车）
  for (const cls of ['web', 'desktop']) {
    const ids = commandsForClass(cls).map((c) => c.id)
    assert.equal(new Set(ids).size, ids.length, `${cls} 的 id 有重复：${ids}`)
    for (const c of commandsForClass(cls)) assert.equal(c.i18nKey, undefined, 'i18n key 由函数派生，不写进数据')
  }
  // 取用函数返回副本：外部改不动内部常量（否则覆盖率可被调用方偷偷改）
  const copy = commandsForClass('web')
  copy[0].implemented = false
  assert.equal(commandsForClass('web')[0].implemented, true, 'commandsForClass 必须返回副本')
})

test('desktop 的 uia 四条必须留在分母里且标 implemented:false（防"删分母刷分"）', () => {
  const desktop = commandsForClass('desktop')
  for (const id of ['focus', 'type', 'key', 'wait']) {
    const c = desktop.find((x) => x.id === id)
    assert.ok(c, `desktop 分母缺 ${id}（删掉它会让覆盖率虚假上升）`)
    assert.equal(c.driver, 'uia')
    assert.equal(c.implemented, false, `${id} 的后端未接入，必须如实记 false`)
    assert.ok(c.reasonKey, `${id} 必须带原因 key（界面要说明为什么缺）`)
  }
  // 而前五条必须真可用（否则覆盖率本身失真）
  for (const id of ['cli', 'script', 'request', 'read', 'query']) {
    assert.equal(desktop.find((x) => x.id === id).implemented, true, `${id} 应可用`)
  }
})

test('覆盖率：web=12/12 达标；desktop=5/9 不达标且缺失清单正确', () => {
  const web = coverageForClass('web')
  assert.equal(web.total, 12)
  assert.equal(web.covered, 12, `web 应 12/12（缺：${missingIdsText('web')}）`)
  assert.equal(web.ratio, 1)
  assert.equal(web.met, true)
  assert.deepEqual(web.missing, [])

  const d = coverageForClass('desktop')
  assert.equal(d.total, 9)
  assert.equal(d.covered, 5)
  assert.equal(d.met, false, 'desktop 5/9=56% < 70%，必须判不达标（不许四舍五入成达标）')
  assert.ok(Math.abs(d.ratio - 5 / 9) < 1e-9)
  assert.deepEqual(d.missing.map((m) => m.id), ['focus', 'type', 'key', 'wait'])
  assert.equal(d.missing[0].i18nKey, 'apps.cmd_desktop_focus')
  assert.match(String(d.missing[0].reasonKey), /Uia/)

  // 阈值边界：恰好 70% 算达标（>= 而不是 >）
  assert.equal(COVERAGE_THRESHOLD, 0.7)
  assert.deepEqual(coverageReport().map((r) => r.class), ['web', 'desktop'])
})

test('未知类别/驱动不抛：返回零值/unknown，界面拿到脏值也不该崩', () => {
  const r = coverageForClass('mobile')
  assert.equal(r.total, 0)
  assert.equal(r.covered, 0)
  assert.equal(r.met, false)
  assert.equal(r.unknown, true)
  assert.equal(classOfDriver('nonsense'), null)
  assert.equal(classOfDriver(''), null)
  assert.equal(classOfDriver('browser'), 'web')
  for (const d of ['process', 'script', 'uia', 'http', 'file']) assert.equal(classOfDriver(d), 'desktop', d)
  const s = specCoverage({ driver: 'nonsense', commands: [] })
  assert.equal(s.unknownDriver, true)
  assert.equal(s.class, null)
})

test('契约 ⊆ 执行器：browser 允许的 act 必须每个都能真跑（否则运行期抛"未知动作"）', () => {
  const allowed = gen.actsFor('browser')
  for (const act of allowed) {
    assert.ok(ACTS.has(act), `契约允许 ${act}，但执行器没有这个分支 ⇒ 生成出来的命令一跑就炸`)
  }
})

test('执行器 ⊆ 契约（控制类）：能跑的控制动作必须都能被模型写出来（本次补 3 个的依据）', () => {
  // 精确断言 15 个：执行器**新增** act 时这里会红 —— 那不是麻烦，而是刻意留的决策点
  // （新增的控制类 act 要同步进契约与目录，否则又是一次"能力被锁住"）。
  assert.deepEqual([...ACTS].sort(), [
    'back', 'click', 'close', 'forward', 'goto', 'hover', 'js', 'pause_for_human',
    'refresh', 'resume', 'scroll', 'select', 'snapshot', 'type', 'wait',
  ], '执行器的 act 集合变了：请同步契约（ACTS_BY_DRIVER.browser）与全量命令目录')
  const allowed = new Set(gen.actsFor('browser'))
  const excluded = new Set(EXCLUDED_ORCHESTRATION_ACTS)
  const orphan = [...ACTS].filter((a) => !allowed.has(a) && !excluded.has(a))
  assert.deepEqual(orphan, [],
    `执行器支持但这些动作模型写不出来（能力被白白锁住）：${orphan.join(', ')}`)
})

test('排除项有据：每个编排动作都必须是执行器里真实存在的 case', () => {
  assert.deepEqual([...EXCLUDED_ORCHESTRATION_ACTS].sort(), ['close', 'pause_for_human', 'resume'])
  for (const act of EXCLUDED_ORCHESTRATION_ACTS) {
    assert.ok(ACTS.has(act), `${act} 被列为"编排类排除"，但执行器里没有它 —— 排除得有据`)
    assert.ok(!gen.actsFor('browser').includes(act), `${act} 是编排动作，不该进控制命令契约`)
  }
})

test('目录 ↔ 契约逐条对齐：web 12 条全在契约里；desktop 的 5 条可用者也在（uia 除外）', () => {
  const browser = new Set(gen.actsFor('browser'))
  for (const c of commandsForClass('web')) {
    assert.equal(c.driver, 'browser')
    assert.ok(browser.has(c.act), `web 目录里的 ${c.id}（act=${c.act}）不在契约里 ⇒ 模型写不出来`)
  }
  // 逐驱动对齐（desktop 的 5 条可用者）
  for (const c of commandsForClass('desktop').filter((x) => x.implemented)) {
    assert.ok(gen.actsFor(c.driver).includes(c.act), `desktop 目录里 ${c.id} 与 ${c.driver} 契约不一致`)
  }
  // uia 的四条是"契约里有、后端没有" ⇒ 契约侧仍应包含（本项不改契约，只在度量层标不可用）
  for (const c of commandsForClass('desktop').filter((x) => !x.implemented)) {
    assert.ok(gen.actsFor(c.driver).includes(c.act),
      `${c.id} 已从契约移除 —— 那本次的"度量层标注"就失去意义（请不要顺手改契约）`)
  }
})

test('specCoverage：按"用到什么"如实报告，但不参与 70% 判定（真实语料的失真就是证据）', () => {
  const spec = {
    driver: 'browser',
    commands: [
      { action: 'openHome', steps: [{ act: 'goto' }, { act: 'wait' }, { act: 'snapshot' }] },
      { action: 'callApi', steps: [{ act: 'js' }] },
    ],
  }
  const r = specCoverage(spec)
  assert.equal(r.class, 'web')
  assert.deepEqual(r.usedActs, ['goto', 'js', 'snapshot', 'wait'])
  assert.deepEqual(r.usedIds, ['goto', 'snapshot', 'js', 'wait'].filter((x) => r.usedIds.includes(x)))
  // 未用到的能力仍在（这就是不能用"用到/全量"当覆盖率的原因）
  for (const id of ['click', 'type', 'scroll', 'back']) assert.ok(r.unusedIds.includes(id), `${id} 应记未用到`)
  assert.ok(r.usedIds.length < coverageForClass('web').total)
})

test('真实语料（~/.yfw/apps）：能跑出类别与"用到什么"，缺目录则跳过', () => {
  const base = join(process.env.USERPROFILE || process.env.HOME || '', '.yfw', 'apps')
  if (!existsSync(base)) return // 新机器/CI 无该目录：跳过（本测试是取证，不是门槛）
  const rows = []
  for (const dir of readdirSync(base)) {
    const p = join(base, dir, 'spec.json')
    if (!existsSync(p)) continue
    let spec
    try { spec = JSON.parse(readFileSync(p, 'utf8')) } catch { continue }
    const r = specCoverage(spec)
    rows.push({ dir, driver: r.driver, class: r.class, cmds: (spec.commands || []).length })
    assert.ok(r.class, `${dir} 的 driver=${r.driver} 落不进任何类别（目录口径有漏？）`)
  }
  assert.ok(rows.length >= 1, '有真实 Spec 目录却一条都没读到')
  for (const r of rows) assert.ok(['web', 'desktop'].includes(r.class))
})
