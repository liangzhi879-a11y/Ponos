// 应用智控：「应用即工具」——把绑定到当前会话的应用命令，注册为 LLM 可直接调用的
// 具名工具（app_<slug>_<action>），与 kernel/dyntools.mjs 的 buildWorkflowTools 同构。
//
// 与工作流工具有意不同的三处：
//   ① 命名真源是 kernel/app-naming.mjs 的 appToolName()，**不是** dyntools.slugToToolName：
//      后者恒带 run_ 前缀、且把中文名清洗成空（回退 run_workflow_<hash>），会让
//      app-permissions.mjs 注入的 `app_*:*` 规则永不命中——read 放不了行、write 挡不住。
//   ② 可见性由 app-spec.mjs 的 isAppVisible 判定（console = 仅本会话绑定的那个应用 /
//      public = 恒可见 / private = 永不可见；**应用页作用域 scopeAppId 优先，public 不旁路**），
//      不在此另造一套可见性口径。
//   ③ 执行不在本进程：内核是独立进程，应用命令必须回到 Electron 执行（browser/desktop
//      两种 driver）。故执行能力经 `runner` 注入（kernel/cli.mjs 注入 app 桥路由 →
//      bridge → 主进程执行器 → stdin app_response）。未注入 runner → **明确报错**，
//      绝不静默成功（静默成功会让模型以为命令跑了，而实际什么也没发生）。
import { deriveInputSchema, shortHash } from './dyntools.mjs'
import { appToolName } from './app-naming.mjs'
import { listApps, loadSpec, isAppVisible, getBoundApp, MAX_COMMANDS_PER_APP } from './app-spec.mjs'

/** runner 缺省实现：内核自身对应用命令零执行能力（必须由 cli.mjs 注入桥路由） */
async function missingRunner() {
  throw new Error('未注入 runner：应用命令必须经 kernel/cli.mjs 注入的 app 桥路由执行（app_response）')
}

/** 成功结果的文本化（data 可能是字符串/对象/null） */
function renderData(data) {
  if (data === undefined || data === null || data === '') return ''
  return `\n输出: ${typeof data === 'string' ? data : JSON.stringify(data, null, 2)}`
}

/**
 * 构建应用工具表：`{ [工具名]: { description, input_schema, concurrencySafe, run } }`。
 *
 * 只返回工具表本身，**不做任何全局注册**（挂载由 kernel/cli.mjs 的 setDynamicTools
 * 视图函数负责；视图函数每次求值 ⇒ 进入/离开控制台、改 Spec 都即时生效，无需重启内核）。
 *
 * @param {object}   p
 * @param {string[]} p.roots       应用数据根（<configDir>/apps 等）
 * @param {string|null} p.agentId  预留：当前可见性只按会话绑定判定（与 app-spec 同口径）
 * @param {string|null} p.sessionId 当前会话 id（读 binding.json 用）
 * @param {string|null} p.scopeAppId 应用页作用域（--app-page）：非空 ⇒ 只注册该应用的工具
 *                 （public 也不旁路；语义见 app-spec.isAppVisible）。缺省 null = 现有行为。
 * @param {Function} p.runner      执行能力：({appId, action, args, sessionId}) → {ok, data, error, kind, durationMs}
 * @param {number}   p.publicLimit 工具总数上限（缺省 → MAX_COMMANDS_PER_APP，与单应用命令上限对齐）
 * @returns {Object} 工具表（非枚举属性 nameConflicts 记录重名冲突明细）
 */
export function buildAppTools({ roots = [], agentId = null, sessionId = null, scopeAppId = null, runner, publicLimit } = {}) {
  const tools = {}
  const conflicts = []
  const run = typeof runner === 'function' ? runner : missingRunner
  // 当前会话绑定的应用（严格单开）。每次求值现读 binding.json —— 与权限规则注入同一时点。
  // scopeAppId 非空时 isAppVisible 直接按作用域判定（binding 不参与），故这里照读即可：
  // 多读一次 binding.json 不会改变结果（作用域优先），但保留了"无作用域"时的原路径。
  const boundApp = getBoundApp({ roots, sessionId })

  for (const app of listApps({ roots })) {
    if (app.enabled === false) continue
    const spec = loadSpec({ roots, appId: app.id })
    // private 恒不可见 / 作用域只留本应用 / console 需绑定（口径见 app-spec.isAppVisible）
    if (!isAppVisible(spec, { agentId, boundApp, scopeAppId })) continue
    const appName = String(spec.name || app.name || app.id)
    const commands = (Array.isArray(spec.commands) ? spec.commands : [])
      .filter((c) => c && c.action)
      .slice(0, MAX_COMMANDS_PER_APP) // 单应用上限：防止一个应用把工具池撑爆
    for (const cmd of commands) {
      const preferred = appToolName(spec, cmd.action)
      let name = preferred
      if (Object.hasOwn(tools, name)) {
        // 同名不静默覆盖（覆盖 = 后者吃掉前者，静默丢命令）：追加短哈希后缀保两者可用
        const alt = `${preferred}_${shortHash(`${app.id}:${cmd.action}`)}`
        name = alt
        for (let i = 2; Object.hasOwn(tools, name); i++) name = `${alt}${i}`
        conflicts.push({ app: app.id, action: cmd.action, preferred, resolved: name })
        console.warn(`[app-tools] 工具名冲突：${preferred} 已被占用，应用「${app.id}」的命令「${cmd.action}」注册为 ${name}`)
      }
      const isWrite = cmd.kind === 'write'
      const title = String(cmd.title || cmd.action)
      tools[name] = {
        // write 的「需确认」不只是文案：app-permissions.mjs 已按 kind 注入 `<name>:*` 的
        // ask 规则（优先级高于档位表，含 bypass 档），此处文案让模型侧也知道会被拦。
        description: `[${appName}] ${title}${isWrite ? '（写操作，需确认）' : ''}`,
        input_schema: deriveInputSchema(cmd.params), // Spec 的 params 就是数组，零适配
        concurrencySafe: !isWrite, // read 可并发；write 串行（避免同一应用上并行改状态）
        run: async (input = {}) => {
          try {
            const r = await run({ appId: app.id, action: cmd.action, args: input || {}, sessionId })
            if (!r || typeof r !== 'object' || r.ok !== true) {
              // 失败**不抛**（抛会中断本轮 turn），转 isError 交模型自愈/说明
              return { content: `应用命令「${title}」执行失败：${(r && r.error) || '未知错误（执行器无返回）'}`, isError: true }
            }
            return {
              content: `应用「${appName}」命令「${title}」执行完成（${r.kind || cmd.kind || 'unknown'}，${Number(r.durationMs) || 0}ms）${renderData(r.data)}`,
              isError: false,
            }
          } catch (err) {
            return { content: `应用命令「${title}」执行失败：${String(err?.message || err)}`, isError: true }
          }
        },
      }
    }
  }

  // 工具总数上限（按注册顺序稳定截断）。
  // 缺省取 MAX_COMMANDS_PER_APP 而**不是** dyntools 的 LIMIT_DEFAULT(20)：生产装配点
  // kernel/cli.mjs 调用本函数时并不传 publicLimit，回退到 20 就会让 app-spec 允许的 40 条里
  // 有 20 条被这里的 slice 静默丢弃——用户存得下一份 40 条命令的 Spec，工具池里只出现前 20 条，
  // 界面上看不出来少了什么（只能靠"模型说没有这个工具"反推）。
  // 显式传入的 publicLimit 优先级不变（仍受全局工具池上限约束）。
  const limit = Number.isInteger(publicLimit) && publicLimit >= 0 ? publicLimit : MAX_COMMANDS_PER_APP
  const out = {}
  for (const n of Object.keys(tools).slice(0, limit)) out[n] = tools[n]
  // 冲突明细挂非枚举属性（与 dyntools 同款）：不进工具表视图（Object.keys/展开不可见），
  // 供诊断与测试读取。
  Object.defineProperty(out, 'nameConflicts', { value: conflicts, enumerable: false })
  return out
}
