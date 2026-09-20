// kit/lib/contract-tools.mjs —— 工具 input_schema 提取器（DevKit P1 · T4）
//
// 设计不变量（每条都由 kit/lib/contract-tools.test.mjs 的断言钉住）：
//   I1 **双路交叉校验**：
//        ① 运行时出口：`(await import('<root>/kernel/tools.mjs')).createToolRegistry({cwd}).toolSchemas()`
//           —— 这是模型真正看到的那份（实测 21 条，无网络无副作用）；
//        ② 静态解析：`kernel/tools.mjs` 里 `const registry = { … }` 的顶层键（4 空格缩进）。
//      `names` = 两路的并集 ⇒ "注册表有、出口没有"和"出口有、注册表没有"都会让
//      `names.length !== staticCount`，一眼可见（只信一路就会静默丢工具）。
//   I2 `shapeOf(name)` 只取**结构指纹**（批 F 起**递归**）：`type` / `enum`（排序后比较）/
//      `items`（数组元素）/**嵌套** `properties` / `required`（排序）/ `additionalProperties`（存在性）/
//      `pattern`·`format`（取值约束），深度上限 8（超出记 `nested:'<deep>'`）→ 规范化 JSON → sha256 前 8 位。
//      ★ **description 散文绝不入哈希**（plan §7 反例 ⑩）：改文案即红会让门禁被基线淹没 = 噪声门禁。
//      已知边界（批 F 之后的**现行**口径，如实写下）：散文/展示（`description`/`title`/`examples`）、
//      数值范围（`minimum`/`maximum`/`minLength`/`maxLength`/`minItems`/`maxItems`/`uniqueItems`/`multipleOf`）、
//      `default`、元信息（`deprecated`/`readOnly`/`writeOnly`）、组合子（`$ref`/`oneOf`/`anyOf`/`allOf`，
//      真仓零使用）**仍不入指纹**。这是**有意的取舍**，不是遗漏：名单由 `contract-tools.test.mjs`
//      的「批 F④」关键字守卫钉住 —— 真仓出现"结构类关键字"却没进名单时**直接失败**，逼后来者显式决定。
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

/** 指纹深度上限（防病态/自引用式嵌套把规范化输入吹爆；超出记 `nested:'<deep>'`） */
const MAX_DEPTH = 8

/** 取值约束里**纳入指纹**的字符串键（调用方要按它们构造入参 ⇒ 属"输入形状"） */
const SHAPE_KEYS = ['pattern', 'format']

/** 排序键：任意 JSON 标量的稳定字符串（`enum` 值可能是串/数/布尔/null） */
const sortKey = (v) => (typeof v === 'string' ? `s:${v}` : `j:${JSON.stringify(v) ?? 'undefined'}`)

/**
 * 单个 schema 节点的结构（**递归**；只取结构，绝不取散文）。
 * ★ 批 F（2026-09-19）把指纹从"只有顶层"扩到**递归**，纳入：
 *   `type` / `enum`（**排序后**比较 —— 换顺序不算契约变更）/ `items`（数组元素，递归）/
 *   `properties`（含**嵌套**对象字段，递归）/ `required`（排序）/ `additionalProperties`（存在性即判据）/
 *   `pattern`·`format`（取值约束）。
 *   **仍不纳入**（见 `kit/README.md` 的边界说明，以及 `contract-tools.test.mjs` 的"关键字守卫"测试）：
 *   散文与展示字段（`description`/`title`/`examples`）、数值范围（`minimum`/`maximum`/`minLength`…）、
 *   默认值（`default` —— 属行为不属形状）、`$ref`、`oneOf`/`anyOf`/`allOf`。
 *   守卫测试会**扫描真仓所有工具 schema**：出现"结构类关键字"却未被本函数覆盖时**直接失败**，
 *   逼着后来者显式决定（而不是静默漏判）。
 */
function shapeOfNode(node, depth) {
  const o = node && typeof node === 'object' && !Array.isArray(node) ? node : {}
  const out = {}
  out.type = Array.isArray(o.type) ? [...o.type].map(String).sort().join('|') : (typeof o.type === 'string' ? o.type : '<none>')
  // 存在性即判据：写了 `enum`（哪怕是空数组）与没写是两种契约
  if (Object.hasOwn(o, 'enum')) {
    out.enum = Array.isArray(o.enum)
      ? [...o.enum].sort((a, b) => { const x = sortKey(a), y = sortKey(b); return x < y ? -1 : x > y ? 1 : 0 })
      : '<not-array>'
  }
  for (const k of SHAPE_KEYS) if (typeof o[k] === 'string') out[k] = o[k]
  if (depth >= MAX_DEPTH) {
    if (Object.hasOwn(o, 'items') || Object.hasOwn(o, 'properties')) out.nested = '<deep>'
    return out
  }
  if (Object.hasOwn(o, 'items')) {
    out.items = Array.isArray(o.items) ? o.items.map((x) => shapeOfNode(x, depth + 1)) : shapeOfNode(o.items, depth + 1)
  }
  if (o.properties && typeof o.properties === 'object') {
    const properties = {}
    for (const k of Object.keys(o.properties).sort()) properties[k] = shapeOfNode(o.properties[k], depth + 1)
    out.properties = properties
  }
  if (Array.isArray(o.required)) out.required = [...o.required].sort()
  if (Object.hasOwn(o, 'additionalProperties')) out.additionalProperties = String(o.additionalProperties)
  return out
}

/** 结构指纹的规范化输入（**只取结构，绝不取散文**）—— 顶层节点，等价于 `shapeOfNode(schema, 0)` */
function structureOf(schema) {
  return JSON.stringify(shapeOfNode(schema, 0))
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
