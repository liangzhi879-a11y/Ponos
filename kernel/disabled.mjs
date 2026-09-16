// kernel/disabled.mjs —— Agent / Skill 的**全局停用注册表**（2026-09-15，待处理清单 P1
// 「agent和skill页面及功能需要大改」D 条款：注册与关闭开关）。
//
// ## 为什么是一个 configDir 下的文件，而不是 spawn 参数
//
// 需求定的是**全局停用**（D3 决策）：停用后所有会话都不再加载/调用它。三个可选落法：
//   ① 新增 spawn 参数（`--disabled-skills` 之类）——每个会话都要透传，而"GUI → 桥 → 内核"
//      这条链每多一个键就多一处**静默失效**点（本仓库已两次踩过：`--spaces`/`--confirm`
//      漏登记被"未知 `--` 参数静默忽略"吞掉）。全局语义与"每会话透传"天然不匹配。
//   ② 写进各个 skill/agent 文件（比如给 frontmatter 加 `disabled: true`）——要改动用户文件，
//      且"停用"会与文件内容纠缠（卸载技能就丢了停用状态）。
//   ③ **一个注册表文件**（本实现）——单一真相源、读写一次、内核启动时读、GUI 经桥读写。
//      全局语义与"一个文件"天然匹配；不碰用户任何技能/agent 文件。
//
// ## 语义边界（必须守住，否则就是"假开关"）
//
// 停用 = **不再被运行中的 agent 自动加载/注入/调用**，三处一致：
//   · 技能：不进提示词技能清单、不在 `Skill` 工具的可用清单里、按名调用被拒；
//   · agent：不在 `Task` 工具的子 agent 表里（`resolveAgents` 过滤）。
// 它**不承诺**阻止用户手动执行技能目录里的脚本（Bash/Read 总能碰到文件）——这条已写进
// spec §5 并在 UI 文案里明说，避免用户以为"停用 = 物理隔离"。
//
// ## 容错纪律
//
// 注册表是**用户可手改的普通 JSON**（就放在配置目录里），故读取必须极度宽容：文件缺失、
// 空的、坏的、键类型不对——一律退化为"没有停用任何东西"，绝不抛错。理由：这个文件的唯一
// 作用是**收窄**能力，读失败时"照旧全开"是用户可感知的（功能还在），而"读失败就崩"会让
// 内核根本起不来（用户看到的是整个应用坏掉）。反过来写路径必须严格：写坏的注册表会让下次
// 启动静默全开或全关，故写入前先归一、写后回读校验（见 writeDisabled）。
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

/** 注册表文件名（相对 configDir）。 */
export const DISABLED_FILE = 'disabled.json'

/**
 * 归一注册表数据：两个键各自"去空、去重、**保序**"。
 *
 * 保序不是洁癖：GUI 可能按用户操作顺序展示停用清单，重排会让"停用列表"的顺序每次刷新都变
 * （用户以为发生了什么）。去空/去重则是为了 json 手改出错时不产生"空 id"这种幽灵条目。
 * 未知键**保留但不透出**不划算，故只取这两个键，其余丢弃（schemaVersion 留在文件里做版本位）。
 */
export function normalizeDisabled(raw) {
  const pick = (v) => {
    if (!Array.isArray(v)) return []
    const out = []
    const seen = new Set()
    for (const x of v) {
      const id = String(x ?? '').trim()
      if (!id || seen.has(id)) continue
      seen.add(id)
      out.push(id)
    }
    return out
  }
  return { schemaVersion: 1, agents: pick(raw?.agents), skills: pick(raw?.skills) }
}

/** 注册表路径。 */
export function disabledPath({ configDir }) {
  return join(configDir, DISABLED_FILE)
}

/**
 * 读取注册表。**永不抛错**（见文件头"容错纪律"）：任何异常都退化为"没有停用任何东西"。
 * @returns {{ schemaVersion: number, agents: string[], skills: string[], ok: boolean }}
 *   `ok=false` 表示"文件存在但读不出来"——调用方（cli）据此打一条 warn，让"停用没生效"
 *   这类问题在日志里可查，而不是只能靠体感。
 */
export function readDisabled({ configDir } = {}) {
  if (!configDir) return { ...normalizeDisabled(null), ok: true }
  const file = disabledPath({ configDir })
  if (!existsSync(file)) return { ...normalizeDisabled(null), ok: true }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8'))
    return { ...normalizeDisabled(raw), ok: true }
  } catch {
    return { ...normalizeDisabled(null), ok: false }
  }
}

/**
 * 写入注册表（原子替换：先写临时文件再 rename）。
 *
 * **为什么必须原子**：GUI 每次点开关都会写这个文件，而内核可能**同时**在读它（新会话启动）。
 * 直接 writeFileSync 会让内核有机会读到**半截 JSON**（截断的文件 = JSON.parse 抛错 = 按上面
 * 的容错退化成"全开"）。表现为"偶尔停用不生效"，是最难复现的一类 bug。rename 在同一文件系统
 * 内是原子操作，读方要么看到旧内容、要么看到新内容。
 *
 * 写后**回读校验**：确认落盘的确实是归一后的内容（磁盘满/权限问题会静默截断）。
 * @returns {{ ok: boolean, error?: string, data?: object }}
 */
export function writeDisabled({ configDir, data } = {}) {
  if (!configDir) return { ok: false, error: 'configDir 缺失' }
  const norm = normalizeDisabled(data)
  const file = disabledPath({ configDir })
  const tmp = `${file}.tmp-${process.pid}`
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(tmp, JSON.stringify(norm, null, 2), 'utf-8')
    renameSync(tmp, file)
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  }
  const back = readDisabled({ configDir })
  if (!back.ok) return { ok: false, error: '写入后回读失败（文件可能损坏）' }
  const same = JSON.stringify({ agents: back.agents, skills: back.skills })
    === JSON.stringify({ agents: norm.agents, skills: norm.skills })
  if (!same) return { ok: false, error: '写入后回读不一致' }
  return { ok: true, data: { agents: norm.agents, skills: norm.skills } }
}

/**
 * 从候选中剔除被停用的 id（保序）。
 * 抽成函数而不是各处 `filter(s => !set.has(s.id))`：**停用判定的口径必须唯一**——
 * 技能与 agent 两处若各写一份（一个比 id、一个比 name/路径），就会出现"GUI 显示了停用、
 * 内核仍能调用"的半生效状态，而这种不一致极难察觉。
 * @param {Array<{id: string}>} list
 * @param {string[]|Set<string>|null|undefined} disabled
 */
export function excludeDisabled(list, disabled) {
  if (!Array.isArray(list)) return []
  const set = disabled instanceof Set ? disabled
    : new Set(Array.isArray(disabled) ? disabled.map((s) => String(s ?? '').trim()).filter(Boolean) : [])
  if (!set.size) return list
  return list.filter((x) => !set.has(String(x?.id ?? '')))
}

/** 单个 id 是否被停用（工具按名调用时的拒绝判定）。 */
export function isDisabled(disabled, id) {
  const set = disabled instanceof Set ? disabled
    : new Set(Array.isArray(disabled) ? disabled.map((s) => String(s ?? '').trim()).filter(Boolean) : [])
  return set.has(String(id ?? '').trim())
}
