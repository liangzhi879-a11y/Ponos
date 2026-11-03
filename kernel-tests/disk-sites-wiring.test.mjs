// 落盘埋点的**静态对账**：site 名必须与真实落盘点一一对应。
// 为什么必须有（本仓实测教训）：自愈阶梯那次，初版漏登记两个 reason + 只认一种事件形态，
// 两条自愈路径在观测面上静默没有级别——"统一观测"悄悄退化成过期注释。落盘域同理：
// 漏埋一个点 ⇒ 快照永远说"ok"，而那个点可能正是写不进去的那个。
//
// ★ Task 3 review 修的两个"空转断言"（实测加 `// disk-site: ghost-site`、或"删真调用留注释"
//   都能骗过旧版并保持绿）：
//   ③ 孤儿标记检查原先只遍历硬编码的 SITE_FILE 表 ⇒ 改成**真扫描** 5 个实现文件的源码，
//      凡出现过的 `// disk-site: <name>` 都必须在 DISK_SITES 里，且**每个文件里每个 site 至多 1 次**。
//   ④ `diskWrite(…'<site>'` 的匹配原先对注释也生效 ⇒ 改成**先剔除注释**再做匹配。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DISK_SITES, createDiskTelemetry } from '../kernel/disk-telemetry.mjs'
import { diskWrite } from '../kernel/disk-write.mjs'

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

/** 按行去掉 `//` 之后的部分，再去掉 `/* *\/` 块（本仓无嵌套块注释、无此类正则字面量，足够精确）。 */
function stripComments(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => { const i = l.indexOf('//'); return i >= 0 ? l.slice(0, i) : l })
    .join('\n')
}

// site → 实现文件（与 spec §2.1 表格逐字一致）
const SITE_FILE = {
  'transcript-append': '../kernel/session.mjs',
  'transcript-usage': '../kernel/session.mjs',
  'session-memory': '../kernel/cli.mjs',
  'loop-state': '../kernel/loop.mjs',
  'tool-result': '../kernel/engine.mjs',
}
/** 5 个实现文件（去重）：对账的**扫描域**，不依赖 SITE_FILE 的键（否则孤儿标记扫不出来）。 */
const IMPL_FILES = [...new Set(Object.values(SITE_FILE))]
const SITE_MARK = /\/\/\s*disk-site:\s*([a-z0-9-]+)/g

test('★ 对账：每个 site 都在其实现文件里被 diskWrite 包装（漏埋即红）', () => {
  for (const site of DISK_SITES) {
    const src = read(SITE_FILE[site])
    assert.ok(src.includes(`// disk-site: ${site}`), `${site} 应在 ${SITE_FILE[site]} 里有埋点标记`)
    // ★ 先剔注释再匹配：否则"删掉真调用、只留一行含该模式的注释"照样绿（review 实测的骗法）
    assert.match(stripComments(src), new RegExp(`diskWrite\\([\\s\\S]{0,120}?'${site}'`),
      `${site} 应实际调用 diskWrite（注释里的同样文本不算数）`)
  }
})

test('★ 对账：site 映射表与真实落盘点同名（改名/挪文件即红，防对账面失真）', () => {
  const src = read('../kernel/disk-write.mjs')
  for (const site of DISK_SITES) {
    assert.ok(src.includes(`'${site}'`) === false, `disk-write.mjs 不应硬编码 site 名（site 由调用方传入）`)
  }
  for (const [site, rel] of Object.entries(SITE_FILE)) {
    assert.ok(DISK_SITES.includes(site), `${site} 必须在 DISK_SITES 里`)
    assert.ok(read(rel).includes(`// disk-site: ${site}`), `${site} 标记缺失`)
  }
})

test('★ 对账（真扫描）：源码里**所有** `// disk-site:` 标记都必须在 DISK_SITES 里（孤儿标记即红）', () => {
  let seen = 0
  for (const rel of IMPL_FILES) {
    const src = read(rel)
    for (const m of src.matchAll(SITE_MARK)) {
      seen++
      assert.ok(DISK_SITES.includes(m[1]),
        `★ ${rel} 里出现孤儿标记 \`// disk-site: ${m[1]}\`：它不在 DISK_SITES 里`
        + `（观测面会认不出这个点；实测旧版断言只遍历硬编码表 ⇒ 加 ghost-site 仍绿）`)
    }
  }
  assert.equal(seen, DISK_SITES.length,
    `5 个实现文件里应恰有 ${DISK_SITES.length} 个埋点标记（实际 ${seen}）：少了说明漏埋，多了说明有重复/孤儿`)
})

test('埋点标记不得重复出现（同一 site 只埋一处，防重复计数）', () => {
  // 反向也扫：同一文件里同一 site 至多 1 次（把 DISK_SITES 之外的重复也算进来，避免"孤儿重复"漏检）
  for (const rel of IMPL_FILES) {
    const counts = new Map()
    for (const m of read(rel).matchAll(SITE_MARK)) counts.set(m[1], (counts.get(m[1]) || 0) + 1)
    for (const [site, n] of counts) {
      assert.equal(n, 1, `${rel} 里 ${site} 标记出现 ${n} 次（应恰 1 次）— 重复埋点会重复计数`)
    }
  }
  for (const site of DISK_SITES) {
    const n = read(SITE_FILE[site]).split(`// disk-site: ${site}`).length - 1
    assert.equal(n, 1, `${SITE_FILE[site]} 里 ${site} 标记应恰 1 次（实际 ${n} 次）`)
  }
})

test('diskWrite：成功透传返回值；失败不抛（落盘不得打断主流程）且如实记录失败', () => {
  const telemetry = createDiskTelemetry({ slowMs: 0 })
  const okRes = diskWrite(telemetry, 'transcript-append', () => 42)
  // 批 2（Task 7）扩展返回形状：成功且无需自愈 ⇒ level/reason 均为 null。这里**如实更新**为新的精确期望
  //（不是放宽）：多出的两个字段是"实际到达的级别/原因"，成功路径上必须为 null 才算零噪音。
  assert.deepEqual(okRes, { ok: true, value: 42, level: null, reason: null })
  const boom = new Error('EACCES: permission denied')
  const badRes = diskWrite(telemetry, 'transcript-append', () => { throw boom })
  assert.equal(badRes.ok, false)
  assert.equal(badRes.error, boom, '错误须原样交回调用方（调用方决定回退策略）')
  assert.equal(badRes.level, 'L3', '关键项（transcript-append）持续失败 ⇒ L3（唯一告警级别）')
  assert.equal(badRes.reason, 'disk-critical-persist-fail')
  const s = telemetry.snapshot()
  // 批 2 起自愈会真的再试一次 ⇒ **一次逻辑写 = 2 次 attempt**，记账口径是"按 attempt 如实记"
  //（与 disk-heal「L0 重试成功 ⇒ failures 仍 +1」同一口径：自愈成功不等于没失败过）。
  // 故此处 1 次成功 + 1 次失败（内部重试 1 次）= 3 次 attempt / 2 次失败。
  assert.equal(s.sites['transcript-append'].count, 3, '1 次成功 + 2 次失败尝试 = 3 次 attempt')
  assert.equal(s.sites['transcript-append'].failures, 2, '失败须按 attempt 如实计数（否则隐患不可见）')
  assert.match(s.sites['transcript-append'].lastError, /EACCES/)
})

test('diskWrite：埋点不改变写入语义（返回值/异常口径与直接调用一致）', () => {
  const telemetry = createDiskTelemetry()
  const ret = diskWrite(telemetry, 'loop-state', () => 'written')
  assert.equal(ret.value, 'written')
  // 关闭埋点时同样不得改变语义（PONOS_DISK_TELEMETRY=0 是可回滚开关）
  const off = createDiskTelemetry({ enabled: false })
  const ret2 = diskWrite(off, 'loop-state', () => 'written-anyway')
  // 回滚路径（埋点关闭 ⇒ 自愈关闭）逐字回"直接调用一次"，故 level/reason 恒为 null（如实更新，非放宽）
  assert.deepEqual(ret2, { ok: true, value: 'written-anyway', level: null, reason: null })
})

test('diskWrite：病态遥测（end 抛错）不外溢、不误报成落盘失败（观测不得成为故障源）', () => {
  const bad = { begin: () => ({ site: 'loop-state', t0: 0 }), end: () => { throw new Error('telemetry bug') } }
  assert.deepEqual(diskWrite(bad, 'loop-state', () => 'v'), { ok: true, value: 'v', level: null, reason: null })
  const boom = new Error('ENOSPC')
  const res = diskWrite({ begin: () => ({}), end: () => { throw new Error('telemetry bug 2') } }, 'loop-state', () => { throw boom })
  assert.equal(res.ok, false)
  assert.equal(res.error, boom, '交回调用点的必须是写入错误，而不是遥测错误')
  assert.equal(res.level, 'L2', '遥测病态不影响阶梯判定：非关键项持续失败 ⇒ L2（舍掉）')
  assert.equal(res.shed, true)
})
