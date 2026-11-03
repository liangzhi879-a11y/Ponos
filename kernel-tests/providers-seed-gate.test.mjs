// 内核 providers.json 播种闸（遗留 C-⑥，2026-09-27）
// ---------------------------------------------------------------------------
// 被修的**洞**（原文在 EGRESS_BOUNDARY 里登记为「尚未接线」）：
//   `kernel/cli.mjs` 启动时 `seedFromFile('<configDir>/providers.json')` 会把该文件里的
//   `apiBaseUrl`/`authToken` 灌进内核注册表 —— 那是**磁盘上的一份凭据**，绕过了"未放行 ⇒
//   不注入凭据"的 env 级收口（桥会剔除 spawn env、清空 settings.json#env 兜底，但管不到这个文件）。
//   它当时发不出去**只因为** `kernel/api.mjs#detectProtocol` 是纯 env 判据，而那条契约被
//   api-protocol.test.mjs 锁着（明确不得读 registry）⇒ 一旦有人把它改成"读注册表兜底"
//   （合理的改动方向），未放行的内核**立刻**能带着这份凭据出网。**是洞不是设计。**
//
// 修法：在**播种这一步**判 —— 未放行 provider 就不播种，凭据根本不进内核。
// 本文件钉住三态（口径的唯一真源是 shared/egress-capability.cjs#capabilitiesOf，此处不复制判据）。
//
// ★ 2026-10-02（真机实测事故）**第二前置**：播种前还须过**陈旧比对**（本文件尾部用例）——
//   providers.json 的写入端已随凭据迁移移除、磁盘上的最后一份永久冻结；照播会用数周前的
//   端点/凭据覆盖用户当下的选择（实测：切到本地模型后全部请求仍发往旧供应商，欠费 ⇒ 本地会话也 402）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { providerCapabilityAllowed, readActiveProvider } from '../kernel/config.mjs'
import { seedFromFile, getProvider, resetProviderForTest } from '../kernel/provider.mjs'

function withConfig(config, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'yfw-provseed-'))
  try {
    if (config !== undefined) {
      writeFileSync(join(dir, 'config.json'), typeof config === 'string' ? config : JSON.stringify(config))
    }
    return fn(dir)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('★ 遗留 C-⑥：显式把 provider 排除在放行表外 ⇒ 不播种（凭据不进内核）', () => {
  assert.equal(withConfig({ network: { capabilities: [] } }, providerCapabilityAllowed), false,
    '空放行表 = "一个都不放行"的明确意志 ⇒ 不得播种')
  assert.equal(withConfig({ network: { capabilities: ['web', 'shell'] } }, providerCapabilityAllowed), false,
    '放行了别的能力但没放 provider ⇒ 同样不得播种（逐能力判定，不是"有一项就全放"）')
})

test('★ 存量零变化：无 network 键（本闸落地前的文件形态）⇒ 照旧播种', () => {
  assert.equal(withConfig({}, providerCapabilityAllowed), true,
    'network 缺键 = legacy 兜底（含 provider）⇒ 存量机器模型能力不受影响')
  assert.equal(withConfig({ some: 'other', model: 'x' }, providerCapabilityAllowed), true, '有别的键但无 network ⇒ 同上')
  assert.equal(withConfig(undefined, providerCapabilityAllowed), true,
    '**根本没有 config.json** ⇒ 按放行（"没配置"不等于"不放行"；否则会把裸机/CI 的模型能力弄没）')
})

test('★ 读不懂 ⇒ 按最严（不播种）：键在但类型非法 / JSON 损坏，都不得当成放行', () => {
  assert.equal(withConfig({ network: { capabilities: 'provider' } }, providerCapabilityAllowed), false,
    '字符串而非数组 ⇒ config-invalid ⇒ 视作 [] ⇒ 不播种（手滑写错一个引号不得比不写更宽）')
  assert.equal(withConfig('{ not json', providerCapabilityAllowed), true,
    'JSON 损坏 ⇒ 退回"读不到"分支（按放行）—— 与 capabilitiesOf 的 legacy 口径一致，不在这里另立一档')
})

test('★ 显式放行 provider ⇒ 播种（闸不误伤正常配置）', () => {
  assert.equal(withConfig({ network: { capabilities: ['provider'] } }, providerCapabilityAllowed), true)
  assert.equal(withConfig({ network: { capabilities: ['provider', 'web'] } }, providerCapabilityAllowed), true)
  assert.equal(withConfig({ network: { capabilities: ['provder'] } }, providerCapabilityAllowed), false,
    '★ 拼错的 provider 被归一丢弃 ⇒ 不放行（丢弃 = 不放行，fail-closed，比用户意图更严）')
})

// ── 第二前置：陈旧比对（2026-10-02 真机实测事故，机理见 kernel/provider.mjs#seedFromFile 头注） ──
// 事故形态：该文件写入端已移除、磁盘上的最后一份永久冻结；内核照播 ⇒ 用户切到本地模型后，
// 全部对话请求仍被发往文件里冻结的旧供应商（欠费 ⇒ 连本地会话也返回 402）。

/** 写一份"可用"的 providers.json（activeProvider 指向同 id 的可用条目）。 */
function withProvidersFile(data, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'yfw-provseed-file-'))
  try {
    if (data !== undefined) writeFileSync(join(dir, 'providers.json'), typeof data === 'string' ? data : JSON.stringify(data))
    return fn(join(dir, 'providers.json'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
const frozenFile = (activeProvider) => ({
  activeProvider,
  providers: [{ id: activeProvider, apiBaseUrl: 'https://frozen.example/old', authToken: 'frozen-token', primaryModel: 'frozen-model' }],
})

test('★ 2026-10-02 陈旧比对：文件 activeProvider ≠ config.json 当前选择 ⇒ 不播种（化石不覆盖当下选择）+ env 权威恢复', () => {
  const saved = { url: process.env.PONOS_BASE_URL, token: process.env.PONOS_AUTH_TOKEN }
  process.env.PONOS_BASE_URL = 'http://current.example'
  process.env.PONOS_AUTH_TOKEN = 'current-token'
  resetProviderForTest()
  try {
    withProvidersFile(frozenFile('deepseek'), (path) => {
      const r = seedFromFile(path, { expectActiveProvider: '1106-muovinsu' })
      assert.deepEqual(r,
        { ok: false, reason: 'stale', fileActiveProvider: 'deepseek', currentActiveProvider: '1106-muovinsu' },
        '不一致 ⇒ stale 且两个 id 都要回给调用方（出声靠它归因）')
      // registry 未激活 ⇒ getProvider() 现读 env —— 这正是"不播种"要保住的东西（用户当下选择）
      assert.equal(getProvider().baseUrl, 'http://current.example')
      assert.equal(getProvider().authToken, 'current-token')
    })
  } finally {
    if (saved.url === undefined) delete process.env.PONOS_BASE_URL; else process.env.PONOS_BASE_URL = saved.url
    if (saved.token === undefined) delete process.env.PONOS_AUTH_TOKEN; else process.env.PONOS_AUTH_TOKEN = saved.token
    resetProviderForTest()
  }
})

test('陈旧比对不误伤：一致 ⇒ 照播（P4-1 链零变化）；无当前选择（裸跑内核）⇒ 无从比对、照播', () => {
  resetProviderForTest()
  try {
    withProvidersFile(frozenFile('deepseek'), (path) => {
      const r = seedFromFile(path, { expectActiveProvider: 'deepseek' })
      assert.equal(r.ok, true)
      assert.equal(r.reason, 'seeded')
      assert.equal(getProvider().baseUrl, 'https://frozen.example/old', '一致 ⇒ 照播（存量行为不变）')
    })
    resetProviderForTest()
    withProvidersFile(frozenFile('deepseek'), (path) => {
      const r = seedFromFile(path) // 裸跑形态：expectActiveProvider 缺省 null
      assert.equal(r.ok, true)
      assert.equal(r.reason, 'seeded')
    })
  } finally { resetProviderForTest() }
})

test('陈旧比对：任一侧缺值 ⇒ 无从比对，不判 stale（走原有可用性判定）', () => {
  resetProviderForTest()
  try {
    withProvidersFile({ providers: [] }, (path) => {
      const r = seedFromFile(path, { expectActiveProvider: 'deepseek' })
      assert.equal(r.reason, 'unusable', '文件没有 activeProvider ⇒ 不判 stale，按不可用处理')
    })
    withProvidersFile(frozenFile('deepseek'), (path) => {
      const r = seedFromFile(path, { expectActiveProvider: '' })
      assert.equal(r.reason, 'seeded', '空串 = 没有当前选择 ⇒ 无从比对 ⇒ 照播（与裸跑同口径）')
    })
    withProvidersFile(frozenFile('deepseek'), (path) => {
      const r = seedFromFile(path, { expectActiveProvider: 'deepseek' })
      assert.equal(r.reason, 'seeded')
    })
  } finally { resetProviderForTest() }
})

test('readActiveProvider：读 config.json#activeProvider；读不到/非法 ⇒ null（无从比对，不得误判）', () => {
  assert.equal(withConfig({ activeProvider: '1106-muovinsu' }, (dir) => readActiveProvider(dir)), '1106-muovinsu')
  assert.equal(withConfig({ activeProvider: 123 }, (dir) => readActiveProvider(dir)), null, '非字符串 ⇒ null')
  assert.equal(withConfig({ activeProvider: '' }, (dir) => readActiveProvider(dir)), null, '空串 ⇒ null')
  assert.equal(withConfig({}, (dir) => readActiveProvider(dir)), null)
  assert.equal(withConfig('{ not json', (dir) => readActiveProvider(dir)), null, 'JSON 损坏 ⇒ null（不在这里另立一档）')
  assert.equal(withConfig(undefined, (dir) => readActiveProvider(dir)), null, '没有 config.json ⇒ null')
})
