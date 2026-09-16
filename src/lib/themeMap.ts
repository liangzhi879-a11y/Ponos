// src/lib/themeMap.ts —— 主题 ID 收敛 6→4→3 的迁移纯函数
// 映射表（spec §1.1）：旧值 → 新值；未知/缺省 → 'dark'；新值幂等。
// 2026-09-15：'light-glass'（浅色玻璃）主题删除 → 迁移到 'light'（同为浅色，
// 只丢掉磨砂壳，保留全部浅色语义），使老用户落盘设置不至于被打回 dark。
export const THEME_IDS = ['dark', 'light', 'dark-glass'] as const
export type ThemeId = (typeof THEME_IDS)[number]

const LEGACY_MAP: Record<string, ThemeId> = {
  'yuanfang': 'dark',
  'dark': 'dark',
  'yuanfang-light': 'light',
  'light': 'light',
  'glass': 'dark-glass',
  'glass-warm': 'dark-glass',
  // 已删除主题：→ 同明暗的实色主题
  'light-glass': 'light',
}

export function migrateThemeId(old?: string): ThemeId {
  if (old && (THEME_IDS as readonly string[]).includes(old)) return old as ThemeId
  return (old && LEGACY_MAP[old]) || 'dark'
}
