// src/lib/visionUi.ts —— 视觉能力判定（GUI 侧唯一一份口径）
//
// **为什么放在 lib 而不是 settingsStore**（2026-09-14）：settingsStore 运行时依赖 `@/lib/*`
// 别名，`node --test` 解析不了 → 它的逻辑拿不到单测（测试入口见 package.json 的 `test` 脚本，
// 全走 `node --test`）。而这两条判定是"设置页"与"知识库导入提示"共用的**关键**逻辑，
// 必须能被钉住。故按本项目既有模式（approvalModeUi.ts / logUi.ts / healthUi.ts）纯函数化，
// 只 import type（类型在运行时被剥离），从而可直测。
//
// 为什么必须是**唯一一份**：设置页要显示"视觉模型"、知识库导入要提示"未配置视觉模型"，
// 两处各算一遍的结果就是"设置页说配好了、导入却提示未配置"——用户无法自行判断谁对。
// 本项目已有同类前车之鉴：bridge 注入 `YFW_VISION_*` 而内核只读 `PONOS_VISION_*`，
// 导致用户明明配好了视觉模型却被判定"未配置"（详见 kernel/provider.mjs 的 visionEnv 注释）。
//
// 与内核口径的对应（kernel/provider.mjs 的 visionEnv / visionAvailable）：
//   内核：VISION_BASE_URL 有值 **且** VISION_MODEL 有值 → 可调用（不要求 token）；
//   GUI ：provider.apiBaseUrl 非空 **且** provider.visionModel 非空 → 可调用（不要求 authToken）。
//   bridge 用同一组字段拼 env（server/bridge.mjs:548），故两边结论一致。
import type { AppSettings, ModelProvider } from '@/types'

/**
 * 视觉模型来源 provider：显式 `visionProviderId` 优先，否则跟随 `activeProvider`。
 *
 * 显式指定的 id **不存在**时回落到 activeProvider（而非 undefined）：
 * 否则用户改错一个 id，视觉能力会静默消失且没有任何提示。
 */
export function resolveVisionProvider(settings: AppSettings): ModelProvider | undefined {
  const providers = settings.providers || []
  return providers.find(p => p.id === settings.visionProviderId)
    || providers.find(p => p.id === settings.activeProvider)
}

/** 判断某个 provider 是否具备视觉能力（baseUrl + visionModel 齐备；不要求 token） */
export function providerHasVision(provider: ModelProvider | undefined): boolean {
  if (!provider) return false
  return !!(provider.apiBaseUrl || '').trim() && !!(provider.visionModel || '').trim()
}

/**
 * 视觉能力是否可用（GUI 侧口径）。用于：
 *  · 设置页展示视觉模型当前是否生效；
 *  · 知识库导入对话框提示"扫描件/图片里的表格能不能被提取"。
 */
export function isVisionConfigured(settings: AppSettings): boolean {
  return providerHasVision(resolveVisionProvider(settings))
}
