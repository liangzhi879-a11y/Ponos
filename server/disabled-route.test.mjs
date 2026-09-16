// server/disabled-route.test.mjs
// `/disabled` 的**桥接线静态守卫**（2026-09-15，P1 D 条款）。
//
// 与 `disabled-routes.test.mjs` 的分工（两文件互补，非重复）：
//   · `disabled-routes.test.mjs` —— 直调纯 handler，测**读写行为**（归一、只改一个键、坏负载不写盘）；
//   · 本文件 —— 源码级断言，测**接线**：bridge 是否真的把 `/disabled` 交给了那个 handler、
//     是否传了正确的 `configDir`。
//
// 为什么接线也要守：本仓库纪律是"测试不起 bridge"（有过误杀运行中应用的前车之鉴），故无法用
// 真请求验证这段接线。而接线断掉的后果是**静默**的——路由不生效 → 前端 PUT 落到 fallback →
// 用户点开关后"看起来关了、重启又回来"，且没有任何报错。故用静态断言把它钉住。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = readFileSync(fileURLToPath(new URL('./bridge.mjs', import.meta.url)), 'utf8')

test('bridge 引入并调用 disabled 路由 handler', () => {
  assert.match(src, /import \{ handleDisabledRoute \} from '\.\/disabled-routes\.mjs'/,
    '必须复用抽出的纯 handler（内联实现会绕开行为测试）')
  assert.match(src, /await handleDisabledRoute\(\{ method: req\.method, pathname: url\.pathname/,
    '必须在请求分发处调用，且把 method/pathname 原样传入')
})

test('configDir 必须是 YFW_HOME（内核子进程的 PONOS_CONFIG_DIR 同处）', () => {
  // 这是本设计的**关键不变量**：桥写 <YFW_HOME>/disabled.json，内核读 <PONOS_CONFIG_DIR>/disabled.json，
  // 而 PONOS_CONFIG_DIR 就取自 YFW_HOME（见 buildChildEnv）。若这里写成别的目录，
  // 开关会"写进一个没人读的文件"——功能整体失效且无任何错误。
  assert.match(src, /configDir: YFW_HOME \}\)/, 'configDir 必须传 YFW_HOME')
  assert.match(src, /PONOS_CONFIG_DIR: YFW_HOME/, '不变量前提：内核的 PONOS_CONFIG_DIR 必须仍等于 YFW_HOME')
})

test('路由在 /sample-skills 之前（分发顺序不得把它挤到 unreachable 分支）', () => {
  const iDisabled = src.indexOf('handleDisabledRoute({')
  const iSample = src.indexOf("url.pathname === '/sample-skills'")
  assert.ok(iDisabled > 0 && iSample > 0)
  assert.ok(iDisabled < iSample, '/disabled 的分发必须在普通技能路由之前，避免被提前 return 吃掉')
})

test('handler 是 await 的（异步读体：不 await 会把 Promise 当结果用）', () => {
  assert.match(src, /const r = await handleDisabledRoute\(/, '必须 await：readJsonBody 是异步的')
  assert.match(src, /if \(r\) return reply\(r\.status/, '未匹配时返回 null，必须判空后再 reply')
})
