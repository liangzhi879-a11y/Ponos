// src/lib/knowledgePacksApi.ts —— 知识包市场 HTTP 客户端（S4 Task 5）
//
// 路由全表（server/knowledge-routes.mjs 的 S4 新增段；判定/安全全在后端，前端只发参数）：
//   GET  /knowledge/packs                     市场列表（清单 ∪ 已装；清单拉不到仍回 200 + indexError）
//   GET  /knowledge/packs/detail?id=          pack.json + README + 版本兼容判定
//   POST /knowledge/packs/install             { id, version?, localPath?, mode? }
//   POST /knowledge/packs/uninstall           { id }
//   POST /knowledge/packs/export              { spaceId, id, version, license, author?, repo?, tags? }
//
// 风格与 src/lib/knowledgeApi.ts 一致：**不 throw**，统一 `{ok:true,data} | {ok:false,error,status?}`，
// 4xx/5xx 都要能在面板里显示成一行提示。相对导入带 `.ts`（`node --test` 原生 TS，不认 alias）。
// baseUrl 可注入（测试用）；缺省 `config.getBridgeUrl()`——它依赖 Vite 注入，纯 node 下会抛，
// 故解析放在 try 内，保证无 Vite 的测试环境仍能返回结构化错误而不是把异常抛给调用方。
import { getBridgeUrl } from './config.ts'

const TIMEOUT_MS = 20_000
/** 写操作宽窗口：安装要解压 + 校验 + （覆盖时）整目录备份；导出要打包 zip。照 knowledgeApi 的 WRITE_TIMEOUT_MS 先例。 */
const WRITE_TIMEOUT_MS = 180_000

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; status?: number }

/** 冲突态（403 kept-user-modified）：后端**一个字节都没写**，等用户在"覆盖/保留/另存为我的空间"里选 */
export interface PackConflict {
  conflicts: string[]
  options: string[]
  message?: string
}

/** 安装/卸载/导出：失败分支比通用 ApiResult 多带 `conflicts`/`errors`（UI 要原样展示原因） */
export type PackActionResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; status?: number; errors?: string[]; conflict?: PackConflict }

export interface KnowledgePacksCallOpts {
  /** 测试注入用；缺省 getBridgeUrl() */
  baseUrl?: string
  timeoutMs?: number
}

// —— 响应形状（字段名照 server/knowledge-routes.mjs 的 `packsList`/`packsDetail` 抄，勿自创） ——

export interface KnowledgePackIndexItem {
  id: string
  name: string
  description: string
  author: string
  /** 仅展示与人工溯源用：**下载 URL 一律由后端按 registry 基址组装**（不接受清单里的任意 URL） */
  repo: string
  version: string
  tags: string[]
  docCount: number
  sizeBytes: number
  /** 仅官方清单条目可为 true */
  official: boolean
  /** 本地离线清单专用：指向本机目录（有它则详情/安装都走本地） */
  localPath?: string
  /** 已装版本（未装为 ''） */
  installedVersion: string
  onDisk: boolean
  updateAvailable: boolean
}

export interface KnowledgePacksIndexData {
  source: 'local' | 'remote' | 'none'
  registry: string
  registryOrigin: 'local' | 'config' | 'default'
  hasLocalIndex: boolean
  updatedAt: string | null
  /** 清单拉取失败的原因（断网/内网）。**不是**请求失败——已装列表与本地安装仍可用 */
  indexError: string | null
  warnings: string[]
  appVersion: string
  packs: KnowledgePackIndexItem[]
}

export interface KnowledgePackManifest {
  id: string
  name: string
  version: string
  license: string
  source: string
  minAppVersion: string
  description: string
  author: string
  homepage: string
  tags: string[]
}

export interface KnowledgePackVersionDecision {
  ok: boolean
  /** `current` = 用包自身版本；`fallback` = 按 versions.json 回退 */
  reason: string
  version?: string
  requiredMin?: string
  appVersion?: string
  error?: string
}

export interface KnowledgePackDetailData {
  pack: KnowledgePackManifest
  readme: string
  versions: Record<string, string> | null
  version: KnowledgePackVersionDecision
  installed: { version: string; files: number; onDisk: boolean; source: string } | null
  updateAvailable: boolean
  source: 'local' | 'remote' | 'none'
  registry: string
  registryOrigin: 'local' | 'config' | 'default'
  warnings: string[]
}

/** 5 态 + 第三选（与 `server/skill-install.mjs` 的 `upsertSkill` 返回值逐字一致，另加 `to-my-space`） */
export type PackInstallStatus = 'installed' | 'updated' | 'unchanged' | 'kept-user-modified' | 'skipped-empty' | 'to-my-space'

export interface PackInstallResult {
  status: PackInstallStatus
  packId: string
  version: string
  spaceId: string
  files: number
  contentBytes?: number
  docCount?: number
  /** 覆盖路径上的备份目录（整目录 rename 到 knowledge/pack-backups/<id>-<ts>） */
  backupPath?: string | null
  warnings?: string[]
}

export interface PackExportMeta {
  spaceId: string
  id: string
  version: string
  license: string
  name?: string
  author?: string
  description?: string
  repo?: string
  tags?: string[]
}

export interface PackExportResult {
  packId: string
  version: string
  spaceId: string
  packJson: KnowledgePackManifest
  /** 落盘位置：`<home>/knowledge/exports/<id>-<version>.zip` */
  zipPath: string
  zipBytes: number
  /** 可直接粘进中央清单的条目片段 */
  manifestEntry: Record<string, unknown>
  readme: string
  docCount: number
  files: number
  skipped: Array<{ rel: string; reason: string }>
}

export interface PackUninstallResult {
  packId: string
  removed: string[]
  removedCount: number
  ledgerCleared: boolean
}

export interface PackInstallInput {
  id: string
  version?: string
  /** `safe`（缺省）= 冲突时不写盘；`overwrite` = 用户明确选择覆盖（仍先备份）；`to-my-space` = 另存为可写空间 */
  mode?: 'safe' | 'overwrite' | 'to-my-space'
}

// —— 请求 ——

interface CallArgs { method?: string; body?: unknown; opts?: KnowledgePacksCallOpts; timeoutMs?: number }

/** 失败响应体：后端固定 `{ error }`（校验失败另带 `errors[]`，冲突态另带 `conflicts/options`） */
interface ErrorBody { error?: unknown; errors?: unknown; conflicts?: unknown; options?: unknown; message?: unknown }

async function call<T>(path: string, { method = 'GET', body, opts = {}, timeoutMs = TIMEOUT_MS }: CallArgs = {}): Promise<PackActionResponse<T>> {
  const ms = opts.timeoutMs ?? timeoutMs
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    const base = opts.baseUrl || getBridgeUrl()
    const res = await fetch(`${base}${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      signal: controller.signal,
    })
    const data: unknown = await res.json().catch(() => null)
    if (!res.ok) {
      const b = (data && typeof data === 'object' ? data : {}) as ErrorBody
      const errs = Array.isArray(b.errors) ? b.errors.map(String) : []
      // 冲突态（403）：把三选原样带给 UI —— 只给一句 error 文案，UI 无法区分
      // "用户改过包"（弹三选）与"校验不过"（显示原因）
      const conflict: PackConflict | undefined = Array.isArray(b.conflicts) && b.conflicts.length
        ? { conflicts: b.conflicts.map(String), options: Array.isArray(b.options) ? b.options.map(String) : [], message: b.message ? String(b.message) : undefined }
        : undefined
      return {
        ok: false,
        error: b.error ? String(b.error) : (errs[0] || `HTTP ${res.status}`),
        status: res.status,
        ...(errs.length ? { errors: errs } : {}),
        ...(conflict ? { conflict } : {}),
      }
    }
    return { ok: true, data: (data ?? null) as T }
  } catch (e: unknown) {
    const err = e as { name?: string; message?: string } | null
    const msg = err?.name === 'AbortError' ? `请求超时（${Math.round(ms / 1000)}s）` : (err?.message || String(e))
    return { ok: false, error: msg }
  } finally {
    clearTimeout(timer)
  }
}

// —— 端点 ——

/** 市场列表。清单拉不到时后端仍回 200（`data.indexError` 有原因）——UI 要把它当"提示"而非"失败"。 */
export function listPacks(opts?: KnowledgePacksCallOpts): Promise<PackActionResponse<KnowledgePacksIndexData>> {
  return call<KnowledgePacksIndexData>('/knowledge/packs', { opts })
}

export function packDetail(id: string, opts?: KnowledgePacksCallOpts): Promise<PackActionResponse<KnowledgePackDetailData>> {
  return call<KnowledgePackDetailData>(`/knowledge/packs/detail?id=${encodeURIComponent(id)}`, { opts })
}

/** 在线安装（id + 可选 version）。`version` 省略 = 用清单条目的版本（后端决定是否回退）。 */
export function installPack(input: PackInstallInput, opts?: KnowledgePacksCallOpts): Promise<PackActionResponse<PackInstallResult>> {
  return call<PackInstallResult>('/knowledge/packs/install', {
    method: 'POST',
    body: { id: input.id, ...(input.version ? { version: input.version } : {}), ...(input.mode ? { mode: input.mode } : {}) },
    opts, timeoutMs: WRITE_TIMEOUT_MS,
  })
}

/** 离线安装：`localPath` 为 zip 文件或目录（后端按**不可信输入**全量校验）。 */
export function installPackFromFile(localPath: string, mode?: PackInstallInput['mode'], opts?: KnowledgePacksCallOpts): Promise<PackActionResponse<PackInstallResult>> {
  return call<PackInstallResult>('/knowledge/packs/install', {
    method: 'POST',
    body: { localPath, ...(mode ? { mode } : {}) },
    opts, timeoutMs: WRITE_TIMEOUT_MS,
  })
}

export function uninstallPack(id: string, opts?: KnowledgePacksCallOpts): Promise<PackActionResponse<PackUninstallResult>> {
  return call<PackUninstallResult>('/knowledge/packs/uninstall', {
    method: 'POST', body: { id }, opts, timeoutMs: WRITE_TIMEOUT_MS,
  })
}

/** 导出（供给侧）：只允许可写空间；产出 zip + 清单条目片段。 */
export function exportPack(meta: PackExportMeta, opts?: KnowledgePacksCallOpts): Promise<PackActionResponse<PackExportResult>> {
  return call<PackExportResult>('/knowledge/packs/export', {
    method: 'POST', body: { ...meta }, opts, timeoutMs: WRITE_TIMEOUT_MS,
  })
}
