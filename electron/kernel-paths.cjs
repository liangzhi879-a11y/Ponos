'use strict'
// 内核/bun 路径解析——全应用单一事实来源。
//
// 背景（2026-08-20 生产事故）：bridge.mjs findYFWorking() 与 main.cjs
// resolveDiagPaths() 各自维护内核路径解析，发生漂移——bridge 会话用
// ~/.yfworking/runtime/ bootstrap 缓存（用户家目录，无 ACL 限制），而诊断
// 探针直接 spawn 安装目录（Program Files 下 EPERM）→ kernel-launch 误报
// exit=1。统一规则：**bootstrap 缓存优先（实际运行路径），安装路径兜底**。
//
// 本模块同时供 ESM（bridge.mjs `import paths from`）与 CJS（main.cjs /
// diag-monitor.cjs `require`）使用，避免再次漂移。
const { existsSync } = require('fs')
const { join } = require('path')
const os = require('os')
const { resolveYfwHome } = require('../server/yfw-home.cjs')

/**
 * 解析内核/bun 路径。
 * @param {{ appDir?: string }} [opts] appDir：app 根目录（含 kernel/ 与
 *   runtime/bun/ 的目录）。缺省按本模块位置推导（electron/ 的上层）。
 * @returns {{
 *   yfwHome: string,
 *   cachedKernel: string, cachedBun: string, cachedReady: boolean,
 *   kernel: string|null, bun: string|null,
 *   install: { kernel: string|null, bun: string|null },
 * }}
 */
function resolveKernelPaths({ appDir } = {}) {
  const yfwHome = resolveYfwHome()
  const cachedKernel = join(yfwHome, 'runtime', 'kernel', 'cli.mjs')
  const cachedBun = join(yfwHome, 'runtime', 'bun', 'bun.exe')

  const appRoot = appDir || join(__dirname, '..') // electron/ 的上层 = app 根
  const candidates = [
    // 打包版/便携版：<app>/kernel + <app>/runtime/bun
    { kernel: join(appRoot, 'kernel', 'cli.mjs'), bun: join(appRoot, 'runtime', 'bun', 'bun.exe') },
    // 备选部署布局：上溯一级
    { kernel: join(appRoot, '..', 'kernel', 'cli.mjs'), bun: join(appRoot, '..', 'runtime', 'bun', 'bun.exe') },
    // dev 源码构建：<appRoot>/yfw-kernel/claude-code/dist + ~/.bun
    // （bridge 原实现：server/../yfw-kernel/claude-code/dist，appRoot=server/.. 等价）
    { kernel: join(appRoot, 'yfw-kernel', 'claude-code', 'dist', 'cli.mjs'), bun: join(os.homedir(), '.bun', 'bin', 'bun.exe') },
  ]
  let install = { kernel: null, bun: null }
  for (const c of candidates) {
    if (c.kernel && existsSync(c.kernel)) {
      install = { kernel: c.kernel, bun: existsSync(c.bun) ? c.bun : null }
      break
    }
  }

  const cachedReady = existsSync(cachedKernel) && existsSync(cachedBun)
  return {
    yfwHome,
    cachedKernel,
    cachedBun,
    cachedReady,
    // 缓存优先（实际运行路径），安装路径兜底
    kernel: existsSync(cachedKernel) ? cachedKernel : install.kernel,
    bun: existsSync(cachedBun) ? cachedBun : install.bun,
    install,
  }
}

module.exports = { resolveKernelPaths }
