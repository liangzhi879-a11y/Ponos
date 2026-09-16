// src/lib/bridgeBase.ts
// 桥基地址的**唯一**解析入口。
//
// 为什么要有这个文件（2026-09-16，同一类 bug 犯过一次）：
//   仓库里曾有 4 个模块各自硬编码 `http://127.0.0.1:3939`，而桥真实监听
//   `YFW_BRIDGE_PORT || 51517`（server/bridge.mjs / electron/main.cjs / vite.config.ts 三处一致）
//   ⇒ 默认配置下这些功能**全部连不上桥**，界面只显示「无法连接本地服务」。
//   把解析逻辑收在一处，既修掉存量，也让后续不再分叉。
//
// 解析优先级：注入值（测试用） → getBridgeUrl()（生产，跟随 VITE_BRIDGE_URL / __BRIDGE_PORT__）
//             → BRIDGE_BASE_FALLBACK 兜底
//
// **抛异常是禁止的**：本函数在 React 渲染路径上被调用，抛出会整页白屏、
// 且用户看不到任何原因。getBridgeUrl() 内部读 import.meta.env / __BRIDGE_PORT__，
// 在 `node --test`（无 vite define）下必然抛，故必须包 try。

import { getBridgeUrl } from './config.ts'

/** 兜底基地址：与桥默认端口一致（YFW_BRIDGE_PORT 未设时桥监听此端口） */
export const BRIDGE_BASE_FALLBACK = 'http://127.0.0.1:51517'

/** 解析桥基地址；永不抛。注入值优先（测试），否则跟随配置，最后兜底。 */
export function resolveBridgeBase(injected?: string): string {
  if (injected) return injected
  try {
    const url = getBridgeUrl()
    if (url) return url
  } catch {
    // node --test：无 import.meta.env / __BRIDGE_PORT__，退回兜底端口
  }
  return BRIDGE_BASE_FALLBACK
}
