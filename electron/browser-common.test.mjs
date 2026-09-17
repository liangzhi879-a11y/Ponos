import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  maskSensitive, truncate, pickSelector, buildSnapshot, diffSummary,
  computeFingerprint, isWhitelisted,
} from './browser-common.cjs'

test('maskSensitive: 身份证/手机号/账号打码', () => {
  assert.equal(maskSensitive('身份证 330106199001011234'), '身份证 330106********34')
  assert.equal(maskSensitive('13812345678'), '138****5678')
  assert.equal(maskSensitive('普通文本'), '普通文本')
})
test('truncate: 超长截断', () => {
  assert.equal(truncate('a'.repeat(100), 10), 'a'.repeat(10) + '…')
})
test('pickSelector: 优先级 id > name > placeholder > aria-label > data-testid', () => {
  assert.equal(pickSelector({ name: 'kw', id: 'q' }), '#q')
  assert.equal(pickSelector({ placeholder: '输入企业名' }), '[placeholder="输入企业名"]')
  assert.equal(pickSelector({}), null)
})
test('buildSnapshot: 交互树精简 + ref 编号 + 只读信息 + 截图非必需', () => {
  const snap = buildSnapshot({
    axTree: [
      { role: 'button', name: '查询', nodeId: 'n1' },
      { role: 'textbox', name: '企业名称', value: '锐取', nodeId: 'n2' },
    ],
    url: 'https://www.gsxt.gov.cn/x', title: '公示系统', viewport: { w: 1200, h: 800 }, scrollY: 0,
    prevSnapshot: null,
  })
  assert.equal(snap.interactives.length, 2)
  assert.equal(snap.interactives[0].ref, 1)
  assert.equal(snap.interactives[0].label, '查询')
  assert.equal(snap.interactives[1].value, '锐取')
})
test('buildSnapshot: clickable 文本节点进 interactives 且 tag=menu-item', () => {
  const snap = buildSnapshot({
    axTree: [
      { role: 'text', name: '科技计划', clickable: true, nodeId: 'n1' },
      { role: 'text', name: '普通说明文字', nodeId: 'n2' },
    ],
    url: 'u', title: 't', viewport: { w: 1, h: 1 }, scrollY: 0, prevSnapshot: null,
  })
  assert.equal(snap.interactives.length, 1)
  assert.equal(snap.interactives[0].ref, 1)
  assert.equal(snap.interactives[0].tag, 'menu-item')
  assert.equal(snap.interactives[0].label, '科技计划')
  assert.equal(snap.info.length, 1)
  assert.equal(snap.info[0].label, '普通说明文字')
})
test('buildSnapshot: 下载类链接标记 download:true', () => {
  const snap = buildSnapshot({
    axTree: [
      { role: 'link', name: '查看附件', href: 'https://x/download.do?id=1', download: true, nodeId: 'n1' },
      { role: 'link', name: '首页', href: 'https://x/', nodeId: 'n2' },
    ],
    url: 'u', title: 't', viewport: { w: 1, h: 1 }, scrollY: 0, prevSnapshot: null,
  })
  assert.equal(snap.interactives[0].download, true)
  assert.equal(snap.interactives[1].download, undefined)
})
test('buildSnapshot: tab/option 角色视为交互', () => {
  const snap = buildSnapshot({
    axTree: [
      { role: 'tab', name: '高新技术企业认定', nodeId: 'n1' },
      { role: 'option', name: '选项一', nodeId: 'n2' },
    ],
    url: 'u', title: 't', viewport: { w: 1, h: 1 }, scrollY: 0, prevSnapshot: null,
  })
  assert.equal(snap.interactives.length, 2)
  assert.equal(snap.interactives[0].tag, 'tab')
  assert.equal(snap.interactives[0].ref, 1)
  assert.equal(snap.interactives[1].tag, 'option')
  assert.equal(snap.interactives[1].ref, 2)
})
test('buildSnapshot: downloads 字段透传（文件名/路径脱敏）', () => {
  const snap = buildSnapshot({
    axTree: [], url: 'u', title: 't', viewport: { w: 1, h: 1 }, scrollY: 0, prevSnapshot: null,
    downloads: [
      { filename: 'RD01 立项报告.pdf', path: 'C:/dl/RD01 立项报告.pdf', size: 137000, received: 137000, status: 'done' },
      { filename: '电话 13812345678.txt', path: 'x', size: 0, received: 0, status: 'downloading' },
    ],
  })
  assert.equal(snap.downloads.length, 2)
  assert.equal(snap.downloads[0].status, 'done')
  assert.equal(snap.downloads[0].size, 137000)
  assert.equal(snap.downloads[1].status, 'downloading')
  assert.ok(!JSON.stringify(snap).includes('13812345678'))
})
test('buildSnapshot: 脱敏生效 + truncated 计数', () => {
  const snap = buildSnapshot({
    axTree: [{ role: 'text', name: '手机 13812345678', nodeId: 'n9' }],
    url: 'u', title: 't', viewport: { w: 1, h: 1 }, scrollY: 0, prevSnapshot: null,
  })
  assert.ok(!JSON.stringify(snap).includes('13812345678'))
})
test('buildSnapshot: link href 脱敏（tel/mailto）', () => {
  const snap = buildSnapshot({
    axTree: [
      { role: 'link', name: '拨打', href: 'tel:13812345678', nodeId: 'n1' },
      { role: 'link', name: '联系', href: 'mailto:zhang.san@example.com', nodeId: 'n2' },
    ],
    url: 'u', title: 't', viewport: { w: 1, h: 1 }, scrollY: 0, prevSnapshot: null,
  })
  assert.ok(!JSON.stringify(snap).includes('13812345678'))
  assert.ok(!JSON.stringify(snap).includes('zhang.san@example.com'))
  assert.equal(snap.interactives[0].href, 'tel:138****5678')
  assert.equal(snap.interactives[1].href, 'mailto:z***@example.com')
})
test('buildSnapshot: page.logged_in 透传（true/false/null）', () => {
  const mk = (logged_in) => buildSnapshot({
    axTree: [{ role: 'text', name: 'x', logged_in, nodeId: 'n1' }],
    url: 'u', title: 't', viewport: { w: 1, h: 1 }, scrollY: 0, prevSnapshot: null,
  })
  assert.equal(mk(true).page.logged_in, true)
  assert.equal(mk(false).page.logged_in, false)
  assert.equal(mk(null).page.logged_in, null)
  assert.equal(mk(undefined).page.logged_in, null)
})
test('buildSnapshot: page.captcha_img 透传（有值/缺省 null）', () => {
  const withImg = buildSnapshot({
    axTree: [{ role: 'text', name: '验证码', captcha: true, captcha_img: 'iVBORw0KGgo=', nodeId: 'n1' }],
    url: 'u', title: 't', viewport: { w: 1, h: 1 }, scrollY: 0, prevSnapshot: null,
  })
  assert.equal(withImg.page.captcha, true)
  assert.equal(withImg.page.captcha_img, 'iVBORw0KGgo=')
  const noImg = buildSnapshot({
    axTree: [{ role: 'text', name: 'x', captcha: false, nodeId: 'n1' }],
    url: 'u', title: 't', viewport: { w: 1, h: 1 }, scrollY: 0, prevSnapshot: null,
  })
  assert.equal(noImg.page.captcha_img, null)
})
test('buildSnapshot: page.title 脱敏', () => {
  const snap = buildSnapshot({
    axTree: [], url: 'u', title: '欢迎 张三 13812345678', viewport: { w: 1, h: 1 }, scrollY: 0, prevSnapshot: null,
  })
  assert.equal(snap.page.title, '欢迎 张三 138****5678')
  assert.ok(!JSON.stringify(snap).includes('13812345678'))
})
test('buildSnapshot: page.title 超长截断', () => {
  const snap = buildSnapshot({
    axTree: [], url: 'u', title: '标'.repeat(100), viewport: { w: 1, h: 1 }, scrollY: 0, prevSnapshot: null,
  })
  assert.equal(snap.page.title, '标'.repeat(60) + '…')
})
test('buildSnapshot: path_hint 超长截断', () => {
  const snap = buildSnapshot({
    axTree: [{ role: 'button', name: '查询', path_hint: '/'.repeat(100), nodeId: 'n1' }],
    url: 'u', title: 't', viewport: { w: 1, h: 1 }, scrollY: 0, prevSnapshot: null,
  })
  assert.equal(snap.interactives[0].path_hint, '/'.repeat(60) + '…')
})
test('diffSummary: URL 变化与节点增减', () => {
  const prev = { url: 'a', interactives: [{ ref: 1, tag: 'button', label: 'x' }] }
  const next = { url: 'b', interactives: [{ ref: 1, tag: 'button', label: 'x' }, { ref: 2, tag: 'link', label: 'y' }] }
  assert.match(diffSummary(prev, next), /URL/)
  assert.match(diffSummary(prev, next), /\+\d+ 节点/)
})
test('computeFingerprint: 相同输入同指纹，输入变化指纹变', () => {
  const a = { title: 't', href: 'h', textLen: 100, inputCount: 2 }
  const b = { ...a }
  assert.equal(computeFingerprint(a), computeFingerprint(b))
  assert.notEqual(computeFingerprint(a), computeFingerprint({ ...b, textLen: 150 }))
})
test('isWhitelisted: gov.cn 通过，白名单外拒绝，授权后通过', () => {
  assert.equal(isWhitelisted('https://www.gsxt.gov.cn/index.html'), true)
  assert.equal(isWhitelisted('https://evil.com/'), false)
  isWhitelisted.allow('evil.com')
  assert.equal(isWhitelisted('https://evil.com/page'), true)
})

test('isWhitelisted: 预设搜索/企查/人社/邮箱域名通过（含子域）', () => {
  assert.equal(isWhitelisted('https://www.bing.com/'), true)
  assert.equal(isWhitelisted('https://www.baidu.com/s?wd=xx'), true)
  assert.equal(isWhitelisted('https://sogou.com/'), true)
  assert.equal(isWhitelisted('https://www.qcc.com/'), true)
  assert.equal(isWhitelisted('https://www.tianyancha.com/'), true)
  assert.equal(isWhitelisted('https://aiqicha.baidu.com/'), true)
  assert.equal(isWhitelisted('https://www.12333.cn/'), true)
  assert.equal(isWhitelisted('https://mail.qq.com/'), true)
  assert.equal(isWhitelisted('https://evil.org/'), false)
})

test('isWhitelisted: 配置文件 allow 动态生效（mtime 重读 + 子域匹配）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yfw-wl-'))
  const cfgPath = path.join(dir, 'browser-whitelist.json')
  const prev = process.env.YFWORKING_HOME
  process.env.YFWORKING_HOME = dir
  try {
    fs.writeFileSync(cfgPath, JSON.stringify({ allow: ['example.org'] }))
    assert.equal(isWhitelisted('https://example.org/'), true)
    assert.equal(isWhitelisted('https://sub.example.org/x'), true)
    assert.equal(isWhitelisted('https://example.net/'), false)
    // 更新配置文件（mtime 变化）即时生效
    fs.writeFileSync(cfgPath, JSON.stringify({ allow: ['example.org', 'example.net'] }))
    assert.equal(isWhitelisted('https://example.net/'), true)
    fs.unlinkSync(cfgPath)
    assert.equal(isWhitelisted('https://example.net/'), false)
  } finally {
    if (prev === undefined) delete process.env.YFWORKING_HOME
    else process.env.YFWORKING_HOME = prev
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ── file:// 放行（2026-09-17 用户明确裁定："允许，不限根目录"）──────────────────
test('isWhitelisted: file:// 本地路径放行（hostname 恒为空串 ⇒ 域名白名单原理上无法表达）', () => {
  // 回归真实事故：agent 想用浏览器预览自己生成的 HTML，`file:///C:/...` 被一律拦截；
  // 内核把空 hostname 顶替成中文占位符「该域名」去弹审批，用户同意后写入端静默拒绝
  // ⇒ "同意 → 重试 → 再弹审批"死循环（见 shared/browser-whitelist-host.cjs 头注）。
  assert.equal(isWhitelisted('file:///C:/Users/x/scratch/mockup.html'), true)
  assert.equal(isWhitelisted('file:///Z:/项目/资料/原型.html'), true, '中文路径同样放行')
  assert.equal(isWhitelisted('file://server/share/a.html'), true, 'UNC 形式按"不限根目录"一并放行')
})

test('isWhitelisted: 放行不外溢到其它非 http 协议', () => {
  assert.equal(isWhitelisted('data:text/html,<b>x</b>'), false)
  assert.equal(isWhitelisted('about:blank'), false)
  assert.equal(isWhitelisted('javascript:alert(1)'), false)
  assert.equal(isWhitelisted('https://still-not-listed.example/'), false)
})

test('isWhitelisted: IPv6 回环放行（与 isAllowedOrigin 视 ::1 为可信来源的口径对齐）', () => {
  assert.equal(isWhitelisted('http://[::1]:5173/'), true)
})

test('isWhitelisted: 配置文件里的脏值被归一滤除，合法项照常生效（与写入端共用口径）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yfw-wl-dirty-'))
  const cfgPath = path.join(dir, 'browser-whitelist.json')
  const prev = process.env.YFWORKING_HOME
  process.env.YFWORKING_HOME = dir
  try {
    // 手改配置文件塞进脏值（中文占位符、含空格、空串、点结构异常）——不得让它们成为可匹配项，也不得崩
    fs.writeFileSync(cfgPath, JSON.stringify({ allow: ['good.test', '该域名', 'bad host!', '', 'a..b', '[::1]'] }))
    assert.equal(isWhitelisted('https://good.test/'), true, '合法项照常生效')
    assert.equal(isWhitelisted('https://sub.good.test/x'), true, '子域匹配照常')
    assert.equal(isWhitelisted('https://bad.test/'), false, '脏值不会被当成域名放行')
    assert.equal(isWhitelisted('http://[::1]:8080/'), true, '合法 IPv6 项生效')
  } finally {
    if (prev === undefined) delete process.env.YFWORKING_HOME
    else process.env.YFWORKING_HOME = prev
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
