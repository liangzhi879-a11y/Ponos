// 命令表生成器：api-calls.json → apis.json 结构
const SERVICES = {
  oauth: 'https://gateway.yfljsj.com/api/oauth',
  upms: 'https://gateway.yfljsj.com/api/upms',
  rcms: 'https://gateway.yfljsj.com/api/rcms',
}
// 服务归属（真机全量检测校准 2026-09-01）：auth→oauth；
// user/role/permission/tenant/group/dp/dept/dict/dictionary/sys/merchant/notice/priAdmin→upms；其余→rcms
const UPMS_PREFIXES = ['user', 'role', 'permission', 'tenant', 'group', 'dp', 'dept', 'dict', 'dictionary', 'sys', 'merchant', 'notice', 'priAdmin']

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

/** 分页接口：尾部为 page/list 等 → v2 对象定义 */
const PAGE_SUFFIXES = ['page', 'list', 'pageForRegister', 'pageForSelect']
export function inferParams(path) {
  const last = path.split('/').pop() || ''
  if (!PAGE_SUFFIXES.includes(last)) return {}
  return {
    current: { type: 'number', required: true, desc: '页码（从1开始）', auto: false },
    size: { type: 'number', required: true, desc: '每页条数' },
  }
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

/** 生成 relations 骨架：路径首段归组 + 常见子对象关联（project→approval/rdItem/member 等） */
export function buildRelations(modules) {
  const relations = {}
  // 核心对象显式定义（人工沉淀）
  relations.project = {
    title: '项目', createOrder: ['projectInfo-add', 'projectAppro-add', 'rdItem-add'],
    children: {
      approval: { title: '立项信息', via: 'projectId → project.id', api: 'projectAppro' },
      rdItem: { title: '研发活动', via: 'sourceProjectId → project.id', api: 'rdItem' },
      member: { title: '项目成员', via: 'projectId → project.id', api: 'projectMember' },
      equipment: { title: '设备', via: 'projectId → project.id', api: 'projectEquip' },
      budget: { title: '预算', via: 'projectId → project.id', api: 'projectRdCost' },
    },
  }
  relations.rdItem = { title: '研发活动', createOrder: ['rdItem-add'], children: {} }
  relations.approval = { title: '立项信息', createOrder: ['projectAppro-add'], children: {} }
  return relations
}

/** 生成 operations 手册：人工沉淀的完整操作流程（步骤 + 示例命令），供 doc 子命令输出 */
export function buildOperations() {
  return {
    createProject: {
      title: '创建研发项目（含立项）',
      steps: [
        { cmd: 'workbench projectInfo-add', desc: '1. 建项目基础信息（projectName/projectCode 必填）' },
        { cmd: 'workbench projectAppro-add', desc: '2. 建立项信息（负责人 headPersonId 从 getUserList 选）' },
        { cmd: 'enterprise rdItem-add', desc: '3. 建研发活动（sourceProjectId=项目id）' },
      ],
      examples: [
        "yfljsj workbench projectInfo-add --data '{\"projectName\":\"AI...\",\"projectCode\":\"TEST-RD-...\"}'",
        "yfljsj workbench projectAppro-add --data '{\"projectId\":100216,\"headPersonId\":100131,...}'",
      ],
    },
  }
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
  return { version: 1, services: SERVICES, modules, relations: buildRelations(modules), operations: buildOperations() }
}
