// src/components/settings/experienceFormat.ts —— 经验设置页的纯格式化函数（S2 Task 10）
//
// 为什么单独成文件：本仓库无 DOM 测试环境（计划 §节奏），组件只能人工走查；
// 把"能算的"抽成纯函数放进 .ts 就能用 node --test 自动守（.tsx 里含 JSX，node 原生 TS 不解析）。

/** 索引年龄 → 人类可读（`/knowledge/stats` 的 indexAgeMs）。null/非数 → '—'（"没数据"不许显示成 0） */
export function fmtAge(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—'
  const min = Math.floor(ms / 60_000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  return `${Math.floor(hour / 24)} 天前`
}

/** 字节数 → KB/MB（索引体积）。同样：无数据给 '—'，不假装是 0 B */
export function fmtBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n < 0) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

/** 注入上限回退：config 里缺省/脏值（0/负数/NaN）一律回 4096，与 server/bridge.mjs
 *  experienceInjectConfig() 的默认值一致——两处不一致会让"界面显示 4096、实际注入别的数"。 */
export function normalizeInjectMax(raw: unknown, fallback = 4096): number {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}
