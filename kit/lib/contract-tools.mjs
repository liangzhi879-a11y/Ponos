// kit/lib/contract-tools.mjs —— 工具 input_schema 提取器（DevKit P1 · T4）
//
// 设计不变量（每条都由 kit/lib/contract-tools.test.mjs 的断言钉住）：
//   I1 **双路交叉校验**：
//        ① 运行时出口：`(await import('<root>/kernel/tools.mjs')).createToolRegistry({cwd}).toolSchemas()`
//           —— 这是模型真正看到的那份（实测 21 条，无网络无副作用）；
//        ② 静态解析：`kernel/tools.mjs` 里 `const registry = { … }` 的顶层键（4 空格缩进）。
//      `names` = 两路的并集 ⇒ "注册表有、出口没有"和"出口有、注册表没有"都会让
//      `names.length !== staticCount`，一眼可见（只信一路就会静默丢工具）。
//   I2 `shapeOf(name)` 只取**结构指纹**：properties 名+类型、required、additionalProperties
//      存在性 → 规范化 JSON → sha256 前 8 位。
//      ★ **description 散文绝不入哈希**（plan §7 反例 ⑩）：改文案即红会让门禁被基线淹没 = 噪声门禁。
//      已知边界（如实写下）：枚举值 / 嵌套 properties / items 结构暂不入指纹 —— 语义变更靠
//      契约规则的"任务/图"两套测试（T7）兜，本模块不假装能判。
//   I3 动态源逐条登记（`sources`）：工作流派生工具（`kernel/dyntools.mjs`，`run_<slug>`）、
//      MCP 工具（`kernel/mcp-tools.mjs`，`mcp__<server>__<tool>`）、应用智控（`kernel/app-tools.mjs`）、
//      出网映射（`kernel/api.mjs`，tools → wire 的 `{name,description,input_schema}` 打包）。
//      它们是**随磁盘与配置变化**的工具 ⇒ 静态计数 21 不是全貌；文件不在就必须报 `present:false`
//      （"提取不到 ≠ 不存在"），而不是把条目删掉。
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const TOOLS_FILE = 'kernel/tools.mjs'

/** 动态/派生的工具来源（顺序即登记顺序；`naming` 是给 T7 判"这个工具名从哪来"的规则） */
export const TOOL_SOURCES = [
  { id: 'static', file: TOOLS_FILE, role: 'definition', naming: '字面名字（registry 顶层键）' },
  { id: 'workflow', file: 'kernel/dyntools.mjs', role: 'dynamic', naming: 'run_<slug>（每个可见工作流一条）' },
  { id: 'mcp', file: 'kernel/mcp-tools.mjs', role: 'dynamic', naming: 'mcp__<server>__<tool>（外部 MCP 服务器发现）' },
  { id: 'app', file: 'kernel/app-tools.mjs', role: 'dynamic', naming: 'appToolName(spec, action)（随已安装应用与绑定变化）' },
  { id: 'wire', file: 'kernel/api.mjs', role: 'egress', naming: '{name, description, input_schema} 出网打包（不新增工具）' },
]

/** 静态解析 `const registry = { … }` 的顶层键（4 空格缩进；真仓形态 kernel/tools.mjs:862） */
export function staticRegistryKeys(src) {
  const lines = String(src).split('\n')
  const start = lines.findIndex((l) => /^\s*(?:export\s+)?const\s+registry\s*=\s*\{/.test(l))
  if (start === -1) return []
  const keys = []
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}\}/.test(lines[i])) break            // registry 对象在 2 空格缩进的 `}` 收口
    const m = /^ {4}([A-Za-z_$][\w$]*)\s*:\s*\{/.exec(lines[i])
    if (m) keys.push(m[1])
  }
  return keys
}

/** 结构指纹的规范化输入（**只取结构，绝不取散文**） */
function structureOf(schema) {
  const s = schema && typeof schema === 'object' ? schema : {}
  const props = s.properties && typeof s.properties === 'object' ? s.properties : {}
  const properties = {}
  for (const k of Object.keys(props).sort()) {
    const p = props[k] && typeof props[k] === 'object' ? props[k] : {}
    const t = Array.isArray(p.type) ? [...p.type].sort().join('|') : (typeof p.type === 'string' ? p.type : '<none>')
    properties[k] = t
  }
  return JSON.stringify({
    type: typeof s.type === 'string' ? s.type : '<none>',
    properties,
    required: Array.isArray(s.required) ? [...s.required].sort() : [],
    // "存在性"是判据本身：`additionalProperties:false` 与"没写"是两种契约
    additionalProperties: Object.hasOwn(s, 'additionalProperties') ? String(s.additionalProperties) : '<absent>',
  })
}

/** sha256 前 8 位（指纹只用于"逐位相等"比较，不承载语义） */
export function fingerprintOf(schema) {
  return createHash('sha256').update(structureOf(schema)).digest('hex').slice(0, 8)
}

/** 读文件（读不到 → null；不抛，由 sources.present 如实表达） */
function readIfExists(root, file) {
  try { return readFileSync(join(root, file), 'utf8') } catch { return null }
}

/**
 * 提取工具名与结构指纹。
 * @param {{root: string}} p
 * @returns {Promise<{names: string[], shapeOf: (name: string) => (string|null), staticCount: number, sources: object[]}>}
 */
export async function extractTools({ root } = {}) {
  if (!root) throw new Error('extractTools: 缺少 root')

  const src = readIfExists(root, TOOLS_FILE)
  const staticKeys = src ? staticRegistryKeys(src) : []

  // 运行时出口（同进程内真跑一遍；失败不抛 —— 由 names/staticCount 的差异与 sources 表达）
  let runtimeSchemas = []
  let runtimeError = ''
  try {
    const mod = await import(pathToFileURL(join(root, TOOLS_FILE)).href)
    const reg = mod.createToolRegistry({ cwd: root })
    runtimeSchemas = reg.toolSchemas() || []
  } catch (e) {
    runtimeError = String(e && e.message ? e.message : e)
  }

  const byName = new Map()
  for (const s of runtimeSchemas) if (s && s.name) byName.set(s.name, s.input_schema)
  const names = [...new Set([...staticKeys, ...byName.keys()])].sort()

  const sources = TOOL_SOURCES.map((s) => {
    const text = readIfExists(root, s.file)
    const present = typeof text === 'string'
    const schemaSites = []
    if (present) {
      const lines = text.split('\n')
      for (let i = 0; i < lines.length; i++) if (lines[i].includes('input_schema')) schemaSites.push(i + 1)
    }
    return {
      ...s,
      present,
      schemaSites,
      // 出口侧的错误必须可见（否则"0 个工具"会被当成"这个仓没工具"）
      ...(s.id === 'static' && runtimeError ? { error: runtimeError } : {}),
    }
  })

  return {
    names,
    shapeOf: (name) => (byName.has(name) ? fingerprintOf(byName.get(name)) : null),
    staticCount: staticKeys.length,
    sources,
  }
}
