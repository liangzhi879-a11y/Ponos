'use strict'
// yfw-home.cjs — YFWorking 数据根（home）单一解析来源。
//
// 双版并行核心隔离开关：在售旧版固定读写 ~/.yfworking；新版（净室）在
// YFWORKING_HOME 设置时把全部状态（config/skills/logs/memory/sessions/
// userData）迁到指定根目录，实现同机双版互不写入对方数据。
//
// 解析序（与旧 electron/browser-common.cjs:115 内联解析一致，消除漂移）：
//   1. process.env.YFWORKING_HOME     —— 新版数据根（最高优先，双版隔离主开关；
//        2026-09-09 起各启动入口兜底注入 ~/.yfw：electron/main.cjs 模块头、
//        dev start.bat、bin/yfworking.cmd，本模块默认值仅作直跑安全网）
//   2. process.env.CLAUDE_CONFIG_DIR  —— Claude Code 系配置根（bridge 向内核
//        spawn 时注入 YFW_HOME，等价兼容）
//   3. <用户家目录>/.yfworking        —— 默认（未设 env 时行为与旧版一致）
// 测试隔离不在此处另设优先级：测试直接设/删 YFWORKING_HOME（或 CLAUDE_CONFIG_DIR）
// 指向临时目录即可，勿依赖任何 test-only env（环境可能已导出上述两变量）。
//
// CJS 模块：可被 ESM（bridge.mjs/packager.mjs 等 `import`）与
// CommonJS（electron/main.cjs 等 `require`）双用，先例 electron/kernel-paths.cjs。
const os = require('os')
const path = require('path')

function resolveYfwHome() {
  const env = process.env
  if (env.YFWORKING_HOME) return env.YFWORKING_HOME
  if (env.CLAUDE_CONFIG_DIR) return env.CLAUDE_CONFIG_DIR
  return path.join(os.homedir(), '.yfworking')
}

module.exports = { resolveYfwHome }
