/**
 * 模块注册表（纯逻辑，不依赖 electron，可单测）。
 * 内置模块清单 + 外部模块 manifest 解析器。
 * 外部模块完整扫描/加载在阶段 B 启用；本文件已含 schema 校验（parseManifest）。
 */
'use strict'

const BUILTIN_MODULES = [
  {
    id: 'dock', name: '导航栏', icon: 'vortex', singleton: true, builtin: true,
    windowSpec: { width: 64, height: 480, minWidth: 48, minHeight: 200, resizable: false, frame: false },
  },
  {
    id: 'cockpit', name: '驾驶舱', icon: 'layout-dashboard', singleton: true, builtin: true,
    windowSpec: { width: 1200, height: 800, minWidth: 900, minHeight: 600, resizable: true, frame: false },
  },
  {
    id: 'chat', name: '聊天', icon: 'message-square', singleton: false, builtin: true,
    windowSpec: { width: 900, height: 700, minWidth: 600, minHeight: 400, resizable: true, frame: false },
    capabilities: ['anchor-host'],  // 可作吸附锚点（积木式拼接主体）
  },
  {
    id: 'files', name: '文件', icon: 'folder', singleton: true, builtin: true,
    windowSpec: { width: 820, height: 640, minWidth: 480, minHeight: 320, resizable: true, frame: false },
  },
  {
    id: 'settings', name: '设置', icon: 'settings', singleton: true, builtin: true,
    windowSpec: { width: 720, height: 640, minWidth: 480, minHeight: 400, resizable: true, frame: false },
  },
  {
    id: 'skills', name: '技能', icon: 'sparkles', singleton: true, builtin: true,
    windowSpec: { width: 900, height: 700, minWidth: 560, minHeight: 400, resizable: true, frame: false },
  },
  {
    id: 'approval', name: '审批', icon: 'shield-check', singleton: true, builtin: true,
    windowSpec: { width: 520, height: 360, minWidth: 440, minHeight: 300, resizable: false, frame: false },
  },
  {
    id: 'panel', name: '面板', icon: 'list', singleton: false, builtin: true,
    windowSpec: { width: 280, height: 400, minWidth: 240, minHeight: 240, resizable: true, frame: false },
  },
  {
    id: 'question', name: '提问', icon: 'help-circle', singleton: false, builtin: true,
    windowSpec: { width: 560, height: 420, minWidth: 480, minHeight: 320, resizable: true, frame: false },
  },
  {
    id: 'sessions', name: '会话管理', icon: 'history', singleton: true, builtin: true,
    windowSpec: { width: 340, height: 720, minWidth: 300, minHeight: 400, resizable: true, frame: false },
    capabilities: ['anchor'],  // 可吸附到锚点窗口侧边（积木式拼接）
  },
]

const REQUIRED_MANIFEST_FIELDS = ['id', 'name', 'entry', 'windowSpec']

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
  const ws = raw.windowSpec
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
