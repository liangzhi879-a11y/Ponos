// src/lib/proxyUi.test.ts —— 网络代理 UI 归约/校验回归网（P1，2026-09-17）
// node --test src/lib/proxyUi.test.ts
//
// 本文件锁两件事：
//   ① 归约与校验的边界行为（空地址、缺 scheme、带路径、未知档位、回环强制项）。
//   ② **与后端唯一实现 shared/proxy-config.cjs 的等价性**：同一组样本喂两侧，
//      "界面放行"必须与"后端接受"一一对应。不等价就会出"界面说没问题、保存被 400"
//      （或更糟：界面拦下合法值，用户根本存不进去）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import {
  DEFAULT_PROXY_UI, LOOPBACK_BYPASS, effectiveBypass, normalizeProxyUi, proxyPatch, proxyStatusKey,
  splitBypass, validateProxyUi,
} from './proxyUi.ts'

const require_ = createRequire(import.meta.url)
const backend = require_('../../shared/proxy-config.cjs')

test('归约：未知档位回落 off（不抛、不猜），url 去空白，bypass 去重', () => {
  assert.deepEqual(normalizeProxyUi(undefined), DEFAULT_PROXY_UI)
  assert.deepEqual(normalizeProxyUi(null), DEFAULT_PROXY_UI)
  assert.deepEqual(normalizeProxyUi('nonsense'), DEFAULT_PROXY_UI)
  assert.equal(normalizeProxyUi({ mode: 'yolo' }).mode, 'off')
  assert.equal(normalizeProxyUi({ mode: 'MANUAL' }).mode, 'manual')
  assert.equal(normalizeProxyUi({ mode: 'manual', url: '  http://h:1  ' }).url, 'http://h:1')
  assert.equal(normalizeProxyUi({ bypass: ' a.com ,A.COM,, b.com ' }).bypass, 'a.com,b.com')
  assert.deepEqual(splitBypass(['a', ' A ', '', null]), ['a'])
})

test('校验：manual 才校验地址；空/缺 scheme/非法协议/带路径都要拦下', () => {
  assert.equal(validateProxyUi({ mode: 'off', url: '', bypass: '' }), null)
  assert.equal(validateProxyUi({ mode: 'system', url: '', bypass: '' }), null)
  // 合法形态（含 socks5 与凭据）
  for (const url of ['http://127.0.0.1:7890', 'socks5://127.0.0.1:1080', 'https://u:p@proxy.corp:8443', 'http://proxy.example']) {
    assert.equal(validateProxyUi({ mode: 'manual', url, bypass: '' }), null, `应判合法：${url}`)
  }
  assert.equal(validateProxyUi({ mode: 'manual', url: '', bypass: '' }), 'settings.proxyErrUrlRequired')
  assert.equal(validateProxyUi({ mode: 'manual', url: '127.0.0.1:7890', bypass: '' }), 'settings.proxyErrScheme')
  assert.equal(validateProxyUi({ mode: 'manual', url: 'ftp://h:1', bypass: '' }), 'settings.proxyErrScheme')
  assert.equal(validateProxyUi({ mode: 'manual', url: 'socks4://h:1', bypass: '' }), 'settings.proxyErrScheme')
  // 从浏览器地址栏复制的带路径值 —— 后端会拒绝，界面必须提前说清
  assert.equal(validateProxyUi({ mode: 'manual', url: 'http://127.0.0.1:7890/dashboard', bypass: '' }), 'settings.proxyErrHasPath')
  assert.equal(validateProxyUi({ mode: 'manual', url: 'http://h:1/?x=1', bypass: '' }), 'settings.proxyErrHasPath')
})

test('回环强制项：用户只能追加，改不掉 127.0.0.1/localhost/::1（界面与后端同口径）', () => {
  const eff = effectiveBypass('example.com')
  for (const host of LOOPBACK_BYPASS) assert.ok(eff.includes(host), `生效列表必须含 ${host}`)
  assert.ok(eff.includes('example.com'))
  // 大小写不敏感去重：用户写 LOCALHOST 不再多出一项
  const dup = effectiveBypass('127.0.0.1, LOCALHOST, ::1')
  assert.equal(dup.filter((h) => h.toLowerCase() === 'localhost').length, 1)
  // 与后端实际生效列表一致（后端 nodeProxyEnv 的 NO_PROXY 就是这一份）
  const env = backend.nodeProxyEnv({ mode: 'manual', url: 'http://h:1', bypass: 'example.com' })
  assert.deepEqual(env.NO_PROXY.split(','), effectiveBypass('example.com'))
})

test('等价性：界面放行 ⇔ 后端接受（同一组样本喂两侧）', () => {
  const samples: unknown[] = [
    undefined, null, {}, { mode: 'off' }, { mode: 'system' }, { mode: 'yolo' },
    { mode: 'manual' }, { mode: 'manual', url: '' }, { mode: 'manual', url: '   ' },
    { mode: 'manual', url: '127.0.0.1:7890' },
    { mode: 'manual', url: 'http://127.0.0.1:7890' },
    { mode: 'manual', url: 'socks5://127.0.0.1:1080' },
    { mode: 'manual', url: 'https://u:p@h:8443' },
    { mode: 'manual', url: 'ftp://h:1' },
    { mode: 'manual', url: 'socks4://h:1' },
    { mode: 'manual', url: 'http://127.0.0.1:7890/dashboard' },
    { mode: 'manual', url: 'http://h:1/?x=1' },
    { mode: 'MANUAL', url: 'http://h:1' },
  ]
  for (const raw of samples) {
    // 真实链路：界面先归约再提交，后端收到的是**归约后的值** ⇒ 两侧都用归约值比
    const uiValue = normalizeProxyUi(raw)
    const uiAllows = validateProxyUi(uiValue) === null
    const backendAccepts = backend.normalizeProxyConfig(uiValue).ok === true
    assert.equal(uiAllows, backendAccepts,
      `界面与后端判定不一致：${JSON.stringify(raw)} → UI=${uiAllows} 后端=${backendAccepts}`)
  }
})

test('提交补丁形状与状态 key：只发 proxy 一段、档位文案 key 齐备', () => {
  const patch = proxyPatch({ mode: 'manual', url: ' http://h:1 ', bypass: ' a ,A ' })
  assert.deepEqual(Object.keys(patch), ['proxy'])
  assert.deepEqual(patch.proxy, { mode: 'manual', url: 'http://h:1', bypass: 'a' })
  assert.equal(proxyStatusKey({ mode: 'off', url: '', bypass: '' }), 'settings.proxyStatusOff')
  assert.equal(proxyStatusKey({ mode: 'system', url: '', bypass: '' }), 'settings.proxyStatusSystem')
  assert.equal(proxyStatusKey({ mode: 'manual', url: 'http://h:1', bypass: '' }), 'settings.proxyStatusManual')
})
