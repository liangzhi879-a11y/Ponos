import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createBridgeHeaderInjector, installBridgeTokenHeaderInjector } from './bridge-header-inject.cjs'

// 背景（2026-09-17 实测）：Electron 43.2.0 / Chromium 150 下，file:// 页面发往
// http://127.0.0.1:<port> 的跨源 fetch **不带 Origin 头**，直接撞进 S2-D2 的
// "无 Origin 无令牌即 401"——打包版渲染层 HTTP 请求整体被拒（文件面板/知识库面板
// 回显 Unauthorized）。修复手段是 main 侧注入令牌头，本文件锁住注入判据与不变量。

const PORT = 51517
const TOKEN = 'a'.repeat(64)
const inject = createBridgeHeaderInjector({ port: PORT, token: TOKEN })
const HEADER = 'x-yfw-bridge-token'

test('桥的 HTTP 请求注入令牌头', () => {
  const headers = inject({ url: `http://127.0.0.1:${PORT}/list-dir?path=C:/x`, requestHeaders: { Accept: '*/*' } })
  assert.equal(headers[HEADER], TOKEN)
  assert.equal(headers.Accept, '*/*', '既有头必须保留')
})

test('桥的 WS 握手同样注入（协议面覆盖 http/https/ws/wss）', () => {
  const headers = inject({ url: `ws://127.0.0.1:${PORT}`, requestHeaders: {} })
  assert.equal(headers[HEADER], TOKEN)
})

test('只认本桥 host：其它端口/其它主机/其它协议一律不注入（令牌不外泄）', () => {
  const urls = [
    `http://127.0.0.1:${PORT + 1}/list-dir`,   // 其它端口
    `http://localhost:${PORT}/list-dir`,        // 同名但非 127.0.0.1
    'http://example.com/x',                     // 外部主机
    `file:///C:/yfworking/dist/index.html`,     // 非同源协议
    'not a url',                                // 非法 URL（不抛、不注入）
    '',
  ]
  for (const url of urls) {
    const headers = inject({ url, requestHeaders: {} })
    assert.equal(headers[HEADER], undefined, `不应注入令牌：${url}`)
  }
})

test('调用方已自带同名头时（大小写不敏感）不覆盖', () => {
  const headers = inject({
    url: `http://127.0.0.1:${PORT}/config`,
    requestHeaders: { 'X-YFW-Bridge-Token': 'self-provided' },
  })
  assert.equal(headers['X-YFW-Bridge-Token'], 'self-provided')
  assert.equal(headers[HEADER], undefined, '不应再塞一个小写键值')
})

test('注入器是纯函数：不修改传入的 details/requestHeaders', () => {
  const requestHeaders = { Accept: '*/*' }
  const details = { url: `http://127.0.0.1:${PORT}/x`, requestHeaders }
  inject(details)
  assert.deepEqual(requestHeaders, { Accept: '*/*' })
  assert.equal(details.requestHeaders, requestHeaders)
})

test('installBridgeTokenHeaderInjector：装上就生效，重复装不生效（防覆盖前一次处理器）', () => {
  const handlers = []
  const fakeSession = {
    webRequest: {
      onBeforeSendHeaders(fn) { handlers.push(fn) },
    },
  }
  assert.equal(installBridgeTokenHeaderInjector(fakeSession, { port: PORT, token: TOKEN }), true)
  assert.equal(installBridgeTokenHeaderInjector(fakeSession, { port: PORT, token: TOKEN }), false,
    '同一 session 重复注册会覆盖上一次的处理器，必须拒绝')
  assert.equal(handlers.length, 1)
  let captured = null
  handlers[0]({ url: `http://127.0.0.1:${PORT}/workflows`, requestHeaders: {} },
    (opts) => { captured = opts })
  assert.equal(captured.requestHeaders[HEADER], TOKEN)
})

test('installBridgeTokenHeaderInjector：非 session / 缺 webRequest 时安全返回 false', () => {
  assert.equal(installBridgeTokenHeaderInjector(null, { port: PORT, token: TOKEN }), false)
  assert.equal(installBridgeTokenHeaderInjector({}, { port: PORT, token: TOKEN }), false)
  assert.equal(installBridgeTokenHeaderInjector({ webRequest: {} }, { port: PORT, token: TOKEN }), false)
})

test('治理约束：main.cjs 确实装了注入器，且默认头名与桥侧一致', () => {
  const mainSrc = readFileSync(new URL('./main.cjs', import.meta.url), 'utf-8')
  assert.match(mainSrc, /require\('\.\/bridge-header-inject\.cjs'\)/)
  assert.match(mainSrc, /installBridgeHeaderInjector\(session\.defaultSession\)/,
    'defaultSession 必须在 ready 内显式安装（它早于 session-created 监听建立）')
  assert.match(mainSrc, /app\.on\('session-created', \(s\) => installBridgeHeaderInjector\(s\)\)/)
  const tokenSrc = readFileSync(new URL('../server/bridge-token.cjs', import.meta.url), 'utf-8')
  assert.match(tokenSrc, /BRIDGE_TOKEN_HEADER = 'x-yfw-bridge-token'/,
    '头名是两侧契约：桥侧 extractToken 读的就是这个名字')
  assert.equal(HEADER, 'x-yfw-bridge-token')
})

test('治理约束：桥的预检响应必须声明令牌头（否则自定义头会让预检失败、真实请求不发）', () => {
  const bridgeSrc = readFileSync(new URL('../server/bridge.mjs', import.meta.url), 'utf-8')
  assert.match(bridgeSrc, /Access-Control-Allow-Headers', 'Content-Type, x-yfw-bridge-token'/)
})
