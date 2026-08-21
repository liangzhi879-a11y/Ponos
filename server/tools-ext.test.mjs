// 新工具正式测试：TodoWrite / WebFetch（本地 http mock）/ OCR 边界
// ---------------------------------------------------------------------------
// OCR 真实引擎冒烟（RapidOCR + 缓存命中）在 zz-smoke/ocr-smoke.mjs（需系统
// python 环境）；此处只做零依赖断言（schema 在 tools-schema.test.mjs，越界/
// 缺失文件报错不触发 python）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createToolRegistry, childEnv } from '../kernel/tools.mjs'

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

test('Read/Write/Edit：相对路径解析到 cwd（resolvePath），缺失文件带 cwd + Glob 纠错提示', async () => {
  const { dir, reg } = tmpReg()
  try {
    mkdirSync(join(dir, 'sub'))
    // Write 用相对路径（相对 cwd）写入
    const w = await reg.run({ name: 'Write', input: { file_path: 'sub/rel.txt', content: 'hello' } })
    assert.equal(w.isError, false)
    assert.ok(w.content.includes(join(dir, 'sub', 'rel.txt')), 'Write 应回显解析后的绝对路径')
    // Read 用相对路径读取同一文件
    const r = await reg.run({ name: 'Read', input: { file_path: 'sub/rel.txt' } })
    assert.equal(r.isError, false)
    assert.equal(r.content.trim(), 'hello')
    // Edit 用相对路径编辑
    const e = await reg.run({ name: 'Edit', input: { file_path: 'sub/rel.txt', old_string: 'hello', new_string: 'hi' } })
    assert.equal(e.isError, false)
    assert.ok(e.content.includes(join(dir, 'sub', 'rel.txt')))
    // 缺失文件：提示含解析后路径 + 当前工作目录 + Glob 建议
    const miss = await reg.run({ name: 'Read', input: { file_path: 'no-such.txt' } })
    assert.equal(miss.isError, true)
    assert.match(miss.content, /文件不存在/)
    assert.ok(miss.content.includes(join(dir, 'no-such.txt')), '提示应含解析后的绝对路径')
    assert.ok(miss.content.includes(dir), '提示应含当前工作目录')
    assert.match(miss.content, /Glob/)
    // Edit 缺失文件同样带纠错提示
    const eMiss = await reg.run({ name: 'Edit', input: { file_path: 'nope.txt', old_string: 'x', new_string: 'y' } })
    assert.equal(eMiss.isError, true)
    assert.match(eMiss.content, /文件不存在/)
    assert.match(eMiss.content, /Glob/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Read：部分读取带续读进度指引；超大文件报错带定向读取建议', async () => {
  const { dir, reg } = tmpReg()
  try {
    // 20 行文件，limit=5 → 提示剩余行数与续读 offset（对照 pi 的 showing X-Y of N）
    const f = join(dir, 'twenty.txt')
    writeFileSync(f, Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n'), 'utf-8')
    const partial = await reg.run({ name: 'Read', input: { file_path: f, limit: 5 } })
    assert.equal(partial.isError, false)
    assert.match(partial.content, /line5/)
    assert.match(partial.content, /共 20 行，已显示 1-5/)
    assert.match(partial.content, /用 offset=6 继续读取剩余 15 行/)
    // offset 起点部分读取同样给指引
    const mid = await reg.run({ name: 'Read', input: { file_path: f, offset: 10, limit: 3 } })
    assert.match(mid.content, /已显示 10-12/)
    assert.match(mid.content, /用 offset=13 继续/)
    // 读到末尾无指引
    const tail = await reg.run({ name: 'Read', input: { file_path: f, offset: 18 } })
    assert.ok(!tail.content.includes('继续读取剩余'), '读到末尾不应有续读指引')
    // 一次读全文（无 offset/limit）也不应有指引
    const all = await reg.run({ name: 'Read', input: { file_path: f } })
    assert.ok(!all.content.includes('继续读取剩余'))
    // 超大文件（>2MB）→ 报错 + offset/limit 建议（对照 claude maxSizeInstruction）
    const big = join(dir, 'big.bin')
    const buf = Buffer.alloc(2 * 1024 * 1024 + 1024, 0x41)
    writeFileSync(big, buf)
    const over = await reg.run({ name: 'Read', input: { file_path: big } })
    assert.equal(over.isError, true)
    assert.match(over.content, /文件过大/)
    assert.match(over.content, /offset\/limit/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Read 去重 stub：全量读后文件未变返回 stub；修改/部分读/新路径正常', async () => {
  const { dir, reg } = tmpReg()
  try {
    const f = join(dir, 'dedup.txt')
    writeFileSync(f, 'v1\nv2\nv3\n', 'utf-8')
    // 第一次全量读 → 正常内容 + 记录缓存
    const first = await reg.run({ name: 'Read', input: { file_path: f } })
    assert.equal(first.isError, false)
    assert.match(first.content, /v2/)
    // 文件未变再次全量读 → stub（不返回内容）
    const second = await reg.run({ name: 'Read', input: { file_path: f } })
    assert.equal(second.isError, false)
    assert.match(second.content, /文件自上次读取后未变化/)
    assert.ok(!second.content.includes('v2'), 'stub 不应包含文件内容')
    // Write 修改文件 → 缓存失效 → 再读返回新内容
    await reg.run({ name: 'Write', input: { file_path: f, content: 'v9\n' } })
    const afterWrite = await reg.run({ name: 'Read', input: { file_path: f } })
    assert.ok(!afterWrite.content.includes('文件自上次读取后未变化'))
    assert.match(afterWrite.content, /v9/)
    // 部分读取（limit）不触发去重（不视为已有全部内容）
    const partial = await reg.run({ name: 'Read', input: { file_path: f, limit: 1 } })
    assert.ok(partial.content.includes('v9'), '部分读取应正常返回内容')
    const partialAgain = await reg.run({ name: 'Read', input: { file_path: f, limit: 1 } })
    assert.ok(partialAgain.content.includes('v9'), '部分读取不缓存，重复定向读仍返回内容')
    // Edit 修改 → 缓存失效 → 再读新内容
    await reg.run({ name: 'Edit', input: { file_path: f, old_string: 'v9', new_string: 'v10' } })
    const afterEdit = await reg.run({ name: 'Read', input: { file_path: f } })
    assert.ok(!afterEdit.content.includes('文件自上次读取后未变化'))
    assert.match(afterEdit.content, /v10/)
    // 新路径不受影响
    const g = join(dir, 'other.txt')
    writeFileSync(g, 'x', 'utf-8')
    const fresh = await reg.run({ name: 'Read', input: { file_path: g } })
    assert.match(fresh.content, /^x/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
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

test('S2-2 env 白名单：API key 剥离、系统路径保留、自定义敏感变量不透传', () => {
  const prev = {
    ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
    SECRET_TEST_VAR: process.env.SECRET_TEST_VAR,
  }
  process.env.ANTHROPIC_AUTH_TOKEN = 'sk-should-not-leak'
  process.env.SECRET_TEST_VAR = 'sensitive'
  try {
    const env = childEnv()
    assert.ok(!('ANTHROPIC_AUTH_TOKEN' in env), 'API key 必须剥离')
    assert.ok(!('SECRET_TEST_VAR' in env), '非白名单自定义变量不透传')
    assert.ok('PATH' in env || 'Path' in env, '系统路径保留')
  } finally {
    if (prev.ANTHROPIC_AUTH_TOKEN === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN
    else process.env.ANTHROPIC_AUTH_TOKEN = prev.ANTHROPIC_AUTH_TOKEN
    if (prev.SECRET_TEST_VAR === undefined) delete process.env.SECRET_TEST_VAR
    else process.env.SECRET_TEST_VAR = prev.SECRET_TEST_VAR
  }
})

test('S2-2 Bash 子进程：白名单 env 生效（不泄露敏感变量），命令正常执行', async () => {
  const { dir, reg } = tmpReg()
  const prev = process.env.SECRET_TEST_VAR
  process.env.SECRET_TEST_VAR = 'must-not-leak'
  try {
    const r = await reg.run({ name: 'Bash', input: { command: 'echo "leak=$SECRET_TEST_VAR"' } })
    assert.equal(r.isError, false)
    assert.match(String(r.content), /leak=$/, `子进程不应看到 SECRET_TEST_VAR，实际 ${r.content}`)
  } finally {
    if (prev === undefined) delete process.env.SECRET_TEST_VAR
    else process.env.SECRET_TEST_VAR = prev
    rmSync(dir, { recursive: true, force: true })
  }
})
