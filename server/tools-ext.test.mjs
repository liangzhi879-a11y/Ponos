// 新工具正式测试：TodoWrite / WebFetch（本地 http mock）/ OCR 边界
// ---------------------------------------------------------------------------
// OCR 真实引擎冒烟（RapidOCR + 缓存命中）在 zz-smoke/ocr-smoke.mjs（需系统
// python 环境）；此处只做零依赖断言（schema 在 tools-schema.test.mjs，越界/
// 缺失文件报错不触发 python）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createToolRegistry } from '../kernel/tools.mjs'

function tmpReg() {
  const dir = mkdtempSync(join(tmpdir(), 'yfw-tools-ext-'))
  return { dir, reg: createToolRegistry({ cwd: dir, addDirs: [dir], skipPermissions: true }) }
}

test('TodoWrite：覆盖式更新与回显（替换语义）', async () => {
  const { dir, reg } = tmpReg()
  try {
    const r1 = await reg.run({ name: 'TodoWrite', input: { todos: [{ content: '任务一' }, { content: '任务二', status: 'in_progress' }] } })
    assert.equal(r1.isError, false)
    assert.match(r1.content, /1\. \[ \] 任务一/)
    assert.match(r1.content, /2\. \[→\] 任务二/)
    // 替换语义：新清单整体替换旧清单（非追加）
    const r2 = await reg.run({ name: 'TodoWrite', input: { todos: [{ content: '新任务', status: 'completed' }] } })
    assert.ok(!r2.content.includes('任务一'))
    assert.match(r2.content, /1\. \[x\] 新任务/)
    // 空清单
    const r3 = await reg.run({ name: 'TodoWrite', input: { todos: [] } })
    assert.match(r3.content, /为空/)
    // 非法 status 归一化 pending
    const r4 = await reg.run({ name: 'TodoWrite', input: { todos: [{ content: 'x', status: 'bogus' }, { content: '' }] } })
    assert.match(r4.content, /1\. \[ \] x/)
    assert.ok(!r4.content.includes('2\.'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('WebFetch：本地 http server 抓取 HTML → 文本（script 剥离）；非法 url / 非 http 报错', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/404') {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<html><body>页面不存在</body></html>')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<html><body><h1>标题</h1><p>正文内容</p><script>alert(1)</script><style>p{color:red}</style></body></html>')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const { dir, reg } = tmpReg()
  try {
    const r = await reg.run({ name: 'WebFetch', input: { url: `http://127.0.0.1:${port}/page` } })
    assert.equal(r.isError, false)
    assert.match(r.content, /HTTP 200/)
    assert.match(r.content, /标题/)
    assert.match(r.content, /正文内容/)
    assert.ok(!r.content.includes('alert'), 'script 内容应剥离')
    // 非 2xx → isError（404 页面）
    const r404 = await reg.run({ name: 'WebFetch', input: { url: `http://127.0.0.1:${port}/404` } })
    assert.equal(r404.isError, true)
    // 非法 url
    const bad = await reg.run({ name: 'WebFetch', input: { url: 'not-a-url' } })
    assert.equal(bad.isError, true)
    assert.match(bad.content, /URL 无效/)
    // 非 http/https 协议
    const ftp = await reg.run({ name: 'WebFetch', input: { url: 'ftp://example.com/x' } })
    assert.equal(ftp.isError, true)
    assert.match(ftp.content, /仅支持 http\/https/)
  } finally {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('OCR：越界路径与缺失文件报错（不触发 python）', async () => {
  const { dir, reg } = tmpReg()
  try {
    // 目录边界外（父目录）
    const outside = await reg.run({ name: 'OCR', input: { file_path: join(dir, '..', 'outside.pdf') } })
    assert.equal(outside.isError, true)
    assert.match(outside.content, /边界/)
    // 目录内但文件不存在
    const missing = await reg.run({ name: 'OCR', input: { file_path: join(dir, 'nope.pdf') } })
    assert.equal(missing.isError, true)
    assert.match(missing.content, /不存在/)
    // file_path 缺失
    const none = await reg.run({ name: 'OCR', input: {} })
    assert.equal(none.isError, true)
    // 是目录
    const isDir = await reg.run({ name: 'OCR', input: { file_path: dir } })
    assert.equal(isDir.isError, true)
    assert.match(isDir.content, /目录/)
    // 引擎路径不可探测 → 引擎不可用错误（不 spawn python）：临时改 env 使
    // YFW_OCR_ENGINE 与两个候选 home 路径全部落空
    const txt = join(dir, 'plain.txt')
    writeFileSync(txt, 'hello', 'utf-8')
    const oldEngine = process.env.YFW_OCR_ENGINE
    const oldUser = process.env.USERPROFILE
    const oldHome = process.env.HOME
    process.env.YFW_OCR_ENGINE = join(dir, 'no-engine.py')
    process.env.USERPROFILE = join(dir, 'fake-home')
    process.env.HOME = join(dir, 'fake-home')
    try {
      const noEngine = await reg.run({ name: 'OCR', input: { file_path: txt } })
      assert.equal(noEngine.isError, true)
      assert.match(noEngine.content, /OCR 引擎不可用|引擎不可用/)
    } finally {
      process.env.YFW_OCR_ENGINE = oldEngine
      process.env.USERPROFILE = oldUser
      process.env.HOME = oldHome
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
