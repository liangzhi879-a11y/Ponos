// kernel/config.mjs —— 配置目录解析（docs/production/security.md S5-1）
// 优先级与现状一致：PONOS_CONFIG_DIR > PONOS_HOME > ~/.ponos。
// 抽为纯函数供 cli 与测试复用（多人共享：个人 configDir 隔离，shared 只读共享）。
import { join } from 'node:path'
import { homedir } from 'node:os'
import { readFileSync } from 'node:fs'
import { capabilitiesOf, EGRESS_CAPABILITY } from '../shared/egress-capability.mjs'

export function resolveConfigDir(env = process.env, homedirFn = () => homedir()) {
  return env.PONOS_CONFIG_DIR || env.PONOS_HOME || join(homedirFn(), '.ponos')
}
export function sharedDirFor(configDir) {
  return join(configDir, 'shared')
}

/**
 * 出网闸的 `provider` 能力是否放行（遗留 C-⑥：`providers.json` 播种闸的前置判据）。
 *
 * ★ 口径**只从** `shared/egress-capability.cjs#capabilitiesOf` 来（唯一实现），本函数不含判据：
 *   它只负责"把 `<configDir>/config.json` 读出来交给闸判"。同一事实两份判据 = 漂移即开关失效
 *   （本仓明令禁止"同一判据两份实现"）。
 * ★ 读不到文件 / 解析失败 ⇒ **按放行**（返回 true）：那是"没有配置文件"的**存量形态**，不是
 *   "用户不放行"。这与 `capabilitiesOf` 对 `network` 键缺失的 legacy 兜底同口径（兜底清单本含
 *   provider）—— 若这里反过来按最严，会把所有未写 `network` 段的存量机器**模型能力直接弄没**。
 *   "键在但读不懂"由闸自己按最严处理（`config-invalid` ⇒ `[]`），此处无需重复判断。
 */
export function providerCapabilityAllowed(configDir) {
  try {
    const raw = readFileSync(join(configDir, 'config.json'), 'utf-8')
    const cfg = JSON.parse(raw)
    return capabilitiesOf(cfg?.network).includes(EGRESS_CAPABILITY.PROVIDER)
  } catch {
    return true
  }
}

/**
 * `config.json` 的当前活跃 provider id（2026-10-02：`providers.json` 播种的**陈旧比对**用——
 * 与 providerCapabilityAllowed 同款：只负责把文件读出来，判定在被调方 `provider.mjs#seedFromFile`）。
 * 读不到 / 解析失败 / 非非空字符串 ⇒ null = "无从比对"（调用方按 legacy 照旧播种，裸机/CI 语义零变化）。
 */
export function readActiveProvider(configDir) {
  try {
    const raw = readFileSync(join(configDir, 'config.json'), 'utf-8')
    const cfg = JSON.parse(raw)
    return typeof cfg?.activeProvider === 'string' && cfg.activeProvider ? cfg.activeProvider : null
  } catch {
    return null
  }
}

/**
 * 读整份 config.json（**只读**，解析失败返回空对象）。
 * 参数面（kernel/param-surface.mjs）需要它来解析生效值；写回一律走"局部补丁"通道，不走这里。
 */
export function readConfigObject(configDir) {
  try {
    const cfg = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf-8'))
    return cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : {}
  } catch {
    return {}
  }
}
