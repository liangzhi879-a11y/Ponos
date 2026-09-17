// 桥侧审批档位：与内核枚举一致性 + spawn 参数 + 覆盖解析
// 打包产物没有 kernel/ 目录 → 桥侧独立一份枚举，本测试负责把"两份必须逐字一致"钉死。
//
// P0-4（2026-09-16）："新装默认档"（NEW_INSTALL_APPROVAL_MODE = auto）与"兜底/回落值"
// （DEFAULT_APPROVAL_MODE = loose）**刻意分离**。末尾两条用例钉住这个分离关系与它的
// 两条机制保证——① 兜底值不变（旧 flag/裸内核路径不回归）；② 存量值原样保留（老用户零影响）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  APPROVAL_MODES, DEFAULT_APPROVAL_MODE, NEW_INSTALL_APPROVAL_MODE,
  isValidApprovalMode, normalizeApprovalMode,
  resolveEffectiveApprovalMode, approvalSpawnArgs, approvalModeSummary, classifyApprovalEcho,
} from './approval-mode.mjs'
import {
  APPROVAL_MODES as KERNEL_MODES, DEFAULT_APPROVAL_MODE as KERNEL_DEFAULT,
  APPROVAL_RANK as KERNEL_RANK,
} from '../kernel/approval-mode.mjs'

test('枚举与默认档：桥侧与内核逐字一致（打包后无 kernel/，只能靠本测试把关）', () => {
  assert.deepEqual(APPROVAL_MODES, KERNEL_MODES)
  assert.equal(DEFAULT_APPROVAL_MODE, KERNEL_DEFAULT)
  assert.deepEqual(Object.keys(KERNEL_RANK), APPROVAL_MODES, '内核 rank 表键序应与枚举一致')
})

test('normalize：非法/空/大小写/空白', () => {
  assert.equal(normalizeApprovalMode('manual'), 'manual')
  assert.equal(normalizeApprovalMode(' BYPASS '), 'bypass')
  assert.equal(normalizeApprovalMode(''), DEFAULT_APPROVAL_MODE)
  assert.equal(normalizeApprovalMode(null), DEFAULT_APPROVAL_MODE)
  assert.equal(normalizeApprovalMode(undefined), DEFAULT_APPROVAL_MODE)
  // 刻意不接受的近义词：permission-mode 语义与本档位不同名
  for (const bad of ['plan', 'acceptEdits', 'bypassPermissions', 'default', 'yolo', 7, {}]) {
    assert.equal(normalizeApprovalMode(bad), DEFAULT_APPROVAL_MODE, `${JSON.stringify(bad)} 应回落默认档`)
    assert.equal(isValidApprovalMode(bad), false)
  }
})

test('resolveEffectiveApprovalMode：会话覆盖 > 全局；非法覆盖不生效', () => {
  assert.equal(resolveEffectiveApprovalMode({ sessionOverride: 'manual', configMode: 'bypass' }), 'manual')
  assert.equal(resolveEffectiveApprovalMode({ sessionOverride: null, configMode: 'auto' }), 'auto')
  assert.equal(resolveEffectiveApprovalMode({ configMode: 'nonsense' }), DEFAULT_APPROVAL_MODE)
  assert.equal(resolveEffectiveApprovalMode({}), DEFAULT_APPROVAL_MODE)
  assert.equal(resolveEffectiveApprovalMode(), DEFAULT_APPROVAL_MODE)
  // 非法覆盖不得放大权限（回落全局档，而不是回落默认档）
  assert.equal(resolveEffectiveApprovalMode({ sessionOverride: 'yolo', configMode: 'manual' }), 'manual')
})

test('approvalSpawnArgs：显式档位 + loose/bypass 保留旧 skip flag（旧内核优雅降级）', () => {
  assert.deepEqual(approvalSpawnArgs('manual'), ['--approval-mode', 'manual'])
  assert.deepEqual(approvalSpawnArgs('auto'), ['--approval-mode', 'auto'])
  assert.deepEqual(approvalSpawnArgs('loose'), ['--approval-mode', 'loose', '--dangerously-skip-permissions'])
  assert.deepEqual(approvalSpawnArgs('bypass'), ['--approval-mode', 'bypass', '--dangerously-skip-permissions'])
  // 非法值 → 默认档参数（不会产生 --approval-mode undefined）
  assert.deepEqual(approvalSpawnArgs('plan'), ['--approval-mode', 'loose', '--dangerously-skip-permissions'])
  assert.deepEqual(approvalSpawnArgs(), ['--approval-mode', 'loose', '--dangerously-skip-permissions'])
  // 参数原子性：--approval-mode 后必须紧跟合法值（cli 用 next() 取值）
  for (const m of APPROVAL_MODES) {
    const args = approvalSpawnArgs(m)
    assert.equal(args[0], '--approval-mode')
    assert.ok(APPROVAL_MODES.includes(args[1]), `档位值必须合法，实际 ${args[1]}`)
  }
})

// init 回显判定（2026-09-17 假告警修复）：比对基准必须是 **spawn 时传下去的档位**，
// 不是此刻的实时档位——否则"spawn→init 窗口内用户切档"会被误判成旧缓存内核。
test('classifyApprovalEcho：基准 = spawn 档；窗口内切档 → realign 而非 degraded（假告警回归）', () => {
  // 2026-09-17 实证场景：全局档 loose 起内核，窗口内（init 前 7s）用户切到 bypass。
  // 内核认账了 --approval-mode loose ⇒ 回显 loose = spawn 档。若拿实时档 bypass 当基准，
  // 就会广播"可能运行的是旧缓存内核"的假告警，并把徽标回写成 loose（界面说反话）。
  assert.equal(classifyApprovalEcho({ echoed: 'loose', spawnMode: 'loose', liveMode: 'bypass' }), 'realign')
  // 反向：按 bypass 起、窗口内降回 loose —— 同样只是时序，不是旧内核
  assert.equal(classifyApprovalEcho({ echoed: 'bypass', spawnMode: 'bypass', liveMode: 'loose' }), 'realign')
  assert.equal(classifyApprovalEcho({ echoed: 'auto', spawnMode: 'auto', liveMode: 'manual' }), 'realign')

  // 三者一致 → 无事
  assert.equal(classifyApprovalEcho({ echoed: 'manual', spawnMode: 'manual', liveMode: 'manual' }), 'ok')
  assert.equal(classifyApprovalEcho({ echoed: 'bypass', spawnMode: 'bypass', liveMode: 'bypass' }), 'ok')
  // 大小写/空白宽容（内核回显与 flag 同样过 normalize）
  assert.equal(classifyApprovalEcho({ echoed: ' BYPASS ', spawnMode: 'bypass', liveMode: 'bypass' }), 'ok')

  // 真·旧内核：忽略未知 flag，靠旧 skip flag 停在 loose ⇒ 回显 ≠ spawn 档 ⇒ 告警
  assert.equal(classifyApprovalEcho({ echoed: 'loose', spawnMode: 'manual', liveMode: 'manual' }), 'degraded')
  assert.equal(classifyApprovalEcho({ echoed: 'loose', spawnMode: 'auto', liveMode: 'auto' }), 'degraded')
  assert.equal(classifyApprovalEcho({ echoed: 'loose', spawnMode: 'bypass', liveMode: 'bypass' }), 'degraded',
    '窗口内切过档也不得掩盖旧内核：spawn 档有 skip flag 而回显停在 loose 时，仍是降级')
  assert.equal(classifyApprovalEcho({ echoed: 'loose', spawnMode: 'manual', liveMode: 'bypass' }), 'degraded',
    'degraded 优先于 realign：既没认账 flag、档位又变过 ⇒ 先如实告警')

  // 回显缺失（更老的内核无该字段）→ unknown：不告警、也不纠正（无从判断）
  assert.equal(classifyApprovalEcho({ echoed: null, spawnMode: 'bypass', liveMode: 'bypass' }), 'unknown')
  assert.equal(classifyApprovalEcho({ echoed: undefined, spawnMode: 'bypass', liveMode: 'manual' }), 'unknown')
  assert.equal(classifyApprovalEcho({}), 'unknown')

  // spawn 档缺失（不该发生：spawn 必传 flag）按兜底档 loose 处理 —— 与 approvalSpawnArgs
  // 缺省同款，不会凭空放大权限；回显 loose 即视为认账，需要时走 realign 对齐。
  assert.equal(classifyApprovalEcho({ echoed: 'loose', liveMode: 'bypass' }), 'realign')
  assert.equal(classifyApprovalEcho({ echoed: 'bypass', liveMode: 'bypass' }), 'degraded')

  // 固有限制（如实记录，勿当回归）：spawn 档本身就是 loose 时，旧内核回显也是 loose，
  // 无信息可区分"新内核按 loose 起"与"旧内核停在 loose" ⇒ 这一格永远只能判 ok。
  assert.equal(classifyApprovalEcho({ echoed: 'loose', spawnMode: 'loose', liveMode: 'loose' }), 'ok')
})

test('approvalModeSummary：四档各有文案且不空', () => {
  for (const m of APPROVAL_MODES) {
    assert.ok(String(approvalModeSummary(m)).length > 0, `${m} 应有摘要文案`)
  }
  assert.match(approvalModeSummary('bypass'), /灾难/, 'bypass 摘要必须点明硬黑名单仍在拦截')
  assert.equal(approvalModeSummary('nonsense'), approvalModeSummary(DEFAULT_APPROVAL_MODE))
})

// ---------------------------------------------------------------------------
// P0-4：新装默认档 = auto（与兜底值分离）
// ---------------------------------------------------------------------------
test('P0-4 新装默认档：= auto，且与兜底档 DEFAULT_APPROVAL_MODE 分离', () => {
  assert.equal(
    NEW_INSTALL_APPROVAL_MODE, 'auto',
    '新装默认档应为 auto（只读+普通 Bash 自动；写文件/出网/派子agent/未识别工具需确认）',
  )
  assert.ok(isValidApprovalMode(NEW_INSTALL_APPROVAL_MODE), '新装默认档必须是合法档位')
  // **分离**是本设计的要点：实现"提高新装默认"**不能**靠改 DEFAULT_APPROVAL_MODE ——
  // 那个值被内核旧 flag 兼容推导（deriveApprovalMode）复用，改它会让写文件从 allow 变 ask
  // = 行为回归（内核文件头明确禁止），且被本文件首个用例与内核值做一致性断言。
  assert.equal(
    DEFAULT_APPROVAL_MODE, 'loose',
    '兜底/回落值必须保持 loose（兼容旧 flag 路径与裸内核行为）——提高新装默认请走 NEW_INSTALL_APPROVAL_MODE',
  )
  assert.equal(normalizeApprovalMode(undefined), DEFAULT_APPROVAL_MODE, '缺值仍回落兜底档（不变）')
  assert.equal(normalizeApprovalMode(''), DEFAULT_APPROVAL_MODE, '空值仍回落兜底档（不变）')
})

test('P0-4 机制保证：存量档位原样保留；新装用户的内核按 auto 启动（不带 skip flag）', () => {
  // ① 存量用户零影响：loadConfig 的 `{...DEFAULT_CONFIG, ...cfg}` 合并中 cfg 优先，
  //    而 normalize 对合法值原样返回 ⇒ 盘上写了 loose 的老用户仍是 loose。
  assert.equal(normalizeApprovalMode('loose'), 'loose', '存量 loose 必须原样保留（老用户零行为变化）')
  assert.equal(normalizeApprovalMode('manual'), 'manual')
  assert.equal(normalizeApprovalMode('bypass'), 'bypass')
  assert.equal(resolveEffectiveApprovalMode({ configMode: 'loose' }), 'loose')

  // ② 新装用户的内核启动参数必须体现新档：auto 只传显式档位，**不**带旧 skip flag
  //    （带了就等于悄悄按 loose 起内核 = 新装默认形同虚设）。
  const autoArgs = approvalSpawnArgs(NEW_INSTALL_APPROVAL_MODE)
  assert.deepEqual(autoArgs, ['--approval-mode', 'auto'], '新装默认档应精确产生 auto 参数')
  assert.ok(
    !autoArgs.includes('--dangerously-skip-permissions'),
    '新装默认档不得携带旧 skip flag（否则内核跑到 loose，新装默认形同虚设）',
  )
  // ③ 对照：存量兜底档仍带 skip flag（行为与改前完全一致）
  const legacyArgs = approvalSpawnArgs(DEFAULT_APPROVAL_MODE)
  assert.deepEqual(legacyArgs, ['--approval-mode', 'loose', '--dangerously-skip-permissions'])
})
