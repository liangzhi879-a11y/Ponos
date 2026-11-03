// kernel/loop-judge.mjs —— 循环任务「判词消息」的组装（ENG-03，2026-10-18）
//
// 【为什么需要独立成文件】
//   缺陷在 `engine.mjs#judgeUntil`：它用 `deriveHistory()` 取历史，而该函数会应用
//   `--fresh` 的 `historySkip` 裁剪。于是 `--fresh` 与 `--until` **互相打架**：
//   · `--fresh` 的语义是「**请求面**跳过 fresh 之前的消息」（省 token，见 `setFreshWindow()`）
//   · 判词器复用同一窗口 ⇒ 第 2 轮起**看不到上一轮的目标与产出**
//   ⇒ 终止条件判定失去依据：目标已达成也判"未达成" ⇒ **无限循环烧预算**；或误判已达成提前收口。
//
//   修法（用户拍板方案①：只裁模型侧、判词读全量历史）：把组装抽成**纯函数**放这里。
//   · engine 侧传**全量**历史（不经 historySkip）
//   · 本模块负责：过滤 system、取最近 N 条、拼系统提示与判词指令
//   ★ 抽成纯函数还有一个好处：**可做真行为测试**（不必 mock 网络），
//     否则只能写"扫描源码里有没有某个字符串"的弱断言。
//
// ★ 判词是**独立的一次小调用**（maxTokens 512），与主对话的上下文裁剪无关：
//   裁主对话是为省 token，而判词必须看到"目标 + 达成证据"才能判定。

/**
 * 判词历史条数上界。
 * 判词不需要整段历史，但**必须能跨过 fresh 边界**——故上界只按条数收，不按时间窗收。
 * 20 与修前一致（原 `.slice(-20)`），避免顺手改变既有成本特征。
 */
export const JUDGE_HISTORY_LIMIT = 20

/** 判词系统提示（原样保留自 engine.mjs，只搬位置不改文案：下游可能按文案判语义） */
export const JUDGE_SYSTEM_PROMPT = '你是目标达成判定器。根据对话历史判断目标是否已达成。只输出一个 JSON 对象：{"done":true|false,"reason":"一句话理由"}'

/**
 * 组装判词消息。
 *
 * @param {object} [o] 全部字段可选 —— 缺省时按"无历史/空目标"处理（下方有防御），
 *   故 JSDoc 标 optional 与实现一致（原先把 history/target 标为必填却给了 `= {}` 默认值，tsc 会报 TS2739）
 * @param {Array<{role:string, content:any}>} [o.history] **全量**对话历史（不得是 --fresh 裁剪后的）
 * @param {string} [o.target] `--until` 的目标文本（显式传入，不依赖历史里恰好有）
 * @param {number} [o.limit] 历史条数上界（默认 JUDGE_HISTORY_LIMIT）
 * @returns {Array<{role:string, content:string}>} 可直接喂给模型的消息数组
 */
export function buildJudgeMessages({ history, target, limit = JUDGE_HISTORY_LIMIT } = {}) {
  const hist = Array.isArray(history) ? history : []
  // ★ 过滤 system：判词自己已有系统提示。混入对话里的 system（如"你是助手…"）
  //   会让模型分不清哪条规则优先，且历史上出现过 system 注入被误当用户要求的情况。
  const usable = hist.filter((m) => m && m.role !== 'system')
  const n = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : JUDGE_HISTORY_LIMIT
  // 取**最近**的（末尾）—— 达成证据通常就在最近几轮
  const tail = usable.slice(-n).map((m) => ({ role: m.role, content: String(m.content ?? '') }))

  return [
    { role: 'system', content: JUDGE_SYSTEM_PROMPT },
    ...tail,
    {
      role: 'user',
      content: `目标：${String(target ?? '')}\n请判定该目标在当前对话中是否已达成，只输出 JSON。`,
    },
  ]
}

/**
 * 解析判词模型输出（原样搬运自 engine.mjs，含既有兜底语义，勿改判据）。
 *
 * @param {string} out 模型原始输出
 * @returns {{done:boolean, reason:string, raw:string}}
 */
export function parseJudgeOutput(out) {
  const text = String(out ?? '')
  const m = text.match(/\{[\s\S]*\}/)
  try {
    const j = JSON.parse(m ? m[0] : '{}')
    return { done: j.done === true, reason: String(j.reason || ''), raw: text.slice(0, 200) }
  } catch {
    // 兜底：模型没给合法 JSON 时按关键词判（既有行为，保持不变）
    return {
      done: /达成|完成|通过|已满足|success|done|yes|true/i.test(text),
      reason: text.slice(0, 120),
      raw: text.slice(0, 200),
    }
  }
}
