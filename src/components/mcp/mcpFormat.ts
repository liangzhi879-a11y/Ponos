// src/components/mcp/mcpFormat.ts（2026-09-16 由 src/components/settings/mcpFormat.ts 迁入：
// MCP 从设置窗提升为第八 rail，纯逻辑随组件一起搬到 components/mcp/）
// MCP 面板的状态归并 + 授权档位/校验的纯函数（与 React / i18n 解耦，便于 node --test 直接断言）。
//
// 为什么单独抽出来：面板的核心判断是「哪几台能连上、各有哪些工具、失败原因是什么」。
// 这段逻辑若埋在 JSX 里就只能靠人眼看，无法回归；抽成纯函数后可精确断言
// （尤其「一台失败不影响另一台」这条——它是多服务器支持的关键契约）。
//
// 零依赖：不 import '@/...'，因为 node --test 走 Node 原生 TS，不认 vite alias。

export type McpToolInfo = { name: string; description?: string }

/** 传输类型：`stdio` = 本地子进程，`http` = 远程 Streamable HTTP */
export type McpTransport = 'stdio' | 'http'

/**
 * 面板用到的配置形状（与 `mcpApi.ts` 的 `McpServerConfig` 结构一致，但**不 import**——
 * 本模块零依赖：node --test 走 Node 原生 TS，不认 `@/` alias）。
 * 列全字段（而非只写 `url`）是刻意的：否则传字面量时 TS 会以"存在多余属性"报错，
 * 而调用点（测试、面板）本来就会连着 `command`/`args` 一起写。
 */
export type McpConfigLike = {
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string | null
  url?: string
  headers?: Record<string, string>
  timeoutMs?: number
  // ---- 授权与开关（2026-09-16 新增，与内核 camelCase 契约一致）----
  /** 显式 false = 关闭（内核不连接）；缺省/其它值 = 开启 */
  enabled?: boolean
  /** 授权档位；缺省（无该字段）= 存量配置 = public */
  expose?: McpExpose
}

/** 授权模式：与内核 `EXPOSE_MODES` 同值域（private = 仅测试 / public = 所有 agent / bound = 仅列出的 agent） */
export type ExposeMode = 'private' | 'public' | 'bound'
/** 界面档位：把 `enabled` 与 `expose.mode` 的四种组合收成用户能懂的四档 */
export type AuthLevel = 'off' | 'test' | 'public' | 'bound'
export type McpExpose = { mode?: ExposeMode; bindAgents?: string[] }

/**
 * 配置 → 界面档位（四档：关闭 / 仅测试 / 公开 / 指定 agent）。
 *
 * 缺省口径与内核 `mcpVisibilityOf` **一致且刻意**：没有 `expose` 字段 = 存量配置 = public。
 * 若这里缺省成 private，升级后所有 MCP 工具会突然消失，而界面显示"仅测试"——
 * 用户会以为是升级把配置改坏了。
 */
export function authLevelOf(cfg: McpConfigLike | null | undefined): AuthLevel {
  if (!cfg) return 'public'
  // 只认显式 false（与内核 normalizeEnabled 同规则）：'false'/0/缺省一律视为开启，
  // 否则一个手写的字符串 "false" 会在界面上显示成"关闭"，而内核那边其实连着。
  if (cfg.enabled === false) return 'off'
  const mode = cfg.expose?.mode || 'public'
  return mode === 'private' ? 'test' : mode
}

/**
 * 界面档位 → 配置。**保留 bindAgents 列表**：切走再切回时不必重选
 * （列表在非 bound 档不生效，留在配置里无害；而丢掉它会让用户在档位间犹豫时反复重填）。
 */
export function applyAuthLevel<T extends McpConfigLike>(cfg: T, level: AuthLevel): T {
  const list = Array.isArray(cfg?.expose?.bindAgents) ? cfg.expose.bindAgents : []
  if (level === 'off') return { ...cfg, enabled: false, expose: { mode: 'public', bindAgents: list } }
  if (level === 'test') return { ...cfg, enabled: true, expose: { mode: 'private', bindAgents: list } }
  if (level === 'bound') return { ...cfg, enabled: true, expose: { mode: 'bound', bindAgents: list } }
  return { ...cfg, enabled: true, expose: { mode: 'public', bindAgents: list } }
}

/**
 * 取出授权字段（只取**存在**的键）。
 *
 * 用途：`configForTransport` 与面板的读/写映射都要跨形态搬运这两个字段。
 * 不搬运的后果不是"少显示一个开关"，而是**静默的权限变更**——
 * 切一次传输就把用户的"指定 agent"重置回"公开"（权限扩大），或把"关闭"重置回"开启"
 * （以为关掉的服务器又连上了）。
 */
export function authFieldsOf(cfg: McpConfigLike | null | undefined): { enabled?: boolean; expose?: McpExpose } {
  const out: { enabled?: boolean; expose?: McpExpose } = {}
  if (cfg?.enabled !== undefined) out.enabled = cfg.enabled
  if (cfg?.expose !== undefined) out.expose = cfg.expose
  return out
}

/**
 * 该传输形态的必填字段是否已填：本地 = 命令，HTTP = URL。
 * `kind` 必须由调用方传入**编辑态**的传输类型（`Row.transport`），不能从 config 反推——
 * 反推会把"已选 HTTP 但 url 尚空"判成 stdio（详见 `configForTransport` 的注释）。
 */
export function requiredFilledOf(cfg: McpConfigLike | null | undefined, kind: McpTransport): boolean {
  return kind === 'http'
    ? Boolean(String(cfg?.url ?? '').trim())
    : Boolean(String(cfg?.command ?? '').trim())
}

/** 校验发现的第一个问题（kind 供界面映射 i18n 文案，msg 是给纯函数调用方的中文兜底文案） */
export type McpRowIssue =
  | { kind: 'dupName'; name: string; msg: string }
  | { kind: 'required'; name: string; transport: McpTransport; msg: string }
  | { kind: 'boundNoAgent'; name: string; msg: string }

/** 校验用的行模型（面板的 Row 结构；只声明校验读得到的字段） */
export type McpRowLike = { key: string; name: string; transport: McpTransport; config: McpConfigLike }

/**
 * 校验各行，返回**第一个**问题（null = 可保存）。规则只有四条，且**只拦必然无效的输入**：
 *   ① 名称必填（它是 servers 的键，空名字存进去就是一条无主配置）；
 *   ② 名称不可重复（重复项会被后写的那个静默覆盖，用户以为两台都在）；
 *   ③ 该传输的必填字段已填（stdio=命令 / HTTP=URL）——**但关闭的服务器跳过**：
 *      它连都不连，凭什么要求填命令？不跳过会让"先建卡片、稍后再填"的用户根本存不下去；
 *   ④ bound 必须至少选一个 agent —— 这是 fail-closed 的**界面侧对应**：
 *      内核读侧遇到空列表会让该服务器对所有人不可见（绝不退化成 public），
 *      与其保存后困惑"授权了却没生效"，不如保存时就报错。
 *
 * ⚠️ 已知跨层不一致（2026-09-16，实现者标注，需内核侧确认）：内核
 * `classifyMcpEntry`（kernel/mcp.mjs:65-70）**先于** `enabled` 判定执行，对
 * "既无 command 也无 url"的条目一律判非法 ⇒ ③ 跳过的代价是：用户把一张空卡片设为
 * 「关闭」后点保存，PUT 会被内核以 `服务器 "x" 缺少 command 或 url` 拒掉（400）。
 * 两条可能的收敛路径（都不在本任务范围内，需改内核或改本条规则）：
 *   a) 内核侧对 `enabled === false` 的条目放宽 classify（关闭的条目本就不连接）；
 *   b) 本规则改为"关闭时仍要求必填字段"，即维持改造前的行为。
 * 现状（跳过 + PUT 报错）至少**不会静默丢配置**：错误原文会显示在面板上并点名服务器。
 *
 * **重复名称优先于必填缺失**（沿用面板既有顺序）：两条同时存在时先提示更能解释全局的那条。
 * URL 是否可达、`${ENV_VAR}` 是否已定义属运行期事实，交给「连接测试」定论，不在此拦。
 *
 * 抽成纯函数而非留在 JSX 里：这条规则链一错就是"配置存不下/权限没生效"，而 JSX 无法回归。
 * 返回 `kind` 而非文案，是为了让面板能给出本地化文案（`validateRowsMsg` 只是中文兜底）。
 */
export function validateRowIssues(rows: McpRowLike[]): McpRowIssue | null {
  const names = rows.map(r => String(r.name || '').trim()).filter(Boolean)
  const dup = names.find((n, i) => names.indexOf(n) !== i)
  if (dup) return { kind: 'dupName', name: dup, msg: `服务器名称重复：${dup}` }

  for (const r of rows) {
    const name = String(r.name || '').trim()
    // 关闭的服务器没有必填项：跳过必填校验（名称仍要——没有名字就无从落盘）
    if (!name) return { kind: 'required', name, transport: r.transport, msg: '名称与命令均为必填' }
    if (authLevelOf(r.config) === 'off') continue
    if (!requiredFilledOf(r.config, r.transport)) {
      return r.transport === 'http'
        ? { kind: 'required', name, transport: r.transport, msg: 'URL 必填' }
        : { kind: 'required', name, transport: r.transport, msg: '名称与命令均为必填' }
    }
    if (authLevelOf(r.config) === 'bound' && !(r.config.expose?.bindAgents || []).length) {
      return {
        kind: 'boundNoAgent', name,
        msg: `服务器 "${name}" 指定了「仅特定 agent」，但一个 agent 都没选`,
      }
    }
  }
  return null
}

/** 校验行的中文文案版（无问题 = 空串）。面板用 `validateRowIssues` + i18n，本函数是纯函数兜底/测试入口。 */
export function validateRowsMsg(rows: McpRowLike[]): string {
  return validateRowIssues(rows)?.msg ?? ''
}

/**
 * 判定配置走哪种传输（面板据此决定渲染哪一组字段、"测试"按钮何时可用、
 * 以及切传输时清哪一侧的字段）。
 *
 * 口径只有一条：**有 `url` 就是 HTTP**。与内核 `classifyMcpEntry` 同源，
 * 但此处**不做校验**（`command` 与 `url` 并存时仍返回 `'http'`）——
 * 前端再实现一遍校验规则就会长出第二份会漂移的真源；
 * 非法组合由后端 `normalizeMcpServers` 返回 400 兜底，界面如实显示其原文即可。
 */
export function transportOf(config?: McpConfigLike | null): McpTransport {
  return String(config?.url ?? '').trim() ? 'http' : 'stdio'
}

/**
 * 切换传输类型时**重造配置对象** —— 即清掉另一侧的全部传输专属字段。
 *
 * 为什么必须清（而不是把另一侧字段留在对象里、只是不渲染）：后端把
 * 「command 与 url 并存」「args/env/cwd 配 url」「headers 配 command」一律判为非法并返回 400。
 * 字段若只是被 UI 藏起来，保存就会被拒，而界面上找不到任何可疑输入 —— 极难自诊。
 * `timeoutMs` 是两种传输共用的，必须显式保留：否则用户设过的超时会因切一次传输而莫名回到默认。
 * 代价：切走再切回会丢掉另一侧已填内容，属刻意取舍（重填成本低，而 400 无法自诊）。
 *
 * ⚠️ 返回的 HTTP 配置里 `url` 是**空串**，所以 `transportOf(结果)` 会得到 `'stdio'`。
 * 这正是「点『远程 HTTP』选不中」那个真实故障的来源：面板当时用 `transportOf(row.config)`
 * 反推当前传输类型，于是刚切到 HTTP 就被判回 stdio —— 判定"没变化"直接 return、
 * 高亮弹回、HTTP 表单也不渲染，用户看到的就是"点了没反应"。
 * 结论：**编辑态的传输类型必须另存**（`Row.transport`），不能从数据反推 ——
 * 空值状态表达不了"已选 HTTP 但还没填 URL"。
 */
export function configForTransport(config: McpConfigLike, kind: McpTransport): McpConfigLike {
  // 授权字段（enabled/expose）与传输**无关**，必须原样搬过去：切传输只该换"怎么连"，
  // 不该顺手把用户选的授权档位重置——那是一次**静默的权限变更**
  //（"指定 agent"被重置回"公开"= 权限扩大；"关闭"被重置回"开启"= 以为关掉的服务器又连上了）。
  const auth = authFieldsOf(config)
  return kind === 'http'
    ? { url: '', headers: {}, timeoutMs: config?.timeoutMs, ...auth }
    : { command: '', args: [], env: {}, timeoutMs: config?.timeoutMs, ...auth }
}

/**
 * 多行 `KEY=VALUE` 编辑器的**解析**（认证头与环境变量共用同一份规则）。
 *
 * 规则三条：① 只按**第一个** `=` 切分（值里可能有 `=`，如 base64 的 `==`）；
 * ② 键为空的行忽略；③ 还没敲到 `=` 的行忽略（半输入状态不该写进配置）。
 *
 * ⚠️ 第 ③ 条意味着**解析是有损的**：`parse('A')` 得到 `{}`。
 * 所以调用方**绝不能**把 `format(parse(text))` 直接当作 textarea 的受控值 ——
 * 用户每敲一个字符都会被抹掉，表现为"这个框一个字都打不进去，只能把整段粘进去"。
 * 正确接法是让编辑器自己留草稿，只在外部值真变了时才回灌（见 `nextDraft`）。
 */
export function parseKeyValueLines(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1)
  }
  return out
}

/** 反向：把 `KEY=VALUE` 对象写成多行文本（供编辑器回显） */
export function formatKeyValueLines(value: Record<string, string>): string {
  return Object.entries(value).map(([k, v]) => `${k}=${v}`).join('\n')
}

/**
 * 参数列表的多行编辑规则：一行一个参数，行首尾空白与空行忽略。
 * 同样**有损**：`parseArgLines('a\n')` 得到 `['a']` —— 尾随空行被吃掉，
 * 于是"把 `join('\n')` 当受控值"会让回车换行看起来毫无反应（同 `nextDraft` 的坑）。
 */
export function parseArgLines(text: string): string[] {
  return text.split('\n').map(s => s.trim()).filter(Boolean)
}

/** 反向：参数数组写成多行文本 */
export function formatArgLines(args: string[]): string {
  return args.join('\n')
}

/**
 * 多行编辑器的草稿同步决策：**只在外部文本真的变了时才回灌草稿**。
 *
 * 为什么需要它：这类编辑器的"值"是解析结果（对象/数组），而 `format(parse(text))` 有损
 * （见上面几个函数）。若把 `format(value)` 当受控值，用户敲下的半成品会被立刻抹掉：
 *   · env / headers：敲 "A"（还没到 `=`）→ 解析为空 → 受控值回到空串 → **一个字都打不进去**；
 *   · args：敲回车 → 尾随空行被过滤 → 受控值回退 → **回车"没反应"**，只能粘贴多行。
 * 所以草稿留在编辑器本地：`external === lastExternal` 说明这次变化是自己输入引起的回声，
 * 保留草稿；不等则说明是"重新读取 / 切换传输清空"这类真外部变化，才接受它。
 *
 * 做成纯函数是为了能直接断言"连敲一串字符草稿不丢"这条性质
 * （组件没有 DOM 测试环境，而这条性质恰恰是最容易写错、坏了却只表现为"输入框怪怪的"）。
 */
export function nextDraft(
  draft: string, external: string, lastExternal: string,
): { draft: string; lastExternal: string } {
  if (external === lastExternal) return { draft, lastExternal }
  return { draft: external, lastExternal: external }
}

/**
 * 保存按钮是否可用。
 *
 * `loadFailed` 时必须禁用 —— 这是一条真实的数据丢失路径：
 * 配置文件损坏时 `GET /mcp` 会返回 `ok:false` + `servers:{}`（后端**刻意用 200**，
 * 好让界面能把"这个文件读不出来 + 原因"画出来），界面于是拿到 rows = []；
 * 若此时仍允许保存，一次点击就会把空配置 PUT 回磁盘，**覆盖掉那份也许只是少了个括号、
 * 还能手工救回来的文件**。读不出当前状态就不允许写。
 *
 * 与后端"PUT 必须显式带 servers 字段，否则 400"是同一个考虑：
 * 别让"一次误发"把用户的全部服务器删掉。
 * 注意「文件不存在」不算失败（内核 `readMcpServers` 返回 `ok:true, servers:{}`），
 * 否则首次使用的人会被挡在保存之外。
 */
export function canSaveConfig(args: {
  rowCount: number
  validateMsg: string
  loadFailed: boolean
}): boolean {
  if (args.loadFailed) return false
  return args.rowCount === 0 || !args.validateMsg
}

/** 单台服务器最近一次连接测试的结果（未测试 = undefined） */
export type McpTestState = {
  running?: boolean
  ok?: boolean
  tools?: McpToolInfo[]
  error?: string
}

export type McpBadge = 'untested' | 'running' | 'ok' | 'failed'

/** 徽章状态：running 优先于 ok/failed（测试进行中不应显示上一次的结论） */
export function badgeOf(state?: McpTestState): McpBadge {
  if (!state) return 'untested'
  if (state.running) return 'running'
  return state.ok ? 'ok' : 'failed'
}

/** 仅当「已测且成功」才返回工具清单；否则一律空数组（防把上一次的清单当成本次结论） */
export function toolsOf(state?: McpTestState): McpToolInfo[] {
  if (!state || state.running || !state.ok) return []
  return Array.isArray(state.tools) ? state.tools : []
}

/** 仅当「已测且失败」才返回错误文案，供红字展示 */
export function errorOf(state?: McpTestState): string {
  if (!state || state.running || state.ok) return ''
  return String(state.error || '')
}

export type TestSummary = {
  total: number
  ok: number
  failed: number
  testing: number
  untested: number
  /** 全部有结论（无 running、无 untested）——用于「全部测试」按钮的忙碌态判定 */
  settled: boolean
}

/**
 * 汇总各台结果。
 * 注意 keys 传入的是「当前配置里的服务器」而非「测试记录里的」——
 * 用户删掉一台后，其残留记录不应再计入统计。
 */
export function summarize(keys: string[], tests: Record<string, McpTestState>): TestSummary {
  let ok = 0, failed = 0, testing = 0, untested = 0
  for (const k of keys) {
    switch (badgeOf(tests[k])) {
      case 'ok': ok++; break
      case 'failed': failed++; break
      case 'running': testing++; break
      default: untested++
    }
  }
  return { total: keys.length, ok, failed, testing, untested, settled: testing === 0 && untested === 0 }
}

/**
 * 汇总文案：如「2 通 · 1 失败」。全通时只显示「2 通」，不列 0 项以免噪声。
 * labels 由调用方从 i18n 取，本函数保持无 i18n 依赖。
 */
export function summaryText(
  s: TestSummary,
  labels: { ok: string; failed: string; testing: string; untested: string },
): string {
  const parts: string[] = []
  if (s.ok) parts.push(`${s.ok} ${labels.ok}`)
  if (s.failed) parts.push(`${s.failed} ${labels.failed}`)
  if (s.testing) parts.push(`${s.testing} ${labels.testing}`)
  if (s.untested) parts.push(`${s.untested} ${labels.untested}`)
  return parts.join(' · ')
}
