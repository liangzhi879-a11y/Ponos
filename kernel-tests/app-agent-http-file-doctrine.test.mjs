// M3：模型可见性——契约里有了 http/file，还得让模型**知道能这么写**，否则清单列了通道也白搭。
// 这批断言同时守住两个"不许含糊"的点：① 需要登录态的接口不许走 http（它不带 Cookie）；
// ② file 只读（不给模型写文件的口子）。
process.env.PONOS_MOCK_API = '1'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { buildAgentSystem } = require('../electron/app-agent.cjs')

test('★ 系统提示词要说清 http / file 两个可选后端与各自边界', () => {
  const sys = buildAgentSystem({ target: { type: 'desktop', exePath: 'C:/x/a.exe' }, driver: 'uia' })
  assert.ok(sys.includes('http'), '要提到 http 后端')
  assert.ok(sys.includes('file'), '要提到 file 后端')
  assert.ok(/request/.test(sys), 'http 的 act 名叫 request，必须写出来')
  assert.ok(/允许访问/.test(sys) || /同源/.test(sys), '要说清 http 只能访问同源地址（或 http.allowHosts 加白）')
  // ★ 登录态这条必须说清"不要走 http"：http 后端刻意不带 Cookie，写了也调不通。
  assert.ok(/登录态[\s\S]{0,40}不要用\s*http/.test(sys), '要说清需要登录态的接口不要走 http')
  assert.ok(/只读/.test(sys), 'file 要写明只读')
})

test('★ 需要登录态的接口走 browser + js：这条只写给浏览器目标（桌面目标不得出现"browse"引导）', () => {
  // ★ 与计划原文的差异（计划自相矛盾，此处按真实代码取舍）：
  //   计划要求**桌面**提示词里出现 driver:"browser"（`/登录态[\s\S]{0,80}browser/`），
  //   但既有 app-agent.test.mjs 锁定「桌面提示词不含 fetch/snapshot/browse 引导」，
  //   而 `browser` 恰好包含子串 `browse` —— 两条断言在同一条提示词上不可能同时成立。
  //   故按驱动分流：浏览器目标写明 browser + js 兜底；桌面目标只写"不要用 http"（桌面本就没有浏览器通道，
  //   runTool 也会明确拒绝浏览器工具，引模型去调它只会制造必然失败的工具调用）。
  const web = buildAgentSystem({ target: { type: 'web', url: 'https://e.com/' }, driver: 'browser' })
  assert.ok(/登录态[\s\S]{0,80}browser/.test(web), '浏览器目标：要说清需要登录态的接口走 browser + js')
  const desk = buildAgentSystem({ target: { type: 'desktop', exePath: 'C:/x/a.exe' }, driver: 'process' })
  assert.ok(!desk.includes('browse'), '桌面提示词不得出现 "browse"（既有硬约束）')
})

test('提示词里的 http/file 说明是**独立一段**，不改变既有 web 分支的其余内容', () => {
  const web = buildAgentSystem({ target: { type: 'web', url: 'https://e.com/' }, driver: 'browser' })
  assert.ok(web.includes('fetch_page'), '既有 web 工具说明不能丢')
  assert.ok(web.includes('【可选执行后端'), '新段落有固定标题，便于人读与测试')
  const desk = buildAgentSystem({ target: { type: 'desktop', exePath: 'C:/x/a.exe' }, driver: 'process' })
  assert.ok(desk.includes('【可选执行后端'), '桌面目标同样要看得见这两个可选后端（否则清单列了也白列）')
})
