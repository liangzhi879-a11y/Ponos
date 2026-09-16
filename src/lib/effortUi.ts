// src/lib/effortUi.ts —— effort「思考深度」UI 归约纯函数
// 规则：被测模块零依赖——不 import zustand store、不用 '@' alias、不 import 任何运行时依赖。
// 值与内核语义对齐：'auto'（默认）不在 spawn env 注入 PONOS_REASONING_EFFORT
// （内核自身默认即 auto）；其余档经 env（新会话 spawn）与 reasoning_effort
// control_request（运行中会话 WS 热切换）传递，内核侧自行完成 medium→high 等归一。
// src/types/index.ts 仅 `import type { EffortLevel }` 消费本模块 → 依赖方向 types→lib，安全。
export type EffortLevel = 'auto' | 'off' | 'low' | 'medium' | 'high' | 'max'

export const EFFORT_OPTIONS: { value: EffortLevel; labelKey: string }[] = [
  { value: 'auto', labelKey: 'effort.auto' },
  { value: 'off', labelKey: 'effort.off' },
  { value: 'low', labelKey: 'effort.low' },
  { value: 'medium', labelKey: 'effort.medium' },
  { value: 'high', labelKey: 'effort.high' },
  { value: 'max', labelKey: 'effort.max' },
]

export function normalizeEffortUi(v: string | null | undefined): EffortLevel {
  return EFFORT_OPTIONS.some(o => o.value === v) ? (v as EffortLevel) : 'auto'
}
