// kernel/config.mjs —— 配置目录解析（docs/production/security.md S5-1）
// 优先级与现状一致：CLAUDE_CONFIG_DIR > PONOS_HOME > ~/.ponos。
// 抽为纯函数供 cli 与测试复用（多人共享：个人 configDir 隔离，shared 只读共享）。
import { join } from 'node:path'
import { homedir } from 'node:os'

export function resolveConfigDir(env = process.env, homedirFn = () => homedir()) {
  return env.CLAUDE_CONFIG_DIR || env.PONOS_HOME || join(homedirFn(), '.ponos')
}
export function sharedDirFor(configDir) {
  return join(configDir, 'shared')
}
