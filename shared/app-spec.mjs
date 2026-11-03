/**
 * P5a（2026-10-27）：`spec.ui` 声明式视图树的**校验器（U1–U7）**。
 *
 * 为什么校验器先落、渲染器后落：**判据可以先立，排版可以后补**。
 * 校验器是纯函数（spec 进、错误清单出），装在哪里都一样跑（草稿阶段 / 安装前 / CI），
 * 而渲染沙箱要等 L2 基元齐了才有意义 —— 先把"什么样的 spec 不许进来"钉死，
 * 后面写渲染器时不会一边写一边放宽标准。
 *
 * 七条判据（设计稿 §6.7）：U1 色值 / U2 令牌档位 / U3 三态 / U4 密度与宽度 /
 * U5 点击区 / U6 文案 / U7 结构白名单。**全部是硬判据**：任何一条红 ⇒ 整个 spec 不通过。
 * 没有"警告档"—— 警告档会被人忽略，忽略多了等于没有判据。
 */

/** L2 基元白名单（应用侧专用；设计稿 §6.3） */
export const L2_COMPONENTS = Object.freeze([
  'Badge', 'Button', 'Input', 'Textarea', 'Switch', 'Tabs', 'Tooltip', 'Spinner',
  'DataTable', 'FormSection', 'StatCard', 'EmptyState', 'ErrorState', 'LoadingState', 'Timeline', 'ChartFrame',
])

/** L3 版式白名单（首批 3 个；`form`/`timeline` 二期） */
export const L3_LAYOUTS = Object.freeze(['list-detail', 'report-table', 'dashboard'])

/** 每个基元的属性白名单。**没列出的属性一律拒**（包括 `className`/`style`） */
export const PROP_WHITELIST = Object.freeze({
  Badge: ['text', 'tone'],
  Button: ['label', 'icon', 'size', 'tone', 'action', 'disabled'],
  Input: ['label', 'placeholder', 'value', 'bind'],
  Textarea: ['label', 'placeholder', 'value', 'bind', 'rows'],
  Switch: ['label', 'checked', 'bind'],
  Tabs: ['items', 'value', 'bind'],
  Tooltip: ['text'],
  Spinner: ['label'],
  DataTable: ['rows', 'columns', 'rowActions', 'density', 'emptyText'],
  FormSection: ['title', 'description', 'children'],
  StatCard: ['label', 'value', 'delta', 'tone', 'icon'],
  EmptyState: ['text', 'hint', 'icon'],
  ErrorState: ['text', 'detail', 'retry'],
  LoadingState: ['text'],
  Timeline: ['items'],
  ChartFrame: ['series', 'kind', 'title'],
})

/** 禁止出现的属性名（无论哪个组件） */
const FORBIDDEN_PROPS = Object.freeze(['className', 'style', 'dangerouslySetInnerHTML', 'css', 'ref', 'onClick'])

/** U2：只允许令牌档位 */
const SIZE_TOKENS = Object.freeze(['xs', 'sm', 'md', 'lg', 'xl'])
const DENSITY_TOKENS = Object.freeze(['compact', 'cozy'])

/** U1：硬编码色值的形态（`#rgb/#rrggbb/#rrggbbaa`、`rgb(...)`、`hsl(...)`、命名色列表里最常见的几个） */
const HARDCODED_COLOR = /(#[0-9a-f]{3,8}\b)|\b(rgba?|hsla?)\(/i
/** 允许的唯一颜色形态：`var(--token)` */
const TOKEN_COLOR = /^var\(--[a-z0-9-]+\)$/i

/** U6：空洞文案（必须说"在做什么/没什么/为什么失败"） */
const HOLLOW_COPY = Object.freeze(['加载中', '加载中...', '加载中…', 'Loading', 'Loading...', '出错了', '错误', '无数据', 'Empty'])

/** U7：图标只能是 lucide 名字（小写连字符），不许 emoji / svg / data: / URL */
const LUCIDE_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** 收集 spec 里所有可绑定的路径（`{{a.b.c}}` 必须能在其中解析） */
function bindingRoots(spec) {
  const roots = new Set(Object.keys(spec || {}))
  return roots
}

function resolvePath(spec, path) {
  // 只解析"spec 顶层键 + 顶层键下的任意层"：视图树自己的字段（如 `ui.views[0].id`）不在此列,
  // 因为绑定的是**数据**，不是视图自身 —— 允许绑定到视图会让视图互相依赖、无法静态审计。
  const parts = String(path).split('.')
  if (!parts.length) return false
  let cur = spec
  for (const p of parts) {
    if (cur === null || cur === undefined) return false
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(p)) return false
      cur = cur[Number(p)]
      continue
    }
    if (!isObj(cur)) return false
    if (!Object.prototype.hasOwnProperty.call(cur, p)) return false
    cur = cur[p]
  }
  return true
}

/** 把字符串里的 `{{path}}` 全部抽出来 */
function bindingsIn(value, out = []) {
  if (typeof value === 'string') {
    const re = /\{\{\s*([^}]+?)\s*\}\}/g
    let m
    while ((m = re.exec(value)) !== null) out.push(m[1])
    return out
  }
  if (Array.isArray(value)) {
    for (const v of value) bindingsIn(v, out)
    return out
  }
  if (isObj(value)) {
    for (const v of Object.values(value)) bindingsIn(v, out)
    return out
  }
  return out
}

/** 递归检查 props：禁属性、色值、图标、档位、文案 */
function checkProps(component, props, at, push) {
  const allow = PROP_WHITELIST[component] || []
  for (const [k, v] of Object.entries(props || {})) {
    if (FORBIDDEN_PROPS.includes(k)) {
      push('U7', `${at}.props.${k}`, `属性 ${k} 不允许（视图层不接受样式/事件/原始 HTML）`)
      continue
    }
    if (!allow.includes(k)) {
      push('U7', `${at}.props.${k}`, `组件 ${component} 没有属性 ${k}（白名单：${allow.join('/') || '无'}）`)
      continue
    }
    // U1：字符串里的颜色必须是令牌
    if (typeof v === 'string' && HARDCODED_COLOR.test(v) && !TOKEN_COLOR.test(v)) {
      push('U1', `${at}.props.${k}`, `硬编码色值「${v}」：只允许 var(--token)`)
    }
    // U2：档位类属性
    // 只查**档位**类属性。`rows` 是数字（Textarea 行数），不是档位 —— 曾误把它当档位，
    // 结果 `rows: '{{results.commands}}'` 的数据绑定被当成"非法档位"，样板 spec 直接假红。
    if ((k === 'size' || k === 'density') && typeof v === 'string') {
      const set = k === 'density' ? DENSITY_TOKENS : SIZE_TOKENS
      if (!set.includes(v)) push('U2', `${at}.props.${k}`, `档位「${v}」不在令牌表里（${set.join('/')}）`)
    }
    // U7：图标只写名字
    if (k === 'icon' && typeof v === 'string') {
      if (!LUCIDE_NAME.test(v)) push('U7', `${at}.props.icon`, `图标只能写 lucide 名字（小写连字符），收到「${v}」`)
    }
    // U6：空洞文案
    if ((k === 'text' || k === 'label' || k === 'emptyText') && typeof v === 'string') {
      if (HOLLOW_COPY.includes(v.trim())) {
        push('U6', `${at}.props.${k}`, `文案「${v}」太空洞：必须说明在做什么/没什么/为什么失败`)
      }
    }
  }
}

/** U4：表格密度与列宽 */
function checkTable(props, at, push) {
  const cols = Array.isArray(props?.columns) ? props.columns : []
  if (!cols.length) push('U4', `${at}.props.columns`, '表格至少要有一列')
  for (const [i, c] of cols.entries()) {
    if (!isObj(c) || typeof c.key !== 'string' || !c.key) {
      push('U7', `${at}.props.columns[${i}]`, '每列必须有 key')
      continue
    }
    // 长文本列必须可换行：`wrap:true`，或用 `truncate:true` 明确"截断"（而不是默认悄悄溢出）
    const wrapped = c.wrap === true || c.truncate === true
    if (!wrapped) push('U4', `${at}.props.columns[${i}]`, `列 ${c.key} 必须显式 wrap:true 或 truncate:true（长文本默认会撑破版面）`)
  }
  if (props?.density !== undefined && !DENSITY_TOKENS.includes(props.density)) {
    push('U4', `${at}.props.density`, `密度只能是 ${DENSITY_TOKENS.join('/')}`)
  }
}

/**
 * 校验一个 `specVersion:2` 的应用 spec。
 * @param {any} spec
 * @returns {{ ok: boolean, errors: Array<{code: string, path: string, message: string}> }}
 */
export function validateAppSpec(spec) {
  const errors = []
  const push = (code, path, message) => errors.push({ code, path, message })
  if (!isObj(spec)) return { ok: false, errors: [{ code: 'U7', path: '', message: 'spec 必须是对象' }] }
  if (spec.specVersion !== 2) push('U7', 'specVersion', `只认 specVersion:2，收到 ${JSON.stringify(spec.specVersion)}`)
  const ui = spec.ui
  if (!isObj(ui)) {
    push('U7', 'ui', '缺少 ui 段（P5a 起 ui 必填）')
    return { ok: false, errors }
  }

  // U7：版式必须是 L3 白名单里的一个（"选"不是"生成"）
  if (!L3_LAYOUTS.includes(ui.layout)) {
    push('U7', 'ui.layout', `layout「${ui.layout}」不在 L3 白名单（${L3_LAYOUTS.join('/')}）`)
  }

  const roots = bindingRoots(spec)
  const views = Array.isArray(ui.views) ? ui.views : []
  if (!views.length) push('U7', 'ui.views', '至少一个视图')
  const viewIds = new Set()
  for (const [i, v] of views.entries()) {
    const at = `ui.views[${i}]`
    if (!isObj(v)) { push('U7', at, '视图必须是对象'); continue }
    if (typeof v.id !== 'string' || !v.id) push('U7', `${at}.id`, '视图必须有 id')
    else if (viewIds.has(v.id)) push('U7', `${at}.id`, `视图 id「${v.id}」重复`)
    else viewIds.add(v.id)
    if (!L2_COMPONENTS.includes(v.component)) {
      push('U7', `${at}.component`, `组件「${v.component}」不在 L2 白名单（不许静默丢弃）`)
      continue
    }
    checkProps(v.component, v.props, at, push)
    if (v.component === 'DataTable') checkTable(v.props, at, push)
    // 绑定路径必须能解析
    for (const p of bindingsIn(v.props)) {
      if (/^ui\./.test(p)) { push('U7', `${at}.props`, `不许绑定视图自身（${p}）：视图之间不得互相依赖`); continue }
      if (!roots.has(p.split('.')[0]) || !resolvePath(spec, p)) {
        push('U7', `${at}.props`, `绑定 {{${p}}} 解析不到（只能绑 spec 顶层数据字段）`)
      }
    }
    // U5：可点击控件的尺寸必须落在令牌档位（默认档已达标，显式给值就得合规）
    if (v.component === 'Button' && v.props?.size !== undefined && !SIZE_TOKENS.includes(v.props.size)) {
      push('U5', `${at}.props.size`, `按钮尺寸「${v.props.size}」小于最小点击区档位（${SIZE_TOKENS.join('/')}）`)
    }
  }

  // U3：三态必填
  const states = isObj(ui.states) ? ui.states : {}
  const need = { empty: 'EmptyState', error: 'ErrorState', loading: 'LoadingState' }
  for (const [k, comp] of Object.entries(need)) {
    const st = states[k]
    if (!isObj(st)) { push('U3', `ui.states.${k}`, `缺少 ${k} 态（空窗口与失败是两种文案，不许互相伪装）`); continue }
    if (st.component !== comp) push('U3', `ui.states.${k}.component`, `${k} 态必须用 ${comp}，收到 ${JSON.stringify(st.component)}`)
    if (!L2_COMPONENTS.includes(st.component)) push('U7', `ui.states.${k}.component`, `组件「${st.component}」不在 L2 白名单`)
    checkProps(st.component, st.props, `ui.states.${k}`, push)
    for (const p of bindingsIn(st.props)) {
      if (!roots.has(p.split('.')[0]) || !resolvePath(spec, p)) push('U7', `ui.states.${k}.props`, `绑定 {{${p}}} 解析不到`)
    }
  }

  // actions：id 唯一、kind 合法、引用它的 rowActions 必须存在
  const actions = Array.isArray(ui.actions) ? ui.actions : []
  const actionIds = new Set()
  for (const [i, a] of actions.entries()) {
    const at = `ui.actions[${i}]`
    if (!isObj(a) || typeof a.id !== 'string' || !a.id) { push('U7', at, 'action 必须有 id'); continue }
    if (actionIds.has(a.id)) push('U7', `${at}.id`, `action id「${a.id}」重复`)
    actionIds.add(a.id)
    if (a.kind !== 'read' && a.kind !== 'write') push('U7', `${at}.kind`, `kind 只能是 read/write，收到 ${JSON.stringify(a.kind)}`)
    if (typeof a.label !== 'string' || !a.label) push('U6', `${at}.label`, 'action 必须有 label')
    else if (HOLLOW_COPY.includes(a.label.trim())) push('U6', `${at}.label`, `文案「${a.label}」太空洞`)
  }
  for (const [i, v] of views.entries()) {
    const refs = v?.props?.rowActions
    if (!Array.isArray(refs)) continue
    for (const r of refs) {
      if (!actionIds.has(r)) push('U7', `ui.views[${i}].props.rowActions`, `引用了不存在的 action「${r}」`)
    }
  }

  return { ok: errors.length === 0, errors }
}
