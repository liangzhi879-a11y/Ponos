// 命令表生成器：api-calls.json → apis.json 结构
const SERVICES = {
  oauth: 'https://gateway.yfljsj.com/api/oauth',
  upms: 'https://gateway.yfljsj.com/api/upms',
  rcms: 'https://gateway.yfljsj.com/api/rcms',
}
const UPMS_PREFIXES = ['user', 'role', 'permission', 'tenant', 'group', 'dp', 'dept', 'dict']

/** 服务归属：auth→oauth；user/role/权限/租户→upms；其余→rcms */
export function inferService(path) {
  const p = path.split('/')[1] || ''
  if (p === 'auth') return 'oauth'
  if (UPMS_PREFIXES.includes(p)) return 'upms'
  return 'rcms'
}

/** action 命名：最后一段资源 + 动作（building/list → building-list） */
export function inferAction(path) {
  const parts = path.split('/').filter(Boolean)
  const action = parts[parts.length - 1]
  const resource = parts.length >= 3 ? parts[parts.length - 2] : parts[0]
  return `${resource}-${action}`
}

/** 分页接口：尾部为 page/list 且路径含常见资源 → 标 page 参数 */
const PAGE_SUFFIXES = ['page', 'list', 'pageForRegister', 'pageForSelect']
export function inferParams(path) {
  const last = path.split('/').pop() || ''
  if (PAGE_SUFFIXES.includes(last)) return { current: 'number', size: 'number' }
  return {}
}

// 敏感字段声明（合并前审阅修复 I-4）：
//   人员/用户类资源的读接口，响应可能含 PII（密码/手机号/身份证/电话）。
//   声明为 params 对象型 schema + sensitive:true，sensitiveFieldsOf 会把它们并入
//   --human 输出脱敏集合。注意：这是「响应字段」声明而非请求参数——
//   required:false 使其不会参与 runCommand 必填校验/请求体拼接。
const PII_PARAMS = {
  password: { type: 'string', sensitive: true, required: false },
  mobile: { type: 'string', sensitive: true, required: false },
  idCard: { type: 'string', sensitive: true, required: false },
  phone: { type: 'string', sensitive: true, required: false },
}
const PII_PATH_RE = /user|sysUser|personnel|employee|staff/i
const PII_ACTION_RE = /list|page|detail|query/
/** 推断敏感字段：path 含 PII 资源关键词 且 action（末段）为读类动词 → 声明 PII 字段 */
export function inferSensitiveParams(path) {
  if (!PII_PATH_RE.test(path)) return undefined
  const last = path.split('/').pop() || ''
  if (!PII_ACTION_RE.test(last)) return undefined
  return { ...PII_PARAMS }
}

/** 读写归类：含删除/变更/导入/启停等动词 → write，否则 read */
export function inferKind(path) {
  return /delete|remove|add|modify|update|save|import|upload|enable|disable/.test(path) ? 'write' : 'read'
}

export function genApis(calls) {
  const modules = {}
  for (const c of calls) {
    const parts = c.path.split('/').filter(Boolean)
    const modKey = parts[0] || 'other'
    if (!modules[modKey]) {
      modules[modKey] = { title: modKey, service: inferService(c.path), commands: [] }
    }
    modules[modKey].commands.push({
      action: inferAction(c.path),
      method: c.methods || 'POST',
      path: c.path,
      // 分页参数 + 敏感字段声明合并（sensitive 字段 required:false，不影响必填校验）
      params: { ...(inferSensitiveParams(c.path) || {}), ...inferParams(c.path) },
      desc: c.path,
      kind: inferKind(c.path),
    })
  }
  return { version: 1, services: SERVICES, modules }
}
