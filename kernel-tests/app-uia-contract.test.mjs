// uia 驱动的契约诚实性回归网（P1 控制命令覆盖，2026-09-17）。
// ---------------------------------------------------------------------------
// 本文件锁"**不假装有能力**"这条底线。背景实测：
//   · `uia` 的 4 个 act 在契约里存在（`ACTS_BY_DRIVER.uia`），用于让桌面目标在没有 CLI/脚本/接口时
//     仍有一条兜底路径；但后端**未接入**（`runUia` 恒返回"未接入"，`app-runner-desktop.cjs`）。
//   · 而 `desktopRunner` 的 uia 分支**此前不校验 act**：任意 act（甚至拼错的 'clic'）都直通那句
//     "后端尚未接入" ⇒ 用户会以为是后端问题，而不是自己拼错了。报错误导比不报错更费时间。
//
// 同时把"uia 四条在覆盖率里必须记 missing"与"运行期确实失败"两件事对齐：
// 度量说不可用 ⇒ 运行期就必须真的不可用；反之若哪天后端接上了，这里会红，提醒同步覆盖率数据。
// 运行：node --test kernel-tests/app-uia-contract.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { coverageForClass, commandsForClass } from '../shared/app-control-commands.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const require_ = createRequire(import.meta.url)
const { desktopRunner, UIA_ACTS } = require_(join(ROOT, 'electron', 'app-runner-desktop.cjs'))
const gen = require_(join(ROOT, 'electron', 'app-generate.cjs'))

const uiaSpec = (act) => ({
  appId: 't', driver: 'uia', target: { type: 'desktop' },
  commands: [{ action: 'go', kind: 'read', params: [], steps: [{ act }] }],
})

test('本模块的 uia act 清单与生成器契约逐字一致（两处漂移即红）', () => {
  // `app-runner-desktop` 刻意不 require 生成器（只依赖 app-util，便于单测注入 + 避免拉进 600 行生成器），
  // 一致性改由这里对账 —— 与 shared/app-control-commands 对 app-generate 的对账同源。
  assert.deepEqual([...UIA_ACTS].sort(), [...gen.actsFor('uia')].sort(),
    'uia 允许的 act 两处不一致：契约放行但运行器拒绝（或反之）')
})

test('uia 分支不再"任意 act 直通"：未知 act 明确报错并列出可用项', async () => {
  const r = await desktopRunner({ appId: 't', action: 'go', args: {}, spec: uiaSpec('clic') })
  assert.equal(r.ok, false)
  assert.match(String(r.error), /不支持步骤 clic/, `应明确指出 act 不支持：${r.error}`)
  assert.match(String(r.error), /focus/, '错误里应列出可用 act（用户才知道改用哪个）')
  // 关键：错误不能再是"后端未接入" —— 那会把"拼错"误导成"后端没做"
  assert.doesNotMatch(String(r.error), /尚未接入/, '拼错 act 不该报成"后端未接入"（误导）')
})

test('uia 的 4 个合法 act：运行期必须真的失败且如实说明"未接入"（不假装成功）', async () => {
  for (const act of UIA_ACTS) {
    const r = await desktopRunner({ appId: 't', action: 'go', args: {}, spec: uiaSpec(act) })
    assert.equal(r.ok, false, `uia.${act} 后端未接入，绝不能返回成功（假装成功会让 write 命令静默空转）`)
    assert.match(String(r.error), /未接入/, `uia.${act} 应如实说明后端未接入：${r.error}`)
  }
})

test('度量与运行期对齐：覆盖率里记 missing 的 uia 命令，运行期确实跑不通', async () => {
  const missing = coverageForClass('desktop').missing.map((m) => m.id)
  assert.deepEqual(missing, ['focus', 'type', 'key', 'wait'], 'desktop 缺失清单应为 uia 四条')
  // 逐条：覆盖率标 missing 的，运行期失败；覆盖率标可用的，运行器不因"act 不支持"而拒绝
  for (const act of missing) {
    const r = await desktopRunner({ appId: 't', action: 'go', args: {}, spec: uiaSpec(act) })
    assert.equal(r.ok, false, `覆盖率说 ${act} 不可用，运行期却成功了 —— 度量在撒谎`)
  }
  const usable = commandsForClass('desktop').filter((c) => c.implemented).map((c) => c.act)
  assert.deepEqual([...usable].sort(), ['cli', 'query', 'read', 'request', 'script'])
  // 只用一条证明"可用的不会被 act 校验挡住"（真正能跑由 app-runner-desktop 自己的测试覆盖）
  const cliSpec = {
    appId: 't',
    driver: 'process',
    target: { exePath: process.execPath },
    commands: [{ action: 'go', kind: 'read', params: [], steps: [{ act: 'cli', argv: ['-e', 'console.log(1)'] }] }],
  }
  const cli = await desktopRunner({ appId: 't', action: 'go', args: {}, spec: cliSpec })
  assert.equal(cli.ok, true, `process/cli 应可跑：${cli.error}`)
})
