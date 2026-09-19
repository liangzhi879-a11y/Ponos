// kit/lib/python-manifest.mjs —— 内嵌 Python 包清单的**单一真源**读取入口（B2）
//
// 为什么要有这个模块（而不是把读取代码直接写在构建脚本里）：
//   包列表的真源在 `kit/manifest/deps.json#python.embedded`，但**读它的一方不止构建脚本** ——
//   测试必须验证"构建脚本读到的就是台账那份"。若各处各写一段读取代码，
//   真源仍是两份（两份读取实现 + 两份对字段名的理解），而漂移的表现是
//   **发出去的应用缺一个包、运行时才炸**（内嵌运行时不可在线补包）。
//   故读取只有这一个入口：`scripts/build-embedded-python.mjs` 与测试共用它。
//
// ★ 失败必须**响亮**：这里刻意不提供任何默认值 / 兜底清单。
//   - 读不到文件 → 抛错（不是"返回 [] 继续装 0 个包然后报成功"）；
//   - 键不存在 / 空数组 / 条目不是字符串 → 抛错（`pip install [object Object]` 会静默装错东西）；
//   - 不传 root → 抛错（禁止用默认值"猜"仓库位置：猜错就装错包，且没有任何报错）。
//   构建脚本的调用点在 `try` 块内，抛错会走 `FATAL:` 分支并以非 0 退出 —— 这正是要的形态。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 真源相对路径（对外导出，让调用方/测试能在消息里指向它，而不是各自手抄一份字符串） */
export const EMBEDDED_MANIFEST_REL = 'kit/manifest/deps.json'

/**
 * 读内嵌 Python 包清单（真源：`<root>/kit/manifest/deps.json` 的 `python.embedded`）。
 *
 * @param {{ root: string }} args root = 仓库根（绝对或相对路径都可；**必传**）
 * @returns {string[]} PyPI 包名清单（原样返回，不做大小写/下划线归一 —— 归一由消费方按需做）
 */
export function readEmbeddedPackages({ root } = {}) {
  if (!root) {
    throw new Error('readEmbeddedPackages: 缺少 root（真源是 <root>/' + EMBEDDED_MANIFEST_REL +
      '#python.embedded，禁止用默认值猜仓库位置）')
  }
  const file = join(root, EMBEDDED_MANIFEST_REL)
  const hint = `未能在 ${file} 读取内嵌包清单 python.embedded（B2：真源在台账，不在构建脚本里）`
  if (!existsSync(file)) throw new Error(`${hint} —— 文件不存在`)
  let deps
  try {
    deps = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    throw new Error(`${hint} —— deps.json 解析失败：${e.message}`)
  }
  const list = deps?.python?.embedded
  if (!Array.isArray(list) || list.length === 0) throw new Error(`${hint} —— 该键缺失或为空数组`)
  const bad = list.filter((n) => typeof n !== 'string' || n.trim() === '')
  if (bad.length) throw new Error(`${hint} —— 第 ${list.indexOf(bad[0]) + 1} 项不是非空字符串：${JSON.stringify(bad[0])}`)
  return list
}
