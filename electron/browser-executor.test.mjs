import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Electron 主进程依赖部分本任务以字符串模板工厂/纯函数抽取（browser-executor.cjs 导出），
// 纯 node 可测；窗口/CDP/可信输入留待 Task 7 端到端人工验收。
import { buildClickBoxScript, buildAxTreeCollectorScript, buildScrollDeltaScript, buildJsWrapperScript, finalizeJsResult, createDownloadHandler, isBlockedUrl, isDownloadishUrl } from './browser-executor.cjs'

test('buildClickBoxScript 含 ref 解析与 getBoundingClientRect', () => {
  const s = buildClickBoxScript(12)
  assert.match(s, /__brRefs\[12\]/)
  assert.match(s, /getBoundingClientRect/)
})

test('buildAxTreeCollectorScript 含 role/name/节点裁剪与验证码启发', () => {
  const s = buildAxTreeCollectorScript(300)
  assert.match(s, /getComputedStyle/)
  assert.match(s, /visibility/)
  assert.match(s, /验证码|captcha/)
})

test('buildAxTreeCollectorScript 含 clickable 启发（光标/onclick/子菜单）', () => {
  const s = buildAxTreeCollectorScript(300)
  assert.match(s, /cursor === 'pointer'/)
  assert.match(s, /onclick/)
  assert.match(s, /:scope > ul/)
  assert.match(s, /node\.clickable/)
})

test('buildAxTreeCollectorScript 悬浮层（下拉/弹层）选项并入快照', () => {
  const s = buildAxTreeCollectorScript(300)
  assert.match(s, /isInsideOverlay/)
  assert.match(s, /dropdown|listbox|popper/)
  assert.match(s, /\[class\*="option"\]/)
  assert.match(s, /return 'option'/)
  assert.doesNotThrow(() => new Function(s), 'collector 可编译执行')
})

test('buildScrollDeltaScript 先滚 window 再回退滚动容器', () => {
  const s = buildScrollDeltaScript(400)
  assert.match(s, /window\.scrollBy\(0, 400\)/)
  assert.match(s, /pageYOffset/)
  assert.match(s, /scrollHeight/)
  assert.match(s, /scrollTop \+= 400/)
  assert.doesNotThrow(() => new Function(s), '脚本可编译执行')
})

test('buildJsWrapperScript 含 await/归一化/b64/深度截断且可编译', () => {
  const s = buildJsWrapperScript('fetch("https://x/api").then(r => r.json())')
  assert.match(s, /await \(fetch/)
  assert.match(s, /__br_type: 'binary'/)
  assert.match(s, /btoa/)
  assert.match(s, /\[深度截断\]/)
  assert.match(s, /__br_type: 'node'/)
  assert.doesNotThrow(() => new Function(s), 'wrapper 可编译执行')
})

test('finalizeJsResult：≤limit 内联保留，>limit 落临时文件返回路径', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'br-js-'))
  try {
    // 小二进制（≤limit=1024）：内联 base64 保留
    const small = { ok: true, value: { a: { __br_type: 'binary', size: 4, b64: 'aGVsbG8=' } } }
    const outSmall = finalizeJsResult(small, 's1', { limit: 1024, tmpDir: tmp })
    assert.equal(outSmall.value.a.__br_type, 'binary')
    assert.equal(outSmall.value.a.b64, 'aGVsbG8=')

    // 大二进制（>limit=4）：写文件 + 替换为 {__br_type:'file', path}
    const big = { ok: true, value: { b: { __br_type: 'binary', size: 10, b64: 'aGVsbG8gd29ybGQ=' } } }
    const outBig = finalizeJsResult(big, 'sess-1', { limit: 4, tmpDir: tmp })
    assert.equal(outBig.value.b.__br_type, 'file')
    assert.match(outBig.value.b.path, /ponos-browser-js/)
    assert.equal(outBig.value.b.size, 10)
    assert.equal(fs.readFileSync(outBig.value.b.path, 'utf8'), 'hello world')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('finalizeJsResult：非 ok 原样返回', () => {
  const bad = { ok: false, error: 'boom' }
  assert.deepEqual(finalizeJsResult(bad, 's1'), bad)
})

test('createDownloadHandler 落盘目录并回传 {type:download, path, filename, status}', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'br-dl-'))
  try {
    const events = []
    const item = { getFilename: () => '报告.pdf', saved: null, setSavePath(p) { this.saved = p } }
    const handler = createDownloadHandler('sess-1', path.join(tmp, 'dl'), (sid, ev) => events.push({ sid, ev }))
    handler(null, item)
    const expect = path.join(tmp, 'dl', '报告.pdf')
    assert.equal(item.saved, expect)
    assert.ok(fs.existsSync(path.join(tmp, 'dl')), '下载目录已创建')
    assert.equal(events.length, 1)
    assert.equal(events[0].sid, 'sess-1')
    assert.deepEqual(events[0].ev, { type: 'download', path: expect, filename: '报告.pdf', status: 'started' })
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('createDownloadHandler 注册表状态流转（updated/done）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'br-reg-'))
  try {
    const registry = new Map()
    const events = []
    const listeners = {}
    const item = {
      getFilename: () => '附件.pdf',
      getURL: () => 'https://sticapply.sz.gov.cn/common/file/download.do?fileId=1',
      setSavePath(p) { this.saved = p },
      getReceivedBytes: () => 500,
      getTotalBytes: () => 1000,
      on(ev, cb) { listeners[ev] = cb },
      once(ev, cb) { listeners[ev] = cb },
    }
    const dlDir = path.join(tmp, 'dl')
    const handler = createDownloadHandler('s1', dlDir, (sid, ev) => events.push(ev), registry)
    handler(null, item)
    const key = 'https://sticapply.sz.gov.cn/common/file/download.do?fileId=1'
    assert.ok(registry.has(key), '注册表含该下载')
    const entry = registry.get(key)
    assert.equal(entry.status, 'downloading')
    assert.equal(entry.path, path.join(dlDir, '附件.pdf'))
    listeners.updated()
    assert.equal(entry.received, 500)
    listeners.done(null, 'completed')
    assert.equal(entry.status, 'done')
    assert.equal(entry.size, 1000)
    assert.equal(events[0].type, 'download')
    assert.equal(events[0].path, path.join(dlDir, '附件.pdf'))
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('createDownloadHandler 落盘失败不发事件', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'br-dl-fail-'))
  try {
    const events = []
    // getFilename 抛错 → 走 catch，不发路径回传事件
    const item = { getFilename() { throw new Error('item gone') } }
    const handler = createDownloadHandler('sess-1', path.join(tmp, 'dl'), (sid, ev) => events.push({ sid, ev }))
    handler(null, item)
    assert.equal(events.length, 0)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('isBlockedUrl 对白名单/非白名单判断正确', (t) => {
  // 隔离真实用户配置：本机 browser-whitelist.json 若含 example.com，子域匹配会把
  // evil.example.com 误判为白名单内。临时 PONOS_HOME 空目录 → 仅默认白名单生效。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ponos-bu-'))
  const prev = process.env.PONOS_HOME
  process.env.PONOS_HOME = dir
  t.after(() => {
    if (prev === undefined) delete process.env.PONOS_HOME
    else process.env.PONOS_HOME = prev
    fs.rmSync(dir, { recursive: true, force: true })
  })
  assert.equal(isBlockedUrl('https://www.gov.cn/xxgk'), false)
  assert.equal(isBlockedUrl('http://localhost:5173/'), false)
  assert.equal(isBlockedUrl('https://evil.example.com'), true)
  assert.equal(isBlockedUrl(''), false)
  assert.equal(isBlockedUrl(null), false)
})

test('isDownloadishUrl 判定下载类链接', () => {
  assert.equal(isDownloadishUrl('https://sticapply.sz.gov.cn/common/file/download.do?fileId=1'), true)
  assert.equal(isDownloadishUrl('https://x.gov.cn/f/attachment?id=2'), true)
  assert.equal(isDownloadishUrl('https://x.gov.cn/files/RD01.pdf'), true)
  assert.equal(isDownloadishUrl('https://x.gov.cn/files/申请书.docx'), true)
  assert.equal(isDownloadishUrl('https://x.gov.cn/list.html'), false)
  assert.equal(isDownloadishUrl(''), false)
  assert.equal(isDownloadishUrl(null), false)
})

test('buildAxTreeCollectorScript 含下载链接标记与绝对 href', () => {
  const s = buildAxTreeCollectorScript(300)
  assert.match(s, /isDownloadLink/)
  assert.match(s, /el\.href \|\| el\.getAttribute\('href'\)/)
  assert.match(s, /node\.download = true/)
})

test('buildAxTreeCollectorScript 含登录态启发与可见 spinner 判定', () => {
  const s = buildAxTreeCollectorScript(300)
  assert.match(s, /logged_in/)
  assert.match(s, /退出\|注销\|安全退出\|logout/)
  assert.match(s, /操作超时\|登录已过期/)
  assert.match(s, /isVisible\(spinners\[i\]\)/)
})
