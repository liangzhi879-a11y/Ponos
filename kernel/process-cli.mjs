// kernel/process-cli.mjs —— `--process <op>` 的聚合实现（待办 860）
// ---------------------------------------------------------------------------
// 与 `kernel/knowledge-cli.mjs` / `kernel/readonly.mjs` 同款范式：stdout 一个 JSON，
// code 0/1，不进 loop。**永不把异常抛给调用方**——CLI 子命令是旁路能力，它的故障不得
// 打断调用方（与 knowledge-cli 的硬契约一致）。
//
// 三个 op（刻意只有三个：能力面越小，"漏登记一个 flag 就静默失效"的历史坑面越小）：
//   · `collect` —— 手动归集（可带语义阶段名，如 `--phase 阶段2-实现`）。引擎轮尾的自动
//                  归集走同一实现（kernel/process-hygiene.mjs），此 op 只是等价的手动入口；
//   · `restore` —— 按账本回退（原处已有文件则跳过，绝不覆盖）；
//   · `list`    —— 列出已归集阶段（谁在什么时间收了什么，供人核对）。
//
// ⚠️ `--phase` / `--add-dir` 必须由 cli.mjs 的 parseArgs **显式登记并转发**到本模块：
//    本 CLI 对未知 `--` 参数静默忽略，漏一个键就等于该 flag 从未存在（**静默失效**，
//    是 kernel/cli.mjs 里反复踩过的最贵的一类假阴性）。

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { collectProcessArtifacts, restoreProcessArtifacts, listProcessPhases, readProcessManifest } from './process-hygiene.mjs'
import { relProcessRoot } from '../shared/process-artifacts.mjs'

/** op 白名单（未知 op 由 runProcessCommand 返回 code=1，不在解析期抛错）。 */
export const PROCESS_OPS = Object.freeze(['collect', 'restore', 'list'])

/**
 * @param {object} args
 * @param {string} [args.op]                collect | restore | list
 * @param {string} [args.projectRoot]       项目根（cli 侧取 `--add-dir` 的首项）
 *   ★ op/projectRoot 登记为**可选**：实现签名有 `= {}` 兜底，且缺参由函数内的校验分支给出
 *     可读错误（`unknown process op` / `项目根不存在`）。写成必填会让 `= {}` 本身报 TS2739。
 * @param {string|null} [args.phase]      阶段名（缺省 = session / unlabeled）
 * @param {string} [args.sessionId]       cli 传入，作为缺省阶段名来源
 * 2026-09-21 起为 **async**：`collect` 内部走 process-hygiene 的真异步 git 读取
 * （不再同步阻塞内核事件循环），调用方必须 await。返回结构不变。
 */
export async function runProcessCommand({ op, projectRoot, phase = null, sessionId = null } = {}) {
  const name = String(op ?? '').trim()
  if (!PROCESS_OPS.includes(name)) {
    return { output: { error: `unknown process op: ${name}`, ops: [...PROCESS_OPS] }, code: 1 }
  }
  if (!projectRoot || !existsSync(String(projectRoot))) {
    return { output: { error: `项目根不存在：${projectRoot || '(空)'}（用 --add-dir <项目根> 指定）` }, code: 1 }
  }
  const root = resolve(String(projectRoot))
  // 缺省阶段名 = 会话 id（"哪个会话/哪次任务产出的"是最小但够用的溯源粒度）；
  // 没有会话上下文（纯 CLI 调用）时回落 unlabeled，由用户显式 --phase 命名。
  const ph = phase || (sessionId ? `session-${String(sessionId).slice(0, 8)}` : 'unlabeled')
  try {
    if (name === 'list') {
      const phases = listProcessPhases(root)
      return { output: { ok: true, projectRoot: root, processDir: relProcessRoot(), phases }, code: 0 }
    }
    if (name === 'collect') {
      const r = await collectProcessArtifacts({ projectRoot: root, phase: ph, source: 'cli-manual' })
      return {
        output: {
          ok: r.ok, reason: r.reason, phase: r.phase, dir: r.dir,
          collected: (r.collected || []).map((c) => ({ from: c.from, to: c.to, bytes: c.bytes })),
          skipped: (r.skipped || []).map((s) => ({ path: s.path || s.from, reason: s.reason })),
        },
        // 归集失败（git 跟踪态读不到等）**不是**命令失败：CLI 成功执行了"检查并归集"，
        // 结果是"什么都没动"。用 code 0 + reason 表达，避免调用方把"安全放弃"当异常。
        code: 0,
      }
    }
    const rr = restoreProcessArtifacts({ projectRoot: root, phase: ph })
    return {
      output: {
        ok: rr.ok, reason: rr.reason, phase: rr.phase,
        restored: rr.restored || [],
        skipped: rr.skipped || [],
        // 回退后把账本一并回给调用方：调用方不必再读一次盘即可核对"哪些条目已回退"。
        manifest: readProcessManifest(root, ph),
      },
      code: 0,
    }
  } catch (e) {
    return { output: { error: e?.message || String(e) }, code: 1 }
  }
}
