// kernel/settings.mjs —— 分层 settings（user < **customer** < project < local 深合并，
// docs/production/platform.md P4-3；customer 层为 E2 Task 4「一客一策」新增）。
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
// ★ 2026-10-18：关键状态落盘统一走带 fsync 的原子写（防断电留半截文件）
import { writeFileAtomicSync } from '../shared/atomic-write.mjs'
import { join } from 'node:path'
import { SCHEMA_VERSION } from '../version.mjs'

export function deepMerge(base, override) {
  const out = { ...(base || {}) }
  for (const [k, v] of Object.entries(override || {})) {
    if (v === undefined) continue
    if (v !== null && typeof v === 'object' && !Array.isArray(v) &&
        out[k] !== null && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v)
    } else {
      out[k] = v
    }
  }
  return out
}

function readJson(p) {
  if (!p || !existsSync(p)) return {}
  try { return JSON.parse(readFileSync(p, 'utf-8')) } catch { return {} }
}

// ── E2 Task 4「一客一策」客户层（2026-09-26）────────────────────────────────
// 层序：**user < customer < project < local**（客户层覆盖默认层，本机层覆盖客户层）。
//
// ★ 选层机制（用户裁定 Q4）= 环境变量 `PONOS_CUSTOMER_ID`：
//   · **未设该 env ⇒ 完全不加该层** —— 这是硬要求：存量机器（绝大多数）的 `merged`
//     必须与本次改动前**逐字节相同**。故这里绝不"猜"客户 id（不按 cwd 自动匹配、
//     不读第二个设置项）：多一条隐式选层路径就多一处"某台机器莫名换了策略"。
//   · `<id>` 必须做**安全校验**：它会被拼进文件名（`customer-<id>.json`），
//     未校验的 id 就是**路径穿越**（`x/../../secret` 之类能读到任意 .json）。
//     非法 ⇒ **跳过该层 + 出声**（返回 notice 并 warn），既不抛、也不静默当合法。
export const CUSTOMER_ID_ENV = 'PONOS_CUSTOMER_ID'

/** 客户 id 是否安全（可拼路径）。白名单字符集 + 显式拒绝 `..`/分隔符/控制字符。 */
export function isSafeCustomerId(id) {
  if (typeof id !== 'string') return false
  const s = id.trim()
  if (!s || s.length > 64) return false
  if (s.includes('..')) return false // 目录回退（`customer-../x` 之类）
  if (/[\u0000-\u001f\u007f]/.test(s)) return false // 控制字符（换行/空字节可截断路径）
  // 白名单：字母数字 + `_`/`-`/`.`。**不含** `/` `\` `:` ⇒ Windows 盘符与 POSIX 分隔符
  // 一并出局（`:` 那类还能造出相对路径语义）。宁可拒掉几个"人看着正常"的 id。
  return /^[A-Za-z0-9._-]+$/.test(s)
}

/**
 * 解析客户层落点。
 * @returns {{ id: string, path: string, reason: 'unset'|'invalid-id'|'no-config-dir'|'active' }}
 *   `path` 非空当且仅当 `reason === 'active'`。
 */
export function resolveCustomerLayer({ configDir = '', env = {} } = {}) {
  const raw = env?.[CUSTOMER_ID_ENV]
  if (raw === undefined || raw === null || String(raw).trim() === '') return { id: '', path: '', reason: 'unset' }
  const id = String(raw).trim()
  if (!isSafeCustomerId(id)) return { id, path: '', reason: 'invalid-id' }
  if (!configDir) return { id, path: '', reason: 'no-config-dir' }
  return { id, path: join(configDir, `customer-${id}.json`), reason: 'active' }
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** 展开成叶键 → 值（`memory.inject` 这种子键也要能报来源，否则"哪层生效"仍不可见）。 */
function flattenLeaves(obj, prefix = '', out = new Map()) {
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined) continue // deepMerge 会跳过 undefined ⇒ 它不参与生效值
    const key = prefix ? `${prefix}.${k}` : k
    if (isPlainObject(v) && Object.keys(v).length) flattenLeaves(v, key, out)
    else out.set(key, v)
  }
  return out
}

// 值可能含凭据（`settings.json#env.*`、`providers[].authToken` 之类）。生效清单是**给人看/进日志**
// 的，必须脱敏后才允许展示 —— 这条不是洁癖：本仓刚花一整轮把明文凭据清出磁盘，
// 不能让"排障用的清单"成为新的泄漏面（`env` 整块永远打码，键名保留）。
//
// 判据刻意**收紧**（宁可少打码一个正常键，不可把 `maxOutputTokens` 这种正常配置打成 `***`）：
// 只认"整段/驼峰末段"是凭据名的键：`ANTHROPIC_AUTH_TOKEN` / `PONOS_API_KEY` / `authToken` /
// `apiKey` / `secretKey` ……；`maxOutputTokens`（复数 Tokens）不算 —— 它会被误伤成 `***`，
// 而清单的用途恰是"看生效值"，误伤等于让清单失去意义。
const SECRET_KEY_RE = /(^|[._-])(token|secret|password|passwd|credential)s?$|[a-z0-9](Token|Secret|Password|Credential|Key)$|^api[-_]?keys?$/i
const maskValue = (v) => (isPlainObject(v) ? `{已打码 ${Object.keys(v).length} 键}` : Array.isArray(v) ? `[已打码 ${v.length} 项]` : '***')
/** 递归判断某个值内部是否藏着密钥类键（数组里的对象也算，如 `providers[].authToken`）。 */
function hasSecretKey(v, depth = 0) {
  if (depth > 6 || v === null || typeof v !== 'object') return false
  for (const [k, child] of Object.entries(v)) {
    if (k === 'env' || SECRET_KEY_RE.test(k)) return true
    if (hasSecretKey(child, depth + 1)) return true
  }
  return false
}

/**
 * 生效清单：逐项给出**生效值 + 来源层**（`← 客户层` 这类归属）。
 * @param {object} layers 形如 `{ user, customer, project, local }`（按优先级从低到高）
 * @returns {Array<{key: string, value: any, layer: 'user'|'customer'|'project'|'local'}>}
 *   同键取**最高优先级层**；按 key 排序（顺序稳定，便于 diff 两份清单）。
 */
export function settingsProvenance(layers = {}) {
  const order = ['user', 'customer', 'project', 'local']
  const merged = new Map()
  for (const layer of order) {
    for (const [key, value] of flattenLeaves(layers?.[layer] || {})) merged.set(key, { key, value, layer })
  }
  const out = [...merged.values()].filter((it) => it.key !== 'schemaVersion') // 版本位不是"生效值"，进清单只会变成噪声
  for (const it of out) {
    if (SECRET_KEY_RE.test(it.key) || it.key === 'env' || it.key.startsWith('env.') || hasSecretKey(it.value)) {
      it.value = maskValue(it.value)
    }
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

// —— D2-1 settings schema 版本化：迁移链 + 校验 ——
// v0 = 无 schemaVersion 字段的旧文件；迁移表 { from: fn }，fn 返回 from+1 版本数据。
export const MIGRATIONS = {
  0: (d) => ({ ...d, schemaVersion: 1 }),
}

export function migrateSettings(data = {}) {
  let current = data
  let from = Number(current.schemaVersion)
  if (!Number.isFinite(from) || from < 0) from = 0
  let migrated = false
  while (from < SCHEMA_VERSION) {
    const fn = MIGRATIONS[from]
    if (!fn) break // 缺迁移函数：停在当前版本（不硬失败）
    current = fn(current)
    from++
    migrated = true
  }
  return { data: current, from: Number(data.schemaVersion) || 0, to: from, migrated }
}

export function validateSettings(data = {}) {
  const v = Number(data.schemaVersion)
  if (Number.isFinite(v) && v > SCHEMA_VERSION) {
    return { ok: false, error: `settings schema 版本 ${v} 高于内核支持的 ${SCHEMA_VERSION}，请升级内核` }
  }
  return { ok: true, error: null }
}

export function loadSettings({ configDir = '', cwd = '', local = {}, env = process.env } = {}) {
  const userPath = configDir ? join(configDir, 'settings.json') : ''
  const projectPath = cwd ? join(cwd, '.ponos', 'settings.json') : ''
  const user = readJson(userPath)
  const project = readJson(projectPath)
  // 迁移只对已存在的 user 文件执行：无文件 = 无配置，merged 保持空（P4 既有语义）
  const { data: migratedUser, migrated } = userPath && existsSync(userPath)
    ? migrateSettings(user)
    : { data: user, migrated: false }

  // ★★ 2026-10-18 AI-05 修复：迁移后**原子回写 + 留 .bak**。
  //
  // 原状：`migrateSettings(user)` 的结果只用于内存合并，**从不写回** settings.json ⇒
  //   · 磁盘上的 schemaVersion 永远停在旧值，任何"按版本判断"的下游逻辑（诊断/兼容分支/
  //     "是否需提示用户重新配置"）永远看到旧版本；
  //   · 每次启动都要串行重跑整条迁移链，迁移链越长代价越大（未来 v1→v2→v3 会放大）。
  //
  // 三条纪律（缺一就会把"版本号没更新"变成"启动坏了"）：
  //   ① 只在**真的发生迁移**（migrated === true）时写 —— 已是最新版本时不碰磁盘，
  //      否则每次启动都产生无谓写与 .bak 堆积（有测试钉住）；
  //   ② 写前留 `.bak`（迁移前原样内容）—— 迁移函数写错了用户还能拿回原文件；
  //   ③ 写失败**只记日志、绝不抛** —— 配置读得出来比"版本号新"重要得多，
  //      绝不能因为写不进去（只读盘/权限/杀软占用）而让内核起不来。
  if (migrated && userPath) {
    try {
      if (existsSync(userPath)) {
        // .bak 必须是**迁移前**的原样内容：从磁盘再读一次（不依赖内存里的 user，
        // 因为 readJson 对坏 JSON 返回 {}，那样备份下来的就不是原文件了）
        try {
          const rawOriginal = readFileSync(userPath, 'utf8')
          writeFileSync(`${userPath}.bak`, rawOriginal, 'utf8')
        } catch (e) {
          // 备份失败不阻断回写本身（回写仍有价值），但要出声
          console.warn('[settings] 迁移前备份 .bak 失败（继续回写）:', e?.message || e)
        }
      }
      // ★★ 2026-10-18：改用 writeFileAtomicSync（**fsync 后 rename** + rename 重试 + 失败清理）。
      //   原来是手写 `writeFileSync(tmp) + renameSync`，**没有 fsync** ⇒ 断电时
      //   rename 可能先于数据落盘被持久化 ⇒ settings.json 变成空文件/半截 JSON。
      //   后果：`loadSettings` 读坏会退回默认配置，用户的设置"莫名其妙没了"，
      //   且**不报错**（用户只看到"我的配置怎么变回去了"）。
      //   `shared/atomic-write.mjs` 文件头写着"必须 fsync 文件再 rename"，本处此前没照做。
      writeFileAtomicSync(userPath, JSON.stringify(migratedUser, null, 2))
    } catch (e) {
      // 按纪律 ③：只出声，不抛
      console.warn('[settings] 迁移结果回写失败（已忽略，不影响本次运行）:', e?.message || e)
    }
  }

  const valid = validateSettings(migratedUser)

  // ── 客户层（E2 Task 4）：<configDir>/customer-<id>.json，id 来自 env `PONOS_CUSTOMER_ID` ──
  // ⚠️ `readJson` 的既有语义：**文件不存在返回 `{}`**，坏 JSON 也返回 `{}`（`catch { return {} }`）。
  //    于是客户层"不存在"与"坏文件"最终都退化为 `{}` = **等效于不加该层**（退化为上层值，不抛）。
  //    这是沿用既有容错纪律的**有意**选择：分层文件是用户可手改的普通 JSON，读失败就崩会让内核
  //    （以及整个应用）起不来，代价远大于"客户层这一份读丢了"。**但它确实是可观测性缺口**：
  //    下面 `customerLayer` / `paths.customer` / `provenance` 能说明"客户层有没有参与、键从哪来"，
  //    若客户层存在却读坏，`customer` 会是 `{}` —— 届时清单里就不会有 `← 客户层`，可据此发现。
  const cust = resolveCustomerLayer({ configDir, env })
  const customer = cust.path ? readJson(cust.path) : {}
  const notice = cust.reason === 'invalid-id'
    // 出声（且**不抛**）：非法 id 往往正是有人在试探路径穿越，静默跳过等于把这件事藏了。
    ? `${CUSTOMER_ID_ENV}=${JSON.stringify(cust.id)} 含路径分隔符 / ".." / 控制字符或白名单外字符 ⇒ 客户层已跳过（该值会被拼进文件名，未校验即路径穿越）`
    : ''
  if (notice) console.warn(`[settings] ${notice}`)

  return {
    user: migratedUser,
    customer,
    project,
    local,
    // 层序：user < customer < project < local（客户层覆盖默认层，本机层覆盖客户层）
    merged: deepMerge(deepMerge(deepMerge(migratedUser, customer), project), local),
    paths: { user: userPath, customer: cust.path, project: projectPath },
    // 客户层可观测面：id（非法时是原始输入，仅供报错看）、参与状态、逐项生效清单。
    customerId: cust.id,
    customerLayer: cust.reason,
    notice,
    // 未设 env ⇒ customer 恒为 `{}` 且不参与合并 ⇒ 存量零变化（有测试钉住）。
    provenance: settingsProvenance({ user: migratedUser, customer, project, local }),
    schema: { version: SCHEMA_VERSION, migrated, error: valid.error },
  }
}

// —— D1-2 配置漂移检测：运行配置 vs schema 默认值 ——
export const SETTINGS_DEFAULTS = {
  model: '',
  maxOutputTokens: 64000,
  autoApproveHighRisk: false,
  // 审批档位（2026-09-12 四档化）：'' = 未设置 → 由 --approval-mode / 旧 flag 派生。
  // 刻意不动 SCHEMA_VERSION、不加迁移：缺键本就是"走派生"，迁移会无谓改写所有用户的
  // settings.json（且这类写盘会触发 .bak 轮转）。
  approvalMode: '',
  disallowedTools: [],
  env: {},
  compact: { thresholdTokens: 0, reserveTokens: 0, maxToolResults: 0 },
  // memory 的两个 S3 灰度位（injectMode / injectMaxBytes）**不在这里声明默认值**：
  // SETTINGS_DEFAULTS 的消费方 diffFromDefault 是"整键 JSON 相等"比较，多两个键会让
  // "只设了 memory.inject" 的用户被误报为配置漂移；且默认值放两处就必然漂移。
  // 它们的单一权威在 kernel/knowledge-inject.mjs 的 resolveInjectMode / resolveInjectBudget
  // （缺省 legacy / 4096 = 既有行为），settings.json 里可缺、可写（validateSettings 不校验子键）。
  memory: { inject: true, capture: true },
  // skill.catalogBudgetBytes（技能清单字节天花板，2026-09-26 Task 2 收尾轮）**刻意不登记在此**，
  // 与上面 memory.injectMode/injectMaxBytes、以及 workflow.publicLimit 同款理由：
  //   · diffFromDefault 是"整键 JSON 相等"比较，登记 `skill: {…}` 会让"只设了 skill 子键"的用户
  //     被当成配置漂移（多一处误报来源）；
  //   · 更关键的是**值不能有默认数字**：预算是"降级【可用技能】清单（触发词→描述→仅列 id）"的开关，
  //     给默认数字 = 替所有存量用户静默改提示词形态。故语义只有两态：缺省/null = 不设限，
  //     正数 = 上限字节。它的**单一权威**是 kernel/prompt.mjs#resolveSkillCatalogBudget
  //     （被 kernel/cli.mjs 在组装系统提示词时调用一次）。settings.json 里可缺、可写
  //     （validateSettings 只校验顶层 schemaVersion，不校验子键）。
  hooks: [],
}

export function diffFromDefault(settings = {}) {
  const out = []
  for (const k of Object.keys(SETTINGS_DEFAULTS)) {
    if (settings[k] === undefined) continue
    if (JSON.stringify(settings[k]) !== JSON.stringify(SETTINGS_DEFAULTS[k])) {
      out.push({ key: k, value: settings[k], default: SETTINGS_DEFAULTS[k] })
    }
  }
  return out
}
