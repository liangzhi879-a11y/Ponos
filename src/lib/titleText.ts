// 会话标题的**文本策略**（纯模块：零依赖、不碰 store/网络，可直接被 node:test 跑）
// ---------------------------------------------------------------------------
// 与 `src/lib/titleGen.ts` 的分工：
//   · 本模块 = 文本策略（即时截断 / 模型输出清洗 / 提示词构造）—— 纯函数，改坏了会被单测立刻抓住；
//   · titleGen.ts = 编排（挑选目标供应商 + 经桥调用 + 失败留痕），依赖 store 与网络。
// 2026-09-18 拆分原因：原先两者同在一个文件里，而该文件 import 了 zustand store ⇒ **纯函数测不到**
//   （node 解析不到 `@/stores/settingsStore`），于是"12 字截断/清洗规则"长期没有测试保护 ——
//   这正是清单项「标题效果一直不好」迟迟没被发现的一环。
//
// 长度上限 12 字符（按 Unicode 码点计，汉字 1 字）。提示词里的约束必须与它一致，
// 否则模型按 15 字给、这里截成 12 字，标题会被**拦腰切断**。

export const MAX_TITLE = 12

/** 即时标题：折叠空白后截断到 12 字符。空文本返回 ''。 */
export function truncateTitle(text: string, max: number = MAX_TITLE): string {
  const clean = (text || '').replace(/\s+/g, ' ').trim()
  if (!clean) return ''
  return [...clean].slice(0, max).join('')
}

/**
 * 模型输出清洗：去首尾引号/标点/空白，压缩内部空白，截断到 12 字符。无效（清洗后为空）返回 null。
 * 返回 null 而非空串是**有意的**：调用方据此区分"模型没给出可用标题"（保留原标题）
 * 与"标题就是空"（会把会话标题清空）—— 后者是绝对不该发生的。
 */
export function sanitizeTitle(raw: string): string | null {
  let t = (raw || '').replace(/\s+/g, ' ').trim()
  t = t.replace(
    /^[\s"'“”‘’「」『』【】《》\[\]()（）:：!！?？.。,，、;；]+|[\s"'“”‘’「」『』【】《》\[\]()（）:：!！?？.。,。，、;；]+$/g,
    '',
  )
  t = [...t].slice(0, MAX_TITLE).join('')
  return t || null
}

/** 构造给模型的提示词（两侧各截 400 字，避免把整段会话发出去） */
export function buildPrompt(userText: string, assistantText: string): string {
  return (
    '根据以下对话内容生成一个不超过12个字的概括标题（名词短语优先，无引号无结尾标点），只输出标题本身：\n' +
    `用户：${(userText || '').slice(0, 400)}\n` +
    `助手：${(assistantText || '').slice(0, 400)}`
  )
}
