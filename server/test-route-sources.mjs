// server/test-route-sources.mjs —— 测试助手：把服务端**全部路由模块**的源码拼起来
// ---------------------------------------------------------------------------
// 为什么需要它：本仓库有一批"结构断言"测试——某些埋点/日志只在真实阻塞与真实轮询中出现，
// 单测触发不到，于是改为断言"源码里存在这段代码"。这类断言原先写死读 `server/bridge.mjs`，
// 而 P1 的拆分正把端点一个个搬出 bridge（files / office / collab / host / auth / readonly），
// 于是每次搬迁都会误伤这些守卫——**它们断言的意图是"这段代码存在"，与代码落在哪个文件无关**。
//
// 所以这里统一为"扫全部路由模块"。这样：
//   · 端点继续搬家时守卫仍然有效（不必跟着改）；
//   · 真正的意图（埋点/日志/异步形态落地了）被严格守住；
//   · 反向也守得住——如果某段代码被**整个删掉**，拼接源码里就再也找不到，断言照样失败。
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SERVER_DIR = dirname(fileURLToPath(import.meta.url))

/** 路由模块文件列表：bridge.mjs + 所有 `*-routes.mjs`（按名排序，去掉测试文件） */
export function routeModuleFiles() {
  const routes = readdirSync(SERVER_DIR)
    .filter((f) => f === 'bridge.mjs' || (f.endsWith('-routes.mjs') && !f.endsWith('.test.mjs')))
    .sort()
  return routes
}

/** 拼接后的源码文本（供结构断言使用） */
export function allRouteSource() {
  return routeModuleFiles()
    .map((f) => `/* ==== ${f} ==== */\n${readFileSync(join(SERVER_DIR, f), 'utf8')}`)
    .join('\n')
}
