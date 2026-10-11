'use strict'
// shared/egress-capability.cjs —— **出网能力闸**的唯一实现（E2 ①「客户数据安全」第一项）。
//
// ★★ 与 server/egress-policy.cjs#authorizeEgress 的分工（**勿混，两者并行不悖**）：
//   · `authorizeEgress` 的语义在它自己的模块头就明文限定为"**过团队源**"（把数据分享到团队知识空间/
//     团队工作流库供他人可见），并明确把"访问 LLM provider"排除在外 —— 它管的是**数据**能不能过团队源；
//   · 本模块管的是"**进程/工具能不能出网**"，按**能力类别**判定。故本模块**另建**，
//     `authorizeEgress` 一个字都不动（改它 = 混淆两个语义，且会让"团队源"的判据失去可解释性）。
//
// ★★ 默认姿态（本模块存在的全部意义）：**默认最严 + 显式放行 + fail-closed + 可审计**
//   · 未显式放行的能力一律拒绝（含宽松档；档位只记账、不绕过显式表）；
//   · **未知能力（拼错）也必须拒绝** —— 否则一个错别字就等价于放行；
//   · 判定返回 `{ allowed, reason, host-only audit }`：审计只留 host（丢弃查询串/路径/账号密码），
//     因为凭据常以 `?key=…`/`?token=…` 形态出现，**审计本身不能成为泄露通道**。
//
// ★★ 边界（**如实声明，勿高估**，D4）：本闸首版的定位是"**干道收口 + 显式放行 + 可审计**"。
//   设计上可拦、**且本任务已接线**：① 桥派生进程的 env 级出口 —— **两条路径同时**收口：
//   (a) `buildChildEnv` 未放行时先从 `process.env` 拷贝里**剔除**凭据类同名键（含启动器 env 带进来的），
//   (b) 清空内核 `settings.json` 里那份兜底凭据；凭据名集合**只从** `shared/legacy-env.mjs#credentialEnvKeys`
//   派生（主名 ∪ 由 `legacyNamesOf` 派生的旧名（当前为 `ANTHROPIC_*`）∪ `PONOS_API_KEY` 本体 ∪ 视觉双前缀名）——
//   修复轮 R=1 前的病灶是"只清主名"，而内核会把旧名映射回主名 ⇒ **未放行档下仍能带凭据出网**；
//   ② 桥自身出网（provider 探测 / /test-provider / 标题生成 / 知识包市场）；
//   ③ 主进程出网（联网检索 / 模型调用 / 后台取页面素材 / 应用接口直调 —— E2 Task 2 已接线，入口
//   `electron/app-egress.cjs`，判据仍是本模块，不另写一份）。
//   设计上可拦、**当前尚未接线**：⑤ 内核工具 SkillSearch 抓技能市场；⑥ 内核 `providers.json`
//   注册表播种（**2026-09-27 已接线**，见下方条目）；④ Chromium 轨（**2026-09-27 已接线**：
//   只闸 agent 驱动分区的数据外发形态，见下方条目）。逐条理由见下方 `EGRESS_BOUNDARY.canBlock`，
//   那里是**唯一**的接线状态清单）。**未接线 = 现在拦不住**，不许读成已生效。
//   ★ 覆盖面（2026-09-27 起）：工作流 `http` 节点的「访问网络」开关**覆盖所有触发路径** ——
//   手动运行以 `grant.network` 为准；定时 / webhook / 自动触发 / 子流程等**无 grant 的入口默认拒绝**，
//   只有工作流声明 `permissions.network: true` 才放行（见 `EGRESS_BOUNDARY.canBlock` 同名条目；
//   修复前是"只覆盖手动运行"，2026-09-27 补上无 grant 判据并把两处文案一起改）。
//   **拦不住**：① Bash 等任意子进程直连 —— 本应用**没有命令过滤、没有网络隔离**，`curl https://any/`
//   不命中任何高危规则（★ 2026-09-27 起出网族命令会**触发审批 + 留痕**，但那只是抬高门槛，
//   别名/管道/脚本内硬编码照样绕过 —— 不许写成"Bash 出网被禁"）；② 脚本/工作流里硬编码 URL 的出网；③ 用户本机代理/转发端口（代理是**配置项**
//   不是**限制项**，`off` 档下更是一个变量都不注入）。要"硬拦"需要系统级手段（防火墙规则/网络命名空间），
//   登记为后续工作，**不在本版**。任何文档/注释/GUI 文案都不得把本闸说成"能拦住一切出网"。
//
// ★★ 威胁模型（避免后人高估收益）：**同用户进程本已互信** —— 任一同用户进程都能读
//   `config.json`/`settings.json` 与 `bridge-token`，故本模块**不**防同用户进程；它的收益在
//   "静态落盘与干道"这一层（明确哪些出口被判、判据可观测、审计可查）。若将来要防同用户进程，
//   须另立威胁模型（本模块不在那个范围内）。
//
// 为什么 CJS + ESM 转发层：与 `shared/proxy-config.cjs`（同目录同惯例）一致 —— `electron/main.cjs`
//   是 CJS（Task 2 的主进程轨要同步用它），`server/*.mjs` 是 ESM。CJS 唯一实现 + `.mjs` 转发层，
//   避免两侧各写一份判据（本仓明令禁止"同一判据两份实现"）。
//   ★ 与 `shared/browser-whitelist-host.cjs`、`server/bridge-token.cjs`、`server/egress-policy.cjs` 同构。

/**
 * 出网能力类别（六类，来自 plan §D3 对 26 条路径的实测归类）。
 * 新增类别必须同时给出"谁来接线"的落点，否则只是一个词条（登记而不接线 = 假机制）。
 */
const EGRESS_CAPABILITY = Object.freeze({
  PROVIDER: 'provider',   // 模型服务（内核模型调用 / 标题生成 / provider 探测 / vision / websearch）
  TEAM: 'team',           // 团队源（归 server/egress-policy.cjs#authorizeEgress 管，此处仅登记类别）
  WEB: 'web',             // 公网抓取（WebFetch / MCP HTTP / 工作流 http 节点 / 知识包市场 / 应用接口直调）
  SHELL: 'shell',         // 任意子进程（Bash / MCP stdio / hooks）
  BROWSER: 'browser',     // Chromium 轨（应用内浏览器 / 自动化分区）
  LOOPBACK: 'loopback',   // 仅本地（桥自身回环），**永远允许**
})

/**
 * 档位。★ **本版档位只记录、不改变判定**：唯一口径是显式放行表。
 * 为什么不做"宽松档自动放行某几类"：那等于**凭空造一条未经审批的默认放行道**（本轮要消灭的正是
 * "默认放行"），故首版刻意不实现，仅记账位供界面/审计区分来源。要放宽只能**显式写进放行表**。
 */
const CAPABILITY_MODES = Object.freeze({ STRICT: 'strict', LOOSE: 'loose' })

/** 拒绝/放行原因（稳定枚举）。测试与排障都依赖字面量，**改动即破坏契约**。 */
const EGRESS_REASONS = Object.freeze({
  EXPLICITLY_ALLOWED: 'explicitly-allowed',
  LOOPBACK: 'loopback',                       // 仅本地，不计出网
  UNKNOWN_CAPABILITY: 'unknown-capability',   // 白名单外（含拼错）—— fail-closed
  NOT_EXPLICITLY_ALLOWED: 'not-explicitly-allowed',
})

/** 放行清单的来源（稳定枚举）：显式声明 / **读不懂**（按最严） / 存量兜底。 */
const CAPABILITY_SOURCES = Object.freeze({
  EXPLICIT: 'config-explicit',
  INVALID: 'config-invalid',      // ★ 键存在但读不懂 ⇒ 视作 []（fail-closed，见 capabilitiesReadability）
  LEGACY: 'legacy-fallback',
})

/** 已知类别名集合。★ 类型显式标成 `Set<string>`：checkJs 会把 `Object.values(...)` 推成**字面量联合**，
 *  于是 `KNOWN.has(任意 string)` 在类型层就是错的（本闸的输入按设计就是"任意字符串"——拼错也要能判）。 */
const KNOWN = /** @type {Set<string>} */ (new Set(Object.values(EGRESS_CAPABILITY)))

/**
 * ★ **存量兜底放行清单**（= "不知道时怎么兜"，与 `server/approval-mode.mjs` 的
 *   `DEFAULT_APPROVAL_MODE` 同款语义）。
 *
 * 为什么需要它：`config.json` 在**本项落地之前就已经存在**（存量用户的文件里没有
 * `network.capabilities` 这个键）。若"键缺失"按最严处理，所有存量用户升级后**内核立刻拿不到
 * provider 凭据**（模型不可用）、标题生成与 provider 探测全失败 —— 那是"升级即坏"，不是安全。
 * 故缺失 ⇒ 按**本项落地前的实际行为**兜底：provider（模型调用）、web、browser、shell 都放行。
 * ⇒ **存量零变化**（逐字等于升级前的行为）。
 *
 * `team` **刻意不在此表**：团队源出网归 `authorizeEgress` 管（本模块只登记类别、不接线），
 * 放进兜底表会让人以为"本闸在管团队源"。
 */
const DEFAULT_CAPABILITIES = Object.freeze(['provider', 'web', 'browser', 'shell'])

/**
 * ★ **新装放行清单**（= "新装给什么"，与 `NEW_INSTALL_APPROVAL_MODE` 同款语义，刻意与上一条分离）。
 *
 * 形状 = **"最严且可用"的最小集**，只有 `provider` 一项，理由两条：
 *   ① 不注入 provider 凭据 ⇒ 内核连模型都调不到 ⇒ **应用核心功能不可用**（不是"更安全的默认"，
 *      而是"装好就是坏的"）。这与 `NEW_INSTALL_APPROVAL_MODE='auto'` 的取舍同构 —— 那里也是
 *      "新装最严**但可用**"（只读与普通 Bash 仍自动，写文件/出网/子 agent 才问）；
 *   ② web/browser/shell 一律**需显式放行**：它们各自都有"不经显式同意就把数据或命令发出去"的形态
 *      （公网抓取、Chromium 轨、任意子进程），新装即拦。
 * ★ 代价如实登记（不藏）：新装下"知识包市场"（走 web）需显式放行 `web` 才可用；本任务只交付
 *   `config.json` 的显式放行 + 只读端点，**GUI 开关未在本任务范围**（见 task-1-report 的遗留项）。
 */
const NEW_INSTALL_CAPABILITIES = Object.freeze(['provider'])

/**
 * 归一放行表：只留**已知**类别名、去重、保持书写顺序。
 * 拼错的条目**被丢弃**（丢弃 = 不放行，fail-closed；不会因为表里有个错字就多放行一类）。
 */
function normalizeCapabilities(v) {
  const out = []
  for (const item of Array.isArray(v) ? v : []) {
    const s = typeof item === 'string' ? item.trim() : ''
    if (!s || !KNOWN.has(s) || out.includes(s)) continue
    out.push(s)
  }
  return out
}

/**
 * 这张放行表**读不读得懂**？三态（**唯一实现**，`capabilitiesOf` 与 `capabilitiesSource` 同源）。
 *
 * ★ 为什么必须有第三态 `config-invalid`（审查实测缺陷，2026-09-26 修复轮 R=1）：
 *   修复前判据只有"是不是数组"一个分支 —— `capabilities: "provider"`（字符串）**键在、类型非法**，
 *   却落进"键缺失"的兜底分支 ⇒ 生效清单变成 `['provider','web','browser','shell']`，
 *   **比用户写的意图更宽**。这直接违反 Global Constraints 的"读不到/判不了**不得**当成放行"
 *   （也违反本模块的"默认最严"）：手滑写错一个引号就把闸开得比不写还大。
 *   ⇒ 键存在但**不是字符串数组**时按**最严**处理（视作 `[]`，一个都不放行），并让来源可辨识。
 *
 * 判据（逐条）：
 *   · `network` 缺失/为 null            ⇒ `legacy-fallback`（存量文件形态：本项落地前没有这个键）
 *   · `network` 存在但**不是普通对象**  ⇒ `config-invalid`（读不懂这张表 ⇒ 最严）
 *   · 普通对象但**没有** `capabilities` 键 ⇒ `legacy-fallback`（存量）
 *   · 该键存在且是**全字符串**数组      ⇒ `config-explicit`（哪怕 `[]` = "一个都不放行"的明确意志）
 *   · 该键存在但**不是数组或含非字符串元素** ⇒ `config-invalid`（视作 `[]`；见下）
 *
 * ★ 元素"非法"的口径（刻意分两类，避免把"拼错"与"类型错"混为一谈）：
 *   · **类型非法**（非字符串元素，如 `['provider', 42]`）⇒ `config-invalid` ⇒ 整表视作 `[]`。
 *     理由：混进非字符串元素 = 这张表不是本闸期待的形状，读不懂的部分**不得**当成放行；
 *     且"整表读不懂"比"丢掉坏元素后照旧用剩下的"更保守（后者要靠人逐条判断哪些可信）。
 *   · **拼错的字符串**（如 `['provder']`）⇒ 归一时**丢弃**（`normalizeCapabilities`），
 *     来源仍是 `config-explicit`、值里没有它 ⇒ **丢弃 = 不放行**（fail-closed，比用户意图更严）。
 *     丢弃项要**出声**（端点回 `dropped`，桥打日志），不许静默。
 */
function capabilitiesReadability(network) {
  if (network == null) return CAPABILITY_SOURCES.LEGACY
  if (typeof network !== 'object' || Array.isArray(network)) return CAPABILITY_SOURCES.INVALID
  if (!('capabilities' in network)) return CAPABILITY_SOURCES.LEGACY
  const v = network.capabilities
  if (!Array.isArray(v)) return CAPABILITY_SOURCES.INVALID
  for (const item of v) if (typeof item !== 'string') return CAPABILITY_SOURCES.INVALID
  return CAPABILITY_SOURCES.EXPLICIT
}

/**
 * 从 `config.json` 的 `network` 段解析**生效的放行清单**（唯一入口，谁都不许自己再写一份）。
 * 语义：**显式声明优先**（哪怕是空数组 `[]` —— 那是"一个都不放行"的明确意志）；
 * 键缺失（本项落地前的存量文件）⇒ 存量兜底清单；**读不懂 ⇒ 最严（`[]`）**，见 `capabilitiesReadability`。
 */
function capabilitiesOf(network) {
  const read = capabilitiesReadability(network)
  if (read === CAPABILITY_SOURCES.EXPLICIT) return normalizeCapabilities(network.capabilities)
  if (read === CAPABILITY_SOURCES.INVALID) return []
  return [...DEFAULT_CAPABILITIES]
}

/** 放行清单的来源（只读端点/排障用）：`config-explicit` | `config-invalid` | `legacy-fallback`。 */
function capabilitiesSource(network) {
  return capabilitiesReadability(network)
}

/** 被归一丢弃的条目（拼错的字符串/空串；端点与日志据此**出声**，不是静默）。 */
function droppedCapabilities(network) {
  if (capabilitiesReadability(network) !== CAPABILITY_SOURCES.EXPLICIT) return []
  const kept = new Set(normalizeCapabilities(network.capabilities))
  const out = []
  for (const item of network.capabilities) {
    const s = typeof item === 'string' ? item.trim() : ''
    if (!s || !KNOWN.has(s) || kept.has(s)) continue
    if (!out.includes(s)) out.push(s)
  }
  return out
}

/**
 * 边界声明（**只在新增的只读端点 `GET /egress/capability` 里回给界面/文档**）。
 * ★ 放成常量而不是散在各处的文案：只写一份、改一处，避免"文档说 A、端点说 B"。
 * ★ 措辞纪律：只声明**实测支持**的结论（见模块头 D4 的三条硬证据），**不许**把本闸说成"能拦住一切出网"。
 */
const EGRESS_BOUNDARY = Object.freeze({
  positioning: '干道收口 + 显式放行 + 可审计（首版）',
  // ★ 每条**必须以「已接线」/「尚未接线」开头**：这是"设计上可拦"与"现在真的拦得住"的唯一区分。
  //   没有这个前缀，界面/文档会把 Task 2 才接的轨（Chromium / 主进程）读成已经生效 —— 正是本仓
  //   反复出现的"注释说过头"（有先例）。`server/egress-capability-gate.test.mjs` 有断言钉住这一点。
  canBlock: Object.freeze([
    // ★ 修复轮 R=1 订正（原文案"覆盖面大于实际"，见报告 R=1 节）：
    //   原文案只说"不注入模型凭据 + 清空 settings.json 兜底"，听起来像"凭据一个都出不去"，
    //   而实现当时**只清了主名** —— 内核认旧名（`shared/legacy-env.mjs`）⇒ `ANTHROPIC_BASE_URL/
    //   AUTH_TOKEN/API_KEY` 与 `PONOS_API_KEY` 照样把凭据送进内核（审查实测 2 次命中）。
    //   修后清理集合由 `credentialEnvKeys()` 派生（主名 ∪ 旧名 ∪ PONOS_API_KEY 本体），文案
    //   如实写上"含哪些名字"，并附可复现的行为证据（`server/egress-capability-gate.test.mjs` 的 M3 用例）。
    '已接线：桥派生进程的 env 级出口（未放行 provider 时不注入模型凭据，并清空/剔除内核 settings.json 与'
      + '启动器 env 里那份兜底；凭据名集合由 shared/legacy-env.mjs#credentialEnvKeys 派生 —— '
      + '主名 ∪ 旧名（legacyNamesOf 派生，当前为 ANTHROPIC_*）∪ PONOS_API_KEY 本体 ∪ 视觉双前缀名 PONOS_VISION_*/YFW_VISION_*）',
    '已接线：桥自身出网（provider 探测 / /test-provider / 标题生成 / 知识包市场）',
    // ★ 2026-09-27 订正（**与 kernel-tests/workflow-network-grant.test.mjs 那条边界用例同批改**，
    //   两处一起改的纪律见该用例上方注释；遗留 B）：
    //   原文案是「**仅覆盖手动运行**」—— 那是修复轮 R=1 的**如实登记**（当时确实只有手动运行
    //   带 ctx.grant，而 grantDecision 首行 `if (!grant) return null` ⇒ 定时 / webhook / 子流程 /
    //   自动触发 / dyntools 这 5 条入口下这条判据**整条不生效**）。现在**补上了无 grant 的判据**，
    //   覆盖面从"仅手动运行"变为"**所有触发路径**"：
    //     · 有 grant（手动运行）：`grant.network` 仍是唯一判据（行为不变）；
    //     · 无 grant（无人值守入口）：网络**默认拒绝**，唯一放行依据 = 工作流自己声明
    //       `permissions.network: true`（由 kernel/workflow-engine.mjs#run 透传为 ctx.networkDeclared）
    //       —— 那些入口没有对话框可问，"工作流里写死的声明"是唯一可得的用户意志。
    //   另修一处**提权**：`execSubworkflow` 原先把父运行的授权整个丢掉（子流程 ctx.grant 为
    //   undefined ⇒ 比父流程还宽）；现继承父的**网络**授权。工具/写入两维不在本次范围（已登记）。
    '已接线：工作流 http 节点的「访问网络」约束（**所有触发路径**，kernel/workflow-nodes.mjs#execHttp）'
      + '—— 手动运行以 ctx.grant.network 为唯一判据；**无 grant 的无人值守入口（定时 / webhook / 自动触发 /'
      + ' 子流程）默认拒绝**，只有工作流声明 permissions.network: true 才放行（ctx.networkDeclared 透传）',
    // ★ 2026-09-27 **已接线**（用户裁决：只闸 agent 驱动分区 + 复用既有浏览器白名单）。
    //   落点：`electron/chromium-egress.cjs`（纯判定）+ `electron/main.cjs#installChromiumEgress`
    //   挂在既有 `app.on('session-created')` 上，用**同一个** `isUntrustedBridgeSession(...,
    //   UNTRUSTED_SESSION_PARTITION_PREFIXES)`（= `persist:automation-*`）限定作用面 ——
    //   与"桥令牌不得注入该分区"是同一判据（那处防窃密、此处防外发）。
    //   ★ 覆盖面（如实，勿读成"Chromium 出网被全面拦住"）：**只拦数据外发形态**的子资源
    //   （`xhr` / `fetch` / `websocket` / `ping`）到**白名单外** host —— 这正是导航级检查
    //   （`will-navigate` / `did-redirect-navigation`）管不到的绕过点；**渲染类子资源
    //   （script/stylesheet/image/font/media/subFrame）刻意不拦**，因为拦了会让白名单页面
    //   因第三方 CDN / 验证码 iframe 整页降级（申报站点普遍如此），且它们不承载"agent 读到的数据"。
    //   ⇒ **残余风险**：`<img>` beacon 形态的微量外发仍可行（要连它一起拦需把判据换成"除主框架外
    //   全部"，会显著牺牲可用性 ⇒ 属产品裁决，未做）。
    //   ★ 主框架导航**不在此轨判**：仍由 `browser-executor.cjs` 负责（能给出 `whitelist-blocked`
    //   可读错误并走既有审批流）—— 不抢它的活。
    //   ★ 为什么不用 `browser` 能力位：它进程级、无对话框，且 `browser` 不在
    //   `NEW_INSTALL_CAPABILITIES` ⇒ 一旦强制，**新装用户的内置浏览器与自动化抓取会整体失效**
    //   且无法自解。白名单是域名级、有用户同意（审批流 `whitelist:<domain>` 写 allow 数组），
    //   正是这一轨需要的同意单元。
    '已接线：Chromium 轨——**agent 驱动分区**（persist:automation-*）的数据外发闸'
      + '（electron/chromium-egress.cjs，判据=既有浏览器白名单 isWhitelisted）：拦 xhr/fetch/websocket/ping'
      + ' 到白名单外 host；渲染类子资源与主框架导航不在此轨（后者仍由 browser-executor 管）；'
      + '**用户自己开的浏览器窗口不受约束**（用户裁决）。残余：<img> beacon 形态的微量外发未覆盖',
    // ★ E2 Task 2 后订正（原文案把主进程整轨算作"尚未接线"，已过时）：主进程的四条干道已接线，
    //   判据与桥同源（唯一实现仍是 decideEgress，见 electron/app-egress.cjs）。
    '已接线：主进程出网（联网检索 / 模型调用 / 后台取页面素材 / 应用接口直调 —— 见 electron/app-egress.cjs，'
      + '判据与桥同源）',
    // ★ 2026-09-27 补登记（遗留 C，修"**低报**"）：Vision 的出网此前在 canBlock 里**一条都没有**
    //   （只在 EGRESS_CAPABILITY.PROVIDER 的枚举注释里出现过一次——枚举注释不是覆盖登记）。
    //   按本仓口径"低报也是缺陷"，这里显式登记它的实际防线与**边界**。
    '已接线：内核视觉工具 Vision 的 provider 出网（走 provider 能力）—— 未放行 provider 时桥不注入'
      + ' PONOS_VISION_*/YFW_VISION_*（见本表第 1 条的凭据名集合），kernel/media-tools.mjs:310 的'
      + ' `if (!base || !model || !token)` 因此在**发请求之前**返回「Vision 未配置」/降级本地 OCR'
      + ' ⇒ 取不到端点就不出网。★ 与第 1 条**同源**（env 级凭据剔除），不是独立判据：'
      + '若将来出现"无需凭据也能出网"的视觉路径，此条必须重判',
    '尚未接线：内核工具 SkillSearch 抓技能市场（kernel/skill-search.mjs:50 直连 HTTP，不经本闸）——'
      + '设计上可拦，登记为后续工作（审批档位上已归 net 类，manual/auto 档会询问）。'
      + '★ 它**刻意不在**工作流「访问网络」开关的覆盖内：`shared/egress-tools.mjs#EGRESS_WEB_TOOLS`'
      + ' 只收 WebFetch/WebSearch，而 `src/lib/workflowModel.test.ts` 把"NET 必须**严格**包含 WEB"'
      + ' 锁成不变量（附注"Vision/SkillSearch 出网但不过 grant.network"）⇒ 要把它并进 WEB 名单，'
      + '得同时改那条锁定断言，属产品裁决，不是随手补一行（2026-09-27 已核，不做）',
    // ★ Task 1 复审 C-1 订正（"低报"）：上面那条"清空 settings.json + 不注入启动器 env"只覆盖**两条**
    //   凭据注入路径，而内核还有**第三条**：`<configDir>/providers.json` 的注册表播种
    //   （`kernel/cli.mjs` 的 `seedFromFile`）—— 该文件若存在，内核**照样能读到** model/apiBaseUrl/authToken。
    //   ⇒ 2026-09-27（遗留 C-⑥）**已接线**：不再"靠协议检测兜着"，直接在**播种这一步**判 ——
    //   未放行 provider 就**不播种**，凭据根本不进内核（`kernel/cli.mjs#providerCapabilityAllowed`，
    //   口径取自本模块的 `capabilitiesOf`，不另写判据）。
    //   存量零变化：`network` 键缺失时 `capabilitiesOf` 走 legacy 兜底（含 provider）⇒ 照旧播种；
    //   只有用户显式把 provider 排除、或放行表读不懂（按最严 `[]`）时才跳过，并打日志出声。
    //   ★ 2026-10-02（真机实测事故）同一处再补**第二前置：陈旧比对**：该文件的写入端已随凭据迁移
    //   **移除**、磁盘上的最后一份会**永久冻结** —— 只判"放行与否"接不住"放行了但文件是陈的"：
    //   照播会用数周前的端点/凭据**静默覆盖用户当下的选择**（实测：用户切到本地模型后，全部对话请求
    //   仍被发往文件里冻结的旧供应商，旧供应商账户欠费 ⇒ 连本地会话也返回 402）。
    //   现在播种前与 `config.json#activeProvider` 比对，不一致 ⇒ 视为化石**不播种**并出声
    //   （`kernel/provider.mjs#seedFromFile` 的 `expectActiveProvider`；任一侧缺值 ⇒ 无从比对 ⇒ 照旧播种）。
    '已接线：内核 <configDir>/providers.json 的注册表播种闸（kernel/cli.mjs#providerCapabilityAllowed）'
      + ' —— 未放行 provider 时**跳过播种**（凭据不进内核；此前只靠 kernel/api.mjs#detectProtocol 是'
      + '纯 env 判据才发不出去，属"一动协议检测即成洞"）。存量与新装默认清单均含 provider ⇒ 零变化。'
      + '★ 2026-10-02 增补**第二前置：陈旧比对** —— 该文件写入端已移除、磁盘上的最后一份会永久冻结，'
      + '播种前与 `config.json#activeProvider` 比对，不一致即视为化石**不播种**并出声（防数周前的'
      + '端点/凭据覆盖用户当下选择；实测事故：切到本地模型后请求仍发往冻结的旧供应商 ⇒ 402）。'
      + '任一侧缺值（裸跑内核 / 文件或配置缺键）⇒ 无从比对 ⇒ 照旧播种，裸机语义零变化',
  ]),
  cannotBlock: Object.freeze([
    // ★ 2026-09-27 修订（E2 ① 最后一条边界的处置，用户裁决"① 如实声明 + ② 审批式识别含留痕"）：
    //   原文案是"无命令过滤、无网络隔离，curl 一条命令即可出网"。现在**加了**出网族的审批 + 留痕，
    //   但**仍然拦不住** —— 两件事必须同时说清，否则读者会把"有审批"读成"有沙箱"：
    //     · 新增（②）：`shared/high-risk.mjs` 的出网族（curl/wget/ssh/scp/nc/Invoke-WebRequest…）
    //       命中即走**审批**（内核 `matchesHighRisk` → 问用户），桥侧同步留痕
    //       （`[bridge] egress-command 触发审批：rules=… hosts=…`，**只记 rule 与 host、不记命令原文**）。
    //     · 绕得开：别名 / `base64 -d | sh` / `node -e "fetch(…)"` / 脚本内硬编码 URL /
    //       `bash -c "curl …"`（引号内不匹配）—— 本族只是**抬高门槛**，不是命令过滤、更不是网络隔离。
    'Bash 等任意子进程直连（本应用**无命令过滤、无网络隔离** ⇒ 直连本身拦不住）；'
      + '2026-09-27 起对**出网族命令**加了一条审批 + 留痕（命中 curl/wget/ssh/scp/nc/Invoke-WebRequest 等'
      + '即要求用户批准，并在 app.log 记 rule 与 host —— 只记 host，不记命令原文）。'
      + '★ 这是**抬高门槛 + 可审计**，**不是沙箱**：别名、`base64 -d | sh`、`node -e "fetch(…)"`、'
      + '脚本内硬编码 URL、`bash -c "curl …"` 均可绕过',
    '脚本/工作流里硬编码 URL 的出网',
    '用户本机代理或转发端口（代理是配置项不是限制项）',
    '同用户进程互信范围内的读取（任一进程都能读 config.json / bridge-token）',
  ]),
  note: '★ 前缀含义：「已接线」= 本版真的拦得住；「尚未接线」= 设计上可拦但**现在拦不住**（不许读成已生效）。'
    + '「拦不住」那几条需要系统级手段（防火墙规则 / 网络命名空间），登记为后续工作，不在本版。',
})

/**
 * 审计形状：与 `server/egress-policy.cjs` 的 `audit` 同风格，**不含正文、不含凭据**。
 * ★ 只取 `URL#host`：同时丢掉 path / query / hash / 账号密码 —— 查询串里最常带 `key=`/`token=`，
 *   路径里也可能嵌凭据（`/v1/<token>/messages`）。
 */
function auditOf({ at, capability, target, mode, allowed, reason }) {
  let host = ''
  try { host = new URL(String(target == null ? '' : target)).host } catch { host = '' }
  return { at, capability, host, mode, allowed, reason }
}

/**
 * 出网判定（**唯一入口**）。判定顺序即优先级，逐条有据：
 *   1. `loopback` ⇒ 放行（不得把自己代理掉/拦掉自己的回环 —— 与 `shared/proxy-config.cjs` 的
 *      `LOOPBACK_BYPASS` 同一条纪律）
 *   2. 未知能力   ⇒ 拒（白名单式；**拼错不得等于放行**）
 *   3. 不在放行表 ⇒ 拒（"显式放行才可出网"）
 *   4. 其余       ⇒ 放行
 *
 * @param {object}   [o]
 * @param {string}   [o.capability] EGRESS_CAPABILITY 之一（未知一律拒）
 * @param {string}   [o.target]     目标（审计只留其 host）
 * @param {string}   [o.mode]     CAPABILITY_MODES（**只记录，不改变判定**，见 CAPABILITY_MODES 注释）
 * @param {string[]} [o.allow]    **显式放行清单**（唯一放行来源；缺省 = 空 = 一个都不放行）
 * @param {number}   [o.now]      注入时间（单测用；审计的 `at`）
 * @returns {{allowed:boolean, reason:string, audit:object}}
 */
function decideEgress({ capability, target, mode = CAPABILITY_MODES.STRICT, allow = [], now = Date.now() } = {}) {
  const at = new Date(now).toISOString()
  const mk = (allowed, reason) => ({ allowed, reason, audit: auditOf({ at, capability, target, mode, allowed, reason }) })

  if (capability === EGRESS_CAPABILITY.LOOPBACK) return mk(true, EGRESS_REASONS.LOOPBACK)
  if (!KNOWN.has(capability)) return mk(false, EGRESS_REASONS.UNKNOWN_CAPABILITY)
  if (!Array.isArray(allow) || !allow.includes(capability)) return mk(false, EGRESS_REASONS.NOT_EXPLICITLY_ALLOWED)
  return mk(true, EGRESS_REASONS.EXPLICITLY_ALLOWED)
}

module.exports = {
  EGRESS_CAPABILITY,
  CAPABILITY_MODES,
  EGRESS_REASONS,
  CAPABILITY_SOURCES,
  EGRESS_BOUNDARY,
  DEFAULT_CAPABILITIES,
  NEW_INSTALL_CAPABILITIES,
  normalizeCapabilities,
  capabilitiesOf,
  capabilitiesSource,
  droppedCapabilities,
  auditOf,
  decideEgress,
}
