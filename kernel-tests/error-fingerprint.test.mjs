// kernel-tests/error-fingerprint.test.mjs —— P1 Task 1：错误指纹纯函数（设计 §4.1、方案 Task 1）
//
// 为什么先写测试：指纹的唯一价值是「同错同码、异错异码」。这两条只要有一条不成立，
// 归因视图就把两件事并成一件（或一件拆成两件），后续 MTTR / 复发率全部失真。
// 四条不变量：① 稳定性 ② 区分性 ③ 幂等 ④ 空输入 = null（不参与聚合）
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeErrorText, fingerprintOf } from '../kernel/error-fingerprint.mjs'

// ── ① 稳定性：同一错误的不同写法必须归到同一个 fp ────────────────────────────
test('★ 稳定性：路径 / 行号 / 时间戳 / GUID 变化不改 fp', () => {
  const a = "2026-10-21 07:47:03 ERROR open 'C:\\Users\\A\\proj\\src\\a.mjs' failed: ENOENT (line 42)"
  const b = "2026-10-27 09:12:59 ERROR open 'D:\\work\\other\\b.ts' failed: ENOENT (line 107)"
  assert.equal(fingerprintOf(a), fingerprintOf(b), '同一错误换路径/行号/时间戳后 fp 必须相同')
})

test('★ 稳定性：会话 id 与耗时（ms）不影响 fp', () => {
  const a = 'session 8f2c1b7a-3a44-4c1e-9c2a-1f0d2e3b4c5d 超时（120000ms）'
  const b = 'session 11111111-2222-3333-4444-555555555555 超时（60000ms）'
  assert.equal(fingerprintOf(a), fingerprintOf(b))
})

// ── ② 区分性：不同错误不得撞码（宁少并、不错并）────────────────────────────
test('★★ 区分性：三种不同错误必须是三个不同 fp', () => {
  const errs = [
    '退出码 2 stderr: kernel: only stream-json I/O format is supported',
    "写入失败：ENOENT: no such file or directory, open 'x.json'",
    '正则无效：Invalid regular expression: /(?i)atlas/: Invalid group',
  ]
  const fps = errs.map((e) => fingerprintOf(e))
  assert.equal(new Set(fps).size, 3, `三种错误必须三个 fp，实际 ${JSON.stringify(fps)}`)
  assert.ok(fps.every((f) => typeof f === 'string' && f.length === 12), 'fp 形态 = 12 位十六进制')
})

test('★ 区分性：数字量级不同（同一条错误的阈值差异）不改变 fp —— 那是同一类错误', () => {
  const a = '扫描超出时间预算，已中止（已扫 1437 个条目 / 10003ms）'
  const b = '扫描超出时间预算，已中止（已扫 981 个条目 / 10020ms）'
  assert.equal(fingerprintOf(a), fingerprintOf(b))
})

// ── ③ 幂等：归一化两次 == 归一化一次（否则跨源比对会漂移）──────────────────
test('★ 幂等：normalize(normalize(x)) === normalize(x)', () => {
  const samples = [
    "ENOENT: no such file or directory, open 'C:\\a\\b.mjs'",
    '2026-10-27T09:12:33.123Z GET /evolution/candidates 500',
    'Invalid regular expression: /(?i)atlas/: Invalid group',
    'sha256=deadbeefdeadbeef token=abcdef123456',
  ]
  for (const s of samples) {
    const once = normalizeErrorText(s)
    assert.equal(normalizeErrorText(once), once, `不幂等：${s}`)
  }
})

// ── ④ 边界：空/非字符串 ⇒ null（不参与聚合，不当成空 fp 去并堆）──────────────
test('★ 边界：空串 / 纯空白 / 非字符串 ⇒ fingerprintOf 返回 null', () => {
  for (const v of ['', '   \n\t ', null, undefined, 42, {}]) {
    assert.equal(fingerprintOf(v), null, `应返回 null：${JSON.stringify(v)}`)
  }
})

test('★ 边界：超长文本只取头尾（前 4 KB + 后 1 KB），不因长度改变同错判定', () => {
  // 构造：头 > 4 KB、尾 ≥ 1 KB ⇒ 中段（2000 字符）必然落在被丢弃的区间里
  const head = 'ERR_STABLE_PREFIX '.repeat(300)   // ≈ 5.4 KB
  const tail = 'Z'.repeat(1200)                   // ≥ 1 KB，保证尾部切片不含中段
  const mid1 = 'x'.repeat(2000)
  const mid2 = 'y'.repeat(2000)
  assert.equal(fingerprintOf(head + mid1 + tail), fingerprintOf(head + mid2 + tail),
    '中段噪声不该影响 fp（只保留头尾）')
})
