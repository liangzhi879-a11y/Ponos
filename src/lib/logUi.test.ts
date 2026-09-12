// src/lib/logUi.test.ts
// node --test src/lib/logUi.test.ts（Node 24 原生 TS，相对导入必须带 .ts）
// 与 server/log-policy.cjs 的常量/钳制一致性由 server/log-policy-parity.test.mjs 深比较钉住
//（本文件不 import .cjs：src/ 在 tsconfig include 内且未开 allowJs）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_LOG_POLICY, LOG_LEVELS, LOG_POLICY_LIMITS,
  bytesToMb, clampInt, formatBytes, formatLogAge, isLogLevel, mbToBytes,
  normalizeLogPolicyUi, pickDefaultLogFile, type LogFileInfo,
} from './logUi.ts'

test('默认策略 = 用户决策（5MB × 3 份 + 14 天，开启持久化）', () => {
  assert.deepEqual(DEFAULT_LOG_POLICY, {
    persist: true, level: 'info',
    maxFileBytes: 5 * 1024 * 1024, maxFiles: 3, maxAgeDays: 14,
  })
  assert.deepEqual(LOG_LEVELS, ['debug', 'info', 'warn', 'error'])
})

test('normalizeLogPolicyUi：缺失/非对象/数组 → 默认档', () => {
  for (const bad of [null, undefined, 'x', 7, [], true]) {
    assert.deepEqual(normalizeLogPolicyUi(bad), DEFAULT_LOG_POLICY, `${JSON.stringify(bad)} 应回落默认`)
  }
})

test('normalizeLogPolicyUi：persist 只有显式 false 才关（脏数据不得关掉日志）', () => {
  assert.equal(normalizeLogPolicyUi({ persist: false }).persist, false)
  for (const v of [undefined, null, 0, '', 'false', 'no', 'off', NaN]) {
    assert.equal(normalizeLogPolicyUi({ persist: v }).persist, true, `persist=${String(v)} 应保持开启`)
  }
})

test('normalizeLogPolicyUi：数值钳到边界（含负数/0/超大/小数/字符串数字）', () => {
  const L = LOG_POLICY_LIMITS
  assert.equal(normalizeLogPolicyUi({ maxFileBytes: -1 }).maxFileBytes, L.minFileBytes, '负数 → 下限而非 0')
  assert.equal(normalizeLogPolicyUi({ maxFileBytes: 0 }).maxFileBytes, L.minFileBytes)
  assert.equal(normalizeLogPolicyUi({ maxFileBytes: 1e12 }).maxFileBytes, L.maxFileBytes)
  assert.equal(normalizeLogPolicyUi({ maxFileBytes: '1048576' }).maxFileBytes, 1048576, '字符串数字可用')
  assert.equal(normalizeLogPolicyUi({ maxFileBytes: 1048576.9 }).maxFileBytes, 1048576, '小数取整')
  assert.equal(normalizeLogPolicyUi({ maxFileBytes: 'abc' }).maxFileBytes, DEFAULT_LOG_POLICY.maxFileBytes)
  assert.equal(normalizeLogPolicyUi({ maxFiles: -3 }).maxFiles, L.minFiles, '0 份合法（只留主文件）')
  assert.equal(normalizeLogPolicyUi({ maxFiles: 999 }).maxFiles, L.maxFiles)
  assert.equal(normalizeLogPolicyUi({ maxAgeDays: 0 }).maxAgeDays, L.minAgeDays)
  assert.equal(normalizeLogPolicyUi({ maxAgeDays: 9999 }).maxAgeDays, L.maxAgeDays)
})

test('normalizeLogPolicyUi：level 大小写/空白归一，非法回落 info', () => {
  assert.equal(normalizeLogPolicyUi({ level: 'DEBUG' }).level, 'debug')
  assert.equal(normalizeLogPolicyUi({ level: '  Warn  ' }).level, 'warn')
  for (const bad of ['verbose', 'trace', '', null, 3, {}]) {
    assert.equal(normalizeLogPolicyUi({ level: bad }).level, 'info', `level=${String(bad)} → info`)
  }
  assert.equal(isLogLevel('error'), true)
  assert.equal(isLogLevel('ERROR'), false, '大小写敏感（先归一再用）')
})

test('clampInt：NaN/Infinity/非数字回落默认值', () => {
  assert.equal(clampInt(undefined, 1, 10, 7), 7)
  assert.equal(clampInt(NaN, 1, 10, 7), 7)
  assert.equal(clampInt(Infinity, 1, 10, 7), 7, 'Infinity 非有限 → 回落默认（与 log-policy.cjs 同）')
  assert.equal(clampInt('4', 1, 10, 7), 4)
  assert.equal(clampInt(4.9, 1, 10, 7), 4)
  assert.equal(clampInt(-4, 1, 10, 7), 1)
})

test('formatBytes：B/KB/MB/GB 与非法值', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(1023), '1023 B')
  assert.equal(formatBytes(1024), '1 KB')
  assert.equal(formatBytes(512 * 1024), '512 KB')
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB')
  assert.equal(formatBytes(1024 * 1024 * 1024), '1.0 GB')
  assert.equal(formatBytes(-1), '—')
  assert.equal(formatBytes(undefined), '—')
  assert.equal(formatBytes('abc'), '—')
})

test('bytesToMb / mbToBytes 往返稳定（表单显示与回写）', () => {
  assert.equal(bytesToMb(5 * 1024 * 1024), 5)
  assert.equal(bytesToMb(64 * 1024), 0.06, '下限 64KB 不应显示成 0MB')
  assert.equal(bytesToMb(undefined), 0)
  assert.equal(mbToBytes(5), 5 * 1024 * 1024)
  assert.equal(mbToBytes(0.06), 62915, '0.06MB 取整到字节（再经 normalize 钳到 64KB 下限）')
  assert.equal(mbToBytes(-1), 0)
  assert.equal(mbToBytes('x'), 0)
  // 往返：字节 → MB → 字节在整数 MB 上无损
  for (const mb of [1, 3, 5, 20, 100]) {
    assert.equal(bytesToMb(mbToBytes(mb)), mb)
  }
})

const F = (name: string, size: number, mtimeMs = 1000): LogFileInfo => {
  const m = /^(.*?)\.log(?:\.(\d+))?$/.exec(name)
  return { name, base: `${m?.[1] ?? name}.log`, index: Number(m?.[2] ?? 0), size, mtimeMs }
}

test('pickDefaultLogFile：优先有内容的 app.log', () => {
  assert.equal(pickDefaultLogFile([F('app.log', 100), F('kernel-stderr.log', 999)]), 'app.log')
})

test('pickDefaultLogFile：[立即清理] 后 app.log 空 → 选中真正有内容的轮转份', () => {
  // 清理后的现场：主文件被改名成 .1，app.log 为空或根本不存在
  assert.equal(pickDefaultLogFile([F('app.log', 0), F('app.log.1', 500)]), 'app.log.1')
  assert.equal(pickDefaultLogFile([F('app.log.1', 500), F('kernel-stderr.log.1', 20)]), 'app.log.1', '同族优先由 base 排序决定')
  assert.equal(pickDefaultLogFile([F('kernel-stderr.log', 20)]), 'kernel-stderr.log')
})

test('pickDefaultLogFile：全空 / 空表 / 脏输入 → 确定的名字，绝不空白', () => {
  assert.equal(pickDefaultLogFile([F('app.log', 0)]), 'app.log')
  assert.equal(pickDefaultLogFile([]), 'app.log')
  assert.equal(pickDefaultLogFile(null), 'app.log')
  assert.equal(pickDefaultLogFile(undefined), 'app.log')
  assert.equal(pickDefaultLogFile([{ name: 'x' } as LogFileInfo]), 'app.log', '缺字段的脏行被容错')
})

test('pickDefaultLogFile：同 mtime 时顺序稳定（批量轮转场景）', () => {
  const files = [F('app.log.2', 30, 5000), F('app.log.1', 10, 5000), F('kernel-stderr.log.1', 20, 5000)]
  assert.equal(pickDefaultLogFile(files), 'app.log.1', '同 mtime → base 字典序最小（app.log 族优先）+ index 最小')
  assert.equal(pickDefaultLogFile([...files].reverse()), 'app.log.1', '与输入顺序无关')
})

test('formatLogAge：s/m/h/d 分档与非法值', () => {
  const now = 1_000_000_000
  assert.equal(formatLogAge(now - 5_000, now), '5s')
  assert.equal(formatLogAge(now - 90_000, now), '1m')
  assert.equal(formatLogAge(now - 3 * 3600_000, now), '3h')
  assert.equal(formatLogAge(now - 2 * 86400_000, now), '2d')
  assert.equal(formatLogAge(now + 10_000, now), '0s', '时钟漂移不出现负数')
  assert.equal(formatLogAge(0, now), '—')
  assert.equal(formatLogAge(undefined, now), '—')
})
