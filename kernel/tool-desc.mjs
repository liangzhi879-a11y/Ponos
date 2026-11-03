// kernel/tool-desc.mjs —— 工具面描述预算（T1.1，2026-10-20；净化计划 §T1.1）
// ---------------------------------------------------------------------------
// 为什么要有这个模块：工具面是**每请求固定注入**的最大一块（实测 31,116 B，占固定注入面
// ≈61 KB 的一半）。其中 `description` 17,043 B = 55%，而**长散文集中在 5 个工具**
// （Screen 4,489 / KnowledgeImport 1,560 / KnowledgeDelete 1,154 / Browser 841 / Read 823）。
// 这些散文对**第一次使用**有价值，对**每一轮**都是重复付费。
//
// ★ 关键事实（已核实，是本任务敢动手的前提）：
//   工具契约指纹只覆盖 `input_schema` 的结构哈希（`kit/lib/contract-tools.mjs` 的
//   `structureOf → shapeOfNode`，`SHAPE_KEYS` 只有 `pattern/format`）⇒ **改 `description`
//   不动 docs/bridge-contract.md §12、无需 kit:sync**。这条还有门禁自证：
//   `kit/lib/contract-tools.test.mjs` 用 `descriptionText` 变化做反证。
//
// ★ 改法：**不删信息，搬走信息**。完整长文外迁到 `docs/tool-descriptions.md`（模型可用 Read
//   按需查阅），内联改成"做什么 + 何时用 + 最容易踩的一两条 + 去哪看全文"。
//
// ★ 开关（Global Constraint 7：独立开关 + 一行回退）：
//   `PONOS_TOOL_DESC=full` ⇒ 逐字节恢复改动前的长描述（31,116 B）；
//   缺省 = 紧凑版（≈23.8 KB）。改默认是独立一步，回退只需设一个环境变量。
//
// ★ 纪律：**没有紧凑版的工具一律原样保留**（不做机械截断）。截断会把一句话切断在半路
//   （"…必须给出 window（绝不" 这种），比长描述更糟。测试对此有棘轮：
//   紧凑模式下每个工具的描述必须 ≤ 240 字符，且**必须**在表里显式登记 —— 未登记而超限即红。

/**
 * 内联描述字符上限 —— **次级护栏**（真正的棘轮是工具面总字节）。
 *
 * ★ 为什么不是计划里那个 240：240 是**实测取样点**（"≤240 字 ⇒ 23,823 B"），不是必须遵守
 *   的常量。实际外迁后总字节 23,267 B，**比 240 字那一档还低**（因为 Top5 压得更狠）。
 *   把 240 当硬不变量会逼着把"最容易踩的坑"也删掉——那是拿质量换字节，与本计划的
 *   第一约束（不降低任务成功率）冲突。故此值取 360：够装下"做什么 + 一两条坑 + 指针"，
 *   又能挡住"悄悄把长散文塞回来"（超限即红，必须显式改这个常量并说明理由）。
 */
export const TOOL_DESC_MAX_CHARS = 360

/** 外迁文档路径（相对仓根；短描述里用反引号标出，模型可 Read 查阅） */
export const TOOL_DESC_DOC = 'docs/tool-descriptions.md'

/** 运行时护栏的去重标志（只在首次超限时出声：正常跑零输出，不刷屏） */
let descWarned = false

/**
 * 紧凑描述（只登记**超预算**的工具；其余工具原样保留）。
 *
 * 写这几条的原则（按优先级）：
 *  ① 先说"做什么 + 什么时候该用"（决定选不选它）；
 *  ② 再说**最容易踩、且踩了会静默出错**的那一两条（如 Screen 的 keyCombo 键名 vs typeText 文本）；
 *  ③ 最后给外迁指针（需要细节时去哪儿看）。
 * 刻意**不**保留：历史沿革、为什么这么设计、示例 JSON 全文 —— 那些在 `docs/tool-descriptions.md`。
 */
export const SHORT_TOOL_DESCRIPTIONS = Object.freeze({
  Screen: '观测并操作屏幕。读：displays / windows（含弹窗传 params.includePopups）/ capture 只回元数据 / look 按文字定位并回坐标。输入：move/clickAt/drag/scroll/keyCombo/typeText/sequence 发真实键鼠，**需批准**且必须给 window 或 hwnd（同名多实例用 hwnd）；x/y 是**相对窗口的 0..1000**。★ 输入文字用 typeText；keyCombo 的 value 是**键名**（Enter/Ctrl+C）。★ 能读控件树就别用像素。详见 `docs/tool-descriptions.md#screen`。',
  KnowledgeImport: '把文件或目录（递归）导入知识空间（**写盘**），之后用 KnowledgeSearch 检索。支持 PDF（含扫描件 OCR）/docx/xlsx/pptx/图片/文本/CSV。护栏：单文件 ≤50MB、整批 ≤500 个且 ≤300MB。报告 summary 是全量计数（imported/skipped/rejected/failed），results 逐条给原因——rejected 是**本就不该**进库，failed 是该进库但**没成功**。dryRun=true 只预览不写盘。详见 `docs/tool-descriptions.md#knowledgeimport`。',
  KnowledgeDelete: '管理知识库删除（**软删除到回收站**）：list / doc（需 space+path）/ space（需 confirm 精确等于 space；内置空间只能删条目，pack-* 只读）/ restore（trashId）/ purge（不可恢复，或 all=true 清空）。还原会放回原位，遇同名自动改名让位。★ 不可逆操作先与用户确认；不确定先 list。详见 `docs/tool-descriptions.md#knowledgedelete`。',
  Browser: '驱动内置浏览器（快照驱动：先 snapshot 拿 ref，再按 ref 操作）。动作 goto/back/forward/refresh/snapshot/click/type/select/scroll/hover/wait/js。★ ref 随页面变化失效——失败就重新 snapshot，别沿用旧 ref。goto 非白名单域名会被拦截并请求用户批准：批准即写入白名单、直接重试；拒绝则改用 WebFetch/WebSearch。详见 `docs/tool-descriptions.md#browser`。',
  Read: '读取文本文件（上限 2000 行 / 2MB）。默认读全文而非分段取样；超大文件用 offset/limit 并会提示续读位置。重复读未变化的文件会回"未变化"——直接引用此前结果。优先用它而非 Bash cat/sed。范围：会话目录及挂载目录（--add-dir）、记忆目录、已授权知识库、技能 extra_dirs；其余路径被拒并列出可用根。详见 `docs/tool-descriptions.md#read`。',
  // ── 以下 5 条是"原本就不长但超 240 字"的工具（同样只是搬家，语义不丢）──────────
  Bash: '执行 shell 命令。仅用于系统命令/测试/构建/git；读文件用 Read、搜内容用 Grep、找路径用 Glob。多步验证用 && 串联。默认 120s 超时（timeout_ms 可覆盖，上限 30min）；无 stdin（勿用 ssh/vi）；输出超 200KB 截断保留尾部；失败返回退出码与 stderr。Windows GBK 乱码先 chcp 65001 或改 PowerShell；全树搜索优先 git ls-files。详见 `docs/tool-descriptions.md#bash`。',
  Edit: '先读后改的字符串替换（old_string 需与文件字节精确匹配含空格换行；需唯一，或 replace_all）。一次覆盖一个完整逻辑块；同文件多处改动合并为一次；改动过大考虑 Write 重写。失败（未找到/不唯一）按错误信息调整上下文，勿原样重试。边界：仅可编辑会话目录、挂载目录（--add-dir）与技能 extra_dirs 内经校验的工作目录。详见 `docs/tool-descriptions.md#edit`。',
  Glob: '在会话目录与已授权知识库内递归搜文件路径（支持 * ? **）。先 Glob 定位候选再 Read，避免无目标 ls。已知位置务必传 path 收窄——省略会遍历全部会话目录，代价极高。node_modules/dist/build/release/vendors/workspace 默认剪枝；目标在其中时 pattern 需显式含目录名。无匹配时按返回提示换更精确 pattern，勿反复全树试探。',
  OCR: '对扫描件 PDF 或图片做 OCR（mode=text 全文；mode=table 额外识别表格，仅 PDF）。结果按 project 缓存，重复识别秒回。图片默认走增强管线（enhance=auto：反色/对比度/低置信度重试/数字复核/超长截图分块；enhance=off 回退基础）。首次调用加载模型可能数十秒，属正常初始化。边界：仅可识别会话目录及挂载目录（--add-dir）内的文件；会话外路径先请用户放入或挂载，勿盲目重试。',
  KnowledgeSearch: '在知识库做块级检索（本地索引）：可按语义+关键词命中到单个知识块，返回清单（空间/文件/标题/行号/分数/摘要 + 命中词）。mode=full 回整块原文；命中多时用 offset 翻页（回执末行给 total 与 nextOffset）。可 Read 的空间要用全文就 Read 对应文件行，其余只能 mode=full。spaces 限定空间；给 related=<blockId> 展开该条的**一跳**关联锚点。详见 `docs/tool-descriptions.md#knowledgesearch`。',
})

/**
 * 给 schema 列表应用描述预算。
 *
 * @param {Array<{name: string, description?: string, input_schema?: object}>} schemas
 * @param {{mode?: string, short?: Record<string, string>}} [opts]
 *   `mode`：`'full'` ⇒ **原样返回**（逐字节回到改动前，一行回退）；其余/缺省 ⇒ 紧凑版。
 * @returns {Array<{name: string, description?: string, input_schema?: object}>}
 */
export function applyToolDescriptionBudget(schemas, { mode = '', short = SHORT_TOOL_DESCRIPTIONS } = {}) {
  const list = Array.isArray(schemas) ? schemas : []
  if (mode === 'full') return list
  const out = list.map((s) => {
    const compact = short[s?.name]
    // ★ 没登记的工具**原样保留**（不做机械截断：切断在半句上比长描述更糟）
    return compact ? { ...s, description: compact } : s
  })
  // ★ 运行时护栏（不是只在测试里）：未登记工具的**原生描述**若超上限，这里出声一次。
  //   为什么这也算护栏：新增工具（或有人直接改 tools.mjs 把长散文加回来）时，测试会红，
  //   但**已部署的实例**不会重跑测试 —— stderr 这一行是它们唯一的现场提示。
  //   只在超限时说话（正常跑零输出），且不影响返回（不截断、不丢能力）。
  if (!descWarned) {
    const over = out
      .filter((s) => !short[s?.name])
      .map((s) => ({ name: String(s?.name || ''), len: String(s?.description || '').length }))
      .filter((x) => x.len > TOOL_DESC_MAX_CHARS)
    if (over.length > 0) {
      descWarned = true
      try {
        console.error(`[kernel] 工具描述超上限（未登记紧凑版）：${over.map((x) => `${x.name}(${x.len})`).join('、')} > ${TOOL_DESC_MAX_CHARS} 字 —— 请把长文移到 ${TOOL_DESC_DOC} 并在 kernel/tool-desc.mjs 登记紧凑版`)
      } catch { /* 埋点不得影响主流程 */ }
    }
  }
  return out
}

// ── T1.5（2026-10-20）：动态工具面**总预算**（防长尾）────────────────────────
//
// 问题（问0）：动态工具是三处**各管一段**的上限（工作流 `dyntools.LIMIT_DEFAULT=20`、
// app ≤40、MCP 各自 cap）⇒ 三者叠加没有天花板：20 个工作流 + 40 个 app + N 个 MCP
// 的 schema 全部进请求体，等于把"前缀面"重新撑回去（实测单条 schema 平均 ≈540 B）。
//
// ★ 本任务**默认关**（`PONOS_DYNAMIC_TOOL_BUDGET_BYTES` 未设 ⇒ 不裁剪），理由：
//   裁剪会让"能力可见性"下降（模型看不见的工具等于不存在），必须先观测"真实长尾有多长"
//   再决定默认值。这是 Global Constraint 7 的直接适用场景。
//
// ★ 裁剪规则（三条写死，都为防"把必需工具裁掉"）：
//   ① **静态工具永不被裁**（Read/Write/Edit/Bash/Grep/Glob 等是任务的地基，丢一个就废）；
//   ② 只裁**动态工具**，且按名字**稳定排序**后从尾部裁（同一输入必得同一结果 = 可复现，
//      不依赖 Map 插入顺序这种"看起来随机"的东西）；
//   ③ 裁掉的工具**必须回报**（`dropped` 列表）—— 静默消失会让模型"记得自己用过某工具"
//      却调不到，比一开始就不给更糟。
//
// ★ 未实现（诚实标注）：「保留最近使用」需要 per-tool 使用频次，数据源由 T0.3 的
//   `turn.toolCalls` 逐步积累；在拿到真实分布之前，按使用频次排序只会引入噪声。
//   现阶段用稳定字典序 —— 它至少是**确定**的。

/**
 * 按字节预算裁剪**动态工具**（静态工具原样保留）。
 *
 * @param {Array<object>} schemas 完整工具面
 * @param {{maxBytes?: number|null, isStatic?: (name: string) => boolean}} [opts]
 * @returns {{schemas: Array<object>, dropped: string[], bytesBefore: number, bytesAfter: number}}
 */
export function applyDynamicToolBudget(schemas, { maxBytes = null, isStatic = () => false } = {}) {
  const list = Array.isArray(schemas) ? schemas : []
  const bytesBefore = Buffer.byteLength(JSON.stringify(list), 'utf8')
  const cap = Number(maxBytes)
  // 预算未设/非法 ⇒ 原样返回（默认关：一行开关都没有就零行为变化）
  if (!(Number.isFinite(cap) && cap > 0)) return { schemas: list, dropped: [], bytesBefore, bytesAfter: bytesBefore }
  if (bytesBefore <= cap) return { schemas: list, dropped: [], bytesBefore, bytesAfter: bytesBefore }

  const statics = list.filter((s) => isStatic(s?.name))
  const dyn = list.filter((s) => !isStatic(s?.name))
  // ② 稳定排序（同名字典序）后从尾部裁 —— 结果可复现，不依赖输入顺序
  dyn.sort((a, b) => (String(a?.name) < String(b?.name) ? -1 : String(a?.name) > String(b?.name) ? 1 : 0))
  const kept = [...dyn]
  const dropped = []
  // 每次丢**最后一个**（字典序最大的那个），直到装进预算或动态工具丢光
  while (kept.length > 0 && Buffer.byteLength(JSON.stringify([...statics, ...kept]), 'utf8') > cap) {
    dropped.push(String(kept.pop()?.name || ''))
  }
  // 恢复成"静态在前、动态按原顺序"的稳定形态（下游对顺序无要求，但保持可预期）
  const keptSet = new Set(kept.map((s) => s?.name))
  const out = list.filter((s) => isStatic(s?.name) || keptSet.has(s?.name))
  return { schemas: out, dropped: dropped.filter(Boolean), bytesBefore, bytesAfter: Buffer.byteLength(JSON.stringify(out), 'utf8') }
}

// ── 2026-10-26：工具面预算的**按窗口推导**（本地小模型「首轮撑爆」的修复之二）──────
//
// 病灶（真实会话实测，非估算）：本地 Qwen3.8-27B / 128K 窗口 + lottiefiles-creator 一个
// MCP 服务器 = **110 个工具、约 380 KB schema**。首请求服务端计 103,650 token，其中
// **固定前缀（system + tools）约 101,000**，5 条对话消息只占 2,667 ⇒ 79% 的窗口被工具面
// 吃掉，只剩约 13K 给对话与工具结果 ⇒ 一两次工具调用就撞窗口。
//
// 而 T1.5 的总预算**默认关**（`PONOS_DYNAMIC_TOOL_BUDGET_BYTES` 未设 ⇒ 不裁）——理由在
// 当时是对的（"先观测长尾再定默认值"），但它把一个**与窗口无关**的开关留给了用户：
// 同一份 380 KB 在 1M 窗口上是 9.5%（可接受），在 128K 窗口上是 79%（直接不可用）。
// ⇒ 预算必须**随窗口缩放**，而不是要么全给要么靠人记得设 env。
//
// 三条设计纪律：
//   ① 默认**只按窗口推导**，env 显式值仍然优先（用户可覆盖，含调大）；
//   ② `window` 未知/非法 ⇒ 返回 null ⇒ **退回 T1.5 的"不裁"**（零行为变化；kit 门禁、
//      工作流节点、单测这些不传 window 的调用点因此逐字不变）；
//   ③ 比例与字节换算都是**可配**的（env），且默认值的来历写在下面，不留拍脑袋常数。
//
// 为何取 15% 而不是更小/更大：128K 窗口下 15% ≈ 19.6K token ≈ 69 KB，约能装 20 个
// 典型 MCP 工具或 110 个紧凑工具；剩下 85% 要同时容纳 system prompt（实测 15–25K token）、
// 对话历史与输出预算（local 档 maxOutputTokens=16384）。再大就重演本次事故，再小则
// "能装的工具数少于完成一件事所需"（MCP 工具常在单任务里用 3–8 个）。
export const TOOLS_BUDGET_WINDOW_RATIO = 0.15
/** JSON schema 的字节/token 近似：schema 几乎全是 ASCII 结构符与英文描述，实测 3.2–3.8 */
export const SCHEMA_BYTES_PER_TOKEN = 3.5
/** 下限：低于此值的预算等于"把动态工具全裁光"，不如不裁（交由上层显式配置） */
export const TOOLS_BUDGET_FLOOR_BYTES = 8192

/**
 * 按**上下文窗口**推导动态工具面字节预算。
 * @param {number|null|undefined} window 生效上下文窗口（token）；未知时返回 null = 不裁
 * @param {object} [env] 环境变量源（测试可注入）
 * @returns {number|null} 字节预算；null 表示"不设预算"（保持 T1.5 默认关）
 */
export function dynamicToolBudgetForWindow(window, env = process.env) {
  const w = Number(window)
  if (!Number.isFinite(w) || w <= 0) return null
  const ratioRaw = Number(env?.PONOS_TOOLS_BUDGET_WINDOW_RATIO)
  // 0 = 显式关闭按窗口推导（想保留"全量注入"的极端场景仍可退回去）。
  // ★ 必须先判 0 再回落默认值：写成 `ratio > 0 ? ratio : DEFAULT` 之后，0 会被
  //   静默当成"没配"⇒ 关闭开关失效（本仓"死代码 + 静默失效"的经典形态）。
  if (Number.isFinite(ratioRaw) && ratioRaw === 0) return null
  const ratio = Number.isFinite(ratioRaw) && ratioRaw > 0 ? ratioRaw : TOOLS_BUDGET_WINDOW_RATIO
  const bptRaw = Number(env?.PONOS_SCHEMA_BYTES_PER_TOKEN)
  const bpt = Number.isFinite(bptRaw) && bptRaw > 0 ? bptRaw : SCHEMA_BYTES_PER_TOKEN
  return Math.max(TOOLS_BUDGET_FLOOR_BYTES, Math.floor(w * ratio * bpt))
}
