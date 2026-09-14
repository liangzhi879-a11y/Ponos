// src/lib/loopCommand.ts
// 循环任务面板的指令组装（从 ScheduleGuide 抽出的纯函数，便于断言生成的语法）。
// 语法契约见 kernel/loop-commands.mjs 的 parseLoopDirective：
//   /loop [次数] [--every <间隔>] [--until <目标>] [--done <命令>]... <任务>
// 为什么由本模块统一收口（三个易错点）：
//   1) 次数位在前、间隔走 --every。内核虽也接受 `/loop 10m 任务`（首 token 为时长即视为
//      --every，等价写法），但那种写法 **count=null 恒为持续运行**，无法表达"跑几轮"；
//      面板以次数为主，故显式输出 `次数 + --every`。
//   2) 带空格的值必须双引号包裹 —— tokenizer 对 `--until 目标 达成` 只取首个 token。
//   3) `不限`（count 缺省）必须配间隔 —— count=null 且 everyMs=0 时内核回落默认 3 轮，
//      与"持续运行"语义冲突。

/** 间隔格式（与内核 parseDuration 同源：Ns/Nm/Nh/Nd） */
export const DURATION_RE = /^\d+(?:\.\d+)?[smhd]$/

/** 取值加双引号；值内双引号归一为单引号，避免破坏引号配对 */
export function quoteLoopValue(v: string): string {
  return `"${v.replace(/"/g, "'")}"`
}

export interface LoopCommandInput {
  /** 循环次数；''/空白 = 不限（持续） */
  count: string
  /** 执行间隔；''/空白 = 连续执行 */
  interval: string
  /** 达成条件 → --until（可选） */
  until?: string
  /** 验收命令，一行一条 → 重复 --done（可选） */
  done?: string
  /** 任务正文 */
  task: string
}

/** 组装 `/loop` 指令文本 */
export function buildLoopCommand(input: LoopCommandInput): string {
  const count = input.count.trim()
  const interval = input.interval.trim()
  const task = input.task.trim()
  const parts = ['/loop']
  if (count) parts.push(count)
  if (interval) parts.push('--every', interval)
  if (input.until && input.until.trim()) parts.push('--until', quoteLoopValue(input.until.trim()))
  for (const line of (input.done || '').split('\n').map(s => s.trim()).filter(Boolean)) {
    parts.push('--done', quoteLoopValue(line))
  }
  parts.push(task)
  return parts.join(' ')
}

/** 校验；返回空串表示合法（错误则禁用提交按钮，不做静默兜底） */
export function validateLoopInput(input: LoopCommandInput): string {
  const count = input.count.trim()
  const interval = input.interval.trim()
  if (count && !/^\d+$/.test(count)) return '循环次数需为正整数'
  if (count && Number(count) < 1) return '循环次数需不小于 1'
  if (interval && !DURATION_RE.test(interval)) return '间隔格式如 5m / 30s / 2h / 1d'
  if (!count && !interval) return '「不限」次数需选一个执行间隔（否则内核按默认 3 轮执行）'
  return ''
}
