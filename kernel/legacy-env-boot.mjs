// 内核进程的兼容垫片引导模块：必须在 `kernel/cli.mjs` 的**首个 import** 位置引入，
// 其模块体在后续任何 import 求值之前执行，从而保证旧名在主名被读取前完成映射
// （`kernel/engine-config.mjs` 等模块在顶层就读 env，晚于本模块即失效）。
import { applyLegacyEnvAliases } from '../shared/legacy-env.mjs'

applyLegacyEnvAliases()
