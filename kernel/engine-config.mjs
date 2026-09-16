// 环境阈值与守卫配置（原 engine.mjs 顶部，P1-6 拆出）：PONOS_* 环境变量的唯一求值点。
// 性质：纯「配置」——与 createEngine 的闭包状态（signal/wire/session…）无关，故可独立成模块。
// 注意：求值时机不变（模块顶层读 process.env）。engine.mjs 导入使用并 re-export 原导出面。
import { nrNorm } from './gen-guards.mjs'


// —— agent loop 兜底（本地模型死循环防护）——
// 参考同类实现：主循环均默认无全局硬上限（靠 Esc 中断/可选 maxTurns/上下文
// 自愈）；另有「连续同工具调用达阈值注入提醒」的做法。本地模型（vLLM
// Qwen 等）死循环两大形态：① 工具调用不断但无进展（反复同工具/全失败重试/无限续轮，
// 含"测量打转"——只读测量参数微变、守卫③b/⑤抓不到，由守卫⑥无进展停滞兜底）；
// ② 生成环节打转（thinking/文本重复打转、流式无数据挂起、单轮拖超时）。本引擎按本地
// 模型场景默认开启以下守卫，全部可用 PONOS_* 环境变量调（0 = 关），PONOS_LOOP_GUARD=0
// 一键全关（对齐参考实现"无硬上限"语义）。到限一律优雅收尾：附说明文本 + result 闭轮，
// 会话上下文保留，用户可发「继续」让模型接续，不烧死 token 也不丢任务。
// 无感愈合原则（2026-09-10）：模型异常（重复/停滞/连续失败/中断/空流）优先注入
// 指令自愈续跑，用户无感知（guard_heal 事件可观测），恢复即清零愈合计数；耗尽
// 各形态愈合预算（PONOS_*_HEAL_MAX）才落可见收尾——硬停是最后防线，非默认路径。
// 轮次墙钟（守卫①）默认关闭（2026-09-10 用户要求取消 30 分钟上限）——长任务正常形态
// 由守卫⑥（无进展停滞，10 分钟）承担"循环但无进展"的兜底，互不冲突。
export function envNonNeg(name, def) {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : def
}
// 愈合预算解析（2026-09-11 持久自愈）：-1 = 持久无限自愈（安全网 = 守卫⑥
// 无进展停滞——纯循环无工具进展，⑥ 兜底收尾）；>0 = 有限预算（耗尽落可见收尾）；
// 0 = 关闭该形态自愈（回到旧行为：命中即收尾）。LOOP_GUARD=0 时全部关闭。
export function envHealMax(name, def) {
  const raw = process.env[name]
  if (raw === undefined) return def
  const v = Number(raw)
  return Number.isFinite(v) ? Math.floor(v) : def
}
export const LOOP_GUARD_OFF = process.env.PONOS_LOOP_GUARD === '0'
// 单轮工具迭代上限：默认不限（0）——应用需要长任务能力，单轮几十次工具调用是正常
// 路径（调查/重构/批量编辑）。本地模型死循环经调试验证不在工具调用链：根因是上下文
// 400 溢出吞错、生成重复打转、文件工具边界全拒等，各自有对应专项守卫（溢出按进展自
// 愈 / 生成重复 / 空闲看门狗 / 失败熔断）。迭代数硬上限只会误杀长任务轮（用户侧表现：
// 任务"自己停下来"、需反复发「继续」），故默认取消。需要保险时可显式设
// PONOS_LOOP_MAX_ITERATIONS（>0），旧变量 PONOS_MAX_TOOL_ITERATIONS（>0）优先。
export const LEGACY_MAX_TOOL_ITER = Number(process.env.PONOS_MAX_TOOL_ITERATIONS)
export const MAX_TOOL_ITERATIONS = LOOP_GUARD_OFF ? 0
  : (Number.isFinite(LEGACY_MAX_TOOL_ITER) && LEGACY_MAX_TOOL_ITER > 0)
    ? Math.floor(LEGACY_MAX_TOOL_ITER)
    : envNonNeg('PONOS_LOOP_MAX_ITERATIONS', 0)
// 轮次墙钟（主 loop 每轮 + 子 lane）：默认关闭（2026-09-10 取消 30 分钟单轮时长
// 上限——长任务（咨询材料整包处理等）单轮超 30 分钟是正常形态，误杀表现为
// "已达单轮时长上限…已自动收尾"，任务半途中断）。挂起防护由空闲看门狗
// （STREAM_IDLE_MS/首内容宽限）、生成重复守卫与工具 deadline 承担，不再靠
// 轮次总时长一刀切。需要硬上限时可显式设 PONOS_TURN_TIMEOUT_MS（>0，分钟级）。
export const TURN_TIMEOUT_MS = LOOP_GUARD_OFF ? 0 : envNonNeg('PONOS_TURN_TIMEOUT_MS', 0)
// 溢出重试上限（2026-09-12 长会话 UI 闪烁事故）：溢出自愈的每次重试都是一次完整 API
// 请求（贴窗口的长会话请求体可达 1MB）。线上事故实测：7 分钟内同一份 985KB 请求被
// 重发 240 次、摘要请求 200 次，用户侧看到压缩条 ~1Hz 闪烁、服务端被持续轰炸。根因是
// 瘦身副本在 continue 前被无条件清空（见下方 request_trimmed 分支）→ 修掉之后仍有
// "瘦身后依旧装不下"的极端形态（估算与真实 token 偏差数倍）→ 达上限直接落终局可见
// 文案（会话保留、原因可见），不再无界空转。0 = 不设上限（仅调试用）。
export const MAX_OVERFLOW_RETRIES = LOOP_GUARD_OFF ? 0 : envNonNeg('PONOS_OVERFLOW_MAX_RETRIES', 12)
// 流式生成空闲看门狗：单次模型流内间隔超时判挂起（防 fetch 永不回块）。
// 默认 5min（2026-09-10 云端校准）：MiniMax M3 等云端模型在"思考→正文"阶段切换
// 或服务拥塞时，中段停顿可超 2 分钟（实测 120s 窗口误杀一次健康轮，落
// "120 秒无数据…已按挂起自动收尾"）。中段容忍与首字节窗口（480s）同量级——
// 真挂起的代价由 300s 界定，误杀代价（整段已产出内容作废+重试）更贵。
export const STREAM_IDLE_MS = LOOP_GUARD_OFF ? 0 : envNonNeg('PONOS_STREAM_IDLE_MS', 300_000)      // 5min
// 首内容宽限窗口（2026-09-09 长任务挂起事故修复）：自建/共享服务的 prefill 时长随
// 上下文线性增长（实测 27B 空闲端 85k tokens 冷 prefill = 45.7s 零事件，排队/并发
// 会话下轻松超 2min）——message_start/content_block_start 不产生内核可见 chunk，
// 首个内容 delta 前"零数据"是 prefill 的正常形态，不是死连接。故首个 chunk 前用
// 更宽窗口（默认 5min），首个 chunk 后回到 STREAM_IDLE_MS 的 2min 判生成停顿。
// 硬上限 8min（2026-09-09 事故三次校准）：首内容前"零数据"的真实构成 =
// prefill + 模型隐藏思考（tools 触发工具规划推理，服务端缓冲不流式——实测
// 35-260s，kernel 实际步频 100-260s）。300s 上限曾把健康长思考步假 abort
// （300+3+300+3+301=907s 三步重试链即此形态），480s 覆盖最坏思考+prefill，
// 又封死病态宽限（settings 旧值 447s 自动钳制；超 20 万字符由 adaptive 升 600s）。
export const FIRST_BYTE_HARD_CAP_MS = 480_000
export const STREAM_FIRST_BYTE_MS = LOOP_GUARD_OFF ? 0 : Math.min(envNonNeg('PONOS_STREAM_FIRST_BYTE_MS', 300_000), FIRST_BYTE_HARD_CAP_MS)
// K1.4 请求面记忆化开关（默认 on）。**必须惰性读**：cli.mjs 的 settings.env 注入发生在
// 所有 ESM 模块求值之后，写成模块级常量会永远读到 undefined（同 perf.mjs 头注 1）。
let requestFaceCacheOn = null
export const isRequestFaceCacheOn = () => (requestFaceCacheOn === null ? (requestFaceCacheOn = process.env.PONOS_REQUEST_FACE_CACHE !== '0') : requestFaceCacheOn)

// ── 失真红线锚点注入（2026-09-15 闭环）───────────────────────────────────────
// 开关：默认开；PONOS_FIDELITY_ANCHOR=0 关闭。**惰性读**——cli.mjs 的 settings.env
// 注入发生在所有 ESM 模块求值之后（与 perf.mjs 同一坑：顶层直读 process.env 会永远
// 拿到注入前的值）。
let fidAnchorCacheOn = null
export const isFidAnchorOn = () => (fidAnchorCacheOn === null ? (fidAnchorCacheOn = process.env.PONOS_FIDELITY_ANCHOR !== '0') : fidAnchorCacheOn)

// 把锚点并入请求面**尾部**（而非 system）：前缀字节不变，prompt cache 命中不受影响。
// 末条为 user 时并入其 content 而非新起一条——保证 user/assistant 交替合法（部分端点
// 拒连续两条 user）。纯派生：不写日志、不发消息事件，GUI 看不到，transcript 权威性不变。
export function withAnchorTail(face, text) {
  const body = `【系统提醒 · 上下文失真告警】\n${text}\n（以上由内核自动检测：你已丢失这些信息，请据此修正——重新读取或复述相关事实，不要臆造假信息。）`
  const arr = Array.isArray(face) ? face.slice() : []
  const last = arr[arr.length - 1]
  if (last && last.role === 'user') {
    if (typeof last.content === 'string') arr[arr.length - 1] = { ...last, content: `${last.content}\n\n${body}` }
    else if (Array.isArray(last.content)) arr[arr.length - 1] = { ...last, content: [...last.content, { type: 'text', text: body }] }
    else arr[arr.length - 1] = { ...last, content: body }
    return arr
  }
  arr.push({ role: 'user', content: body })
  return arr
}
// 锚点注入节流（2026-09-16 活跃度巡检）：失真 red 期间**每个 API 请求步都重建注入**——
// 注入缓存键是「锚点指纹 + face 身份」，而 face 每步必变 ⇒ 每步都注入一次，没有任何
// 冷却。真实运行实测（kernel-stderr.log，38 小时窗口）：876 次注入，单会话最高
// 388 次 / 748 次 API 请求 = **52% 的请求带锚点**；而锚点尾句固定要求"请先复述关键
// 事实确认，再继续任务"（fidelity.mjs 的 ANCHOR_TAIL）——模型因此被反复要求复述，
// 是"内核频繁提醒模型继续"体感的最大来源（量级高于全部循环守卫注入之和）。
//
// 节流语义（同指纹连续期内两级）：
//   · 同一锚点指纹（issue ids 集合）连续注入至多 FID_ANCHOR_MAX_CONSEC 次（默认 2）；
//   · 之后每跳过 FID_ANCHOR_REINJECT_EVERY 步（默认 8）**补注一次**——不彻底静默：
//     长任务里锚点仍需在场（模型长程跑偏、早期注入被挤出注意力），只是不再每步重复。
// 不受节流约束（立即注入）的两种情形：
//   · 指纹变化——失真证据集合变了＝新信息，必须送达（锚点内容也随之变化）；
//   · 上下文收缩——本次 face 消息数少于上次注入时＝压缩/裁剪发生，旧锚点已被遮蔽。
// 0 = 关闭节流（恢复"每步都注入"旧行为）。失真轴与压力轴独立，故不受 LOOP_GUARD 影响。
export const FID_ANCHOR_MAX_CONSEC = envNonNeg('PONOS_FIDELITY_ANCHOR_MAX_CONSEC', 2)
export const FID_ANCHOR_REINJECT_EVERY = envNonNeg('PONOS_FIDELITY_ANCHOR_EVERY', 8)
// 上游零数据挂起（prefill 超首内容宽限）的自动重试上限：真死服务重试无益，但
// 排队/瞬态负载场景一次重试常能恢复。0 = 关闭（直接按挂起收尾）。
// 2026-09-10 无感愈合原则：预算 2 → 3（多一轮静默重试才落可见收尾）。
export const IDLE_DEAD_RETRY_MAX = LOOP_GUARD_OFF ? 0 : envNonNeg('PONOS_IDLE_DEAD_RETRIES', 3)
export const IDLE_DEAD_RETRY_BACKOFF_MS = 3000 // 零数据挂起重试前的小幅退避（让排队窗口错开）

// 首内容窗口自适应（2026-09-09 本地 vLLM 容器适配）：prefill 时长随输入规模线性
// 增长（实测空闲端 85k tokens ≈ 46s，排队/并发下轻松翻倍），固定宽限对大上下文
// 会话会误杀（输入 100k+ 的长任务实测 300s 零响应被收尾）。输入体量超阈值时放宽
// 到 600s（大上下文 prefill 266s + 思考 300s ≈ 566s 的正常形态，600s 封顶）。
export function adaptiveFirstByteMs(messagesProvider, baseMs) {
  if (!baseMs || baseMs <= 0) return 0
  try {
    const chars = JSON.stringify(messagesProvider()).length
    if (chars > 200_000) return Math.min(Math.max(baseMs, 600_000), 600_000)
  } catch { /* 估算失败保持默认窗口 */ }
  return baseMs
}
// 连续工具失败熔断：一轮内连续全部失败的迭代达上限即收尾（成功一次即复位）
export const MAX_ERROR_ITERATIONS = LOOP_GUARD_OFF ? 0 : envNonNeg('PONOS_LOOP_MAX_ERROR_ITERATIONS', 6)
// 同工具重复提醒注入阈值（仅提醒不 veto，硬性由
// 迭代上限兜底）。PONOS_LOOP_REPEAT_REMIND 逗号分隔，如 "3,5"；空串/0 → 关闭。
export function envRemindList(name) {
  const raw = process.env[name]
  if (raw === undefined) return [3, 5]
  const vals = String(raw).split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0)
  return [...new Set(vals)]
}
export const REPEAT_REMIND_AT = LOOP_GUARD_OFF ? [] : envRemindList('PONOS_LOOP_REPEAT_REMIND')
// 句级近重复检测（守卫③b）：本地模型"编织变体"死循环——措辞微变反复重述同一批内容
// （"Let me run it." / "Let me run it now."…），逐字符精确周期（守卫③）抓不到。逐新句
// 与先前句池做 bigram Jaccard，最近 recent 句的平均高相似近邻数 ≥ avg 即判退化。默认值
// 经真实 35KB 死循环样本回放 + 长文/代码对照标定（样本 ~10.6k 归一化字符止损；对照零误伤）。
// RECENT=0 / PONOS_LOOP_GUARD=0 关闭；SIM/RECENT/AVG/BACK 可经 env 调。
export function envFloat(name, def) {
  const v = Number(process.env[name])
  return Number.isFinite(v) ? v : def
}
export const NEAR_REPEAT_RECENT = LOOP_GUARD_OFF ? 0 : envNonNeg('PONOS_NEAR_REPEAT_RECENT', 10)
export const NEAR_REPEAT_AVG = LOOP_GUARD_OFF ? 0 : envFloat('PONOS_NEAR_REPEAT_AVG', 1.2)
export const NEAR_REPEAT_SIM = LOOP_GUARD_OFF ? 0 : envFloat('PONOS_NEAR_REPEAT_SIM', 0.6)
export const NEAR_REPEAT_BACK = LOOP_GUARD_OFF ? 0 : envNonNeg('PONOS_NEAR_REPEAT_BACK', 48)
// 近重复守卫代码单元豁免（系统性修复：用户实证"代码内容容易被误判为重复"）：结构高度
// 相似的多行实现代码（对多个字段/入口做同类改造、批量绑定监听等）经 nrNorm 归一化后
// 彼此 Jaccard 高（实测 14 行同类改造 avgNeighbor=2 ≥ 1.2 误触发收尾）。代码行不进
// 句池/直方：正常代码流不再参与"近似重复"累计。PONOS_NEAR_REPEAT_CODE=0 关闭豁免。
export const NEAR_REPEAT_CODE_SKIP = LOOP_GUARD_OFF ? false : process.env.PONOS_NEAR_REPEAT_CODE !== '0'
// 生成重复守卫内部自愈上限（P1）：③/③b 命中先"注入推进指令续跑"而不是直接收尾把报错
// 说明喂给用户（本地模型一次性打转 / 探测器误判时一轮注入即恢复，用户无感）。真死循环
// 模型会持续复现 → 耗尽上限才落回收尾说明（仍保证不死循环烧 token）。=0 关闭自愈
// （回到旧行为：命中即收尾 + 可见说明）。2026-09-11 持久自愈：默认 -1 = 无限预算——
// 愈合后出现一轮"无命中的干净迭代"即清零；真循环每轮必命中、预算不耗尽，安全网 =
// 守卫⑥（纯文本循环无工具进展，10 分钟无进展停滞接管收尾）。设 >0 恢复有限预算语义。
export const REPEAT_HEAL_MAX = LOOP_GUARD_OFF ? 0 : envHealMax('PONOS_REPEAT_HEAL_MAX', -1)
// 输出截断自愈（2026-09-12 对标：8K 撞顶升档 64K 重试 / 可恢复截断重试）：
// 文本收尾被 max_tokens 截断 → 不再让用户发「继续」，内部按档位升输出预算续写、
// 拼进同一回复（8K/16K/32K/64K，最多升 2 档）；64K 再截断才按普通收尾处理
// （用户可发「继续」）。=0 关闭（旧行为：截断即收尾）。
export const CONTINUE_HEAL_MAX = LOOP_GUARD_OFF ? 0 : envHealMax('PONOS_CONTINUE_HEAL_MAX', 2)
export const OUTPUT_TIERS = [8192, 16384, 32768, 65536]
// 无感愈合预算族（2026-09-10 模型异常愈合原则；2026-09-11 持久化）：模型异常优先注入
// 指令自愈续跑（用户无感知），恢复即清零；默认 -1 = 持久无限自愈（安全网 = 守卫⑥），
// 设 >0 恢复有限预算（耗尽落可见收尾）。各形态独立计数：连续失败熔断（④）/
// 空闲中断（已产出后停顿）/ 上游空流（vLLM 加载中，基础设施型保持有限默认）。
export const MELTDOWN_HEAL_MAX = LOOP_GUARD_OFF ? 0 : envHealMax('PONOS_MELTDOWN_HEAL_MAX', -1)
export const IDLE_HEAL_MAX = LOOP_GUARD_OFF ? 0 : envHealMax('PONOS_IDLE_HEAL_MAX', -1)
export const UPSTREAM_DEAD_HEAL_MAX = LOOP_GUARD_OFF ? 0 : envNonNeg('PONOS_UPSTREAM_DEAD_HEAL_MAX', 2)
export const UPSTREAM_DEAD_HEAL_BACKOFF_MS = LOOP_GUARD_OFF ? 0 : envNonNeg('PONOS_UPSTREAM_DEAD_HEAL_BACKOFF_MS', 30_000)
// 守卫⑥：无进展停滞（2026-09-10 循环未拦截事故；同月改自愈优先）。"测量打转"循环——
// 模型每轮用微变参数对同一目标做只读测量（Browser js/snapshot）+ 注释文本，同工具键
// 窗口（⑤）与文本近重复（③b）都抓不到（每轮键/措辞都不同），轮次墙钟默认关闭后无
// 任何守卫能停。本守卫在迭代边界检查"距上次实质进展的时长"：进展信号 = 成功且非只读
// 测量的工具结果（Write/Edit/Read/Grep/Bash/Browser goto/click 等）；Browser js/snapshot
// 与失败结果不算。纯文本轮次本来即收尾，无需计入。默认 600s（0=关闭；LOOP_GUARD=0 同关）。
// 命中时**先注入推进指令自愈续跑**（用户无感知，与③/③b 自愈同哲学）——恢复实质进展
// 即清零愈合计数；耗尽 STALL_HEAL_MAX 仍无进展才落可见收尾（硬停是最后防线，非默认路径）。
export const LOOP_STALL_MS = LOOP_GUARD_OFF ? 0 : envNonNeg('PONOS_LOOP_STALL_MS', 600_000)
export const STALL_HEAL_MAX = LOOP_GUARD_OFF ? 0 : envNonNeg('PONOS_STALL_HEAL_MAX', 2)
// B3 子 agent 后台并发槽（2026-09-11）：同时运行的后台 lane 上限（默认 4，
// 对齐同类产品的"每会话并发线程数"上限）；超限派发排队（FIFO），
// 槽位释放自动启动。0 = 不限（既有行为）。
export const LANE_MAX_CONCURRENT = LOOP_GUARD_OFF ? 0 : envNonNeg('PONOS_LANE_MAX_CONCURRENT', 4)
