/**
 * 模块注册表（纯逻辑，不依赖 electron，可单测）。
 * 内置模块清单 + 外部模块 manifest 解析器。
 * 外部模块完整扫描/加载在阶段 B 启用；本文件已含 schema 校验（parseManifest）。
 *
 * P1 收敛：BUILTIN_MODULES 仅保留计划所需两个内置模块（launcher、chat）。
 * 其余 dock/cockpit/files/skills/approval/panel/question/sessions 为
 * YFWorking 旧基线遗留，超出 P1 范围（阶段 B 起由外部 manifest 扫描承担）。
 * P2 扩展：新增 state-manager（node-worker 运行时进程）与 settings（ui-renderer 窗口）。
 * entry.ui 为仓库根相对路径（repo root = harness/src 的 ../..）；entry.main 为 node-worker 进程入口。
 */
'use strict'

const BUILTIN_MODULES = [
  {
    id: 'launcher', name: '启动台', icon: 'vortex', singleton: true, builtin: true,
    windowSpec: { width: 480, height: 640, minWidth: 360, minHeight: 480, resizable: true, frame: false },
    capabilities: ['system.modules', 'system.window'],
    entry: { ui: 'dist/modules/launcher/index.html' },
  },
  {
    id: 'chat', name: '聊天', icon: 'message-square', singleton: false, builtin: true,
    windowSpec: { width: 900, height: 700, minWidth: 600, minHeight: 400, resizable: true, frame: false },
    capabilities: ['system.window', 'agent'],  // 与 modules/chat/module.json 对齐：可开窗 + 直连 agent
    entry: { ui: 'dist/modules/chat/index.html' },
  },
  {
    id: 'state-manager', name: '状态服务', icon: 'database', singleton: true, builtin: true,
    runtime: 'node-worker',
    capabilities: ['state'],
    entry: { main: 'modules/state-manager/main.cjs' },  // repo-root 相对（node-worker 进程入口）
  },
  {
    id: 'settings', name: '设置', icon: 'settings', singleton: false, builtin: true,
    windowSpec: { width: 720, height: 560, minWidth: 480, minHeight: 400, resizable: true, frame: false },
    capabilities: ['state'],  // 与 modules/settings/module.json 对齐：读/写全局状态
    entry: { ui: 'dist/modules/settings/index.html' },
  },
]

// REQUIRED_MANIFEST_FIELDS 放宽：windowSpec 仅 ui-renderer 语义必需，node-worker/cli-bridge 无窗口
const REQUIRED_MANIFEST_FIELDS = ['id', 'name', 'entry']

function listModules() {
  // 阶段 B：合并 scanExternalModules() 结果
  return BUILTIN_MODULES.map(m => ({ ...m }))
}

function getModule(id) {
  return BUILTIN_MODULES.find(m => m.id === id)
}

// entry 归一化：旧字符串 → { ui }；对象保持，ui-renderer 缺 main 也可
function normalizeEntry(raw) {
  if (typeof raw === 'string' && raw.length > 0) return { ui: raw }
  if (raw && typeof raw === 'object') {
    const out = {}
    if (typeof raw.ui === 'string' && raw.ui.length > 0) out.ui = raw.ui
    if (typeof raw.main === 'string' && raw.main.length > 0) out.main = raw.main
    return Object.keys(out).length > 0 ? out : null
  }
  return null
}

/**
 * 解析并校验外部模块 manifest.json。
 * 返回 { ok:true, manifest } 或 { ok:false, error }。不读取文件系统（调用方负责读文件）。
 */
function parseManifest(jsonText, baseDir) {
  let raw
  try {
    raw = JSON.parse(jsonText)
  } catch {
    return { ok: false, error: 'manifest JSON 解析失败' }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'manifest 必须是 JSON 对象' }
  }
  for (const f of REQUIRED_MANIFEST_FIELDS) {
    if (raw[f] === undefined || raw[f] === null || raw[f] === '') {
      return { ok: false, error: `manifest 缺少必需字段: ${f}` }
    }
  }
  const entry = normalizeEntry(raw.entry)
  if (!entry) return { ok: false, error: 'manifest entry 必须为非空字符串或 { ui|main } 对象' }
  const ws = raw.windowSpec || {}  // node-worker/cli-bridge 可无窗口 → 回落默认
  const num = (v, dft) => (typeof v === 'number' && Number.isFinite(v) && v > 0) ? Math.round(v) : dft
  const manifest = {
    id: String(raw.id),
    name: String(raw.name),
    version: typeof raw.version === 'string' ? raw.version : '0.0.0',
    icon: typeof raw.icon === 'string' ? raw.icon : '',
    runtime: ['ui-renderer', 'node-worker', 'cli-bridge'].includes(raw.runtime) ? raw.runtime : 'ui-renderer',
    entry,
    baseDir: String(baseDir || ''),
    windowSpec: {
      width: num(ws.width, 640),
      height: num(ws.height, 480),
      minWidth: num(ws.minWidth, 320),
      minHeight: num(ws.minHeight, 240),
      resizable: ws.resizable !== false,
      frame: ws.frame === true,
    },
    singleton: raw.singleton !== false,
    channels: Array.isArray(raw.channels) ? raw.channels.map(c => String(c)) : [],
    permissions: Array.isArray(raw.permissions) ? raw.permissions.map(p => String(p)) : [],
    interfaces: {
      provides: Array.isArray(raw.interfaces?.provides) ? raw.interfaces.provides : [],
      consumes: Array.isArray(raw.interfaces?.consumes) ? raw.interfaces.consumes : [],
    },
    capabilities: Array.isArray(raw.capabilities) ? raw.capabilities.map(c => String(c)) : [],
    lifecycle: (raw.lifecycle && typeof raw.lifecycle === 'object') ? { init: raw.lifecycle.init || null, destroy: raw.lifecycle.destroy || null } : { init: null, destroy: null },
    runtimeConfig: (raw.runtimeConfig && typeof raw.runtimeConfig === 'object') ? raw.runtimeConfig : { sandbox: {} },
    homepage: typeof raw.homepage === 'string' ? raw.homepage : '',
    author: typeof raw.author === 'string' ? raw.author : '',
  }
  return { ok: true, manifest }
}

module.exports = { listModules, getModule, parseManifest, BUILTIN_MODULES }
