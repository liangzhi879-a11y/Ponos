// 供应商画像一致性：src/lib/providerProfileUi.ts ≡ server/provider-profile.mjs
// ---------------------------------------------------------------------------
// 为什么需要：状态栏底部那颗图标（本地=芯片 / 云端=云）由渲染层判定，而**内核 env 的
// 行为画像**由服务端 `resolveProviderProfile()` 判定。两边一旦不一致，界面就在撒谎：
// 显示芯片图标（本地）实际请求打到云端，或反过来——不报错、不崩，只在用户纳闷时才暴露。
// 本仓库既有同类守卫：log-ui ↔ log-policy、knowledge-import ↔ knowledge-import-policy。
//
// 放在 server/（不在 tsconfig include 内）才能从 .mjs 直接 import .ts；
// 依赖方向 safety：src/lib/providerProfileUi.ts 是零依赖纯模块（不 import React/store）。
//
// 动态导入而非静态：`release/YFWorking/` 只发 server/ electron/ dist/，**不含 src/**，
// 而该目录同样带 `.test.mjs`。静态 import 会让发布目录里的套件永久红一条。
// ⚠️ skip 判据必须**先看文件在不在**，不能靠"报错消息里有没有这个路径"：Node 对"入口文件自身
// 依赖解析失败"的报错同样带 `imported from <入口路径>`，那样会把**真失败**（比如镜像里 import 了
// 解析不到的包）吞成静默跳过 —— 独立审查实测确认过这一点。故：文件不存在 ⇒ 跳过；存在 ⇒
// 正常导入，任何异常一律抛出。
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveProviderProfile, activeProviderModel } from './provider-profile.mjs'

const UI_ENTRY = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib', 'providerProfileUi.ts')
let ui = null
let uiSkip = false
if (existsSync(UI_ENTRY)) {
  ui = await import('../src/lib/providerProfileUi.ts')
} else {
  uiSkip = true
}
const SKIP = uiSkip ? '发布目录无 src/lib/providerProfileUi.ts，一致性守卫仅在源码树运行' : false

/** 用例表故意覆盖两侧都可能分叉的边界（协议、IPv6、端口、大小写、显式画像覆盖） */
const CASES = [
  // 显式画像优先
  { profile: 'local', apiBaseUrl: 'https://api.deepseek.com' },
  { profile: 'cloud', apiBaseUrl: 'http://127.0.0.1:8000/v1' },
  { profile: 'LOCAL', apiBaseUrl: 'https://api.openai.com' },
  { profile: ' Cloud ', apiBaseUrl: 'http://127.0.0.1' },
  { profile: 'auto', apiBaseUrl: 'http://127.0.0.1:8000/v1' },
  // 私有网段 → local
  { apiBaseUrl: 'http://127.0.0.1:8000/v1' },
  { apiBaseUrl: 'http://localhost:11434/v1' },
  { apiBaseUrl: 'http://[::1]:8080/v1' },
  { apiBaseUrl: 'http://10.0.0.5/v1' },
  { apiBaseUrl: 'http://192.168.1.20:8000/v1' },
  { apiBaseUrl: 'http://172.16.3.9/v1' },
  { apiBaseUrl: 'http://172.31.255.1/v1' },
  // 云域名 → cloud
  { apiBaseUrl: 'https://api.deepseek.com' },
  { apiBaseUrl: 'https://api.minimaxi.com/v1' },
  { apiBaseUrl: 'https://api.anthropic.com' },
  // 公网 IP：明文 http 视为自建（local），https 视为托管（cloud）
  { apiBaseUrl: 'http://8.8.8.8:8000/v1' },
  { apiBaseUrl: 'https://8.8.8.8/v1' },
  { apiBaseUrl: 'http://1.2.3.4' },
  // 认不出的域名 → cloud（缺省保守）
  { apiBaseUrl: 'https://api.some-vendor.example/v1' },
  { apiBaseUrl: 'https://openrouter.ai/api/v1' },
  // 边界/脏值（**刻意不含 `null`**：服务端 `resolveProviderProfile(null)` 会抛 TypeError，
  // 而渲染层必须容忍 null —— 配置未加载完就会走到这里。此差异是**有意**的，见下面那条用例）
  { apiBaseUrl: '' },
  { apiBaseUrl: undefined },
  { apiBaseUrl: null },
  { apiBaseUrl: 'not a url' },
  { apiBaseUrl: 'http://172.15.0.1/v1' },  // 172.15 不在私网段内 → cloud 域名分支兜底
  { apiBaseUrl: 'http://172.32.0.1/v1' },  // 172.32 同理
  {},
  undefined,
  { apiBaseUrl: 'https://api.deepseek.com.evil.example' }, // 后缀伪装：不得被 CLOUD_DOMAIN_RE 命中
  { apiBaseUrl: 'https://notdeepseek.com' },
]

test('画像判定一致性：同一批输入，渲染层与服务端产出完全相同', { skip: SKIP }, () => {
  for (const c of CASES) {
    const server = resolveProviderProfile(c)
    const front = ui.resolveProviderProfileUi(c)
    assert.equal(front, server, `画像漂移：${JSON.stringify(c)} 服务端=${server} 渲染层=${front}`)
  }
})

test('host 解析一致性：非法 URL / IPv6 / 端口 / 大小写', { skip: SKIP }, () => {
  for (const c of CASES) {
    const base = c?.apiBaseUrl
    if (typeof base === 'string' && base.startsWith('http')) {
      assert.equal(ui.hostOf(base), (() => { try { return new URL(base).hostname.replace(/^\[|\]$/g, '') } catch { return base } })(),
        `hostOf 漂移：${base}`)
    }
  }
})

test('活动供应商回退语义一致：匹配不到时回落到第一个（内核就是这么挑的）', { skip: SKIP }, () => {
  const providers = [
    { id: 'a', name: 'A', apiBaseUrl: 'http://127.0.0.1:8000/v1', primaryModel: 'm-a', models: ['m-a'] },
    { id: 'b', name: 'B', apiBaseUrl: 'https://api.deepseek.com', primaryModel: 'm-b', models: ['m-b'] },
  ]
  // ⚠️ 必须拿**服务端真实实现**比。首版这里抄了一份内联 `serverPick`，等于断言空转：
  // 服务端换了回退规则（list.at(-1)、过滤无 id…）这条测试照样绿（独立审查抓出）。
  for (const id of ['a', 'b', 'missing', undefined, null, '', 0]) {
    const picked = ui.activeProviderOf(providers, id)
    assert.equal(ui.resolveEffectiveModel(picked), activeProviderModel({ providers, activeProvider: id }),
      `活动供应商选中的模型与服务端口径不一致：activeProvider=${JSON.stringify(id)}`)
  }
  assert.equal(ui.activeProviderOf([], 'a'), null)
  assert.equal(ui.activeProviderOf(undefined, 'a'), null)
  assert.equal(activeProviderModel({ providers: [], activeProvider: 'a' }), '')
})

test('模型名回退口径一致：primaryModel 为空 ⇒ 两侧都取 models[0]（否则界面看不见在用的模型）', { skip: SKIP }, () => {
  // 这一支可达：POST /providers 允许 primaryModel 为空，探测回填 models 时也不改写空的 primaryModel
  const cases = [
    { id: 'a', primaryModel: '', models: ['first', 'second'] },
    { id: 'a', primaryModel: '', models: [] },
    { id: 'a', primaryModel: '', models: undefined },
    { id: 'a', primaryModel: 'primary', models: ['first'] },
    { id: 'a', models: ['only'] },
    { id: 'a', primaryModel: '', models: ['', 'second'] },
  ]
  for (const provider of cases) {
    assert.equal(ui.resolveEffectiveModel(provider), activeProviderModel({ providers: [provider], activeProvider: 'a' }),
      `模型回退口径漂移：${JSON.stringify(provider)}`)
  }
})

test('有意的差异（已记录）：渲染层容忍 null，服务端会抛 —— 故 null 不入一致性表', { skip: SKIP }, () => {
  // 为什么容忍：状态栏在任何时刻都可能重绘，配置/供应商列表尚未加载完时 provider 就是 null。
  // 服务端 `resolveProviderProfile()` 在真实调用点永远拿到对象（由 config 传入），故不必防御。
  // 这条用例把差异**显式钉住**，免得后人看到一致性表里没有 null 而"顺手补齐"成假红。
  assert.throws(() => resolveProviderProfile(null), TypeError, '服务端对 null 会抛（本差异的前提）')
  assert.equal(ui.resolveProviderProfileUi(null), 'cloud', '渲染层必须容忍 null，且保守判为云端')
  assert.equal(ui.resolveProviderProfileUi(undefined), 'cloud', 'undefined 两侧一致（服务端同样返回 cloud）')
})
