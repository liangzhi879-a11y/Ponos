// 隔离工作区管理：git worktree 为每个 (agent × task) 组合创建独立副本
// ---------------------------------------------------------------------------
// 要点：
//  - worktree 与主仓库共享 .git 对象，磁盘占用小、checkout 快
//  - 每 worktree checkout 到任务 base commit，独立 branch（bench-<agent>-<task>）
//  - 任务完成后保留工作区（供人工检查 agent 改动），清理用 cleanupWorkspace()
// ---------------------------------------------------------------------------
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export function repoGit(repo, args, opts = {}) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...opts,
  })
}

/** worktree 是否已存在（branch 名或路径） */
export function worktreeExists(repo, branch) {
  try {
    const out = repoGit(repo, ['worktree', 'list', '--porcelain'])
    return out.includes(`branch refs/heads/${branch}`)
  } catch {
    return false
  }
}

/**
 * 创建（或复用）一个隔离工作区。
 * @param {object} o
 * @param {string} o.repo 内核仓库路径
 * @param {string} o.wsRoot benchmark/workspace 根目录
 * @param {string} o.branch 分支名（唯一标识 agent×task）
 * @param {string} o.base 起点 commit（父提交 / HEAD）
 * @returns {string} 工作区路径
 */
export function ensureWorkspace({ repo, wsRoot, branch, base }) {
  const wsPath = `${wsRoot}/${branch}`
  if (worktreeExists(repo, branch)) {
    // 复用前重置到 base 干净状态——丢弃上次评测 agent 的改动与未跟踪文件，
    // 否则 verify 会跑在旧改动上造成"假 PASS"（实测：usage=0 却 status=pass）。
    // 保留 ignored 文件（node_modules 等），只清 tracked 修改与 untracked。
    execFileSync('git', ['-C', wsPath, 'reset', '--hard', base], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    execFileSync('git', ['-C', wsPath, 'clean', '-fd'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return wsPath
  }
  // 新建 branch + worktree（checkout 到 base commit）
  execFileSync('git', ['-C', repo, 'worktree', 'add', wsPath, base, '-b', branch], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  return wsPath
}

/** 采集 agent 在工作区的改动（unstaged diff stat + 新增未跟踪文件） */
export function collectDiff(repo, wsPath, exclude = []) {
  // 排除路径（如环境补丁文件）：git pathspec 须单 token ':(exclude)<path>'，
  // 拆成 [':(exclude)', path] 会被 git 解析为"排除一切"→ diff 恒为空。
  // 注意：diff 须以工作区为 repo（-C wsPath，工作区有自己的 HEAD=base commit），
  // 而非主仓库；pathspec 用 '.'（相对工作区根）
  const exclArgs = exclude.flatMap((p) => [':(exclude)' + p])
  const out = {}
  try {
    out.stat = repoGit(wsPath, ['diff', '--stat', '--no-color', '--', '.', ...exclArgs], { cwd: wsPath }).trim()
  } catch {
    out.stat = ''
  }
  try {
    out.nameStatus = repoGit(wsPath, ['diff', '--name-status', '--no-color', '--', '.', ...exclArgs], { cwd: wsPath }).trim()
  } catch {
    out.nameStatus = ''
  }
  try {
    out.untracked = execFileSync('git', ['-C', wsPath, 'ls-files', '--others', '--exclude-standard'], {
      encoding: 'utf8',
    }).trim()
  } catch {
    out.untracked = ''
  }
  // patch 全文（含未跟踪文件内容）：供语义越界审计扫描 agent 新增代码中的
  // "自我合理化"注释/语义决策（如去重口径）。未跟踪文件无 diff，直接读内容。
  let patch = ''
  try {
    patch = repoGit(wsPath, ['diff', '--no-color', '--', '.', ...exclArgs], { cwd: wsPath })
  } catch { /* 忽略 */ }
  for (const u of out.untracked.split('\n').filter(Boolean)) {
    try {
      const content = readFileSync(join(wsPath, u), 'utf8')
      patch += `\n--- ${u} (untracked) ---\n${content}`
    } catch { /* 忽略 */ }
  }
  out.patch = patch.slice(0, 60000)
  return out
}

/** 清理评测产生的工作区（branch + worktree） */
export function cleanupWorkspace(repo, branch, wsPath) {
  try {
    execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', wsPath], {
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch { /* 忽略 */ }
  try {
    execFileSync('git', ['-C', repo, 'branch', '-D', branch], {
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch { /* 忽略 */ }
}
