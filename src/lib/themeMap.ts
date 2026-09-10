// src/lib/themeMap.ts —— 主题 ID 收敛 6→4 的迁移纯函数
// 映射表（spec §1.1）：旧值 → 新值；未知/缺省 → 'dark'；新值幂等。
export const THEME_IDS = ['dark', 'light', 'dark-glass', 'light-glass'] as const
export type ThemeId = (typeof THEME_IDS)[number]

const LEGACY_MAP: Record<string, ThemeId> = {
  'yuanfang': 'dark',
  'dark': 'dark',
  'yuanfang-light': 'light',
  'light': 'light',
  'glass': 'dark-glass',
  'glass-warm': 'dark-glass',
}

export function migrateThemeId(old?: string): ThemeId {
  if (old && (THEME_IDS as readonly string[]).includes(old)) return old as ThemeId
  return (old && LEGACY_MAP[old]) || 'dark'
}
