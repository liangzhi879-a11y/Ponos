// kernel-tests/knowledge-import-progress.test.mjs —— 批量导入的进度旁路与上限覆盖（2026-09-14）
//
// 需求："支持批量大量文件、上传时显示进度条（先查文件数，然后根据实时处理的文件数量算进度）"。
//
// 这里钉的是**契约中最容易静默错**的四件事，而不是形式覆盖：
// ① plan 事件的 total 必须等于实际文件数 —— GUI 的分母就来自它；错了整条进度条就是假的。
// ② process 的 done 必须**按下标单调递增到 total-1**，且**跳过/被拒/失败的文件也计入**。
//    这是本实现最容易写错的一点：若按"成功数"计，被跳过的文件会让进度条永远差一截。
// ③ onProgress 抛错**不能**影响导入结果（进度是旁路，消费方崩了照样要落盘）。
// ④ `--max-files`/`max-total-mb` 覆盖必须真的生效（键名写错时内核**不报错**、只静默按默认走）。
//
// 纪律同 knowledge-import.test.mjs：不启动 bridge、不依赖真实 python/OCR（转换器注入假实现）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importDocuments, IMPORT_LIMITS } from '../kernel/knowledge-import.mjs'

function mkHome() {
  const dir = mkdtempSync(join(tmpdir(), 'yfw-kbpg-'))
  writeFileSync(join(dir, 'config.json'), '{"model":"fake"}')
  return dir
}
function mkSrc(files) {
  const dir = mkdtempSync(join(tmpdir(), 'yfw-kbpgsrc-'))
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, ...rel.split('/'))
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content, 'utf-8')
  }
  return dir
}
const fakeConvert = ({ rel }) => Promise.resolve({
  ok: true,
  value: { converter: 'docx', title: rel, sections: [{ heading: 'h', level: 1, text: '正文', tables: [] }], warnings: [] },
})

test('进度：plan 先报总数，process 按下标递增，done 收尾', async () => {
  const home = mkHome()
  const src = mkSrc({ 'a.docx': 'x', 'b.docx': 'y', '子目录/c.docx': 'z' })
  const events = []
  const r = await importDocuments({
    configDir: home, from: src, space: '进度库', converter: fakeConvert,
    onProgress: (e) => events.push(e),
  })
  assert.equal(r.ok, true)
  assert.equal(r.counts.converted, 3)

  // ① 首个事件必须是 plan，且 total == 实际文件数（GUI 的分母来源）
  assert.equal(events[0].phase, 'plan', '首个进度事件应为 plan')
  assert.equal(events[0].total, 3, 'plan 的 total 必须等于文件数')
  assert.equal(events[0].done, 0)
  assert.equal(typeof events[0].totalBytes, 'number')

  // ② process 事件覆盖每个文件一次，done = 0..2（下标，含最后一个文件时 done=total-1）
  const proc = events.filter((e) => e.phase === 'process')
  assert.equal(proc.length, 3, '每个文件应有且仅有一个 process 事件')
  assert.deepEqual(proc.map((e) => e.done), [0, 1, 2], 'done 应为 0,1,2 递增（循环下标）')
  assert.ok(proc.every((e) => e.total === 3), '每个 process 事件的 total 应恒为计划文件数')
  assert.ok(proc.every((e) => typeof e.current === 'string' && e.current.length > 0), 'process 应带当前文件相对路径')

  // ③ 末事件必须是 done，且 done === total（进度条可据此收到 100%）
  const last = events[events.length - 1]
  assert.equal(last.phase, 'done')
  assert.equal(last.done, 3)
  assert.equal(last.total, 3)

  rmSync(home, { recursive: true, force: true })
  rmSync(src, { recursive: true, force: true })
})

test('进度：二次导入全部跳过时，done 仍收敛到 total（分母一致性）', async () => {
  const home = mkHome()
  const src = mkSrc({ 'a.docx': 'x', 'b.docx': 'y', 'c.docx': 'z' })
  await importDocuments({ configDir: home, from: src, space: '幂等库', converter: fakeConvert })

  // 同一份源再导一次：全部走 skipped 分支（多条 continue 的典型路径）
  const events = []
  const r2 = await importDocuments({
    configDir: home, from: src, space: '幂等库', converter: fakeConvert,
    onProgress: (e) => events.push(e),
  })
  assert.equal(r2.counts.converted, 0)
  assert.equal(r2.counts.skipped, 3, '第二次导入应全部跳过')

  const proc = events.filter((e) => e.phase === 'process')
  assert.deepEqual(proc.map((e) => e.done), [0, 1, 2],
    '被跳过的文件也必须计入 done —— 否则进度条永远差一截（分母对不上）')
  assert.equal(events[events.length - 1].done, 3)
  assert.equal(events[events.length - 1].total, 3)

  rmSync(home, { recursive: true, force: true })
  rmSync(src, { recursive: true, force: true })
})

test('进度：onProgress 抛错不影响导入成功（进度是旁路）', async () => {
  const home = mkHome()
  const src = mkSrc({ 'a.docx': 'x', 'b.docx': 'y' })
  let calls = 0
  const r = await importDocuments({
    configDir: home, from: src, space: '容错库', converter: fakeConvert,
    onProgress: () => { calls += 1; throw new Error('消费者崩了') },
  })
  assert.equal(r.ok, true, '进度回调抛错不应让导入失败')
  assert.equal(r.counts.converted, 2, '文件必须照常落盘')
  assert.ok(calls > 0, '回调确实被调用过（不是被直接跳过）')

  rmSync(home, { recursive: true, force: true })
  rmSync(src, { recursive: true, force: true })
})

test('上限：maxBatchFiles 覆盖生效，超限整批拒绝（不是只导前 N 个）', async () => {
  const home = mkHome()
  const src = mkSrc({ 'a.docx': '1', 'b.docx': '2', 'c.docx': '3' })

  // 覆盖到 2：3 个文件应被整批拒绝
  const denied = await importDocuments({
    configDir: home, from: src, space: '上限库', converter: fakeConvert,
    limits: { maxBatchFiles: 2 },
  })
  assert.equal(denied.ok, false, '超过 maxBatchFiles 应整批拒绝')
  assert.equal(denied.error, 'too-many-files')
  assert.match(denied.message, /3/, '拒绝消息里应带上实际文件数，便于用户判断要怎么分批')

  // 覆盖到 5：应放行
  const allowed = await importDocuments({
    configDir: home, from: src, space: '上限库', converter: fakeConvert,
    limits: { maxBatchFiles: 5 },
  })
  assert.equal(allowed.ok, true, '放宽上限后应放行')
  assert.equal(allowed.counts.converted, 3)

  // 默认档仍是内核历史值（改默认要同时改 server/knowledge-import-policy.cjs，parity 测试钉住）
  assert.equal(IMPORT_LIMITS.maxBatchFiles, 500)

  rmSync(home, { recursive: true, force: true })
  rmSync(src, { recursive: true, force: true })
})

test('上限：maxBatchBytes 覆盖生效（总字节护栏同样可配）', async () => {
  const home = mkHome()
  // 造 ~3KB 内容，上限设 1KB → 拒绝
  const src = mkSrc({ 'a.docx': 'x'.repeat(3000) })
  const denied = await importDocuments({
    configDir: home, from: src, space: '字节库', converter: fakeConvert,
    limits: { maxBatchBytes: 1024 },
  })
  assert.equal(denied.ok, false)
  assert.equal(denied.error, 'batch-too-large')

  const allowed = await importDocuments({
    configDir: home, from: src, space: '字节库', converter: fakeConvert,
    limits: { maxBatchBytes: 1024 * 1024 },
  })
  assert.equal(allowed.ok, true)

  rmSync(home, { recursive: true, force: true })
  rmSync(src, { recursive: true, force: true })
})

test('递归：文件夹源含多层子目录，全部被收集且保留目录结构', async () => {
  const home = mkHome()
  // 四层深 + 一个同级分支
  const src = mkSrc({
    'top.docx': 'a',
    'x/lv2.docx': 'b',
    'x/y/lv3.docx': 'c',
    'x/y/z/lv4.docx': 'd',
    'other/e.docx': 'e',
  })
  const events = []
  const r = await importDocuments({
    configDir: home, from: src, space: '递归库', converter: fakeConvert,
    onProgress: (e) => events.push(e),
  })
  assert.equal(r.ok, true)
  assert.equal(events[0].total, 5, '四层子目录的文件都应被发现（"子目录及以下"）')
  assert.equal(r.counts.converted, 5)
  const outs = r.converted.map((x) => x.out).filter(Boolean).join(' | ')
  assert.match(outs, /lv4/, '深层文件应保留在产出路径中')

  rmSync(home, { recursive: true, force: true })
  rmSync(src, { recursive: true, force: true })
})
