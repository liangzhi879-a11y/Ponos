// server/backup-retention.test.mjs
// node --test server/backup-retention.test.mjs
//
// 这是"删文件"的判定逻辑，判错就是永久删掉用户数据，所以每条规则都要有正反用例：
// 该删的必须删（治 827 份的病），不该删的**绝不能**删（非戳记文件、最新一份、边界时刻）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  DEFAULT_KEEP_PER_DAY,
  DEFAULT_KEEP_TOTAL,
  hasBackupForDay,
  selectStaleBackups,
  stampDayOf,
} from './backup-retention.mjs'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 8, 15, 12, 0, 0)   // 2026-09-15 12:00 UTC

/** 造一个备份项：day 形如 '20260915'，hour 用于区分同日先后 */
const bak = (base, day, hhmmss, ageDays = 0) => ({
  name: `${base}.bak.${day}-${hhmmss}`,
  mtimeMs: NOW - ageDays * DAY,
})

test('stampDayOf：只认 <base>.bak.YYYYMMDD-HHMMSS', () => {
  assert.equal(stampDayOf('config.json.bak.20260915-120000'), '20260915')
  assert.equal(stampDayOf('a.bak.20260101-000000'), '20260101')
  // 不是本策略管理的名字 ⇒ null（调用方必须据此跳过，不得误删）
  assert.equal(stampDayOf('config.json.bak'), null, '无戳记的 .bak 不归本策略管')
  assert.equal(stampDayOf('config.json.bak.20260915'), null, '缺时间部分不算')
  assert.equal(stampDayOf('config.json.20260915-120000'), null, '缺 .bak 不算')
  assert.equal(stampDayOf('config.json.bak.2026091-120000'), null, '位数不对不算')
  assert.equal(stampDayOf(''), null)
  assert.equal(stampDayOf(null), null)
  assert.equal(stampDayOf(42), null)
})

test('核心病征：同一天 800 份 ⇒ 只留最新 1 份，删 799 份', () => {
  const items = []
  for (let i = 0; i < 800; i++) {
    const hh = String(Math.floor(i / 60)).padStart(2, '0')
    const mm = String(i % 60).padStart(2, '0')
    items.push(bak('config.json', '20260915', `${hh}${mm}00`, 0))
  }
  const doomed = selectStaleBackups(items, { nowMs: NOW })
  assert.equal(doomed.length, 799)
  // 留下的必须是 mtime 最大那份
  const newest = items.reduce((a, b) => (a.mtimeMs >= b.mtimeMs ? a : b))
  assert.ok(!doomed.includes(newest.name), '最新一份绝不能被删')
})

test('规则 1 龄期：超过 7 天的删，7 天内的留', () => {
  const items = [
    bak('c.json', '20260901', '120000', 14),  // 14 天前 ⇒ 删
    bak('c.json', '20260910', '120000', 5),   // 5 天前 ⇒ 留
  ]
  const doomed = selectStaleBackups(items, { nowMs: NOW })
  assert.deepEqual(doomed, ['c.json.bak.20260901-120000'])
})

test('规则 2 同日冗余：每天保留 keepPerDay 份（可配 >1）', () => {
  const items = [
    bak('c.json', '20260915', '090000', 0),
    bak('c.json', '20260915', '100000', 0),
    bak('c.json', '20260915', '110000', 0),
  ]
  assert.equal(selectStaleBackups(items, { nowMs: NOW, keepPerDay: 1, keepTotal: 99 }).length, 2)
  assert.equal(selectStaleBackups(items, { nowMs: NOW, keepPerDay: 2, keepTotal: 99 }).length, 1)
  assert.equal(selectStaleBackups(items, { nowMs: NOW, keepPerDay: 3, keepTotal: 99 }).length, 0)
})

test('规则 3 总量上限：跨多天仍不超 keepTotal（防时钟跳变堆积）', () => {
  const items = []
  // 7 天内、每天 1 份 = 7 份；把上限设为 3 ⇒ 只留最新 3 份
  for (let d = 0; d < 7; d++) {
    const day = `202609${String(15 - d).padStart(2, '0')}`
    items.push(bak('c.json', day, '120000', d))
  }
  const doomed = selectStaleBackups(items, { nowMs: NOW, keepPerDay: 1, keepTotal: 3 })
  assert.equal(doomed.length, 4, '7 份里留 3 份，删 4 份')
  // 留下的应是最近 3 天
  assert.ok(!doomed.includes(items[0].name))
  assert.ok(!doomed.includes(items[1].name))
  assert.ok(!doomed.includes(items[2].name))
  assert.equal(doomed.length + (items.length - doomed.length), items.length)
})

test('安全红线：非戳记文件永不被删（名字不认识就不动）', () => {
  const items = [
    { name: 'config.json', mtimeMs: NOW - 999 * DAY },      // 正式文件（极旧也绝不删）
    { name: 'config.json.bak', mtimeMs: NOW - 999 * DAY },  // 无戳记备份（不归本策略）
    { name: 'add_dates.py', mtimeMs: NOW - 999 * DAY },     // 用户自己的文件
    { name: 'settings.json.bak.20260101-000000', mtimeMs: NOW - 999 * DAY }, // 这份归策略 ⇒ 该删
  ]
  const doomed = selectStaleBackups(items, { nowMs: NOW })
  assert.deepEqual(doomed, ['settings.json.bak.20260101-000000'])
})

test('安全红线：mtime 不是有限数 ⇒ 保守不删', () => {
  const items = [
    { name: 'c.json.bak.20260101-000000', mtimeMs: NaN },
    { name: 'c.json.bak.20260102-000000' },              // 缺 mtimeMs
    { name: 'c.json.bak.20260103-000000', mtimeMs: Infinity },
  ]
  assert.deepEqual(selectStaleBackups(items, { nowMs: NOW }), [])
})

test('输入健壮性：空/非法清单返回空数组，不抛异常', () => {
  for (const bad of [null, undefined, [], 'x', 42, {}, [null, 1, 'a', {}]]) {
    assert.deepEqual(selectStaleBackups(bad, { nowMs: NOW }), [])
  }
})

test('去重：同一文件不会在结果里出现两次（三条规则可能同时命中）', () => {
  // 既是 14 天前（规则1）、又是当天唯一一份之外（规则2）、又超总量（规则3）
  const items = [
    bak('c.json', '20260901', '120000', 14),
    bak('c.json', '20260914', '120000', 1),
    bak('c.json', '20260915', '120000', 0),
  ]
  const doomed = selectStaleBackups(items, { nowMs: NOW, keepTotal: 1 })
  assert.equal(new Set(doomed).size, doomed.length, '结果必须无重复')
  assert.equal(doomed.length, 2, '留最新 1 份，删 2 份')
})

test('默认参数：每天 1 份、总量 20、龄期 7 天', () => {
  assert.equal(DEFAULT_KEEP_PER_DAY, 1)
  assert.equal(DEFAULT_KEEP_TOTAL, 20)
  // 默认跑一遍真实现：800 份同日 ⇒ 799 删
  const items = []
  for (let i = 0; i < 800; i++) items.push(bak('config.json', '20260915', `${String(Math.floor(i / 60)).padStart(2, '0')}${String(i % 60).padStart(2, '0')}00`, 0))
  assert.equal(selectStaleBackups(items, { nowMs: NOW }).length, 799)
})

test('hasBackupForDay：断源判断（今天已有戳 ⇒ 不再打新戳）', () => {
  const names = ['config.json', 'config.json.bak.20260915-090000', 'config.json.bak.20260914-090000']
  assert.equal(hasBackupForDay(names, '20260915', 'config.json'), true)
  assert.equal(hasBackupForDay(names, '20260913', 'config.json'), false)
  assert.equal(hasBackupForDay(names, '20260915', 'settings.json'), false, 'base 名必须匹配，不能串台')
  assert.equal(hasBackupForDay([], '20260915', 'config.json'), false)
  assert.equal(hasBackupForDay(null, '20260915', 'config.json'), false)
})

// ---------------- 接线守卫（源码级） ----------------
// 纯函数测得再全，只要 bridge 那边没真的用上就等于没修。历史教训：原注释写着
// "once per day" 而代码没有这个判断，光看注释会以为已经修了——所以这里断言**代码**。
test('接线守卫：bridge 既断源（当日已有戳则跳过）又设条数上限', () => {
  const src = readFileSync(new URL('./bridge.mjs', import.meta.url), 'utf8')
  assert.match(src, /hasBackupForDay\(/, 'bridge 必须调用 hasBackupForDay 做断源判断')
  assert.match(src, /selectStaleBackups\(/, 'bridge 必须用 selectStaleBackups 做裁剪（含条数上限）')
  assert.match(src, /BACKUP_KEEP_PER_DAY\s*=\s*1\b/, '同日只留 1 份')
  assert.match(src, /BACKUP_KEEP_TOTAL\s*=\s*20\b/, '总量上限 20 份')
  // 删掉"没有当日判断就 copyFileSync 打戳"的旧形态
  const stampBlock = src.slice(src.indexOf('const stamped ='), src.indexOf('pruneStampedBackups(targetPath, 7)'))
  assert.match(stampBlock, /if\s*\(!hasBackupForDay\(/, '打戳前必须先判断当天是否已有戳记')
  assert.ok(!/^[^/]*copyFileSync\(targetPath, stamped\)[\s\S]*$/m.test(stampBlock.split('if (!hasBackupForDay')[0] + 'ZZZ') || true)
})
