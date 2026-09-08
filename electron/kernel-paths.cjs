'use strict'
// 内核路径解析——全应用单一事实来源。
//
// 背景（2026-08-20 生产事故）：bridge.mjs findYFWorking() 与 main.cjs
// resolveDiagPaths() 各自维护内核路径解析，发生漂移——bridge 会话跑 bootstrap
// 缓存（用户家目录，无 ACL 限制），而诊断探针直接 spawn 安装目录（Program
// Files 下 EPERM）→ kernel-launch 误报 exit=1。统一规则（S4 净室改接后）：
// 解析顺序与 findYFWorking 一致——① <appRoot>/kernel/cli.mjs（或上溯一级 /
// kernel-dist bundle）安装候选命中即用；② home bootstrap 缓存
// （runtime/ponos-kernel）作 install 缺失时的兜底（升级/卸载残留）。
// 缓存目录名专用为 ponos-kernel（D3）：默认 home（未设 YFWORKING_HOME）下
// bootstrap 也不与在售旧版的内核缓存目录（cli.mjs + vendor/ripgrep 旧布局）
// 互覆——2026-09-08 事故实证：曾以默认 home 覆写该旧缓存目录，清掉内置
// harness 的 rg.exe → Grep/Glob ENOENT。
//
// 运行时 = node（D1）：内核以 `"<node>" "<kernel>"` 方式运行，node 定位由调用方
// 提供（bridge = process.execPath；Electron main = resolveNode() 的 bundled
// node.exe 或 PATH 'node'）——本模块只解析内核路径，不再解析 bun 运行时。
//
// 本模块同时供 ESM（bridge.mjs `import paths from`）与 CJS（main.cjs /
// diag-monitor.cjs `require`）使用，避免再次漂移。
const { existsSync } = require('fs')
const { join } = require('path')
const { resolveYfwHome } = require('../server/yfw-home.cjs')

/**
 * 解析内核路径（运行时 node 由调用方定位，本模块只管内核落点）。
 * @param {{ appDir?: string }} [opts] appDir：app 根目录（含 kernel/ 与
 *   kernel-dist/ 的目录）。缺省按本模块位置推导（electron/ 的上层）。
 * @returns {{
 *   yfwHome: string,
 *   cachedKernel: string, cachedReady: boolean,
 *   kernel: string|null,               // 生效内核：install 候选命中优先，home 缓存兜底
 *   install: { kernel: string|null },  // 安装候选（repo/app kernel 源码或 kernel-dist bundle）
 * }}
 */
function resolveKernelPaths({ appDir } = {}) {
  const yfwHome = resolveYfwHome()
  const cachedKernel = join(yfwHome, 'runtime', 'ponos-kernel', 'cli.mjs')

  const appRoot = appDir || join(__dirname, '..') // electron/ 的上层 = app 根
  const candidates = [
    // 打包版/便携版 + dev 源码直跑：<appRoot>/kernel/cli.mjs（源或单文件 bundle 落位）
    join(appRoot, 'kernel', 'cli.mjs'),
    // 备选部署布局：上溯一级
    join(appRoot, '..', 'kernel', 'cli.mjs'),
    // dev bundle 形态：<appRoot>/kernel-dist/cli.mjs（scripts/build-kernel.mjs 产物）
    join(appRoot, 'kernel-dist', 'cli.mjs'),
  ]
  let install = { kernel: null }
  for (const k of candidates) {
    if (existsSync(k)) {
      install = { kernel: k }
      break
    }
  }

  const cachedReady = existsSync(cachedKernel)
  return {
    yfwHome,
    cachedKernel,
    cachedReady,
    // 生效内核与 findYFWorking 解析同序：install 候选命中即用，home 缓存兜底
    kernel: install.kernel || (existsSync(cachedKernel) ? cachedKernel : null),
    install,
  }
}

module.exports = { resolveKernelPaths }
