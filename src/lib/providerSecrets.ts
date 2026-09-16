// src/lib/providerSecrets.ts —— 把模型供应商密钥从"明文落盘"迁到密码库
//
// 背景（实测，不是假设）：
//   · `settingsStore` 用 zustand persist 把整个 settings 写进 localStorage，
//     `providers[].authToken`（真实的模型 API Key）与历史遗留 `apiKey` 都是明文；
//   · 更严重的一路在 <YFW_HOME>/config.json（由 bridge 持久化，权限曾是 0666 世界可读）。
//   本模块负责**渲染层这一半**：密钥的唯一真相源改成密码库（safeStorage 加密），
//   localStorage 只留"非秘密"的配置。
//
// 为什么拆成纯函数：迁移是**一次性的、有破坏性判断的**操作（"以谁为准"），
// 一旦判错就是把用户的密钥清掉。逻辑放 `.ts` + 单测，才谈得上"验证过"；
// 组件里写这段就等于没法测。
//
// 分工：
//   · 本模块 = 纯逻辑（收集/比对/决策），无 IO；
//   · `src/stores/settingsStore.ts` = 调用方（注水、写回、擦除 localStorage）。
import type { AppSettings, ModelProvider } from '@/types'

/** 供应商 authToken 在库中的键名（带前缀避免与用户密码条目/将来其它密钥混淆） */
export const providerTokenKey = (providerId: string): string => `provider:${providerId}:token`
/** 历史遗留的单一 apiKey（providers 之前的老字段），迁移后等同处理 */
export const LEGACY_API_KEY = 'legacy:apiKey'

/** 从 localStorage 的持久化副本里**抽掉**秘密：persist 的 partialize 用它。
 * 注意这里只改"要落盘的那份"，不碰内存状态——否则正在用的密钥会当场消失。 */
export function stripSecretsFromPersisted(settings: AppSettings): AppSettings {
  return {
    ...settings,
    apiKey: '',
    providers: (settings.providers || []).map(p => ({ ...p, authToken: '' })),
  }
}

/** 收集"内存里当前实际持有的密钥"（只收非空值，空值不写库） */
export function collectSecrets(settings: AppSettings): Record<string, string> {
  const out: Record<string, string> = {}
  for (const p of settings.providers || []) {
    if (p && typeof p.id === 'string' && typeof p.authToken === 'string' && p.authToken !== '') {
      out[providerTokenKey(p.id)] = p.authToken
    }
  }
  if (typeof settings.apiKey === 'string' && settings.apiKey !== '') {
    out[LEGACY_API_KEY] = settings.apiKey
  }
  return out
}

/**
 * 首次注水决策。两类动作分开表达，调用方必须分清：
 *   · toWrite  = 内存里有、库里没有 ⇒ **迁移**（把既有明文搬进库，之后才能安全擦除 localStorage）
 *   · toApply  = 库里有值 ⇒ 注回内存（库是唯一真相源）
 * 冲突时 **库优先**：库里已有值说明此前已迁移过，内存里的那个可能是任何旧副本，
 * 不能反过来用旧副本覆盖。宁可用库（可信源）。
 * 库里**没有**、内存也**没有** ⇒ 什么都不做（区别于"有值但为空"）。
 */
export function planHydration(
  inMemory: Record<string, string>,
  fromVault: Record<string, string>,
): { toWrite: Record<string, string>; toApply: Record<string, string> } {
  const toWrite: Record<string, string> = {}
  const toApply: Record<string, string> = {}
  for (const [k, v] of Object.entries(inMemory)) {
    if (v === '') continue
    if (!(k in fromVault)) toWrite[k] = v          // 首次迁移：只有内存有
  }
  for (const [k, v] of Object.entries(fromVault)) {
    if (typeof v === 'string' && v !== '') toApply[k] = v   // 库优先，覆盖内存
  }
  return { toWrite, toApply }
}

/**
 * 运行期差量同步：只报"需要写的"，**不推断删除**。
 *
 * 为什么不推断删除：整库同步若把"库里存在、内存里没有"的键当删除，那么
 * "注水还没完成时先跑了一次同步"就会把全部密钥清掉（内存此刻本来就还没有值）。
 * 破坏性动作必须显式表达，不能由"没看到"推断出来：
 *   · 用户清空某个 token 输入框 ⇒ 内存里是 '' ⇒ 这里会报 { key: '' }，等价删除；
 *   · 用户删掉整个供应商 ⇒ 由调用方在该动作里显式调 `deleteProviderSecret()`。
 * 另外，库里存在而内存没有的键（可能由其它窗口写入）一律不动——宁可留，也不误删密钥。
 */
export function planSecretSync(
  inMemory: Record<string, string>,
  inVault: Record<string, string>,
): Record<string, string> {
  const ops: Record<string, string> = {}
  for (const [k, v] of Object.entries(inMemory)) {
    if (inVault[k] !== v) ops[k] = v
  }
  return ops
}

/** 把库里取回的密钥注回 settings（不改其它字段；只认已知键，忽略陌生键） */
export function applySecretsToSettings(settings: AppSettings, secrets: Record<string, string>): AppSettings {
  const providers: ModelProvider[] = (settings.providers || []).map(p => {
    const v = secrets[providerTokenKey(p.id)]
    return typeof v === 'string' && v !== '' ? { ...p, authToken: v } : p
  })
  const legacy = secrets[LEGACY_API_KEY]
  return {
    ...settings,
    providers,
    apiKey: typeof legacy === 'string' && legacy !== '' ? legacy : settings.apiKey,
  }
}

/**
 * 注水完成闸门（防"注水前的空内存"被当成真相）。
 *
 * 启动顺序是：store 从 localStorage 起身（此时**没有**密钥，因为落盘那份已被剥离）
 * → 异步从库取密钥 → 注回内存。如果同步逻辑在这中间跑过，它会认为"所有密钥都该是空的"。
 * 因此用一个显式闸门：注水完成前，任何写回都直接跳过。
 * 这不是过度设计——它挡的是"把用户全部 API Key 清掉"这种不可恢复的后果。
 */
export function createHydrationGate() {
  let hydrated = false
  return {
    markHydrated: () => { hydrated = true },
    isHydrated: () => hydrated,
    /** 注水完成前返回 false，调用方据此跳过写回 */
    canSync: () => hydrated,
  }
}
