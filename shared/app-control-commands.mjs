// shared/app-control-commands.mjs —— ESM 转发层（**不含实现**）。
//
// 唯一实现在 `app-control-commands.cjs`：它是底层契约，被 `electron/*.cjs`（require）与
// 桥/kernel（ESM import）**共用同一份**。两侧各写一份会漂移，而漂移的后果是
// "界面显示的覆盖率与实际能跑的命令不一致"（比没有覆盖率更糟：它是个假指标）。
// CJS 双用先例见 `shared/proxy-config.cjs`、`server/bridge-token.cjs`。
export {
  TARGET_CLASSES,
  COVERAGE_THRESHOLD,
  CLASS_BY_DRIVER,
  UNAVAILABLE_REASON,
  CONTROL_COMMANDS,
  EXCLUDED_ORCHESTRATION_ACTS,
  commandI18nKey,
  isTargetClass,
  classOfDriver,
  classOfSpec,
  commandsForClass,
  coverageForClass,
  coverageReport,
  specCoverage,
  missingIdsText,
} from './app-control-commands.cjs'
