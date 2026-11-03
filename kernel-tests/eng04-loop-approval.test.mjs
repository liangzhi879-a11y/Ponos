// ENG-04 修复验证（P2 可用性）：循环任务缺「减少询问」档，逐工具审批使自动化任务近乎不可用。
//
// 【缺陷】循环任务（`--loop`）是**无人值守的自动化**：一轮跑几十个工具调用，
//   而审批是按**逐次**挂起等用户应答的。默认档 `loose` 下 `appTool`（app_* 应用智控）与
//   `highRiskBash` 的来源档是 `bypass` ⇒ **每一次都要 ask** ⇒ 自动化任务卡在第一个 app_* 或高危命令上，
//   "近乎不可用"。
//
// 【为什么不能简单地把档位调到 bypass】（本仓 AI-02/AI-03 的教训）
//   · `bypass` 会连**灾难命令黑名单**一起放宽（curl|sh、格式化磁盘等）；
//   · AI-02 刚把"高危判定"提到 allow 之前，正是为了防止"宽 allow 规则顺手放行高危形式"。
//   ⇒ 全局放宽是**倒退**，不能用来解决可用性。
//
// 【修法：循环任务**专用放行白名单**（用户拍板的方向）】
//   · 只对**白名单内**的工具自动放行；白名单外仍按档位逐次审批；
//   · 白名单来自循环任务的显式声明（`--loop-allow` / 工作流声明的工具集），**默认空 = 不放行**；
//   · **灾难命令（`perm.hard`）永不因白名单放行** —— 这段必须写在白名单判定之前/之内都显式排除；
//   · 与既有 `askOncePerRun` 同一实现姿态：只把 `decision` 从 ask 降成 allow，**不 return**，
//     以免跳过 `hooks.preToolUse`（本文件既有注释已写明这个坑）。
//
// ★ 为什么是"白名单"而不是"减少询问次数"：后者只减少弹窗**次数**，第一次仍会卡住；
//   而循环任务无人看着，第一次卡住 = 任务卡死。必须让**声明过的**工具直接从 allow 走。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  normalizeLoopAllowlist, loopAllowlistMatches, canLoopAutoApprove,
} from '../kernel/loop-approval.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const ENGINE = readFileSync(new URL('../kernel/engine.mjs', import.meta.url), 'utf8')
  .split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

test('★ ENG-04：白名单解析必须容错（数组/逗号串/空白/大小写/去重）', () => {
  assert.deepEqual(normalizeLoopAllowlist(['Bash', 'Write']), ['Bash', 'Write'])
  assert.deepEqual(normalizeLoopAllowlist('Bash, Write ,Read'), ['Bash', 'Write', 'Read'])
  assert.deepEqual(normalizeLoopAllowlist('  Bash  '), ['Bash'])
  assert.deepEqual(normalizeLoopAllowlist(['bash', 'BASH']), ['bash'], '去重必须按归一化后比较（不区分大小写）')
  assert.deepEqual(normalizeLoopAllowlist(null), [], '缺失 ⇒ 空（默认不放行）')
  assert.deepEqual(normalizeLoopAllowlist(undefined), [])
  assert.deepEqual(normalizeLoopAllowlist(['']), [], '空串条目必须丢弃')
})

test('★ ENG-04：匹配必须支持精确名与前缀通配（app_* / mcp__*）', () => {
  const al = normalizeLoopAllowlist(['Read', 'app_*', 'mcp__fs__*'])
  assert.equal(loopAllowlistMatches(al, 'Read'), true, '精确名必须命中')
  assert.equal(loopAllowlistMatches(al, 'read'), true, '匹配不区分大小写')
  assert.equal(loopAllowlistMatches(al, 'app_open_editor'), true, '前缀通配必须命中')
  assert.equal(loopAllowlistMatches(al, 'mcp__fs__read_file'), true)
  assert.equal(loopAllowlistMatches(al, 'Bash'), false, '未声明的工具不得命中')
  assert.equal(loopAllowlistMatches(al, 'app'), false, '* 不能退化成"匹配前缀本身"')
})

test('★★ ENG-04：灾难命令（hard）永不因白名单放行 —— 这是安全底线', () => {
  const al = normalizeLoopAllowlist(['Bash'])
  // 普通 ask ⇒ 白名单内可放行
  assert.equal(canLoopAutoApprove({ allowlist: al, toolName: 'Bash', hard: false }), true)
  // 灾难级（hard）⇒ **即使白名单里有 Bash 也不放行**
  assert.equal(canLoopAutoApprove({ allowlist: al, toolName: 'Bash', hard: true }), false,
    '灾难命令（硬黑名单）必须逐次询问，绝不因循环白名单自动放行 —— '
    + '否则等于用一个可用性开关把 AI-02/AI-03 建的安全闸门整片关掉')
})

test('★ ENG-04：白名单为空时不得放行任何工具（默认最严）', () => {
  assert.equal(canLoopAutoApprove({ allowlist: [], toolName: 'Read', hard: false }), false,
    '空白名单必须表示"不放行" —— 默认不能悄悄放大权限')
  assert.equal(canLoopAutoApprove({ allowlist: normalizeLoopAllowlist(null), toolName: 'app_x', hard: false }), false)
})

test('★★ ENG-04：engine 必须接入白名单，且只降级 ask（不 return，避免跳过 hook）', () => {
  assert.match(ENGINE, /loop-approval\.mjs|canLoopAutoApprove/,
    'engine 必须接入循环放行白名单判定')
  const i = ENGINE.indexOf('async function gateToolUse(')
  assert.ok(i > -1, '必须有 gateToolUse')
  const body = ENGINE.slice(i, i + 4000)
  assert.match(body, /canLoopAutoApprove\(/,
    'gateToolUse 必须调用白名单判定 —— 否则功能没接上')
  // 必须与 askOncePerRun 同姿态：只改 decision
  assert.match(body, /perm\.decision\s*=\s*'allow'/,
    '放行必须写成 `perm.decision = \'allow\'`（只降级），**不能** `return { allowed: true }` —— '
    + '后者会跳过下方 hooks.preToolUse，使白名单内工具绕过 hook 否决')
  // hard 必须作为参数传入（而不是在调用方漏掉）
  assert.match(body, /hard:\s*perm\.hard/,
    '调用白名单判定时必须传入 perm.hard —— 灾难命令的排除依赖它')
})

test('★ ENG-04：必须有热设置入口（循环控制器在轮次开始/结束时启停）', () => {
  assert.match(ENGINE, /setLoopAllowlist/, '必须有 setLoopAllowlist 热设置（循环开始时启用、结束时清空）')
  assert.match(ENGINE, /getLoopAllowlist/, '必须有 getLoopAllowlist 供 UI/诊断查看当前生效白名单')
})
