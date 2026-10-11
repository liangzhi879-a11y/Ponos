'use strict'
// shared/vault-credential.cjs —— 服务商凭据「密码库化」的**唯一真源**（CJS：main 与桥双用）
//
// 为什么是 .cjs：本模块必须被两侧共用 —— `server/bridge.mjs`（ESM，经 `vault-credential.mjs`
// 转发）与 `electron/main.cjs`（CJS）。两侧各写一份的后果不是"多几行"，而是**指针形态漂移**：
// main 按 A 形态写盘、桥按 B 形态识别 ⇒ config.json 里的令牌被当成"没配"（fail-closed 下表现为
// 模型调用没有凭据，且没有任何一处报错）。先例：`server/bridge-token.cjs`、`shared/proxy-config.cjs`。
//
// ★ 威胁模型（Global Constraints 末条，**别读成"防同用户进程"**）：
//   同一用户的任意进程本就能读 `<home>/runtime/bridge-token` 与 `config.json`、并能连 127.0.0.1
//   的桥。因此本轮把凭据搬进 `vault.enc`（OS 安全存储加密，仅主进程能解）的收益是
//   **静态落盘保护**：文件被拷走 / 进备份 / 上云同步时读到的是密文或指针，而不是真令牌。
//   它**不是**"防同用户进程读凭据"——那需要另一个威胁模型（进程隔离/权限模型），本轮不做，
//   也不得对外宣称做到了。
//
// 两处落盘形态：
//   · `config.json` 的 `providers[].authToken` → **指针** `{ enc:1, k:'provider:<id>:token' }`，
//     真值在 `<home>/vault.enc`。刻意**不**把密文抄进 config.json：密文的家是 vault.enc
//     （那才是"入密码库"的交付物），两处都存 = 两份真相，回填/删除时必然漂移。
//   · `settings.json` 的 `env.<凭据键>` → **空串**（内核的 `settings.env` 只对"缺失键"兜底，
//     空串在 `kernel/cli.mjs` 是 falsy ⇒ 语义等于"没有凭据"；真值经 spawn env 注入，
//     见 `server/bridge.mjs#buildChildEnv`）。**为什么必须一起堵**：`syncKernelSettings`
//     会整份重写 settings.json，漏了它下一次写就会把明文再落回去。
//
// 键名与渲染层**同名**：`src/lib/providerSecrets.ts#providerTokenKey` 用的就是
// `provider:<id>:token`。★ 该模块是**约定的**渲染层实现，**当前未被任何应用代码调用（未接线）**——
// 将来接线时必须写**指针**（照本模块的 `vaultPointer`：`{ enc:1, k:'provider:<id>:token' }`），
// **不要**写 `authToken:''` 或明文：桥按指针判断"这个 provider 有没有凭据"，写成 `''` 就是
// "没配"（静默 fail-closed，模型调用没有凭据且没有一处报错）；写成明文则等于没加密。
// 键名一致性由 `server/vault-client.test.mjs` 读源文件比对钉住。

/** 指针信封版本（形态变更时的迁移位；不认识就**拒绝**当指针，见 isVaultPointer） */
const ENC_VERSION = 1

/** 回显给界面的令牌占位（保存时按磁盘现值回填，见 restoreRedactedProviderTokens）。
 *  与 `shared/proxy-config.cjs#REDACTED_PASSWORD` 取同一个字面量：界面侧只需认识一个占位符。 */
const REDACTED_TOKEN = '***'

/**
 * 供应商令牌在密码库中的键名。**必须**与 `src/lib/providerSecrets.ts#providerTokenKey` 逐字相同。
 * @param {string} providerId
 * @returns {string}
 */
function providerTokenVaultKey(providerId) {
  return 'provider:' + String(providerId) + ':token'
}

// ★ 单一真源：秘密键名从 `shared/legacy-env.mjs` 派生（CJS→ESM 的 require 在本仓既有先例：
//   `electron/main.cjs` 就 `require('../server/experience.mjs')`；Node ≥22.12 支持 require(esm)）。
const { secretCredentialEnvKeys } = require('./legacy-env.mjs')

/**
 * 历史遗留的 settings.json 凭据键（老版本可能残留 ANTHROPIC_*；内核经 legacy-env 映射回主名）。
 *
 * ★ **从唯一真源派生，不得手写**（2026-09-26 复审在真机上实测出的洞）：
 *   此前这里手写 6 键、**漏了 `PONOS_VISION_AUTH_TOKEN`** —— 而 `kernel/media-tools.mjs` 读的
 *   **正是**该键（`syncKernelSettings` 写的却是 `YFW_VISION_AUTH_TOKEN`，内核侧无读者）。
 *   后果：真数据根上的 vision 明文**既不会被迁移清掉、也不会被同步钉成空串**（活漏洞）。
 *   现由 `secretCredentialEnvKeys()` 派生 ⇒ 将来新增/改名别名会**自动**纳入，不会再漏。
 *
 * `OPENAI_API_KEY` 为**显式补充**：别名表未登记它，但老配置里可能存在。
 *
 * @type {string[]}
 */
const SETTINGS_CREDENTIAL_ENV_KEYS = [
  ...new Set([...secretCredentialEnvKeys(), 'OPENAI_API_KEY']),
]

/**
 * 迁移 settings.json 时用的库键名（前缀区分于 provider 令牌，避免互相覆盖）。
 *
 * ★ **当前没有读者**（`git grep legacy.settings` 只命中迁移与测试；`server/bridge.mjs#buildChildEnv`
 *   只认 `provider:<id>:token`）。迁移把这些键清成 `''` 之后，内核**拿不到** settings.json 里那份
 *   凭据（凭据只经 spawn env 注入）⇒ 这份库键是**备份用途**：值不会丢，但要恢复得**人工**从
 *   密码库取回并写回 settings.json（或配成 provider 令牌）。
 *   ⇒ **不得**读成"settings.json 里的凭据迁移后仍可被内核取用"（那需要一个真读者，本轮没做）；
 *   也**不得**把它当成"已加密 + 仍然可用"。
 * @param {string} envKey
 */
function legacySettingsVaultKey(envKey) {
  return 'legacy.settings.' + String(envKey)
}

/**
 * 是否"密码库指针"。版本不认识的**不**当指针（当指针会让桥拿一个解不开的键去问，
 * 表现为"配了却用不了"；不当指针则它是明文分支，至少不假装成功）。
 * @param {unknown} v
 */
function isVaultPointer(v) {
  return !!(v && typeof v === 'object' && v.enc === ENC_VERSION && typeof v.k === 'string' && v.k)
}

/**
 * 构造指针。
 * @param {string} key 密码库键名
 */
function vaultPointer(key) {
  return { enc: ENC_VERSION, k: String(key) }
}

/** 明文令牌：**只**认字符串。指针/数字/对象/undefined ⇒ ''（绝不把对象拿去当令牌发请求） */
function plainTokenOf(v) {
  return typeof v === 'string' ? v : ''
}

/** 是否需要"回填"（界面把占位符回传了） */
function isRedactedToken(v) {
  return v === REDACTED_TOKEN
}

/**
 * 单个 provider 的界面回显形态：有令牌（明文或指针）⇒ `***`，没有 ⇒ `''`。
 * 为什么不回明文：`/config`、`/providers` 是渲染层全量读取的端点，值会进界面状态、截图、日志。
 * @param {any} provider
 */
function redactProviderToken(provider) {
  const p = provider && typeof provider === 'object' ? provider : {}
  const has = isVaultPointer(p.authToken) || plainTokenOf(p.authToken) !== ''
  return { ...p, authToken: has ? REDACTED_TOKEN : '' }
}

/**
 * 整份 config 的界面回显形态（只动 providers[].authToken，其余键原样）。
 * @param {any} cfg
 */
function redactProviderTokens(cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : {}
  if (!Array.isArray(c.providers)) return { ...c }
  return { ...c, providers: c.providers.map(redactProviderToken) }
}

/**
 * 回填：把入参里 `authToken === '***'` 的 provider 换成**磁盘现值**。
 *
 * 为什么必须有这一步（本仓已踩过，见 `server/bridge.mjs` 的 `restoreRedactedProxyUrl` 注释）：
 * 打码后的值会被渲染层放进 state 再回传保存，不打码就落盘 = 用户令牌被字面量 `***` 覆盖，
 * 事后表现为"模型突然 401、配置页看着明明有值"。
 *
 * 语义：
 *   · `'***'` ⇒ 回填磁盘现值（**不写占位符**）
 *   · 字符串（含 `''`）⇒ 原样（`''` = 用户显式清空，是有效意图，不在这里吞掉）
 *   · 键缺失/undefined ⇒ 保留磁盘现值（整份替换的调用方可能被 `stripSecretsFromPersisted`
 *     剥掉了秘密，把它读成"清空"就是**销毁凭据**；宁可留，也不误删——同
 *     `src/lib/providerSecrets.ts#planSecretSync` 的立场）
 * @param {any} incoming 入参（含 providers 数组时才有动作）
 * @param {any} current  磁盘现值（loadConfig() 的结果）
 */
function restoreRedactedProviderTokens(incoming, current) {
  const inc = incoming && typeof incoming === 'object' ? incoming : {}
  if (!Array.isArray(inc.providers)) return inc
  const byId = new Map()
  for (const p of (current && current.providers) || []) {
    if (p && typeof p.id === 'string') byId.set(p.id, p)
  }
  return {
    ...inc,
    providers: inc.providers.map((p) => {
      if (!p || typeof p !== 'object') return p
      const prev = byId.get(p.id)
      const prevTok = prev ? prev.authToken : undefined
      const tok = p.authToken
      if (tovKeep(tok)) return { ...p, authToken: prevTok === undefined ? '' : prevTok }
      if (isRedactedToken(tok)) return { ...p, authToken: prevTok === undefined ? '' : prevTok }
      return p
    }),
  }
}

/** 缺失/undefined 的判定（单独成函数只为让上面那条分支读得出来） */
function tovKeep(v) {
  return v === undefined || v === null
}

module.exports = {
  ENC_VERSION,
  REDACTED_TOKEN,
  SETTINGS_CREDENTIAL_ENV_KEYS,
  providerTokenVaultKey,
  legacySettingsVaultKey,
  isVaultPointer,
  vaultPointer,
  plainTokenOf,
  isRedactedToken,
  redactProviderToken,
  redactProviderTokens,
  restoreRedactedProviderTokens,
}
