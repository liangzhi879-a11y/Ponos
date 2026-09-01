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
      params: inferParams(c.path),
      desc: c.path,
      kind: inferKind(c.path),
    })
  }
  return { version: 1, services: SERVICES, modules }
}
