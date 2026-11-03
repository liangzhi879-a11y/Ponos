// `Screen` 工具的**排除清单匹配逻辑**（P2 computeruse 像素层，P2a；spec §3.5 S4）。
//
// 为什么需要：像素层引入了语义层没有的风险 —— 截图会把**用户屏幕上的一切**送进模型上下文
// （spec §2.2 E5 实测：截一张 Electron 主窗，即把真实客户项目名与对话内容整体读入）。
// 排除清单是机制而非建议：命中项不可被截取，**且不告知模型"那里有东西"**。
//
// 为什么"不告知"是设计的一部分：若返回 "KeePass 窗口已排除"，模型就知道那里有密码库，
// 会尝试用其它方式获取（诱导用户、换截图方式）。**静默剔除**让该信息在模型侧不存在。
//
// 分层：数据真源在 shared/screen-exclusions-data.cjs（CJS，供 electron 侧同源引用）；
// 本模块只放匹配逻辑，纯函数、不 import electron。
import data from '../shared/screen-exclusions-data.cjs'

/** 缺省排除清单（数据真源 re-export，保持既有 import 点不变） */
export const DEFAULT_EXCLUSIONS = data.DEFAULT_EXCLUSIONS

/** 进程名归一化：小写 + 去 .exe 后缀 */
function normProcess(s) {
  return String(s ?? '').trim().toLowerCase().replace(/\.exe$/, '')
}

/** 通配模式 → 正则（只支持 `*`，其余字符转义；大小写不敏感） */
function patternToRegExp(pattern) {
  const p = String(pattern ?? '').trim().toLowerCase()
  if (!p) return null
  // ★ 转义类必须含 `?`（2026-10-14 审查期实测抓到）：漏掉它时 `?` 被当量词，
  //   patternToRegExp('?x') 造出 /^?x$/ → **SyntaxError: Nothing to repeat**，
  //   ⇒ 违反本函数自述的“不抛异常”，且与 PS 侧（[regex]::Escape，`?` 是字面量）
  //   真实分叉（对账 fixture 若不覆盖 `?` 就看不出来）。
  //   审查者用 95 个可打印字符逐个核对：`?` 是**唯一**破坏字面语义的字符。
  const escaped = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').split('*').join('.*')
  return new RegExp(`^${escaped}$`)
}

/**
 * 某项（窗口/进程）是否被排除。
 * @param {{process?:string, title?:string}} item
 * @param {{processes?:string[], titlePatterns?:string[]}} list
 * @returns {boolean} 缺数据/异常一律返回 false（不排除）；**不抛异常**
 */
export function isExcluded(item, list) {
  if (!item || typeof item !== 'object') return false
  const procs = Array.isArray(list?.processes) ? list.processes : []
  const pats = Array.isArray(list?.titlePatterns) ? list.titlePatterns : []
  const proc = normProcess(item.process)
  if (proc && procs.some((p) => normProcess(p) === proc)) return true
  const title = String(item.title ?? '').trim().toLowerCase()
  if (title) {
    for (const pat of pats) {
      const re = patternToRegExp(pat)
      if (re && re.test(title)) return true
    }
  }
  return false
}

// ★ 有意**不实现** `filterExcluded`（用户 2026-10-14 拍板 F2）：它在 P2a 的 Node 侧零调用者，
//   且过滤职责已归脚本侧（`screen.ps1` 的 `Test-Excluded` 才是生产路径上的那份）
//   ⇒ 加了也永无消费者。本仓 HEAD `72b755ad` 正是「清理零调用者的孤儿」，不重复制造。
//   本模块的 `isExcluded` 只作**对账参照**：消费方 = Task 12 的两侧语义对账测试。
