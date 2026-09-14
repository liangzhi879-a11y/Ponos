// 应用智控：**file 执行后端**（M3）——只读本地文件，不写盘。
//
// ★ 为什么独立成一个后端：很多桌面应用没有 CLI、也不值得做 UI 自动化，
//   但它的工程文件/配置/导出数据是稳定的接口面（如 Aseprite 的 *.ini、Blender 导出的 *.json）。
//   读这些文件比模拟点击稳得多，也更容易被复现。
//
// ★ 安全（硬约束，逐条有测试，**勿放宽**）：
//   ① **只读**：只提供 read / query，遇到 write 之类步骤明确拒绝（用户拍板：file 只读）；
//   ② 路径必须过 `app-explore.cjs` 的 `resolveExplorePath`（越界/穿越拒绝，转成 `{ok:false}` 而非抛）；
//   ③ 二进制拒绝（避免往模型上下文灌乱码）；④ 单文件字节上限；
//   ⑤ 参数校验/插值复用 `app-util.cjs`（与 desktop / http 后端**同一份实现**，避免三套口径漂移）。
'use strict'
const appExplore = require('./app-explore.cjs')
const { interpolate, checkRequired } = require('./app-util.cjs')

/** 支持的读取格式（未知值按 text —— 宽容降级，但绝不猜成 json） */
const FILE_FORMATS = ['text', 'json']

/**
 * 极简选择器：点分路径 + `[*]` 数组展开（`$` 前缀可省略）。
 * ★ 为什么自己写而不引第三方 JSONPath：不新增依赖；而"只取需要的字段"这个诉求用
 *   点分路径 + 数组展开就够（过滤/函数/负索引都不需要）。语法超集不认时返回空数组（如实为空，不乱猜）。
 */
function selectJson(value, select) {
  const raw = String(select ?? '').trim()
  if (!raw || raw === '$') return value
  const parts = raw.replace(/^\$\.?/, '').split('.').filter(Boolean)
  let acc = [value]
  for (const part of parts) {
    const isArray = /\[\*\]$/.test(part)
    const key = isArray ? part.slice(0, -3) : part
    const next = []
    for (const item of acc) {
      const v = key ? item?.[key] : item
      if (isArray) { if (Array.isArray(v)) next.push(...v) }
      else if (v !== undefined) next.push(v)
    }
    acc = next
  }
  return acc.length === 1 ? acc[0] : acc
}

/** 步骤值 → 命令结果（json 解析失败要区分"文件本身坏了"与"被截断导致不完整"） */
function parseReadValue({ text, format, truncated, maxBytes = appExplore.DEFAULT_MAX_BYTES } = {}) {
  const fmt = FILE_FORMATS.includes(format) ? format : 'text'
  if (fmt !== 'json') return { ok: true, value: text }
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (e) {
    const why = truncated
      ? `JSON 文件被截断（超过 ${maxBytes} 字节上限）导致内容不完整，无法解析；请改用 query 步骤只取需要的字段`
      : `JSON 解析失败：${String(e?.message || e)}`
    return { ok: false, error: why }
  }
}

/**
 * 执行一条 file 驱动命令（只读）。
 * @param {{appId:string, action:string, args?:object, spec:object, roots:string[], deps?:object}} p
 * @returns {Promise<{ok:boolean, data:any, error:string|null, kind:string, durationMs:number}>}
 */
async function fileRunner({ appId, action, args = {}, spec, roots, deps = {} } = {}) {
  const startedAt = Date.now()
  const cmd = spec?.commands?.find((c) => c.action === action)
  const kind = cmd?.kind ?? 'unknown'
  const fail = (error) => ({ ok: false, data: null, error, kind, durationMs: Date.now() - startedAt })
  if (!Array.isArray(roots) || roots.length === 0) return fail('缺少允许目录（roots）：file 驱动只允许读取目标程序目录与其用户数据目录')
  if (!cmd) return fail(`未找到命令：${action}`)
  const req = checkRequired(cmd.params, args)
  if (!req.ok) return fail(req.errors.join('；'))
  try {
    let saved = null
    for (const step of cmd.steps || []) {
      if (step?.act !== 'read' && step?.act !== 'query') {
        throw new Error(`file 驱动只读，不支持步骤 ${String(step?.act)}（只允许 read / query）`)
      }
      const res = await appExplore.readTextFile(
        { path: interpolate(step.path, args), maxBytes: step.maxBytes },
        { roots, readFile: deps.readFile },
      )
      if (!res.ok) throw new Error(res.error)               // 守卫/二进制/权限的真实原因原样给出去
      const parsed = parseReadValue({ text: res.text, format: step.format, truncated: res.truncated === true, maxBytes: step.maxBytes })
      if (!parsed.ok) throw new Error(parsed.error)
      const value = step.act === 'query' ? selectJson(parsed.value, step.select) : parsed.value
      if (step.save) saved = value
      else if (saved === null) saved = value
    }
    return { ok: true, data: saved, error: null, kind, durationMs: Date.now() - startedAt }
  } catch (e) {
    return fail(String(e?.message || e))
  }
}

module.exports = { fileRunner, selectJson, parseReadValue, FILE_FORMATS }
