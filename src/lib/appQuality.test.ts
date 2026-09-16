// src/lib/appQuality.test.ts
// node --test src/lib/appQuality.test.ts
//
// 这些断言锁的是"自动质检不重跑"与"提示词硬约束"两条**行为不变量**：
//   ① 指纹稳定（键序无关、数组保序）——否则每次读盘都判"spec 变了"→ 每进一次应用页就重跑一轮；
//   ② shouldAutoQuality 的四个否决分支——否则要么并发跑、要么白跑；
//   ③ 提示词里的硬约束（只复跑 read / write 不执行 / 不得删命令 / 不得改 expose）——
//      这些是安全边界，被"顺手润色"掉就等于允许模型在真实系统里写数据。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { specFingerprint, shouldAutoQuality, buildQualityPrompt } from './appQuality.ts'

test('specFingerprint：对象键序无关（同一份逻辑内容恒得同一个指纹）', () => {
  const a = { specVersion: 1, name: 'x', commands: [{ action: 'q', kind: 'read' }] }
  const b = { commands: [{ kind: 'read', action: 'q' }], name: 'x', specVersion: 1 }
  assert.equal(specFingerprint(a), specFingerprint(b))
  // 嵌套对象同样按键序无关
  assert.equal(
    specFingerprint({ target: { type: 'web', url: 'u' } }),
    specFingerprint({ target: { url: 'u', type: 'web' } }),
  )
})

test('specFingerprint：数组保序（命令表顺序有语义，不得当无序集合）', () => {
  assert.notEqual(specFingerprint(['a', 'b']), specFingerprint(['b', 'a']))
  assert.notEqual(
    specFingerprint({ commands: [{ action: 'a' }, { action: 'b' }] }),
    specFingerprint({ commands: [{ action: 'b' }, { action: 'a' }] }),
  )
})

test('specFingerprint：不同内容 → 不同指纹；同内容 → 同指纹；脏输入不抛', () => {
  assert.notEqual(specFingerprint({ a: 1 }), specFingerprint({ a: 2 }))
  assert.equal(specFingerprint({ a: 1 }), specFingerprint({ a: 1 }))
  // 8 位十六进制
  assert.match(specFingerprint({ a: 1 }), /^[0-9a-f]{8}$/)
  // undefined / null / 原始值 / 空对象都不抛
  for (const v of [undefined, null, 0, '', false, [], {}]) {
    assert.equal(typeof specFingerprint(v), 'string')
  }
  // undefined 值的键写盘即丢 → 与缺字段视为同一内容（否则读盘后必判"变了"）
  assert.equal(specFingerprint({ a: undefined }), specFingerprint({}))
})

const MARK = { fingerprint: 'abcd1234', checkedAt: 1, clean: true, findings: 0 }
const base = { autoQuality: true, fingerprint: 'new99999', spec: { commands: [] }, isStreaming: false }

test('shouldAutoQuality：开着自动质检 + 空闲 + 有 spec + 指纹变了 → true', () => {
  assert.equal(shouldAutoQuality({ ...base, quality: MARK }), true)
  assert.equal(shouldAutoQuality({ ...base, quality: null }), true)
})

test('shouldAutoQuality：指纹相同 → false（这一版已查过，不要每次进入都重跑）', () => {
  assert.equal(shouldAutoQuality({ ...base, fingerprint: MARK.fingerprint, quality: MARK }), false)
})

test('shouldAutoQuality：isStreaming → false（绝不并发）', () => {
  assert.equal(shouldAutoQuality({ ...base, quality: MARK, isStreaming: true }), false)
})

test('shouldAutoQuality：无 spec → false；autoQuality 关闭 → false', () => {
  assert.equal(shouldAutoQuality({ ...base, quality: MARK, spec: null }), false)
  assert.equal(shouldAutoQuality({ ...base, quality: MARK, spec: undefined }), false)
  assert.equal(shouldAutoQuality({ ...base, quality: MARK, autoQuality: false }), false)
})

test('shouldAutoQuality：并发优先于"指纹变了"（流式中即使 spec 变了也不跑）', () => {
  assert.equal(shouldAutoQuality({ ...base, quality: MARK, isStreaming: true }), false)
})

test('buildQualityPrompt：注入已给事实（自检结论 / 试跑明细 / Spec 摘要）', () => {
  const p = buildQualityPrompt({
    appName: '演示应用',
    check: { status: 'drifted', issues: ['命令 query 的 params 与真实必填项不一致'] },
    verifyReport: {
      tried: ['query', 'list'],
      failures: [{ action: 'query', error: '步骤 click 失败：未找到元素 #ok' }],
      notRun: ['submit'],
      skipped: ['detail'],
    },
    specSummary: 'driver=browser；target.type=web；命令：query(read)、submit(write)',
  })
  assert.match(p, /演示应用/, '应用名要进提示词')
  assert.match(p, /drifted/)
  assert.match(p, /命令 query 的 params 与真实必填项不一致/)
  assert.match(p, /query｜步骤 click 失败：未找到元素 #ok/, '失败明细必须含 action + error')
  assert.match(p, /通过 1 条，失败 1 条/, '通过数 = tried - failures')
  assert.match(p, /driver=browser/, 'Spec 摘要原样注入')
  assert.match(p, /submit/, 'write 命令列入"未试跑"')
})

test('buildQualityPrompt：硬约束必须逐字出现（安全边界，不得被润色掉）', () => {
  const p = buildQualityPrompt({ appName: 'x' })
  for (const must of [
    '逐条真实复跑',       // 复跑而不是凭报错猜
    'write 命令一律不执行', // 写操作绝不在质检里执行
    '不得删除命令',
    '不得修改 expose',
    '必须先 Read',
    '```json',            // 结构化结论契约
  ]) {
    assert.ok(p.includes(must), `提示词缺少硬约束：${must}`)
  }
  assert.match(p, /"findings"/)
  assert.match(p, /"clean"/)
})

test('buildQualityPrompt：对空值健壮（缺字段写"（无）"，不抛、不出现 undefined）', () => {
  for (const input of [undefined, {}, { appName: '' }, { check: null, verifyReport: null, specSummary: null }]) {
    const p = buildQualityPrompt(input as never)
    assert.equal(typeof p, 'string')
    assert.ok(p.length > 0)
    assert.ok(p.includes('（无）'), '缺字段必须落成"（无）"')
    assert.ok(!p.includes('undefined'), '提示词里不得出现 undefined 字样')
    assert.ok(!p.includes('[object Object]'))
  }
  // 脏形状（数组/字符串/数字混进来）也不抛
  const dirty = buildQualityPrompt({
    appName: 42 as never,
    check: { status: null, issues: [null, '', ' 有效 '] } as never,
    verifyReport: { tried: 'query', failures: [{ action: null, error: null }, null] } as never,
    specSummary: {} as never,
  })
  assert.ok(dirty.includes('有效'))
  assert.ok(!dirty.includes('undefined'))
})
