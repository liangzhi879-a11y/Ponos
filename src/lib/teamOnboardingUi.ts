// src/lib/teamOnboardingUi.ts —— S3 团队**开通/加入**的渲染层纯逻辑（2026-09-17）
//
// spec：`docs/superpowers/specs/2026-09-14-team-collaboration-design.md`
//   §5.9「两条进入路径」：新建团队 = **3 步向导**（① 团队名 + 本机身份 ② 团队源 ③ 初始化 +
//        识别码 + 停留在"邀请成员"）；加入 = **两个数字**（9 位识别码 + 6 位验证码）。
//   §7 / §7.1 / §7.2：团队源**一接口两档实现**——L1 共享目录（本轮）/ L2 团队服务器（S5，定案 14
//        "只留结构不做实现"）；目录布局即交付契约（`team.json` / `members/` / `keys/` / `cas/` /
//        `versions/` / `claims/`）。
//   §5.9「邀请界面必须小字明示」+ §11「UI 措辞风险」：**不得**暗示"已加密"或"仅受邀者可读"，
//        并须说明验证码**仅为成员登记**。这是安全承诺的红线（写错会误导用户以为切了模式/
//        被邀请了就等于数据被保护了，而真实边界是网盘 ACL）。
//
// 纪律（照 `knowledgeScopeUi.ts` / `appQuality.ts`）：零 import、纯函数、不碰 store。
// 组件只做 map，所有"判错了会出丑"的规则都在这里被 `node --test` 钉住。
//
// 常量与内核**同源镜像**（`shared/team-crypto.mjs`），不 import 的原因同 teamModeUi 头部：
// 内核是独立进程，前端 bundle 不该把它拉进来；内核始终是收口方（前端只做即时反馈）。

/** 识别码位数（镜像 `shared/team-crypto.mjs` 的 `IDENT_CODE_LEN`）。 */
export const IDENT_CODE_LEN = 9

/** 验证码位数（镜像 `shared/team-crypto.mjs` 的 `VERIFY_CODE_LEN`）——6 位数字。 */
export const VERIFY_CODE_LEN = 6

/** 展示分组宽度（`483 920 517` / `739 204`）：两个短数字要"可口头传"，人眼分段才读得出来。 */
export const CODE_GROUP = 3

/** 输入框清洗：只留数字（用户从聊天记录里复制常带空格/连字符，粘贴进来的杂质不该算错）。 */
export function digitsOnly(raw: unknown): string {
  return String(raw ?? '').replace(/\D+/g, '')
}

/** 展示形态：`483920517` → `483 920 517`（长度不符时原样返回数字串，不编造分组）。 */
export function formatCode(raw: unknown, len: number, group = CODE_GROUP): string {
  const d = digitsOnly(raw).slice(0, len)
  if (!d) return ''
  const out: string[] = []
  for (let i = 0; i < d.length; i += Math.max(1, group)) out.push(d.slice(i, i + Math.max(1, group)))
  return out.join(' ')
}

export type CodeIssue = 'empty' | 'length' | 'nondigit'

/** 三类失败原因共用的 i18n 键（文案里用 `{name}` 参数区分是"识别码"还是"验证码"）——
 *  三套键 × 两种码 = 6 条重复文案，重复的分叉点迟早不一致，故只留一套 + 参数。 */
export const CODE_ISSUE_KEYS: Readonly<Record<CodeIssue, string>> = Object.freeze({
  empty: 'team.codeEmpty',
  length: 'team.codeLength',
  nondigit: 'team.codeNondigit',
})

/** 两种码的展示名键（供 `{name}` 参数用）。 */
export const IDENT_CODE_NAME_KEY = 'team.identName'
export const VERIFY_CODE_NAME_KEY = 'team.verifyName'

export interface CodeCheck {
  ok: boolean
  /** 清洗后的数字串（ok=true 时即"可以送后端的值"）。 */
  digits: string
  /** 期望位数（渲染 `team.codeLength` 的 `{n}` 参数）。 */
  len: number
  /** 失败原因：空 / 位数不对 / 含非数字字符。三者文案不同（"再输两位"≠"请只输入数字"）。 */
  issue?: CodeIssue
  /** 失败原因对应的 i18n 键（成功时为 null）。 */
  issueKey: string | null
}

/**
 * 校验一个短数字码。**区分"位数不够"与"含非法字符"**：前者是还没输完（不该报错），
 * 后者是输错了东西（该提示）。两者合并成一句"格式错误"会让边打字边报红。
 */
export function checkCode(raw: unknown, len: number): CodeCheck {
  const text = String(raw ?? '').trim()
  const digits = digitsOnly(text)
  if (!text) return { ok: false, digits, len, issue: 'empty', issueKey: CODE_ISSUE_KEYS.empty }
  if (text !== digits || digits.length !== len) {
    const issue: CodeIssue = text !== digits ? 'nondigit' : 'length'
    return { ok: false, digits, len, issue, issueKey: CODE_ISSUE_KEYS[issue] }
  }
  return { ok: true, digits, len, issueKey: null }
}

/** 识别码校验（9 位，团队级固定，写在 `team.json` 明文里）。 */
export function checkIdentCode(raw: unknown): CodeCheck {
  return checkCode(raw, IDENT_CODE_LEN)
}

/** 验证码校验（6 位、每成员一个、一次性、默认 7 天）。 */
export function checkVerifyCode(raw: unknown): CodeCheck {
  return checkCode(raw, VERIFY_CODE_LEN)
}

// ---------------------------------------------------------------------------
// 新建团队：3 步向导（§5.9「新建团队」）
// ---------------------------------------------------------------------------

export type WizardStep = 1 | 2 | 3
export const WIZARD_STEPS: readonly WizardStep[] = [1, 2, 3]

export interface WizardDraft {
  /** ① 团队名 */
  name?: string
  /** ① 本机身份指纹（自动生成，只展示） */
  fingerprint?: string
  /** ② 团队源类型 */
  sourceKind?: string
  /** ② 团队源目录（L1 共享目录 / 网盘同步根下的团队目录） */
  dir?: string
}

/** 每步的可推进判据（返回阻断项的 i18n 键；空数组 = 可以下一步）。
 *
 *  顺序是 **硬约束**（§5.9「顺序要点」原文）：**先有团队工作区实体，再配置团队源**——
 *  故第 ① 步只校验"名字"（身份由应用自动生成），目录在第 ② 步才要求。
 */
export function wizardBlockers(step: WizardStep, draft: WizardDraft = {}): string[] {
  const out: string[] = []
  if (step === 1) {
    if (!String(draft.name ?? '').trim()) out.push('team.wizardNeedName')
  } else if (step === 2) {
    const kind = String(draft.sourceKind ?? 'l1-shared-dir')
    if (kind !== 'l1-shared-dir') out.push('team.wizardNeedL1')
    if (!String(draft.dir ?? '').trim()) out.push('team.wizardNeedDir')
  }
  return out
}

export function canAdvance(step: WizardStep, draft: WizardDraft = {}): boolean {
  return wizardBlockers(step, draft).length === 0
}

/** 下一步（已是最后一步 → 停在 3：第 ③ 步是"已建成 + 邀请成员"页，没有第 4 步）。 */
export function nextStep(step: WizardStep): WizardStep {
  return step >= 3 ? 3 : ((step + 1) as WizardStep)
}

/** 上一步（第 1 步 → 停在 1）。 */
export function prevStep(step: WizardStep): WizardStep {
  return step <= 1 ? 1 : ((step - 1) as WizardStep)
}

// ---------------------------------------------------------------------------
// 团队源两档实现（§7 的表；定案 14：L2 本轮**只留结构不做实现**）
// ---------------------------------------------------------------------------

export type TeamSourceKind = 'l1-shared-dir' | 'l2-server'

export interface TeamSourceOption {
  kind: TeamSourceKind
  /** 本轮是否可用（L2 = false：S5 明确不做，只保证抽象边界干净） */
  available: boolean
  /** 选项标题 i18n 键 */
  labelKey: string
  /** 选项说明 i18n 键（写清"是否本轮可用"以及为什么） */
  hintKey: string
}

/**
 * 两档团队源。**L2 刻意渲染成"不可选 + 说明"而不是隐藏**：
 * 隐藏会让用户以为这个产品永远只有共享目录；画出来但说清"按定案 14 只留结构"才是诚实的边界。
 */
export const TEAM_SOURCE_OPTIONS: readonly TeamSourceOption[] = Object.freeze([
  Object.freeze({
    kind: 'l1-shared-dir' as TeamSourceKind,
    available: true,
    labelKey: 'team.sourceL1Label',
    hintKey: 'team.sourceL1Hint',
  }),
  Object.freeze({
    kind: 'l2-server' as TeamSourceKind,
    available: false,
    labelKey: 'team.sourceL2Label',
    hintKey: 'team.sourceL2Hint',
  }),
])

export function sourceOption(kind: unknown): TeamSourceOption | null {
  return TEAM_SOURCE_OPTIONS.find((o) => o.kind === kind) ?? null
}

/** 该团队源类型能否在本版本使用；不可用时给出 i18n 键（原因必须写清，不能只是禁用）。 */
export function sourceUnavailableKey(kind: unknown): string | null {
  const opt = sourceOption(kind)
  if (!opt) return 'team.sourceUnknown'
  return opt.available ? null : 'team.sourceL2Unavailable'
}

// ---------------------------------------------------------------------------
// 目录布局（§7.1 / §7.2 的交付契约）——向导第 ③ 步要"告诉用户团队源目录里会出现什么"
// ---------------------------------------------------------------------------

/**
 * 团队留档的**容器目录名**：全部团队文件都收在团队根目录下的这一个点开头目录里。
 *
 * 为什么：团队根目录就是用户的**工作目录**（真实例子：`Z:\…\湖北美宝药业股份有限公司`），
 * 早先把 `team.json` / `members/` / … 直接摊在工作文件旁，会和申报材料混在一起。
 * 收进容器后工作目录只多出**一个**条目；Windows 上还会额外设隐藏属性（点开头在 Windows
 * 上并不隐藏），故界面上不该宣称"看得到这六个目录"。
 * 常量与内核同源：`shared/team-source.mjs` 的 `TEAM_LAYOUT.CONTAINER`。
 */
export const TEAM_CONTAINER_DIR = '.yfworking'

export interface LayoutEntry {
  /** 相对**容器目录**的路径（容器内的布局；根就是 `.yfworking/`） */
  path: string
  /** 说明 i18n 键 */
  hintKey: string
  /** 是否可能包含**团队密钥材料**：`keys/` 是验证码封装的信封（明文团队密钥永不入团队源）。 */
  keyMaterial: boolean
}

export const TEAM_LAYOUT_ENTRIES: readonly LayoutEntry[] = Object.freeze([
  Object.freeze({ path: 'team.json', hintKey: 'team.layoutManifest', keyMaterial: false }),
  Object.freeze({ path: 'members/', hintKey: 'team.layoutMembers', keyMaterial: false }),
  Object.freeze({ path: 'keys/', hintKey: 'team.layoutKeys', keyMaterial: true }),
  Object.freeze({ path: 'cas/', hintKey: 'team.layoutCas', keyMaterial: false }),
  Object.freeze({ path: 'versions/', hintKey: 'team.layoutVersions', keyMaterial: false }),
  Object.freeze({ path: 'claims/', hintKey: 'team.layoutClaims', keyMaterial: false }),
])

// ---------------------------------------------------------------------------
// 加入失败态 → 文案键（错误码由 `kernel/team-store.mjs:joinTeam` 给出）
// ---------------------------------------------------------------------------

export interface JoinFailureCopy {
  /** 主文案键 */
  titleKey: string
  /** 可操作提示键（§10 S3-4「未匹配到团队时给出可操作提示」） */
  hintKey: string
  /** 是否值得让用户**改一个数字重试**（false ⇒ 重试同一个码永远不成功，界面不该诱导重试） */
  retriable: boolean
}

/**
 * 错误码 → 文案。**逐项区分，不笼统报"加入失败"**（`team-store.mjs` 的注释点名了这条）：
 * 「验证码错」与「已用过 / 已过期」必须分开——否则用户会反复重试一个永远不会成功的码。
 * 键值以内核 reason 为准（路由原样透传，不在前端重新发明错误码）。
 */
export const JOIN_FAILURE: Readonly<Record<string, JoinFailureCopy>> = Object.freeze({
  // ① 输入格式（前端也应先本地拦，这里兜住"绕过界面直接改 URL/脚本"的情形）
  'bad-ident-format': { titleKey: 'team.joinErrIdentFormat', hintKey: 'team.joinErrIdentFormatHint', retriable: true },
  'bad-code-format': { titleKey: 'team.joinErrCodeFormat', hintKey: 'team.joinErrCodeFormatHint', retriable: true },
  // ② 环境（搜索根没设/不可用）——"两个数字加入"的前提是搜索根已设置（§10 S3-4）
  'search-root-missing': { titleKey: 'team.joinErrNoRoot', hintKey: 'team.joinErrNoRootHint', retriable: true },
  // ③ 定位（找不到 / 找到多个）
  'ident-not-found': { titleKey: 'team.joinErrNotFound', hintKey: 'team.joinErrNotFoundHint', retriable: true },
  'ident-ambiguous': { titleKey: 'team.joinErrAmbiguous', hintKey: 'team.joinErrAmbiguousHint', retriable: false },
  // ④ 信封（团队源里根本没有未使用的邀请）
  'no-envelope': { titleKey: 'team.joinErrNoEnvelope', hintKey: 'team.joinErrNoEnvelopeHint', retriable: false },
  // ⑤ 验证码本身：**错 / 过期 / 用过三者必须三套文案**
  'bad-code': { titleKey: 'team.joinErrBadCode', hintKey: 'team.joinErrBadCodeHint', retriable: true },
  expired: { titleKey: 'team.joinErrExpired', hintKey: 'team.joinErrExpiredHint', retriable: false },
  'already-used': { titleKey: 'team.joinErrUsed', hintKey: 'team.joinErrUsedHint', retriable: false },
  // ⑥ 桥层兜底（路由异常不外逃，统一 4xx 回执）
  'join-failed': { titleKey: 'team.joinErrUnknown', hintKey: 'team.joinErrUnknownHint', retriable: true },
})

/** 取失败文案；未知 reason **不静默**（落到"未知失败"并保留原码给排障展示）。 */
export function joinFailure(reason: unknown): JoinFailureCopy {
  const key = String(reason ?? '').trim()
  return JOIN_FAILURE[key] ?? { titleKey: 'team.joinErrUnknown', hintKey: 'team.joinErrUnknownHint', retriable: true }
}

/** 网络层失败（桥没起/端口不通）：与"业务失败"分开——它不该被算作"验证码错了"。 */
export const JOIN_NETWORK_FAILURE: JoinFailureCopy = Object.freeze({
  titleKey: 'team.joinErrNetwork', hintKey: 'team.joinErrNetworkHint', retriable: true,
})

// ---------------------------------------------------------------------------
// 🔴 反向断言②：邀请/验证码文案**不得**暗示"已加密 / 仅受邀可读"（spec §5.9 强制小字 + §11）
// ---------------------------------------------------------------------------

/**
 * 强制小字（spec §5.9 原文照抄的语义）："访问权限由共享目录 / 网盘的操作系统权限控制，请另行设置。"
 * 键名收口在这里，组件只允许通过 `inviteDisclosureKeys()` 取（防止某处漏画小字）。
 */
export const INVITE_DISCLOSURE_KEYS = Object.freeze({
  /** 权限来源：OS ACL / 网盘权限 */
  acl: 'team.inviteAclNote',
  /** 验证码的**真实**作用：仅成员登记（一次性、7 天），不是加密钥匙 */
  code: 'team.inviteCodeNote',
  /** 应用层登记的边界：不阻止有目录权限的人读取 */
  enforcement: 'team.inviteNoEnforcementNote',
  /** 模式 ≠ 隔离（§5.9「为什么必须明说」） */
  modeNotIsolation: 'team.modeNotIsolationNote',
})

export function inviteDisclosureKeys(): string[] {
  return [INVITE_DISCLOSURE_KEYS.acl, INVITE_DISCLOSURE_KEYS.code, INVITE_DISCLOSURE_KEYS.enforcement]
}

/**
 * **禁止出现的措辞**（承诺形状，不是关键词形状）。
 *
 * 为什么是"承诺形状"而不是"出现'加密'二字就报错"：合法文案里**必须**能说
 * "验证码不是加密钥匙"（否认句式），否则就只能回避这个词、反而说不清边界。
 * 故这里列的是**肯定式承诺**（读者会理解成"数据受保护"的句子片段）。
 */
export const FORBIDDEN_PERMISSION_CLAIMS: readonly string[] = Object.freeze([
  // 中文：肯定式加密承诺
  '已加密', '数据已加密', '加密保护', '加密存储', '端到端加密',
  // 中文：肯定式"仅受邀可读"承诺
  '仅受邀', '只有受邀', '受邀方可读', '受邀者可读', '邀请即授权',
  // 英文：肯定式承诺（'encryption' 单独不列——"not an encryption key" 是合法的否认句）
  'is encrypted', 'are encrypted', 'encrypted storage', 'end-to-end encrypted',
  'invite-only', 'only invited users', 'only invited people', 'invitation grants access',
])

/**
 * 找出文本里命中的**禁止承诺**（大小写不敏感的英文匹配；空文本 → 空数组）。
 * 返回原文片段便于测试给出"哪一句错了"。
 */
export function findForbiddenClaims(text: unknown): string[] {
  const s = String(text ?? '')
  if (!s) return []
  const lower = s.toLowerCase()
  const hits: string[] = []
  for (const claim of FORBIDDEN_PERMISSION_CLAIMS) {
    const c = claim.toLowerCase()
    if (lower.includes(c)) hits.push(claim)
  }
  return hits
}

/** 递归收集对象里的字符串值（用于扫描整棵翻译子树，含嵌套命名空间）。 */
export function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') { out.push(value); return out }
  if (Array.isArray(value)) { for (const v of value) collectStrings(v, out); return out }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) collectStrings(v, out)
    return out
  }
  return out
}

/**
 * 去掉行注释与块注释 —— **只服务于措辞守卫的扫描**。
 *
 * 为什么必须先剥注释：注释是**写给人看的**（"这里不得暗示『已加密』"），
 * 它永远到不了用户眼前；不剥注释的扫描会逼着后来的维护者**不敢在注释里引用禁令原文**，
 * 于是这条约束反而更容易被忘记。守卫要盯的是**渲染出去的字符串**。
 *
 * 边界（刻意从简）：`//` 前是 `:`/引号/反斜杠时不视作注释（保住 `'http://…'` 这类字面量）；
 * JSX 里的块注释 `{/* … *\/}` 由第一条规则吃掉。误判只可能**多删**代码注释，不会让真实文案逃过扫描
 * （真实的承诺必须写在字符串里，而那部分保留）。
 */
export function stripComments(src: unknown): string {
  return String(src ?? '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1 ')
}
