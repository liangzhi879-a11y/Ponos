// 文件知识库导入的路由层测试（2026-09-14）。
// 纪律同 knowledge-append-routes.test.mjs：**直调 handler + 注入假 callKernel**，
// 不起 bridge、不起内核子进程（本仓库有"测试起桥误杀运行中应用"的前车之鉴）。
//
// 本文件只钉**路由层的映射规则**（转发成什么 argv、超时窗口、状态码怎么定），
// 不重复内核侧的白名单/幂等/落盘口径（那在 kernel-tests/knowledge-import.test.mjs）。
// 分层的理由：路由一旦"重写一套判据"，两处口径必然漂移 —— 故这里只验证它**没有**自作主张。
//
// ⚠️ 内核 flag 是 `--src` 不是 `--from`：`--from` 已被内核 CLI 的范围语义占用
// （与 `--to` 配对；switch 重复 case 先命中者生效 ⇒ 复用会变成死代码 + 静默降级）。
//
// T4 审计补齐（2026-09-14）：逐字段 argv 精确断言 + 两条错误车道的**逐码**状态码映射
// （403/404/413 曾全塌成 400）+ dryRun 宽松解析 + 超时/缓冲精确值。
// 字段 → flag 全量映射见 server/knowledge-routes.mjs 的路由注册处注释。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleKnowledgeRoute } from './knowledge-routes.mjs'

function ctx({ method = 'POST', url = '/knowledge/import', body = null, callKernel } = {}) {
  const u = new URL(`http://x${url}`)
  return {
    method, pathname: u.pathname, searchParams: u.searchParams,
    readJsonBody: async () => body,
    callKernel: callKernel || (async () => '{}'),
  }
}
/** 假内核：记录 (argv, opts)，返回预设 JSON 字符串 */
function fakeKernel(responder = () => ({})) {
  const calls = []
  const fn = async (argsList, opts) => {
    calls.push({ args: argsList, opts })
    return JSON.stringify(responder(argsList, opts))
  }
  fn.calls = calls
  return fn
}

const REPORT = {
  ok: true, spaceId: '资料库', spaceName: '资料库', spaceCreated: true, dryRun: false,
  counts: { total: 3, converted: 2, skipped: 0, failed: 1 },
  converted: [{ source: 'a.docx', out: 'a.md', converter: 'docx', bytes: 120, warnings: [] }],
  skipped: [], failed: [{ source: 'x.doc', error: 'unsupported', message: '旧版二进制格式' }],
  indexSync: 'reloaded', warnings: [],
  // 视觉表格提取的整批汇总（GUI 据此提示"未配置视觉模型"）——报告字段必须原样过路由，
  // 否则前端永远看到 undefined，提示逻辑形同虚设。
  vision: { configured: false, skipped: 'not-configured', used: false, pages: 0, tables: 0 },
}

test('POST /knowledge/import 薄转发为 `--knowledge import --src --space`，报告原样回', async () => {
  const callKernel = fakeKernel(() => REPORT)
  const r = await handleKnowledgeRoute(ctx({ body: { from: 'D:/资料', spaceId: '资料库' }, callKernel }))
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, REPORT)
  assert.deepEqual(callKernel.calls[0].args, ['--knowledge', 'import', '--src', 'D:/资料', '--space', '资料库'])
})

test('name / dryRun / maxOcrPages 只在给了才追加（空值等于没给）', async () => {
  const callKernel = fakeKernel(() => ({ ...REPORT, dryRun: true }))
  await handleKnowledgeRoute(ctx({
    body: { from: 'D:/资料', space: 's', name: '申报资料', dryRun: true, maxOcrPages: 50 },
    callKernel,
  }))
  assert.deepEqual(callKernel.calls[0].args, [
    '--knowledge', 'import', '--src', 'D:/资料', '--space', 's',
    '--name', '申报资料', '--dry-run', '--max-ocr-pages', '50',
  ])
  const callKernel2 = fakeKernel(() => REPORT)
  await handleKnowledgeRoute(ctx({
    body: { from: 'D:/资料', space: 's', name: '', dryRun: false, maxOcrPages: 0 },
    callKernel: callKernel2,
  }))
  assert.deepEqual(callKernel2.calls[0].args, ['--knowledge', 'import', '--src', 'D:/资料', '--space', 's'])
})

test('`space`（GET 习惯）与 `spaceId` 都收 —— 否则前端按 GET 习惯发就撞 400', async () => {
  const callKernel = fakeKernel(() => REPORT)
  await handleKnowledgeRoute(ctx({ body: { from: 'D:/a', space: 'x1' }, callKernel }))
  assert.deepEqual(callKernel.calls[0].args, ['--knowledge', 'import', '--src', 'D:/a', '--space', 'x1'])
  // 只给 name（空间名即 id）也要能走通
  await handleKnowledgeRoute(ctx({ body: { from: 'D:/a', name: '报告库' }, callKernel }))
  assert.deepEqual(callKernel.calls[1].args, ['--knowledge', 'import', '--src', 'D:/a', '--name', '报告库'])
})

test('from 数组 → 每个源一次 `--src`（GUI 多选文件就是这条）', async () => {
  const callKernel = fakeKernel(() => REPORT)
  const r = await handleKnowledgeRoute(ctx({
    body: { from: ['D:/a.pdf', 'D:/b.docx'], space: 's' }, callKernel,
  }))
  assert.equal(r.status, 200)
  assert.deepEqual(callKernel.calls[0].args, [
    '--knowledge', 'import', '--src', 'D:/a.pdf', '--src', 'D:/b.docx', '--space', 's',
  ])
  // 数组里的空项要被丢掉，不能变成 `--src ""`（内核会把它当成一个空路径源）
  const callKernel2 = fakeKernel(() => REPORT)
  await handleKnowledgeRoute(ctx({ body: { from: ['', 'D:/a.pdf', '  '], space: 's' }, callKernel: callKernel2 }))
  assert.deepEqual(callKernel2.calls[0].args, ['--knowledge', 'import', '--src', 'D:/a.pdf', '--space', 's'])
  // 全是空 → 400，不调内核
  const callKernel3 = fakeKernel()
  const r3 = await handleKnowledgeRoute(ctx({ body: { from: ['', ''], space: 's' }, callKernel: callKernel3 }))
  assert.equal(r3.status, 400)
  assert.equal(callKernel3.calls.length, 0)
})

test('缺 from / 缺 space 与 name → 400，且**不调内核**（必填校验是路由唯一该做的判断）', async () => {
  const callKernel = fakeKernel()
  for (const body of [{}, { from: '' }, { from: '   ' }, { from: 'D:/a' }, { from: 'D:/a', space: '', name: '' }]) {
    const r = await handleKnowledgeRoute(ctx({ body, callKernel }))
    assert.equal(r.status, 400, `应 400：${JSON.stringify(body)}`)
  }
  assert.equal(callKernel.calls.length, 0)
})

test('超时窗口必须显著长于默认值（扫描件 OCR 按分钟计，60s 必然超时）', async () => {
  const callKernel = fakeKernel(() => REPORT)
  await handleKnowledgeRoute(ctx({ body: { from: 'D:/a', space: 's' }, callKernel }))
  const opts = callKernel.calls[0].opts
  assert.ok(opts, '必须传 opts（否则退回 kernelReadonly 的短默认值）')
  // 精确值也钉住：普通读路由走 kernelReadonly 缺省 **60s**（server/kernel-readonly.mjs:60），
  // 本路由 15min = 15 倍。窗口是"跨层"契约：`.import.json` 的幂等台账保证超时后重试安全，
  // 但窗口仍必须 ≥ 客户端（src/lib/knowledgeApi.ts 的 IMPORT_TIMEOUT_MS = 16min）之下的最大值 ——
  // 客户端稍长，好让超时由**服务端**先报出具体错误，而不是客户端 AbortError 变成"请求超时"。
  assert.equal(opts.timeoutMs, 15 * 60 * 1000)
  assert.equal(opts.maxBuffer, 32 * 1024 * 1024)
  assert.ok(opts.timeoutMs >= 10 * 60 * 1000, `导入超时窗口过短：${opts.timeoutMs}ms`)
  assert.ok(opts.maxBuffer >= 16 * 1024 * 1024, 'stdout 上限过小会在多文件批次上截断报告')
})

test('dryRun 宽松解析：`"true"` 也算预览（漏认 = 预览静默变真写盘，最坏的一类降级）', async () => {
  // GUI 传布尔，但 agent/curl 常传 `"true"`。严格 `=== true` 时它会被当成"真导入"——
  // 用户以为在看报告，文件其实已经进空间（不可逆）。
  for (const v of [true, 'true', 'TRUE', ' true ', '1', 1, 'yes', 'on']) {
    const callKernel = fakeKernel(() => REPORT)
    await handleKnowledgeRoute(ctx({ body: { from: 'D:/a', space: 's', dryRun: v }, callKernel }))
    assert.deepEqual(callKernel.calls[0].args,
      ['--knowledge', 'import', '--src', 'D:/a', '--space', 's', '--dry-run'],
      `dryRun=${JSON.stringify(v)} 应带上 --dry-run`)
  }
  // 明确的"假"值 / 缺失：不带 flag（这就是真导入，与既有行为一致）
  for (const v of [undefined, null, false, 'false', '0', 0, 'no', 'off', '']) {
    const callKernel = fakeKernel(() => REPORT)
    await handleKnowledgeRoute(ctx({ body: { from: 'D:/a', space: 's', dryRun: v }, callKernel }))
    assert.deepEqual(callKernel.calls[0].args,
      ['--knowledge', 'import', '--src', 'D:/a', '--space', 's'],
      `dryRun=${JSON.stringify(v)} 不该带 --dry-run`)
  }
  // 认不出的值（拼错 `drunRun`/`"ture"`/对象）：**400 且不调内核** —— 猜错的代价是
  // 不可逆的真写盘，宁可拒。这与 §7.4「形状缺省即 400，绝不静默」同一纪律。
  for (const v of ['ture', 'dry', {}, [], 'y']) {
    const callKernel = fakeKernel(() => REPORT)
    const r = await handleKnowledgeRoute(ctx({ body: { from: 'D:/a', space: 's', dryRun: v }, callKernel }))
    assert.equal(r.status, 400, `dryRun=${JSON.stringify(v)} 应 400`)
    assert.equal(callKernel.calls.length, 0)
  }
})

test('maxOcrPages 只在是正数时透传（非法值交内核归一为缺省，不在路由再写一套数字校验）', async () => {
  const callKernel = fakeKernel(() => REPORT)
  await handleKnowledgeRoute(ctx({ body: { from: 'D:/a', space: 's', maxOcrPages: '50' }, callKernel }))
  assert.deepEqual(callKernel.calls[0].args,
    ['--knowledge', 'import', '--src', 'D:/a', '--space', 's', '--max-ocr-pages', '50'])
  await handleKnowledgeRoute(ctx({ body: { from: 'D:/a', space: 's', maxOcrPages: 12.7 }, callKernel }))
  assert.deepEqual(callKernel.calls[1].args,
    ['--knowledge', 'import', '--src', 'D:/a', '--space', 's', '--max-ocr-pages', '12'])
  // 与 /knowledge/graph|related 的 `limit` 同纪律：非法/缺省 → 不带 flag，由内核取缺省 200。
  for (const v of [undefined, 0, -1, 'abc', null, NaN]) {
    const callKernel2 = fakeKernel(() => REPORT)
    await handleKnowledgeRoute(ctx({ body: { from: 'D:/a', space: 's', maxOcrPages: v }, callKernel: callKernel2 }))
    assert.deepEqual(callKernel2.calls[0].args, ['--knowledge', 'import', '--src', 'D:/a', '--space', 's'])
  }
})

test('visionTables / maxVisionPages 的字段 → argv 映射（布尔翻 on/off，串原样透传）', async () => {
  // 为什么这两条必须逐字段精确断言：漏转发 = 静默降级。`visionTables:false` 若不转发，
  // 用户以为关掉了视觉调用，实际每个扫描件都在调模型（耗时 + 费用）；`maxVisionPages` 漏转发
  // 则页数护栏失效。字段名与内核 flag 是两套命名，靠这组断言钉在一起。
  const callKernel = fakeKernel(() => REPORT)
  await handleKnowledgeRoute(ctx({ body: { from: 'D:/a', space: 's', visionTables: false }, callKernel }))
  assert.deepEqual(callKernel.calls[0].args,
    ['--knowledge', 'import', '--src', 'D:/a', '--space', 's', '--vision-tables', 'off'])
  await handleKnowledgeRoute(ctx({ body: { from: 'D:/a', space: 's', visionTables: true }, callKernel }))
  assert.deepEqual(callKernel.calls[1].args,
    ['--knowledge', 'import', '--src', 'D:/a', '--space', 's', '--vision-tables', 'on'])
  // 串原样透传：取值合法性由内核判（路由不写第二套校验 —— 那种"两处口径"必然会漂移）
  await handleKnowledgeRoute(ctx({ body: { from: 'D:/a', space: 's', visionTables: 'auto' }, callKernel }))
  assert.deepEqual(callKernel.calls[2].args,
    ['--knowledge', 'import', '--src', 'D:/a', '--space', 's', '--vision-tables', 'auto'])
  // maxVisionPages：0 是**合法值**（显式"一页都不交给视觉模型"），必须与"没给"区分开 ——
  // 若这里把 0 当缺省丢掉，用户明确要求的"关闭"会静默变回默认 20。
  await handleKnowledgeRoute(ctx({ body: { from: 'D:/a', space: 's', maxVisionPages: 0 }, callKernel }))
  assert.deepEqual(callKernel.calls[3].args,
    ['--knowledge', 'import', '--src', 'D:/a', '--space', 's', '--max-vision-pages', '0'])
  await handleKnowledgeRoute(ctx({ body: { from: 'D:/a', space: 's', maxVisionPages: 7.8 }, callKernel }))
  assert.deepEqual(callKernel.calls[4].args,
    ['--knowledge', 'import', '--src', 'D:/a', '--space', 's', '--max-vision-pages', '7'])
  // 缺省/非法 → 不带 flag（由内核取缺省 20）；负数不合法（-1 会渲 0 页而语义含糊）
  for (const v of [undefined, null, 'abc', NaN, -1]) {
    const callKernel2 = fakeKernel(() => REPORT)
    await handleKnowledgeRoute(ctx({ body: { from: 'D:/a', space: 's', maxVisionPages: v }, callKernel: callKernel2 }))
    assert.deepEqual(callKernel2.calls[0].args, ['--knowledge', 'import', '--src', 'D:/a', '--space', 's'])
  }
  // 报告里的 vision 字段原样回传（GUI 靠它提示"未配置视觉模型"）
  const callKernel3 = fakeKernel(() => REPORT)
  const r = await handleKnowledgeRoute(ctx({ body: { from: 'D:/a', space: 's' }, callKernel: callKernel3 }))
  assert.deepEqual(r.body.vision, REPORT.vision)
})

test('整批级错误 → 4xx（错误体走 stdout 那条车道；与 stderr 车道同一张映射表）', async () => {
  // 状态码语义（spec P3-1）：非法 id = 400、只读空间 = 403、源不存在 = 404、批量过大 = 413、
  // 服务端环境问题（bad-config）= 500。两条车道必须查同一张表，否则同一个错误会因"从哪条路来"
  // 得到两种状态码（这正是本次审计发现的缺口：stderr 车道曾把 403/404/413 全压成 400）。
  // 本表 = 内核**整批级**码的全集（逐 `bad(` 调用点核对过，见路由里 IMPORT_ERROR_STATUS 的
  // 「码覆盖清点」）：kernel/knowledge-import.mjs 的 bad-space-id/readonly-space/not-found/
  // bad-source/empty-source/too-many-files/batch-too-large/bad-config + 别名层的
  // invalid-space-id/empty-batch + knowledge-cli.mjs 的 missing-from/bad-max-ocr-pages
  // + 写边界拒绝 target-escape。**每个码都必须在这里出现**：漏一个就等于"兜底 400"，
  // 而 400 会让调用方去改参数（改不动）而不是分批/换空间/看服务端。
  for (const [error, status] of [
    ['bad-space-id', 400], ['invalid-space-id', 400], ['bad-source', 400], ['missing-from', 400],
    ['bad-max-ocr-pages', 400], ['empty-source', 400], ['empty-batch', 400],
    ['bad-vision-tables', 400], ['bad-max-vision-pages', 400],
    ['readonly-space', 403], ['target-escape', 403],
    ['not-found', 404],
    ['too-many-files', 413], ['batch-too-large', 413],
    ['bad-config', 500], ['space-create-failed', 500],
  ]) {
    const callKernel = fakeKernel(() => ({ ok: false, error, message: '原因' }))
    const r = await handleKnowledgeRoute(ctx({ body: { from: 'D:/a', space: 's' }, callKernel }))
    assert.equal(r.status, status, `${error} 应映射 ${status}`)
    assert.equal(r.body.error, error)          // 错误码原样透出（GUI 可按码给针对性提示）
    assert.equal(r.body.code, error)
    assert.equal(r.body.message, '原因')       // 理由原样透出，路由不改写措辞
  }
})

// 下面这组用的是**真实内核**捕获的 stderr 行（2026-09-14 以与 kernelReadonly 逐字节同形的 argv
// 实跑得到：`node kernel/cli.mjs --output-format stream-json --input-format stream-json
// --knowledge import …`）。为什么必须用真串而不是自己编一个：路由是从这行文本里**解析**错误码的，
// 编的串只能证明"按我编的格式能解析"，证明不了"内核真实格式能解析"。
test('内核非零退出（stderr `[knowledge] <code>: <msg>`）→ 按码映射状态码，理由原样带上', async () => {
  const REAL = [
    ['[knowledge] readonly-space: space 不得以 "pack-" 开头（那是只读知识包的保留前缀）', 403, 'readonly-space'],
    ['[knowledge] bad-space-id: space 含非法字符（\\ / : * ? " < > | 或控制字符）：a/b', 400, 'bad-space-id'],
    ['[knowledge] not-found: 导入源不存在：C:\\Users\\T203-15\\AppData\\Local\\Temp\\no-such-xyz', 404, 'not-found'],
    ['[knowledge] too-many-files: 文件数 501 超出单批上限 500（请分批导入）', 413, 'too-many-files'],
    // 写边界拒绝（空间目录是 junction）与 CLI 参数校验：都是**整批级**，语义各不同（403/400），
    // 曾一起落进兜底 400 —— 那会让"清掉那个链接/换空间"与"改参数"看起来是同一件事。
    ['[knowledge] target-escape: 空间目录经 realpath 解析落在 knowledge/spaces 之外（是指向别处的链接？）', 403, 'target-escape'],
    ['[knowledge] bad-max-ocr-pages: import: --max-ocr-pages 必须是 ≥1 的数值（收到 "abc"；不传则用内核默认 200）', 400, 'bad-max-ocr-pages'],
  ]
  for (const [line, status, code] of REAL) {
    const callKernel = async () => { throw new Error(line) }
    const r = await handleKnowledgeRoute(ctx({ body: { from: 'D:/a', space: 's' }, callKernel }))
    assert.equal(r.status, status, `${line} 应映射 ${status}`)
    assert.equal(r.body.code, code)
    // 前缀被剥掉、码与中文理由都保留（调用方要能看到"为什么被拒"）
    assert.ok(!r.body.error.startsWith('[knowledge]'), '前缀不该透给前端')
    assert.ok(r.body.error.includes(code), '错误码要留在文本里')
  }
  // 认不出的码：底裤是 400（`[knowledge]` 前缀本身就意味着"请求被闸门拒了"，
  // 而不是"服务崩了"—— 500 会让调用方去重试/报障）
  const callKernel2 = async () => { throw new Error('[knowledge] 某个还没登记的新码: 原因') }
  const r2 = await handleKnowledgeRoute(ctx({ body: { from: 'D:/a', space: 's' }, callKernel: callKernel2 }))
  assert.equal(r2.status, 400)
  assert.equal(r2.body.code, undefined)
})

test('非闸门类失败（超时/崩溃）不被误标为 400 —— 冒泡为 500', async () => {
  const callKernel = async () => { throw new Error('[kernel-readonly] timeout 900000ms') }
  const r = await handleKnowledgeRoute(ctx({ body: { from: 'D:/a', space: 's' }, callKernel }))
  assert.equal(r.status, 500, '内核崩了不该告诉调用方"是你的输入不合规"')
  // 我们自己的 harness 消息形状固定、不含路径 → 原样透出（调用方唯一能据以判断"是超时还是崩溃"）
  assert.equal(r.body.error, '导入失败：[kernel-readonly] timeout 900000ms')
  assert.equal(r.body.code, 'kernel-failed')
})

// ── 泄漏防护（本次 T4 补齐）──────────────────────────────────────────────────
// 内核非零退出时，`kernelReadonly` 把 **stderr 前 8KB 原样**塞进 `e.message`
// （server/kernel-readonly.mjs:97）。内核崩溃时那段文本是 Node 的 code frame + 绝对路径栈。
// 要求：错误 message 可读、但不把内部路径/栈摊给客户端。
test('内核崩溃的 stderr 栈**不得**透给客户端（含绝对路径的 code frame → 定式消息）', async () => {
  const crash = [
    'D:\\app\\resources\\kernel\\cli.mjs:123',
    '  throw new Error("boom")',
    '  ^',
    '',
    'Error: boom',
    '    at Object.<anonymous> (D:\\app\\resources\\kernel\\cli.mjs:123:9)',
    '    at Module._compile (node:internal/modules/cjs/loader:1254:14)',
  ].join('\n')
  const callKernel = async () => { throw new Error(crash) }
  const r = await handleKnowledgeRoute(ctx({ body: { from: 'D:/a', space: 's' }, callKernel }))
  assert.equal(r.status, 500)
  const body = JSON.stringify(r.body)
  assert.ok(!body.includes('cli.mjs'), `不该泄漏内核文件路径：${body}`)
  assert.ok(!body.includes('at Object.<anonymous>') && !body.includes('node:internal'), `不该泄漏栈帧：${body}`)
  assert.ok(!body.includes('D:\\app'), '不该泄漏服务端目录结构')
  assert.match(r.body.error, /内核异常退出/, '要给一句可读的定式消息（不是空错误体）')
  assert.equal(r.body.code, 'kernel-failed', '给码，便于调用方区分"网关拒绝"与"内核挂了"')
})

test('闸门行被夹在别的 stderr 噪音中时，只透那一行（不是整段 stderr）', async () => {
  // 场景：内核在失败行前后又写了点东西（第三方库告警 / 将来在 --knowledge 分支前加的日志）。
  // 旧实现用 `includes('[knowledge]')` + `replace(/^\[knowledge\]/)`：前缀不在开头，前面那行
  // 就被原样留在响应里。逐行挑才只透内核想给的那一句。
  const noisy = [
    '(node:1234) ExperimentalWarning: something',
    'warning: D:\\app\\resources\\kernel\\internal-impl.mjs loaded',
    '[knowledge] readonly-space: space 不得以 "pack-" 开头（那是只读知识包的保留前缀）',
    'D:\\app\\resources\\kernel\\cli.mjs:355',
  ].join('\n')
  const callKernel = async () => { throw new Error(noisy) }
  const r = await handleKnowledgeRoute(ctx({ body: { from: 'D:/a', space: 'pack-x' }, callKernel }))
  assert.equal(r.status, 403, '闸门行照常按码映射（403），不能被噪音带偏成 400/500')
  assert.equal(r.body.code, 'readonly-space')
  assert.equal(r.body.error.startsWith('readonly-space: '), true)
  const body = JSON.stringify(r.body)
  assert.ok(!body.includes('internal-impl.mjs') && !body.includes('ExperimentalWarning'), `噪音不该透出：${body}`)
})

test('第二条车道（stdout 错误体）错误码原样透出、不夹带其它字段', async () => {
  // `{ok:false,error}` 只回码与 message：不要把内核 stdout 的整包东西（如内部路径）一起传出去。
  const callKernel = fakeKernel(() => ({ ok: false, error: 'target-escape', message: '空间目录经 realpath 解析落在 knowledge/spaces 之外' }))
  const r = await handleKnowledgeRoute(ctx({ body: { from: 'D:/a', space: 's' }, callKernel }))
  assert.equal(r.status, 403)
  assert.deepEqual(Object.keys(r.body).sort(), ['code', 'error', 'message'])
})

test('真实报告形状（results/summary 那份契约）也照样透传，路由不重排字段', async () => {
  // T3 的 `importFiles` 交的是 `{results[], summary}`，内核 CLI 现走 `importDocuments`
  // （counts/converted/skipped/failed，见 src/lib/knowledgeApi.ts 的 KnowledgeImportReport）。
  // 路由对两者都必须**逐字节透传**：它一旦"顺手归一字段"，第三种口径就出现了。
  const ALT = {
    ok: true, space: '资料库', spaceName: '资料库', spaceCreated: false, spaceExisted: true,
    dryRun: true, targetDir: 'C:/cfg/knowledge/spaces/资料库',
    results: [
      { source: 'a.docx', rel: 'a.docx', status: 'imported', mdRel: 'a.md', bytes: 120, converter: 'docx', truncated: false, warnings: [] },
      { source: 'x.doc', rel: 'x.doc', status: 'rejected', error: 'unsupported', message: '旧版二进制格式' },
    ],
    summary: { total: 2, imported: 1, skipped: 0, rejected: 1, failed: 0 },
    indexSync: 'reloaded', warnings: ['1 个文件被拒'],
  }
  const callKernel = fakeKernel(() => ALT)
  const r = await handleKnowledgeRoute(ctx({ body: { from: 'D:/资料', space: '资料库' }, callKernel }))
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, ALT)
  assert.equal(r.body.results.length, 2, 'results 明细必须在（P1-3：每条都要能对上账）')
  assert.equal(r.body.summary.rejected, 1)
})

test('空请求体 / body 为 null → 400 且不调内核（readJsonBody 的缺省形状也要兜住）', async () => {
  const callKernel = fakeKernel()
  for (const body of [null, undefined, {}]) {
    const r = await handleKnowledgeRoute(ctx({ body, callKernel }))
    assert.equal(r.status, 400, `body=${JSON.stringify(body)} 应 400`)
    assert.equal(r.body.error.includes('from'), true, '错误要指向缺的那个字段（from）')
  }
  assert.equal(callKernel.calls.length, 0, '必填校验必须在调内核之前')
})

test('非字符串标量源（如数字）不静默丢弃，String() 后透传，交内核判"源不存在"→404', async () => {
  // "路由不自己判路径是否存在"是薄转发的核心纪律：路由猜"这不是路径"就会把 404 变成 400，
  // 而 404/400 对调用方是两件事（换路径 vs 改参数）。故只做形状归一（String+trim），不做语义判定。
  const callKernel = fakeKernel(() => ({ ok: false, error: 'not-found', message: '导入源不存在：42' }))
  const r = await handleKnowledgeRoute(ctx({ body: { from: 42, space: 's' }, callKernel }))
  assert.deepEqual(callKernel.calls[0].args, ['--knowledge', 'import', '--src', '42', '--space', 's'])
  assert.equal(r.status, 404)
})

test('内核返回非 JSON → 502（不把解析失败当成功）', async () => {
  const callKernel = async () => '这不是 JSON'
  const r = await handleKnowledgeRoute(ctx({ body: { from: 'D:/a', space: 's' }, callKernel }))
  assert.equal(r.status, 502)
})

test('逐文件失败仍返回 200 + 明细（不是 op 失败，不该变 4xx/5xx）', async () => {
  const callKernel = fakeKernel(() => ({ ...REPORT, counts: { total: 1, converted: 0, skipped: 0, failed: 1 } }))
  const r = await handleKnowledgeRoute(ctx({ body: { from: 'D:/a', space: 's' }, callKernel }))
  assert.equal(r.status, 200)
  assert.equal(r.body.failed.length, 1)
})

test('server 侧不做文件数/体积上限（内核是唯一权威）—— 超限由内核拒并映射 413', async () => {
  // 审计事实（2026-09-14）：本路由**没有**自己的文件数或 body 体积护栏，理由与 spec §5.7
  // 的"薄转发"一致 —— 上限一旦在两侧各写一份必然漂移，且内核那份要随解析能力（OCR/表格）
  // 调整。故这里钉住"600 个源原样透传"（不是"能导 600 个"，内核 maxBatchFiles=500 会拒）。
  const many = Array.from({ length: 600 }, (_, i) => `D:/dir/f${i}.pdf`)
  const callKernel = fakeKernel(() => ({ ok: false, error: 'too-many-files', message: '文件数 600 超出单批上限 500（请分批导入）' }))
  const r = await handleKnowledgeRoute(ctx({ body: { from: many, space: 's' }, callKernel }))
  assert.equal(r.status, 413, '内核的批量上限错误要映射成 413（调用方据此分批重试）')
  const args = callKernel.calls[0].args
  assert.equal(args.filter((a) => a === '--src').length, 600, '每源一次 --src，路由不自行截断')
  assert.deepEqual(args.slice(0, 4), ['--knowledge', 'import', '--src', 'D:/dir/f0.pdf'])
  assert.deepEqual(args.slice(-2), ['--space', 's'])
})

test('import 是 POST-only：GET /knowledge/import 落回 null（不冒充 405）', async () => {
  const r = await handleKnowledgeRoute(ctx({ method: 'GET', url: '/knowledge/import' }))
  assert.equal(r, null)
})
