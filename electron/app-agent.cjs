// 应用智控：**自主探索式**生成框架（给 LLM 框架，而不是固定脚本）
//
// ★ 为什么要有这个模块（用户真实反馈驱动）：
//   「网站/应用的构造非常多样，如果你是用的固定脚本，LLM 参与度和自主度很低，那么可以肯定
//     完成不了普遍性任务。给 LLM 框架，让它自己去充分探索和调试测试。并对封装格式质量提出要求。」
//
//   原先的流程是**固定脚本**：`harvestSite()` 按写死的打分规则抓 6 页 → 一次性把素材丢给模型
//   → 让它一把写出所有命令 → 试跑 → 最多回喂修正两次。问题在于：
//     · 抓哪些页、抓几页由**我们的固定规则**决定，模型没有选择权 → 站点结构一变（多级菜单、
//       需要先搜索才能进详情、列表页要翻页…）就抓不到关键页面，模型只能凭猜 → 命令又少又漏。
//     · 模型看不到"试跑到底报什么错"的完整上下文，只能被动接受我们回喂的两轮摘要。
//
//   本模块把控制权交还给模型：给它一组**工具**（抓页面 / 列已抓页面 / 试跑命令 / 提交草稿），
//   让它自己决定看什么、看几遍、先写什么、怎么调试，直到自认为可以交付。我们只负责：
//     · 真实执行这些工具并把**真实结果/真实报错**原样回喂（驱动它自我纠错）；
//     · 守住安全边界（试跑只允许 read；write 绝不自动执行）；
//     · 用**封装质量门槛**卡住"能跑但没法用"的产物；
//     · 预算（轮数/工具次数/时间）兜底，并在预算耗尽时**如实**报告进展，绝不假装成功。
//
// ★ 与 app-generate.cjs 的分工：
//   app-generate 负责"契约与校验"（ACT_CONTRACT / validateSpecBasic / 一次成型式 generateSpec）
//   与本模块共用的提示词素材；本模块只负责**多轮工具驱动的编排**。两者都保持 callLlm/runTool
//   可注入，于是用假模型就能回归全部编排逻辑（不需要真网络、真模型）。
'use strict'

const { extractSpec, validateSpecBasic, actContractLines, driverOf, normalizeDriver, actsFor, SPEC_SHAPE_LINE } = require('./app-generate.cjs')

/**
 * 预算。用户明确"不要期望 llm 分析生成很快完成"，所以给得宽松——但要**有界**：
 * 无上限的循环会烧钱、会让界面看起来卡死。
 */
const DEFAULT_BUDGET = {
  maxTurns: 24,          // 最多 24 轮模型交互（含工具调用轮）
  maxToolCalls: 20,      // 最多 20 次真实工具调用（抓页面/试跑）
  timeBudgetMs: 10 * 60 * 1000,
  historyChars: 60000,   // 回喂给模型的历史上限（超出丢最早的探索结果，保留摘要）
  perToolChars: 5000,    // 单次工具结果进历史的字符上限
}

/** 占位语：产物里出现这些词就等于没写（用户拿到手完全不知道怎么用） */
const PLACEHOLDER = /(^|\s)(todo|fixme|tbd|待补充|待完善|待定|占位|示例|样例|xxx+|命令\s*\d+|param\d*|foo|bar)($|\s|[:：])/i
const isPlaceholder = (s) => PLACEHOLDER.test(String(s || '').trim())
const cjkLen = (s) => String(s || '').trim().length

/**
 * M3「可选执行后端」教义：告诉模型**这两条路存在、怎么写、边界在哪**。
 *
 * ★ 为什么必须写进提示词（而不是只放进契约表）：契约表管的是"写了能不能过校验"，
 *   提示词管的是"模型知不知道能这么写"。只改契约不改提示词，模型会继续写 browser + js
 *   （那是 M1/M2 阶段的唯一选择），能力清单里列出的 http/file 通道等于白列——
 *   这正是本任务"模型可见性"要解决的问题。
 * ★ ① 需要登录态的接口**不要走 http**（http 后端刻意不带 Cookie，写了也调不通）——
 *   这条对所有驱动都要说；但"改用什么"必须按驱动说：浏览器目标才提 `driver:"browser"` + js 步骤，
 *   **桌面目标绝不提**——runTool 对桌面驱动明确拒绝浏览器工具（"这是桌面应用，没有浏览器页面可浏览"），
 *   在桌面提示词里写浏览器方案只会让模型去调一个注定失败的东西
 *   （既有测试锁定：桌面提示词的 `agentToolDocs` 不含 browse/fetch 这套引导）。
 *   ② file 只读（系统不给模型任何写文件的口子，别去试）。
 * @param {boolean} isWeb 驱动是否为 browser
 */
const optionalDriverRules = (isWeb) => [
  '【可选执行后端（M3）：封装"接口级 / 数据级"能力时，把整份 Spec 的 driver 换成下面之一】',
  '· driver:"http" —— 主进程直调 HTTP 接口（steps.act 只能写 "request"，必填 "url"）。',
  '  **只能访问 target 同源的地址**；要调其它公开接口，必须在 Spec 里写 http.allowHosts:["api.example.com"]。',
  '  本机/内网地址会被拒绝，响应体有大小上限，**不会带 Cookie**。',
  ...(isWeb
    ? ['  ⇒ **需要登录态的接口不要用 http**：那种接口请用 driver:"browser" + {"act":"js"}（自带登录会话）。']
    : ['  ⇒ **需要登录态的接口不要用 http**：它拿不到浏览器的会话，请改用 CLI / 本地数据文件这条路。']),
  '· driver:"file" —— 主进程读本地文件（steps.act 只能写 "read" / "query"，必填 "path"）。',
  '  **只读**（没有任何写文件的 act）；路径必须在目标程序目录或其用户数据目录内，越界会被拒绝。',
  '  query 步骤用极简选择器只取需要的字段：{"act":"query","path":"…/project.json","select":"$.frames[*].name","save":"names"}。',
  '· 用不到这两条路就**不要**写（默认沿用探测出的 driver，例如 process 的 cli）。',
].join('\n')

/**
 * 模型每轮可用的工具说明（渲染进 system，字段名必须与 parseTurn/主进程 runTool 一致）。
 * 先归一化驱动再分支：生产 driver 值是 browser/process/script/uia，旧代码判 `driver === 'desktop'`
 * 在生产里永不成立（桌面应用拿到的会是浏览器那套工具说明）。
 * 抓页面/浏览/点击这一组只对 browser 有意义——主进程 runTool 对桌面驱动本来就明确拒绝它们
 * （"这是桌面应用，没有浏览器页面可浏览；请直接用 run_command 试跑或 submit_spec"），
 * 写进提示词只会误导模型去调一个注定失败的工具。
 */
function agentToolDocs(driver = 'browser') {
  const d = normalizeDriver(driver)
  const lines = [
    '【你可以调用的工具】每轮**只输出一个 JSON 对象**，不要输出解释性文字、不要输出多个对象：',
  ]
  if (d === 'browser') {
    lines.push(
      '· 抓取任意页面看结构（后台 HTTP 抓取，不会弹出窗口）。适合无需登录、静态渲染的页面：',
      '  {"thought":"为什么要抓它","tool":"fetch_page","args":{"url":"https://…"}}',
      '· 看你已经抓过哪些页面、有哪些线索（避免重复抓）：',
      '  {"thought":"…","tool":"list_pages","args":{}}',
      '· 用**真实浏览器**打开页面（不弹窗，但**会带上登录态**、能执行 JS）。当 HTTP 抓取只能看到登录页、',
      '  空壳页、或内容明显不全时，改用这个（返回快照，含每个可交互元素的 ref 编号）：',
      '  {"thought":"…","tool":"browse","args":{"url":"https://…"}}',
      '· 在当前页**点击**某个元素（按 ref 或按可见文字），用来展开菜单、翻页、进入列表/详情页：',
      '  {"thought":"…","tool":"click","args":{"ref":3}} 或 {"thought":"…","tool":"click","args":{"text":"下一页"}}',
      '  返回新页面的快照。**删除/支付/提交订单/退出登录这类破坏性按钮会被拒绝**，别试。',
      '· 返回上一页（配合 click 连续探索）：',
      '  {"thought":"…","tool":"back","args":{}}',
      '· **请求用户登录**：当你判断"要看的内容在登录之后"时用它——例如抓到的是登录页（有密码框）、',
      '  或页面内容明显缺少主要功能入口（只有空壳/提示登录）。系统会打开一个可见窗口请用户手动登录，',
      '  检测到登录成功后把**登录后的页面内容**回给你，你再继续探索：',
      '  {"thought":"…","tool":"request_login","args":{"reason":"为什么判断需要登录"}}',
    )
  } else {
    lines.push(
      '· **列目录**（只读）：用于找 scripts/ 扩展目录、数据与配置文件——桌面应用的可控入口常藏在程序目录里：',
      '  {"thought":"…","tool":"list_dir","args":{"path":"目录绝对路径"}}',
      '· **读文本文件**（只读、有字节上限、二进制会被拒绝）：用于看帮助文本、脚本示例、配置与数据格式：',
      '  {"thought":"…","tool":"read_file","args":{"path":"文件绝对路径","maxBytes":65536}}',
      '  两者都**只允许目标程序目录与其用户数据目录之内**；越界会返回明确的错误，照错误改正即可。',
    )
  }
  lines.push(
    '· **联网检索**：确认某个应用是否存在官方/开源 CLI 或 API（探测不到本机 CLI 时先查这里）。',
    '  ★ **本机探不到不等于没有**：很多应用自带 CLI/headless 模式，只是用户填错了路径或没装到 PATH。',
    '  下"无法接入"结论前**先联网确认一次**，确认确实没有再把结论写成"无法接入"：',
    '  {"thought":"…","tool":"web_search","args":{"query":"<应用名> CLI command line | headless | API"}}',
    '· 试跑你草稿里的某条命令，看真实结果或真实报错（**只允许 read 命令**；write 会被拒绝，因为那会真的改动用户的数据）：',
    '  {"thought":"…","tool":"run_command","args":{"action":"命令名","args":{}}}',
    '· 提交一版 Spec（系统会做结构校验 + 封装质量校验 + **真实试跑**，不通过就把具体问题回给你继续改）：',
    '  {"thought":"…","tool":"submit_spec","spec":{…完整 Spec…}}',
  )
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// 用户需求（M1）
// ---------------------------------------------------------------------------
//
// ★ 为什么需要：001 只生成 4 条、用户"不满足要求"的根因之一，是需求**从未进入生成链路**——
//   提示词里只有 `目标：{"type":"web","url":…}`，模型不知道用户想要什么覆盖度，
//   只能按站点表层结构给几条。需求段以"覆盖度硬约束"的口吻给出，并允许模型如实说明做不到。

const REQUIREMENT_MAX_CHARS = 2000
const REQUIREMENT_MAX_ITEMS = 40

/**
 * 归一化需求：字符串/数组都接受，去空、去重、截断。
 * @param {string|string[]|null|undefined} requirement
 * @returns {string[]}
 */
function normalizeRequirement(requirement) {
  const raw = Array.isArray(requirement) ? requirement : [requirement]
  const out = []
  for (const item of raw) {
    if (item == null) continue
    const text = String(item).trim().slice(0, REQUIREMENT_MAX_CHARS)
    if (!text || out.includes(text)) continue
    out.push(text)
    if (out.length >= REQUIREMENT_MAX_ITEMS) break
  }
  return out
}

/**
 * 需求段。★ 无需求时返回空串：保证"没填需求"的既有调用方拿到的提示词与改动前**逐字一致**，
 * 不因为这次改动改变老应用的重生成行为。
 * @returns {string}
 */
function requirementLines(requirement) {
  const list = normalizeRequirement(requirement)
  if (!list.length) return ''
  return [
    '【用户需求】（作为**覆盖度硬约束**：需求里点到的每一项能力都必须有对应命令；',
    '确实做不到的写进 spec.notes 说明原因，不要装作支持）',
    ...list.map((t, i) => `  ${i + 1}. ${t}`),
  ].join('\n')
}

/**
 * 明显是破坏性动作的按钮文字。**为什么必须有这道闸**：用户允许了"自动点击/翻页探索"，
 * 但"探索"不等于"可以替用户删数据/下单"。模型看到一个写着「删除」的按钮时不该去点。
 * 只挡最危险的几类（删除/清空/退出/支付/下单…），不追求穷尽——过宽会误伤正常导航。
 */
const DESTRUCTIVE_LABEL = /(删除|清除|清空|移除|注销|退出登录|退出|解绑|取消订阅|退订|支付|付款|下单|购买|结算|提交订单|确认收货|退款|delete|remove|clear|logout|sign out|signout|unsubscribe|pay|purchase|checkout|place order|refund)/i

function isDestructiveLabel(label) {
  return DESTRUCTIVE_LABEL.test(String(label || ''))
}

/**
 * 把 `{ref}` 或 `{text}` 解析成快照里那个可交互元素。
 * 为什么两种都要支持：ref 精准但会随页面变化失效（模型容易拿旧快照的编号）；文字模糊但稳定，
 * 模型读素材后往往记得"有个叫下一页的链接"。两者都给，命中不了就如实报错并**列出可选目标**，
 * 让模型能自己纠正（比笼统的"元素不存在"有用得多）。
 * @returns {{ok:true, target:object}|{ok:false, error:string}}
 */
function resolveClickTarget(interactives, { ref, text } = {}) {
  const list = Array.isArray(interactives) ? interactives : []
  if (list.length === 0) return { ok: false, error: '当前页面快照里没有任何可交互元素（可能还没 browse 过，或页面是空壳）' }
  if (ref !== undefined && ref !== null && ref !== '') {
    const n = Number(ref)
    const hit = list.find((x) => Number(x?.ref) === n)
    if (!hit) {
      const sample = list.slice(0, 12).map((x) => `${x.ref}:${String(x.label || x.tag || '').slice(0, 14)}`).join('、')
      return { ok: false, error: `快照里没有 ref=${ref} 的元素。当前可选：${sample}（每张新快照的编号都会重排，请用最新一次 browse/click 返回的编号）` }
    }
    return { ok: true, target: hit }
  }
  const want = String(text || '').trim()
  if (!want) return { ok: false, error: '要给出 ref（快照编号）或 text（元素上的可见文字）' }
  const lower = want.toLowerCase()
  const exact = list.filter((x) => String(x?.label || '').trim().toLowerCase() === lower)
  const fuzzy = list.filter((x) => String(x?.label || '').toLowerCase().includes(lower))
  const hit = exact[0] || fuzzy[0]
  if (!hit) {
    const sample = list.slice(0, 12).map((x) => `${x.ref}:${String(x.label || x.tag || '').slice(0, 14)}`).join('、')
    return { ok: false, error: `页面上没有文字含「${want}」的可点击元素。当前可选：${sample}` }
  }
  return { ok: true, target: hit }
}

/**
 * 系统提示词：工具协议 + 探索策略 + **封装质量门槛**。
 *
 * 质量要求的依据（不是凭空拔高）：命令最终会被 kernel/app-tools.mjs 变成一个工具，模型在对话里
 * 能看到的只有两个字段 —— `description = "[应用名] " + cmd.title` 和 `input_schema`（由
 * `cmd.params[].desc` 生成）。所以 title 与 params[].desc 写得潦草，这个工具就等于废掉：
 * 模型不知道它干什么、也不知道参数该填什么。
 */
function buildAgentSystem({ target, driver = 'browser', requirement, surfaceLines } = {}) {
  // 驱动必须走唯一真源推定：生产值是 browser/process/script/uia，旧代码判 `driver === 'desktop'`
  // 在生产里永不成立 → 给桌面应用下发 web act 清单 → 模型写出的 Spec 被校验全拒（D2 真实故障）。
  const d = driverOf({ driver, target }, { targetType: target?.type })
  const acts = actsFor(d)
  const isWeb = d === 'browser'
  // 需求段：无需求时是空串，展开后不产生任何元素 → 提示词与改动前逐字一致
  const req = requirementLines(requirement)
  // 能力清单（探测产出）：模型据此"从最有把握的通道开始封装"。空串同样不产生任何元素。
  const surface = surfaceLines ? String(surfaceLines) : ''
  return [
    '你是「应用即工具」的规格工程师。你的任务**不是**一次成型地写出一份 Spec，而是像一个真正的',
    '工程师那样工作：**先自主探索目标，再写草稿，再真实试跑，根据真实报错反复调试，直到全部通过**。',
    '',
    `目标：${JSON.stringify(target || {})}`,
    `驱动：${d}（${isWeb ? '网站：命令走浏览器自动化' : '桌面应用：命令走本机 CLI / 脚本接口'}）`,
    '',
    ...(req ? [req, ''] : []),
    ...(surface ? [surface, ''] : []),     // ← 清单紧随需求：模型据此"从最有把握的通道开始试"
    optionalDriverRules(isWeb),            // ← 清单告诉它"有哪些路"，这段告诉它"路怎么写"
    '',
    agentToolDocs(d),
    '',
    '【工作方式（强烈建议遵循）】',
    ...(isWeb ? [
      '1) 先探索：至少用 fetch_page 看清楚主要功能入口（导航、列表页、表单、详情页）。',
      '   抓哪些页面**由你自己判断**——不要只抓首页。多级入口、需要先搜索/筛选才能到达的页面，',
      '   都值得抓一次；必要时反复抓、抓更多。list_pages 可以帮你避免重复。',
      '2) **页面抓不到内容时不要放弃**：HTTP 抓取看不到 JS 渲染的内容，也看不到登录后的页面。',
      '   这时候改用 browse（真实浏览器 + 登录态）打开它；如果页面里的入口**需要点击**才能展开',
      '   （折叠菜单、列表翻页、"下一页"、进入详情），就用 click 点进去再看快照。',
      '   探索完一个分支可以用 back 退回来继续看别的入口。用户允许你做这类探索性点击，',
      '   但**不要点删除/支付/提交订单/退出登录这类破坏性按钮**（会被系统拒绝）。',
      '2.2) **优先做「接口级」封装**：只读页面文本是下策——调用方拿到的是一坨文字，取不了数也存不了库。',
      '      多数站点的数据来自它自己的 JSON 接口：用 {"act":"js","expression":"await fetch(\'/x/list?page=1\').then(r=>r.json())"}',
      '      这类步骤直接取数/提交（js 支持 async，可以 await），返回的就是结构化数据，而且**自带登录态**。',
      '      接口线索就在你手里的素材里（表单的 action、页面脚本里的接口路径、按钮的 data-* 属性）；',
      '      必要时用 browse 打开页面点一次功能，再看素材里的真实路径。',
      '      只有「确实没有可用接口」或「必须渲染后内容」时才用 goto+snapshot 这种页面形态。',
      '2.5) **抓到登录页不要硬猜、也不要反复抓同一个页面**：说明该站点需要登录 → 调 request_login',
      '     请用户登录，用户登录后系统会把登录后的内容回给你（HTTP 抓取永远看不到登录后的内容，',
      '     必要时改用 browse 看登录后的真实页面）。',
      '3) 再写草稿：用 submit_spec 提交。第一版不要求完美——它会被真实试跑，报错会原样回给你。',
      '4) 然后调试：根据回给你的**真实报错**修改。你可以用 run_command 单独试跑某条命令快速验证，',
      '   也可以用 fetch_page / browse 再看一眼页面结构（比如确认某个按钮的位置、表单字段名）。',
      '5) 反复做到：试跑全部通过、且命令覆盖了目标的主要功能入口。',
    ] : [
      '1) **先读帮助**：用 run_command 跑 `<程序> --help`（无输出就试 -h、--version、/?）。',
      '   帮助里列出的开关就是可封装的命令来源，**不要凭记忆猜**某个程序有什么参数。',
      '2) **再列目录**：用 list_dir 看程序目录（找 scripts/、插件目录、数据与配置文件），',
      '   用 read_file 抽样看格式（脚本示例、配置、导出数据）。只读，不会改动用户的东西。',
      '3) **联网确认**：用 web_search 查「<应用名> CLI / command line / headless / API」。',
      '   很多原生应用本身没带 CLI，但官方或社区**有**（这一点本机探测不出来）。',
      '4) **优先做「接口级 / 数据级」封装**：能调 CLI 就不要走界面；能读写数据文件就不要模拟点击。',
      '   探到的接口路径、数据格式、脚本 API 都比 UI 自动化稳，也更容易被复现。',
      '5) 然后写草稿：用 submit_spec 提交。第一版不要求完美——它会被真实试跑，报错会原样回给你。',
      '6) 再调试：根据回给你的**真实报错**修改，可用 run_command 单独试跑验证。',
      '7) 真的没有可控路径时：**如实**在 spec.notes 说明"未发现可用接口及其原因"，',
      '   并尽量少提交命令——**不要硬凑**命令来凑数（凑出来的命令会在真实试跑里失败）。',
    ]),
    '',
    '【封装质量要求（不达标会被打回，请一次就写好）】',
    '将来调用这些命令的模型，只能看到「命令标题」和「参数说明」两样东西。所以：',
    '· action：英文小驼峰、动词开头、全局唯一、≤40 字符（例：listOrders、getOrderById）。',
    '· title：能独立看懂的动作短语，2~20 字（例「查询待办列表」「按订单号查详情」）。',
    '  禁止「命令1」「示例」「TODO」「待补充」这类占位语——那等于没写。',
    '· params[].desc：说清「填什么、什么格式」（例「订单号，形如 SO20250101-001」），≥6 字，',
    '  同样禁止占位语；required 必须明确写 true/false；没有参数就写 params:[]。',
    `· returns：read 命令必须说明返回什么，形如 {"type":"text|json","from":"保存键名"}，且 steps 里确实有对应输出${isWeb ? '（web：snapshot 步骤的 save 键名，或 js 表达式的返回值）' : '（桌面：cli / script 步骤用 save:"键名" 保存的输出）'}。`,
    '· 查询命令的 returns：优先 {"type":"json","from":"<save 键名>"}（接口级返回结构化数据）；',
    '  只有页面形态的命令才用 "text"。',
    '· 覆盖度：命令要覆盖你探索到的主要功能入口（不同页面/不同表单/不同查询都算），',
    '  不要只写首页能做的事。查询类命令（kind:"read"）至少 2 条，其中至少 1 条**不需要参数**。',
    '· kind：只读/查询/导出/查看 → "read"；提交/保存/修改/删除/发送 → "write"；拿不准按 "write"。',
    '',
    '【硬约束】',
    `· steps.act 只能取：${acts.join(', ')}。`,
    actContractLines(d),
    // ref/选择器这套只对浏览器执行器成立：桌面驱动的 act（cli/script/focus/type/key/wait）没有元素编号概念
    ...(isWeb ? [
      '· click/type/select/hover 要的是 **ref（快照里的元素编号）**，不是 CSS 选择器；',
      '  ref 必须由**同一条命令内前一步的 snapshot** 产生（编号每次快照都会变）。拿不准就改用 js 表达式。',
    ] : []),
    '· 命令参数插值固定写 ${参数名}。',
    '· expose.mode 固定写 "console"（禁止 "public"）。',
    '· 绝不写入口令、令牌、密钥、身份证号等敏感信息。',
    '· 绝不设计"删除/清空/批量修改"这类破坏性命令，除非用户目标明确要求（那种情况 kind 必须是 write）。',
    '',
    '【输出格式（缺一不可，漏写会被结构校验直接打回）】',
    SPEC_SHAPE_LINE,
    `其中 target 用 ${isWeb ? '{"type":"web","url":"..."}' : '{"type":"desktop","exePath":"..."}'}，expose.mode 固定 "console"。`,
    'commands 是数组、至少 1 条；每条必须有 action（英文小驼峰、唯一）、title、kind、params（数组）、steps。',
    '',
    '只输出 JSON 本体。现在开始按上面的方式工作。',
  ].join('\n')
}

/** 首轮 user：把"已经拿到的种子素材 + 预算 + 现状"交代清楚，让模型从探索开始 */
function buildAgentSeed({ target, driver, probeMode, probeMaterial, seedSummary, budget, requirement, surfaceLines } = {}) {
  const parts = []
  parts.push(`目标：${JSON.stringify(target || {})}`)
  parts.push(`驱动：${driver}`)
  const req = requirementLines(requirement)
  if (req) parts.push(req)          // ★ 首轮就要看见需求：否则模型第一轮抓的页面全凭猜测
  const surface = surfaceLines ? String(surfaceLines) : ''
  if (surface) parts.push(surface)  // ★ 探索起点也要在第一轮就到位（空串时不新增元素 → 逐字不变）
  const parts2 = []
  if (seedSummary) parts2.push(`【系统预取的初始素材】\n${seedSummary}`)
  if (probeMaterial && probeMode && probeMode !== 'none') {
    parts2.push(`【初始素材明细（JSON，可能不完整——你可以继续抓页面补全）】\n${JSON.stringify(probeMaterial).slice(0, 12000)}`)
  } else if (probeMode === 'none') {
    parts2.push('【系统没能预取到素材】可能是登录后才可见、纯前端渲染或抓取被拒。你可以用 fetch_page 自己再试；若确实抓不到，就基于公开常识写**保守**的命令（优先「导航 + snapshot」这类不依赖具体选择器的写法），并如实说明。')
  }
  parts.push(parts2.join('\n\n'))
  parts.push(`预算：最多 ${budget?.maxTurns ?? DEFAULT_BUDGET.maxTurns} 轮交互、${budget?.maxToolCalls ?? DEFAULT_BUDGET.maxToolCalls} 次工具调用。请高效使用：先探索关键页面，再提交草稿，再调试。`)
  parts.push('现在请输出你的下一步（一个 JSON 对象）。')
  return parts.filter(Boolean).join('\n\n')
}

/**
 * 把回喂历史渲染成文本；超限时**从最旧的开始丢**。
 * 关键：至少保留最新一条——那通常就是模型眼下最需要的反馈（真实报错、质量打回原因）。
 * 早先的实现"从头留一条 + 从尾尽量装"会在单条很长时把最新的报错也丢掉，模型于是看不到
 * 自己为什么失败（真机上表现为"反复犯同一个错"）。
 */
function renderLog(log = [], cap = DEFAULT_BUDGET.historyChars) {
  const items = log.map((x) => (typeof x === 'string' ? x : `【${x.role}】${x.text}`))
  const text = items.join('\n\n')
  if (text.length <= cap) return text
  const tail = []
  let size = 0
  for (let i = items.length - 1; i >= 0; i--) {
    const len = items[i].length
    if (tail.length && size + len > cap) break   // 已装上更新的一条，装不下更旧的就算了
    tail.unshift(items[i])
    size += len
  }
  const omitted = items.length - tail.length
  return [omitted > 0 ? `（更早的 ${omitted} 条探索记录已省略）` : '', ...tail].filter(Boolean).join('\n\n')
}

/**
 * 解析模型这一轮的输出。**宽容**朝向"能读懂就继续"：
 * ① 带 tool 字段 → 工具调用；② 带 spec / 本身就是 Spec → 视为 submit_spec；
 * ③ 什么都读不出 → bad（回喂纠正提示，而不是判整次生成失败）。
 */
function parseTurn(text) {
  const raw = String(text || '')
  const j = extractSpec(raw)
  if (!j) return { kind: 'bad', raw }
  const thought = typeof j.thought === 'string' ? j.thought : ''
  const tool = typeof j.tool === 'string' ? j.tool : (typeof j.action === 'string' && (j.args || j.spec) ? j.action : '')
  if (tool && tool !== 'submit_spec') {
    return { kind: 'tool', tool, args: j.args && typeof j.args === 'object' ? j.args : {}, thought, raw }
  }
  const spec = j.spec && typeof j.spec === 'object' ? j.spec : (j.specVersion || j.commands ? j : null)
  if (spec) return { kind: 'spec', tool: 'submit_spec', spec, thought, raw }
  if (tool === 'submit_spec') return { kind: 'spec', tool, spec: null, thought, raw }
  return { kind: 'bad', raw }
}

/**
 * **封装质量校验**（与结构校验互补：结构管"能不能跑"，质量管"能不能用"）。
 *
 * 硬错误只留"会让产物直接不可用"的问题：title 空/占位、params 没有说明、read 没有返回说明、
 * action 命名非法。这些将来会直接体现在模型看到的工具描述里，写砸了工具就是废的。
 *
 * ★ 为什么**没有**对命令条数的任何阈值（含 warning）：用户明确反对写死条数——
 * "条数尽可能多，不要硬性要求；质量是根据实际应用/网站决定的"。
 * 命令该有几条，取决于用户的覆盖度需求与目标实际暴露的入口数，写死任何 N 都会逼模型凑数
 * （凑出来的命令会在真实试跑里失败）或让本来就小的应用永远"不达标"。
 * 覆盖度由 **M4 的 LLM 评审轮**对着"用户需求 + 已探明能力清单 + 交付的 Spec"评判，
 * 结论落进 spec.review，而不是靠一个与真实质量无关的计数。
 * @returns {{ok:boolean, errors:string[], warnings:string[]}}
 */
function checkSpecQuality(spec, { driver = 'browser', hasMaterial = true } = {}) {
  const errors = []
  const warnings = []
  const cmds = Array.isArray(spec?.commands) ? spec.commands : []
  const d = normalizeDriver(driver)
  const paths = new Set()
  for (const [i, c] of cmds.entries()) {
    const at = `commands[${i}]`
    const action = String(c?.action || '')
    if (!/^[a-z][A-Za-z0-9]{1,39}$/.test(action)) {
      errors.push(`${at}.action 不规范：「${action}」——要求英文小驼峰、动词开头、≤40 字符（例：listOrders）`)
    }
    const title = String(c?.title || '').trim()
    if (cjkLen(title) < 2) errors.push(`${at}.title 缺失或过短——title 是将来模型唯一能看到的「这个工具干什么」，必须写清（例「查询待办列表」）`)
    else if (isPlaceholder(title)) errors.push(`${at}.title 是占位语「${title}」——请换成真实动作描述`)
    for (const [k, p] of (Array.isArray(c?.params) ? c.params : []).entries()) {
      const desc = String(p?.desc ?? p?.description ?? '').trim()
      const name = String(p?.name || `params[${k}]`)
      if (!desc) errors.push(`${at}.params[${k}]（${name}）缺少 desc——参数说明会直接展示给调用方，必须写`)
      // 先判占位语再判长度：「待补充」这类词虽然够短，但问题本质是"根本没写"，报错要说准
      else if (isPlaceholder(desc)) errors.push(`${at}.params[${k}]（${name}）的 desc 是占位语「${desc}」——请写清填什么、什么格式`)
      else if (cjkLen(desc) < 6) errors.push(`${at}.params[${k}]（${name}）的 desc 过短（「${desc}」）——要说清填什么、什么格式`)
      if (typeof p?.required !== 'boolean') warnings.push(`${at}.params[${k}]（${name}）未明确 required，建议写成 true/false`)
    }
    if (c?.kind === 'read' && !c?.returns?.from) {
      // returns 当前**没有运行时消费者**（执行结果由 snapshot 的 save 键或 js 返回值决定），
      // 所以它是"给调用方看的说明"，不达标只提示、不拦交付——否则模型漏写一次就永远交不出东西。
      warnings.push(`${at}（${action}）建议补 returns.from，说明这条查询命令返回什么`)
    }
    // 覆盖度：数一数命令各自落到哪些路径/表达式上（粗略但足够提示）
    for (const s of (Array.isArray(c?.steps) ? c.steps : [])) {
      const u = typeof s?.url === 'string' ? s.url : ''
      if (!u) continue
      try { paths.add(new URL(u, 'https://x.invalid').pathname) } catch { paths.add(u) }
    }
  }
  if (hasMaterial && cmds.length >= 3 && paths.size === 1) {
    warnings.push('所有命令都落在同一个页面上，建议覆盖更多功能入口（不同页面/表单/查询）')
  }
  const reads = cmds.filter((c) => c?.kind === 'read')
  /**
   * 「接口级 vs 看页面」偏好（**只提示、不硬拦**）。
   * 依据：只读页面文本的命令，调用方拿到的是一坨文字——取不了数、存不了库，实际价值很低；
   * 而 js 步骤支持 async（electron/browser-executor.cjs 的 executeJavaScript(..., true)），
   * 完全可以直接调站点自己的 JSON 接口（自带登录态），像 CLI 那样给出结构化数据。
   * 设成 warning 而不是 error：模型若一时找不到接口，也必须能交付一版可用产物。
   */
  const pageOnly = (c) => Array.isArray(c?.steps) && c.steps.length > 0
    && c.steps.every((s) => ['goto', 'wait', 'snapshot'].includes(s?.act))
  if (d === 'browser' && hasMaterial && reads.length >= 2 && reads.every(pageOnly)) {
    warnings.push('所有查询命令都是「打开页面 + 取快照」形态，只能拿到页面文本；建议至少加一条**接口级**命令'
      + '（例：{"act":"js","expression":"await fetch(\'/api/xxx\').then(r=>r.json())","save":"r"}），'
      + '直接读写站点的数据接口，返回结构化数据且自带登录态')
  }
  if (reads.length === 0) errors.push('至少要有 1 条 read 命令（否则系统无法自动验证，用户也无从查询该应用的状态）')
  if (reads.length >= 2 && !reads.some((c) => !(c.params || []).some((p) => p?.required))) {
    warnings.push('没有「无需参数」的 read 命令，系统难以自动验证；建议提供一条（例：列出全部）')
  }
  return { ok: errors.length === 0, errors, warnings }
}

// ---------------------------------------------------------------------------
// 交付前评审（M4）：质量控制改由 LLM 评估（用户明确反对写死条数）
// ---------------------------------------------------------------------------
//
// ★ 为什么是"同会话追加一次调用"（用户拍板）：评审要看的上下文与生成完全一致
//   （同一份 system + 同一份 seed + 同一份工具回喂日志），重新开一段对话就得把上下文再喂一遍
//   ——既贵又容易漏。这里的实现就是把**同一份上下文**原样重发，尾部追加评审指令，
//   因此 callLlm 仍然是无状态的（不需要服务端会话支持）。
//
// ★ 为什么"必须能降级"：评审只是质量辅助，它失败不该毁掉一份已经试跑通过的产物。
//   解析失败 / 调用失败一律降级为"不补全 + 如实记录"，绝不抛异常、也绝不靠猜触发补全。

/** 评审 + 补全各占 1 个真实轮次：剩余轮次不足就整段跳过（宁可少一次评审，也不透支预算） */
const REVIEW_RESERVE_TURNS = 2
/** 评审 + 补全至少需要的时间余量（低于它直接跳过，避免"评审跑到一半预算耗尽"） */
const REVIEW_MIN_REMAINING_MS = 60000

/**
 * 评审指令（尾部追加）。要求三件事：
 *   ① 对着**用户需求**逐条核对覆盖度（无需求时对着目标自身核对主要入口）；
 *   ② gaps 必须是**具体**缺口（哪项能力/哪条需求没被命令覆盖），不写"可以更完善"这类空话；
 *   ③ 只输出一个 JSON 对象（结构化，便于机器读取；解析失败有降级路径）。
 */
function reviewInstruction(requirement) {
  const req = normalizeRequirement(requirement)
  return [
    '【现在做一次交付前评审（不要输出工具调用、不要重写 Spec、不要输出解释文字）】',
    req.length
      ? `对着【用户需求】逐条核对：需求里每一项能力，是否都有命令覆盖？\n${req.map((t, i) => `  ${i + 1}. ${t}`).join('\n')}`
      : '这次没有用户需求：请对着**目标本身**核对——已探明/已试跑通过的能力里，哪些主要功能入口还没被任何命令覆盖。',
    '只输出一个 JSON 对象，形如：',
    '{"verdict":"ok|thin","gaps":[{"what":"缺的能力或未被覆盖的需求点","why":"为什么算缺口","hint":"建议怎么补（加什么 act / 调哪个接口 / 读哪个文件）"}],"notes":"一句话说明"}',
    '规矩：',
    '· gaps 每条都必须是**具体**缺口，并指明它属于哪条需求或哪个主要入口；不要写"可以更完善""建议多测"这类空话。',
    '· 覆盖到位就写 verdict:"ok" 且 gaps 为空数组——**不要为了凑数编缺口**（命令条数不是质量指标）。',
  ].join('\n')
}

/** 评审输出 → 结构化结论。★ 任何解析失败都降级为 ok+gaps[]（见上文"为什么必须能降级"） */
function parseReview(text) {
  const raw = String(text || '')
  const j = extractSpec(raw)          // 复用既有的稳健抽取（代码块 / 整段 / 首个 { 到末个 }）
  if (!j) {
    return { ok: false, verdict: 'ok', gaps: [], notes: `评审输出无法解析（已跳过补全）：${raw.slice(0, 200)}`, parseFailed: true }
  }
  const list = Array.isArray(j.gaps) ? j.gaps : []
  const gaps = []
  for (const g of list) {
    if (g == null) continue
    if (typeof g === 'string') {
      const what = g.trim()
      if (what) gaps.push({ what, why: '', hint: '' })
    } else if (typeof g === 'object') {
      const what = String(g.what ?? g.gap ?? g.desc ?? g.title ?? '').trim()
      if (!what) continue
      gaps.push({ what, why: String(g.why ?? g.reason ?? '').slice(0, 300), hint: String(g.hint ?? g.suggestion ?? '').slice(0, 300) })
    }
    if (gaps.length >= 8) break             // 至多 8 条：再多也补不动，还会把提示词撑爆
  }
  const verdict = j.verdict === 'thin' || j.verdict === 'ok'
    ? j.verdict
    : (gaps.length ? 'thin' : 'ok')         // 模型没写/写错 verdict 时按 gaps 推断（保守但不误伤）
  return { ok: true, verdict, gaps, notes: String(j.notes || '').slice(0, 500), parseFailed: false }
}

/** gaps → 回喂给模型的补齐要求（一次补全轮的全部输入） */
function reviewFeedbackLines(review) {
  const gaps = Array.isArray(review?.gaps) ? review.gaps : []
  const lines = ['【交付前评审：发现覆盖缺口，请补齐后重新 submit_spec】']
  for (const [i, g] of gaps.entries()) {
    lines.push(`${i + 1}. 缺：${g.what}`)
    if (g.why) lines.push(`   为什么算缺口：${g.why}`)
    if (g.hint) lines.push(`   建议：${g.hint}`)
  }
  lines.push('要求：只补这些缺口（新增命令、或扩充已有命令的步骤）；**不要推翻**刚试跑通过的部分；')
  lines.push('确实补不了（缺权限/缺登录态/接口不存在）就写进 spec.notes 说明原因，不要硬凑命令行。')
  return lines.join('\n')
}

/**
 * 同会话追加一次评审调用。
 * @param {{system:string, userPrefix:string, requirement:any, callLlm:Function, maxTokens?:number}} p
 *   userPrefix = 本轮生成实际用过的上下文前缀（seedUser + renderLog(log)），原样重发。
 * @returns {Promise<{ok:boolean, verdict:'ok'|'thin', gaps:Array, notes:string, parseFailed?:boolean, callFailed?:boolean, raw?:string}>}
 */
async function reviewSpec({ system, userPrefix, requirement, callLlm, maxTokens } = {}) {
  const user = [userPrefix, reviewInstruction(requirement)].filter(Boolean).join('\n\n')
  let r
  try {
    r = await callLlm({ system, user, maxTokens })
  } catch (e) {
    return { ok: false, verdict: 'ok', gaps: [], notes: `评审调用异常（已跳过补全）：${String(e?.message || e)}`, callFailed: true }
  }
  if (!r?.ok) {
    return { ok: false, verdict: 'ok', gaps: [], notes: `评审调用失败（已跳过补全）：${r?.error || '未知错误'}`, callFailed: true }
  }
  return { ...parseReview(r.text), raw: String(r.text || '') }
}

/** 单次工具结果的进历史文本（截断，但要保留报错原文——那是模型调试的唯一依据） */
function toolResultText(tool, out, cap = DEFAULT_BUDGET.perToolChars) {
  const head = out?.ok === false ? `【${tool} 失败】` : `【${tool} 结果】`
  const body = String(out?.summary || '(无摘要)')
  if (body.length <= cap) return head + body
  return `${head}${body.slice(0, cap)}\n…（本次结果已截断，共 ${body.length} 字符）`
}

/** 进度文案：把工具调用说成人话（界面据此展示"模型正在做什么"，如实、不编百分比） */
function describeToolCall(tool, args) {
  if (tool === 'fetch_page') return `抓取页面 ${args?.url || ''}`
  if (tool === 'list_pages') return '查看已抓页面'
  if (tool === 'browse') return `用浏览器打开（带登录态）${args?.url || ''}`
  if (tool === 'click') return `点击页面元素 ${args?.text ? `「${args.text}」` : `ref=${args?.ref ?? ''}`}`
  if (tool === 'back') return '返回上一页'
  if (tool === 'request_login') return '请求用户登录（等待人工完成）'
  if (tool === 'run_command') return `试跑命令 ${args?.action || ''}`
  return `${tool}`
}

/**
 * 自主探索生成主循环。
 * @param {object} p
 * @param {Function} p.callLlm 单轮模型调用（与 app-llm.callLlmStream 同签名，可注入假模型）
 * @param {Function} p.runTool ({tool,args,draft}) => {ok, summary}
 * @param {Function} [p.validate] 结构校验（默认 validateSpecBasic）
 * @param {Function} [p.verify]  真实试跑：spec => {ok, tried, failures}
 * @param {Function} [p.onProgress]
 * @returns {Promise<{ok:boolean, spec:object|null, verified:boolean, turns:number, toolCalls:number,
 *   trace:Array, issues:string[], blockers:string[], warnings:string[], verify:object|null, elapsedMs:number, stoppedBy:string}>}
 */
async function runAgentLoop({
  target, driver = 'browser', probeMode, probeMaterial, seedSummary, requirement, surfaceLines,
  callLlm, runTool, validate, verify, onProgress, budget, maxTokens,
} = {}) {
  const b = { ...DEFAULT_BUDGET, ...(budget || {}) }
  const t0 = Date.now()
  const system = buildAgentSystem({ target, driver, requirement, surfaceLines })
  const seedUser = buildAgentSeed({ target, driver, probeMode, probeMaterial, seedSummary, budget: b, requirement, surfaceLines })
  const log = []
  const trace = []
  const issues = []
  /**
   * 最新一轮的阻塞原因（面向用户的"当前卡在哪"）。
   * 为什么单列：issues 只增不减，早期轮次的错误会一直排在最前 —— 界面取前 3 条时，用户看到的
   * 是 round-1 的陈旧错误（真实现象："specVersion 必须为 1；缺少 name；…snapshot 不合法"，
   * 而这些其实早就改好了），反而看不到当前真正的卡点。
   */
  let blockers = []
  const setBlockers = (list) => { blockers = (list || []).slice(0, 8) }
  const warnings = []
  let spec = null        // **通过结构+质量校验**的 Spec（只有它才可能被交付）
  let draft = null       // 最近一次提交的草稿（哪怕没通过校验，也留给 run_command 调试用）
  let verified = false
  let verifiedSpec = null  // M4：最后一次**试跑全通过**的 Spec（补全轮翻车时用它兜底交付）
  let review = null        // M4：评审结论（结构化）
  let reviewDone = false    // 评审只做一次（因此补全轮也只有一次）
  let refineGranted = false // 是否给了补全轮
  let refineVerified = false// 补全轮是否也试跑通过
  let chargedTurns = 0      // M4：循环体之外的模型调用（评审）也要记账，避免预算外烧钱
  let verifyResult = null
  let turns = 0
  let toolCalls = 0
  let stoppedBy = 'budget'
  /** 连续"提交了同一批错误"的次数——用于早停（模型原地打转时不要白烧到轮次上限） */
  let lastErrorSig = ''
  let stalls = 0
  /** 连续"输出无法解析"的次数——模型读不懂协议时早点收工 */
  let badStreak = 0
  /**
   * 等待人工（登录）累计时长——**不计入**探索时间预算。
   * 为什么必须扣掉：登录可能要等用户输入账号/短信验证码好几分钟，若算进 10 分钟探索预算，
   * 就会出现"用户刚登录完，探索预算已经被等待吃光"的荒诞结果。
   * 约定：工具结果里的 `pauseMs` 表示"本次调用里有多少毫秒是在等人工"，由 runTool 如实上报。
   */
  let pausedMs = 0
  const hasMaterial = !!probeMaterial && probeMode !== 'none'
  const check = validate || validateSpecBasic
  /**
   * 早停判定：模型提交的一版没通过、且**错误清单与上一次完全相同**时计数；连续两次就停。
   * 为什么需要：轮次/时间预算只为"探索"服务，不该为"原地打转"买单——否则用户要等满 10 分钟
   * 才看到一句"未通过"，而报错其实第 2 轮就已经说明白了。
   */
  const stallCheck = (errs) => {
    const sig = errs.slice().sort().join('｜')
    if (sig && sig === lastErrorSig) stalls++
    else { stalls = 0; lastErrorSig = sig }
    return stalls >= 2
  }

  // 流式增量节流（与 generateSpec 同口径：累计 200 字符或 150ms 才发一次 IPC）
  let lastEmitAt = 0
  let pendingDelta = ''

  for (turns = 1; turns <= b.maxTurns - chargedTurns; turns++) {
    if (Date.now() - t0 - pausedMs > b.timeBudgetMs) {
      stoppedBy = 'time'
      const why = `已达时间预算（${Math.round(b.timeBudgetMs / 1000)}s，不含等待登录的人工时间），停止探索`
      issues.push(why)
      // 必须同时落成 blocker：本路径**没有任何一轮校验错误**，blockers 若为空，界面取到的就是
      // issues 里最早那几条（round-1 的旧结构错误）——用户看到的"失败原因"与真实原因（时间到）无关。
      setBlockers([why])
      break
    }
    const user = [seedUser, renderLog(log, b.historyChars), '请输出你的下一步（一个 JSON 对象）。'].filter(Boolean).join('\n\n')
    onProgress?.({ phase: 'round', turn: turns, maxTurns: b.maxTurns, detail: `第 ${turns}/${b.maxTurns} 轮：${log.length ? '把探索/试跑结果交给模型' : '请求模型开始探索'}…` })
    lastEmitAt = 0; pendingDelta = ''
    const r = await callLlm({
      system, user, maxTokens,
      onDelta: (d, total) => {
        pendingDelta += d || ''
        const now = Date.now()
        if (now - lastEmitAt >= 150 || pendingDelta.length >= 200) {
          lastEmitAt = now
          onProgress?.({ phase: 'stream', turn: turns, maxTurns: b.maxTurns, chars: total, delta: pendingDelta })
          pendingDelta = ''
        } else onProgress?.({ phase: 'stream', turn: turns, maxTurns: b.maxTurns, chars: total })
      },
    })
    if (pendingDelta) { onProgress?.({ phase: 'stream', turn: turns, maxTurns: b.maxTurns, chars: (r?.text || '').length, delta: pendingDelta }); pendingDelta = '' }
    if (!r?.ok) {
      const why = `模型调用失败：${r?.error || '未知错误'}`
      issues.push(why); stoppedBy = 'llm-error'
      // 也要落成 blocker：否则界面会拿上一轮的旧结构错误当"当前卡点"，而真正挂掉的是模型接口
      setBlockers([why])
      onProgress?.({ phase: 'error', detail: why })
      break
    }
    const turn = parseTurn(r.text)
    if (turn.thought) trace.push({ turn: turns, kind: 'thought', text: turn.thought })
    onProgress?.({ phase: 'parse', turn: turns, chars: String(r.text || '').length, detail: `已收到 ${String(r.text || '').length} 字符，解析中…` })

    if (turn.kind === 'bad') {
      log.push({ role: '系统', text: '你的输出无法解析成一个 JSON 对象。请**只输出一个 JSON 对象**：要么是工具调用（{"thought","tool","args"}），要么是 {"thought","tool":"submit_spec","spec":{…}}。' })
      badStreak++
      onProgress?.({ phase: 'invalid', turn: turns, detail: `模型输出无法解析（连续 ${badStreak} 次），已回喂纠正` })
      // 连续读不懂就没必要耗满轮次（模型可能不支持这种协议/输出被截断），早停并如实报告
      if (badStreak >= 3) {
        stoppedBy = 'bad-output'
        const why = `模型连续 ${badStreak} 轮输出无法解析为 JSON（最后一段：${String(turn.raw || '').slice(0, 120)}）`
        issues.push(why)
        // 同样要落 blocker：这条路径的真实原因就在 issues **尾部**，不设 blockers 时界面只会展示
        // 最早几轮的旧错误（如"specVersion 必须为 1"），而用户真正需要知道的是"模型读不懂协议"。
        setBlockers([why])
        break
      }
      continue
    }
    badStreak = 0

    if (turn.kind === 'tool') {
      if (toolCalls >= b.maxToolCalls) {
        log.push({ role: '系统', text: `工具调用次数已达上限（${b.maxToolCalls}）。请立刻用 submit_spec 提交你目前最好的一版。` })
        continue
      }
      toolCalls++
      const label = describeToolCall(turn.tool, turn.args)
      onProgress?.({ phase: 'explore', turn: turns, toolCalls, detail: `第 ${toolCalls}/${b.maxToolCalls} 次工具调用：${label}…` })
      let out
      try {
        out = await runTool?.({ tool: turn.tool, args: turn.args, draft })
      } catch (e) {
        out = { ok: false, summary: `工具执行异常：${String(e?.message || e)}` }
      }
      if (!out || typeof out !== 'object') out = { ok: false, summary: '工具没有返回结果' }
      // 等人工（登录）的时间从时间预算里剔除——只有工具如实上报 pauseMs 才扣
      if (typeof out.pauseMs === 'number' && out.pauseMs > 0) pausedMs += out.pauseMs
      trace.push({ turn: turns, kind: 'tool', tool: turn.tool, args: turn.args, ok: out.ok !== false, summary: String(out.summary || '').slice(0, 400) })
      log.push({ role: '工具', text: toolResultText(turn.tool, out, b.perToolChars) })
      onProgress?.({ phase: 'explore', turn: turns, toolCalls, done: true, detail: `${label} → ${out.ok === false ? `失败：${String(out.summary || '').slice(0, 160)}` : `成功：${String(out.summary || '').slice(0, 160)}`}` })
      continue
    }

    // submit_spec
    if (!turn.spec) {
      log.push({ role: '系统', text: 'submit_spec 缺少 spec 字段。请把完整 Spec 放在 spec 字段里。' })
      continue
    }
    const normalized = { ...turn.spec, expose: { ...(turn.spec.expose || {}), mode: turn.spec.expose?.mode === 'public' ? 'console' : (turn.spec.expose?.mode || 'console') } }
    const v = check(normalized)
    if (!v.ok) {
      issues.push(...v.errors)
      setBlockers(v.errors)
      log.push({ role: '系统', text: `结构校验未通过：\n${v.errors.slice(0, 8).map((e, i) => `${i + 1}. ${e}`).join('\n')}\n请修正后重新 submit_spec。` })
      onProgress?.({ phase: 'invalid', turn: turns, detail: `草稿结构校验未通过：${v.errors.slice(0, 3).join('；')}` })
      if (stallCheck(v.errors)) { stoppedBy = 'no-progress'; issues.push(`模型连续提交同一批结构问题，已早停（避免空耗预算）：${v.errors.slice(0, 2).join('；')}`); break }
      continue
    }
    // 草稿先留存（供 run_command 调试），但**只有通过质量校验才算"可交付"**
    draft = normalized
    const q = checkSpecQuality(normalized, { driver, hasMaterial })
    warnings.push(...q.warnings)
    if (!q.ok) {
      issues.push(...q.errors)
      setBlockers(q.errors)
      log.push({ role: '系统', text: `封装质量校验未通过（命令将来要变成给模型调用的工具，这几项不达标用户就用不了）：\n${q.errors.slice(0, 8).map((e, i) => `${i + 1}. ${e}`).join('\n')}\n请修正后重新 submit_spec。` })
      onProgress?.({ phase: 'quality', turn: turns, detail: `草稿质量未达标：${q.errors.slice(0, 3).join('；')}` })
      if (stallCheck(q.errors)) { stoppedBy = 'no-progress'; issues.push(`模型连续提交同一批质量问题，已早停（避免空耗预算）：${q.errors.slice(0, 2).join('；')}`); break }
      continue
    }
    spec = normalized
    lastErrorSig = ''; stalls = 0
    onProgress?.({ phase: 'parsed', turn: turns, detail: `草稿通过结构与质量校验：${normalized.commands.length} 条命令，进入真实试跑…` })
    verifyResult = verify ? await verify(normalized) : { ok: true, tried: [], failures: [], notRun: [], skipped: [] }
    if (verifyResult.ok) {
      verified = true
      verifiedSpec = normalized
      if (refineGranted) refineVerified = true
      const remainingTurns = b.maxTurns - chargedTurns - turns
      const remainingMs = b.timeBudgetMs - (Date.now() - t0 - pausedMs)
      /**
       * ★ M4 评审门的取值依据（明确写死，便于验收）：
       *   · 剩余轮次 ≥ REVIEW_RESERVE_TURNS(2)：评审 1 轮 + 补全 1 轮；不够就**整段跳过**；
       *   · 剩余时间 ≥ REVIEW_MIN_REMAINING_MS(60s)：避免"评审跑到一半预算耗尽"；
       *   · 只评审一次（reviewDone）⇒ 补全轮不会再次评审，不会形成"评审→补全→再评审"的循环。
       */
      if (!reviewDone && remainingTurns >= REVIEW_RESERVE_TURNS && remainingMs >= REVIEW_MIN_REMAINING_MS) {
        reviewDone = true
        chargedTurns += 1                                   // 评审本身占 1 轮
        onProgress?.({ phase: 'round', turn: turns, maxTurns: b.maxTurns, detail: `第 ${turns}/${b.maxTurns} 轮：试跑通过，追加一次交付前评审（覆盖度）…` })
        review = await reviewSpec({
          system,
          userPrefix: [seedUser, renderLog(log, b.historyChars)].filter(Boolean).join('\n\n'),
          requirement,
          callLlm,
          maxTokens,
        })
        if (review.parseFailed || review.callFailed) warnings.push(review.notes)
        if (review.gaps.length) {
          refineGranted = true
          log.push({ role: '系统', text: reviewFeedbackLines(review) })
          onProgress?.({ phase: 'round', turn: turns, maxTurns: b.maxTurns, detail: `第 ${turns}/${b.maxTurns} 轮：评审发现 ${review.gaps.length} 处覆盖缺口，追加一轮补全…` })
          continue                                          // 进入补全轮（轮次由循环上界记账）
        }
        onProgress?.({ phase: 'round', turn: turns, maxTurns: b.maxTurns, done: true, detail: '评审：覆盖度到位（未发现需补的缺口）' })
      } else if (!reviewDone) {
        review = { ok: false, verdict: 'ok', gaps: [], notes: `预算不足（剩余 ${remainingTurns} 轮 / ${Math.round(remainingMs / 1000)}s），已跳过交付前评审`, skipped: true }
        warnings.push('已跳过交付前评审（预算不足）：本次交付未经过覆盖度评审')
        onProgress?.({ phase: 'round', turn: turns, maxTurns: b.maxTurns, detail: '预算不足，已跳过交付前评审' })
      }
      stoppedBy = 'verified'
      onProgress?.({ phase: 'verify', turn: turns, done: true, detail: `试跑通过：${(verifyResult.tried || []).join('、') || '（无可试跑命令）'}` })
      break
    }
    const fails = (verifyResult.failures || []).map((f) => `${f.action}：${f.error}`)
    issues.push(...fails)
    setBlockers(fails)
    log.push({
      role: '系统',
      text: `你提交的这版**真实试跑未通过**（草稿已保留，你可以用 run_command 逐条调试后再 submit_spec）：\n${fails.slice(0, 8).map((e, i) => `${i + 1}. ${e}`).join('\n')}${(verifyResult.skipped || []).length ? `\n（未试跑：${verifyResult.skipped.join('、')}——可试跑的命令都需要参数）` : ''}`,
    })
    onProgress?.({ phase: 'verify', turn: turns, detail: `试跑未通过 ${fails.length} 条：${fails.slice(0, 2).join('；')}` })
  }

  if (turns > b.maxTurns - chargedTurns) {
    stoppedBy = 'max-turns'
    // 轮次耗尽也是"没有新一轮校验结果"的路径：不设 blockers 时界面只能拿最旧的错误当原因，
    // 而真实原因是"探索轮次用尽、模型没交出合格 Spec"。
    setBlockers([`探索轮次用尽（${b.maxTurns} 轮）仍未产出通过校验的 Spec，停止探索`])
  }
  const elapsedMs = Date.now() - t0
  /**
   * ★ M4：交付物选取——补全轮若没通过试跑，**交付上一版通过试跑的产物**而不是更差的新草稿。
   *   （补全是为了更好；"越补越差"时交付旧版才是对用户更诚实的取舍。）
   */
  const delivered = verifiedSpec || spec
  const reviewOutcome = !review ? null
    : review.skipped ? 'skipped-budget'
      : (review.ok === false ? 'review-failed'
        : (!review.gaps.length ? 'no-gaps' : (refineGranted ? (refineVerified ? 'refined' : 'refine-failed') : 'no-gaps')))
  if (review && reviewOutcome === 'refine-failed') {
    warnings.push('补全轮未通过试跑：已交付上一版通过试跑的 Spec（评审指出的缺口见 spec.review.gaps）')
  }
  const reviewOut = review
    ? { verdict: review.verdict, gaps: review.gaps, notes: review.notes, applied: refineGranted, outcome: reviewOutcome, at: new Date().toISOString() }
    : null
  const specOut = delivered ? (reviewOut ? { ...delivered, review: reviewOut } : delivered) : null
  // 交付判定：只有**结构+质量都过**的草稿才值得给出；试跑未通过时如实标注 verified=false
  const ok = !!specOut
  onProgress?.({
    phase: 'done', done: true,
    detail: ok
      ? (verified
        ? `探索完成：${specOut.commands.length} 条命令，试跑全部通过（${turns + chargedTurns} 轮模型调用${reviewOut ? `，评审：${reviewOut.outcome}` : ''}）`
        : `探索结束（${stoppedBy}）：${specOut.commands.length} 条命令，试跑**未全部通过**，已在界面给出原因`)
      : `探索结束（${stoppedBy}）：未产出通过校验的 Spec`,
  })
  return {
    ok, spec: specOut, verified, review: reviewOut,
    turns: Math.min(turns, b.maxTurns - chargedTurns) + chargedTurns, toolCalls, trace, issues, blockers, warnings,
    verify: verifyResult, elapsedMs, stoppedBy,
  }
}

module.exports = {
  runAgentLoop, buildAgentSystem, buildAgentSeed, parseTurn, checkSpecQuality,
  renderLog, toolResultText, describeToolCall, agentToolDocs,
  resolveClickTarget, isDestructiveLabel, DESTRUCTIVE_LABEL,
  DEFAULT_BUDGET, PLACEHOLDER, isPlaceholder,
  normalizeRequirement, requirementLines,
  parseReview, reviewInstruction, reviewFeedbackLines, reviewSpec,   // ← M4 新增
  REVIEW_RESERVE_TURNS, REVIEW_MIN_REMAINING_MS,                     // ← M4 新增
}
