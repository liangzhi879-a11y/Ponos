// 网络代理策略的回归网（P1「应用内增加网络VPN代理配置功能」，2026-09-17）。
// ---------------------------------------------------------------------------
// 本文件锁四类"错了会很难查"的性质：
//   ① **off 零行为变化**：一个代理变量都不注入（与本方案落地前逐字节一致）。
//   ② **回环不可被配置覆盖**：用户只填自己的 bypass 时，127.0.0.1/localhost/::1 仍必须在列
//      ——这是"应用连不上自己的桥"这一生产事故的唯一防线。
//   ③ **非法输入出声**：非法 URL/模式必须带 error 返回，**不得静默降级为直连**
//      （静默降级的症状是"配了代理却没走"，与代理无关的报错，排障成本极高）。
//   ④ **凭据不打码落盘、也不丢**：打码回显保存后必须回填真密码；磁盘本无密码时不得凭空写 `***`。
// 运行：node --test shared/proxy-config.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  LOOPBACK_BYPASS, bypassListWithLoopback, chromiumProxyOptions, isRedactedProxyUrl,
  mergeProxyPatch, nodeProxyEnv, normalizeBypassList, normalizeProxyConfig,
  redactProxyConfig, redactProxyUrl, restoreRedactedProxyUrl,
} from './proxy-config.mjs'

const MANUAL = { mode: 'manual', url: 'http://127.0.0.1:7890', bypass: '' }

test('off（缺省/空/任意形态）：Node 轨一个变量都不注入，Chromium 轨不调用 setProxy', () => {
  for (const raw of [undefined, null, {}, { mode: 'off' }, { mode: 'OFF' }, 'nonsense']) {
    assert.deepEqual(nodeProxyEnv(raw), {}, `off 不得注入任何代理变量：${JSON.stringify(raw)}`)
    assert.equal(chromiumProxyOptions(raw), null, `off 不得调用 setProxy（不干预系统代理）：${JSON.stringify(raw)}`)
  }
  // 刻意不返回 {mode:'direct'}：Chromium 默认跟随系统代理，主动设 direct 会改掉用户的系统设置，
  // 违反"off 与落地前行为逐字节一致"这条验收基线。
  assert.notDeepEqual(chromiumProxyOptions({ mode: 'off' }), { mode: 'direct' })
})

test('manual：两轨都下发，且大小写变量各一份（Node 两种拼写都认）', () => {
  const env = nodeProxyEnv({ mode: 'manual', url: 'http://127.0.0.1:7890' })
  assert.equal(env.NODE_USE_ENV_PROXY, '1')
  assert.equal(env.HTTP_PROXY, 'http://127.0.0.1:7890')
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7890')
  assert.equal(env.http_proxy, env.HTTP_PROXY)
  assert.equal(env.https_proxy, env.HTTPS_PROXY)
  const chrom = chromiumProxyOptions({ mode: 'manual', url: 'http://127.0.0.1:7890' })
  assert.equal(chrom.proxyRules, 'http://127.0.0.1:7890')
})

test('回环强制并入绕过列表：用户只填自己的绕过项也改不掉 127.0.0.1/localhost/::1', () => {
  const env = nodeProxyEnv({ mode: 'manual', url: 'http://127.0.0.1:7890', bypass: 'example.com, 10.0.0.0/8' })
  const noProxy = env.NO_PROXY.split(',').map((s) => s.trim())
  for (const host of LOOPBACK_BYPASS) {
    assert.ok(noProxy.includes(host), `NO_PROXY 必须含 ${host}（否则桥通信会被代理劫持）：${env.NO_PROXY}`)
  }
  // 反向：用户**只**填 bypass、完全不提回环时，回环仍在（这是本项最关键的一条）
  const only = bypassListWithLoopback('a.com')
  for (const host of LOOPBACK_BYPASS) assert.ok(only.includes(host))
  // 用户重复填回环 ⇒ 去重，不出现两次（否则绕过表越滚越长）
  const dup = bypassListWithLoopback('127.0.0.1,127.0.0.1,LOCALHOST')
  assert.equal(dup.filter((h) => h.toLowerCase() === '127.0.0.1').length, 1)
  assert.equal(dup.filter((h) => h.toLowerCase() === 'localhost').length, 1)
  // Chromium 轨同样带绕过列表
  assert.ok(chromiumProxyOptions({ mode: 'manual', url: 'http://x:1' }).proxyBypassRules.includes('127.0.0.1'))
})

test('非法 URL / 非法模式：ok:false 且带可读 error，绝不静默降级', () => {
  const bad = [
    { mode: 'manual' },                                   // 空地址
    { mode: 'manual', url: '   ' },
    { mode: 'manual', url: '127.0.0.1:7890' },            // 缺 scheme
    { mode: 'manual', url: 'ftp://127.0.0.1:21' },        // 不支持的协议
    { mode: 'manual', url: 'socks4://127.0.0.1:1080' },   // Node 侧不支持
    { mode: 'manual', url: 'http://127.0.0.1:7890/dashboard' }, // 从浏览器地址栏复制的带路径值
    { mode: 'manual', url: 'http://127.0.0.1:7890/?x=1' },
  ]
  for (const raw of bad) {
    const r = normalizeProxyConfig(raw)
    assert.equal(r.ok, false, `应判非法：${JSON.stringify(raw)}`)
    assert.ok(r.error && r.error.length > 0, '非法必须带 error（否则调用方无法出声）')
    assert.equal(r.value.mode, 'off', '非法时取安全默认（不代理）')
    assert.deepEqual(nodeProxyEnv(raw), {}, '非法时不得注入代理变量')
  }
  const modeBad = normalizeProxyConfig({ mode: 'yolo' })
  assert.equal(modeBad.ok, false)
  assert.match(modeBad.error, /yolo/)
})

test('合法形态：socks5 放行、凭据放行、无端口放行（默认端口由 Node/Chromium 自行判定）', () => {
  const ok = [
    'socks5://127.0.0.1:1080',
    'http://user:pass@127.0.0.1:7890',
    'https://proxy.corp.example:8443',
    'http://proxy.example',
  ]
  for (const url of ok) {
    assert.equal(normalizeProxyConfig({ mode: 'manual', url }).ok, true, `应合法：${url}`)
  }
})

test('system：Chromium 轨跟随系统，Node 轨明确不猜（返回空补丁）', () => {
  assert.deepEqual(nodeProxyEnv({ mode: 'system' }), {}, 'Node 无跨平台读系统代理的标准 API ⇒ 不猜')
  assert.deepEqual(chromiumProxyOptions({ mode: 'system' }), { mode: 'system' })
  // 即便配置里残留 url，system 档也不得把它用于 Node 轨（否则"跟随系统"名不副实）
  assert.deepEqual(nodeProxyEnv({ mode: 'system', url: 'http://127.0.0.1:7890' }), {})
})

test('幂等：同一配置算两次结果逐字节一致', () => {
  const raw = { mode: 'manual', url: 'http://u:p@127.0.0.1:7890', bypass: ' b.com , a.com ,, b.com ' }
  assert.equal(JSON.stringify(nodeProxyEnv(raw)), JSON.stringify(nodeProxyEnv(raw)))
  assert.equal(JSON.stringify(chromiumProxyOptions(raw)), JSON.stringify(chromiumProxyOptions(raw)))
  assert.equal(JSON.stringify(normalizeProxyConfig(raw)), JSON.stringify(normalizeProxyConfig(raw)))
})

test('bypass 归一：数组/字符串等价，去空白去空项、按大小写不敏感去重，输出逗号串', () => {
  assert.deepEqual(normalizeBypassList('a.com, b.com ,,B.COM'), ['a.com', 'b.com'])
  assert.deepEqual(normalizeBypassList(['a.com', ' b.com ', '', null, 'A.com']), ['a.com', 'b.com'])
  assert.equal(normalizeProxyConfig({ mode: 'manual', url: 'http://x:1', bypass: ' a ,A, b ' }).value.bypass, 'a,b')
  assert.deepEqual(normalizeBypassList(undefined), [])
})

test('凭据脱敏与回填：打码回显不落盘、磁盘无密码时不凭空造 `***`', () => {
  // 脱敏
  assert.equal(redactProxyUrl('http://u:p@127.0.0.1:7890'), 'http://u:***@127.0.0.1:7890')
  assert.equal(redactProxyUrl('http://u@127.0.0.1:7890'), 'http://u@127.0.0.1:7890', '只有用户名时无密码可打码')
  assert.equal(redactProxyUrl('http://127.0.0.1:7890'), 'http://127.0.0.1:7890')
  assert.equal(isRedactedProxyUrl('http://u:***@h:1'), true)
  assert.equal(isRedactedProxyUrl('http://u:p@h:1'), false)
  // 回填（磁盘有密码）
  assert.equal(
    restoreRedactedProxyUrl('http://u:***@127.0.0.1:7891', 'http://u:realpass@127.0.0.1:7890'),
    'http://u:realpass@127.0.0.1:7891',
    '改端口不该把密码换成字面量 ***',
  )
  // 回填（磁盘无密码）⇒ 还原成无凭据形态，不得留下 ***
  const noPass = restoreRedactedProxyUrl('http://u:***@127.0.0.1:7890', 'http://u@127.0.0.1:7890')
  assert.equal(noPass, 'http://u@127.0.0.1:7890')
  assert.ok(!noPass.includes('***'))
  // 未打码的值原样返回（不重建 URL、不加尾斜杠）
  assert.equal(restoreRedactedProxyUrl('http://h:1', 'http://u:p@h:1'), 'http://h:1')
})

test('mergeProxyPatch：局部补丁继承现值、切档不丢 url、打码保存回填真密码', () => {
  const current = { mode: 'manual', url: 'http://u:p@127.0.0.1:7890', bypass: 'example.com' }
  // 只改 bypass ⇒ mode/url 保持
  const onlyBypass = mergeProxyPatch({ bypass: 'a.com' }, current)
  assert.equal(onlyBypass.ok, true)
  assert.equal(onlyBypass.value.mode, 'manual')
  assert.equal(onlyBypass.value.url, current.url)
  assert.equal(onlyBypass.value.bypass, 'a.com')
  // 切到 off ⇒ url 仍保留（否则 manual→off→manual 一个来回用户填的地址就没了）
  const off = mergeProxyPatch({ mode: 'off' }, current)
  assert.equal(off.value.mode, 'off')
  assert.equal(off.value.url, current.url, '切档必须不丢 url')
  // 前端把打码值发回来（用户只改了端口）⇒ 落盘必须是真密码
  const saved = mergeProxyPatch({ url: 'http://u:***@127.0.0.1:7891' }, current)
  assert.equal(saved.value.url, 'http://u:p@127.0.0.1:7891')
  assert.ok(!saved.value.url.includes('***'))
  // 非法补丁照旧出声
  assert.equal(mergeProxyPatch({ mode: 'manual', url: 'bad' }, current).ok, false)
})

test('redactProxyConfig：只改 network.proxy.url，其余键（含其它嵌套对象）引用不变', () => {
  const other = { a: 1 }
  const cfg = { activeProvider: 'x', providers: [], network: { proxy: { mode: 'manual', url: 'http://u:p@h:1' }, other } }
  const out = redactProxyConfig(cfg)
  assert.equal(out.network.proxy.url, 'http://u:***@h:1')
  assert.equal(out.activeProvider, 'x')
  assert.equal(out.network.other, other, '不应深拷贝整份配置')
  assert.equal(cfg.network.proxy.url, 'http://u:p@h:1', '不得就地改写原对象')
  // 无 network 键时原样返回（老 config.json）
  assert.equal(redactProxyConfig({ activeProvider: 'x' }).network, undefined)
  assert.equal(redactProxyConfig(null), null)
})
