// Ponos-turbo 内核执行基座：子进程登记 / 子进程 env 白名单 / 文件路径边界
// ---------------------------------------------------------------------------
// **为什么独立成模块**（P2-1 巨石瘦身第一刀）：
//   `kernel/tools.mjs` 原本把这些"基础设施"与"具体工具实现"混在一个文件里。基础设施
//   有三个特征：① 被**多个**模块使用（tools 的 Bash/OCR、knowledge-import 的 python
//   转换）；② 自身只依赖 node 内置，不依赖任何工具逻辑；③ 携带**跨模块共享的活状态**
//   或安全策略。把它们下沉到本模块后，依赖方向变成单向的 DAG：
//
//       shared/*  ←  exec-base  ←  tools  ←  knowledge-import
//                                        ↖  media-tools（后续从 tools 拆出）
//
//   这样后续拆分 `tools.mjs` 的媒体簇（OCR/视觉）时，媒体模块可以静态依赖本模块拿到
//   子进程登记与边界校验，**不必反向 import tools.mjs** —— 否则 `tools ↔ media` 立刻
//   构成 ESM 循环依赖（图谱生成器把动态 import 也计为边，所以"改成动态 import"躲不掉）。
//
// **本模块承载的三件事**：
//   ① 活跃子进程登记（`ACTIVE_CHILDREN`）：Bash/OCR spawn 的子进程统一登记，内核退出或
//      会话中止时 `killActiveChildren()` 兜底全杀，防孤儿进程。
//   ② 子进程 env 白名单（`ENV_WHITELIST`/`childEnv`）：只透传系统路径/编码/代理变量，
//      剥离全部凭据类与 PONOS_* 配置类变量（防子进程窃取宿主密钥）。
//   ③ 文件路径边界（`safeRealpath`/`realForComparison`/`withinBoundary`/`resolvePath`）：
//      realpath 解析真实路径（解符号链接）后再比对，防链接逃逸出 --add-dir 边界。
//
// **不搬进来的**：`runShell`（Bash 工具的 shell 语义与输出截断属工具实现）、
// `READ_MAX_LINES/BYTES`（Read 工具常量）、`BASH_TIMEOUT_MS`（Bash 工具超时）——
// 它们只服务单个工具，留原地更内聚。本模块只收"多模块共用的管道"。
//
// **一处必须同步的耦合**：`ENV_WHITELIST` 的代理变量集合与 `kernel/mcp.mjs` 的
// `ENV_KEEP` **逐字对齐**，由 `kernel-tests/proxy-env-whitelist.test.mjs` 断言两套集合
// 相等防漂移（该测试与 `knowledge-root-consistency.test.mjs` 会扫描**本文件**取白名单，
// 搬迁时已同步更新其路径）。改这里的代理段必须同步改 `mcp.mjs`，否则测试会红。
import { spawn, execSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { dirname, resolve, sep, join, basename } from 'node:path'

// R2-1 活跃子进程登记：Bash/OCR spawn 的子进程统一登记，内核退出（SIGINT/TERM）
// 时 killActiveChildren 兜底清理，防孤儿进程。child 'close' 后自动移除。
const ACTIVE_CHILDREN = new Set()
export function registerChild(child) {
  ACTIVE_CHILDREN.add(child)
  child.once('close', () => ACTIVE_CHILDREN.delete(child))
  return child
}
export function killActiveChildren() {
  for (const c of ACTIVE_CHILDREN) {
    try {
      // Windows 坑：git-bash（MSYS2）的 bash.exe 对 TerminateProcess 免疫，
      // child.kill() 返回 true 但进程不死（实测）。taskkill /F /T 杀整个进程树
      // （含 bash 派生的 sleep 等子进程），契约 §8"真杀 bash"同源。非 Windows
      // 走常规 kill。已退出进程 taskkill 非 0 → execSync 抛 → catch 忽略。
      if (process.platform === 'win32') {
        try { execSync(`taskkill /F /T /PID ${c.pid}`, { stdio: 'ignore' }) } catch { /* 进程已退出 */ }
      }
      c.kill()
    } catch {}
  }
  ACTIVE_CHILDREN.clear()
}

// S2-2 子进程 env 白名单：仅透传系统路径/编码/代理变量，其余一律剥离——包含全部
// 凭据类与 PONOS_* 配置类变量，以及那些经兼容垫片映射为 PONOS_* 的历史旧名
// （防 Bash/OCR 子进程窃取宿主密钥）。
// S6 增补 `PONOS_HOME`：内核 CLI 解析配置根时会认它（`PONOS_CONFIG_DIR > PONOS_HOME > ~/.ponos`），
// 而 `PONOS_CONFIG_DIR` 被上面这条安全策略刻意剥离 → 不补这一项，agent 在 Bash 里跑的
// `--knowledge append` 会落到 `~/.ponos`（**与应用侧 `.yfw` 不同的根**，写进去 GUI 看不见）。
// 选语义中性的 `PONOS_HOME` 而非放开 `PONOS_CONFIG_DIR`：前者只是一个目录路径，
// 后者是配置/会话根目录名；放行前者的代价最小（HOME 本就在白名单，目录名也可猜），
// 却能保证"内核子进程 / Bash 子进程"两条路解析到同一个根。
const ENV_WHITELIST = [
  'PATH', 'Path', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'TMP', 'TEMP', 'TMPDIR',
  'SystemRoot', 'WINDIR', 'ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA', 'APPDATA',
  'LANG', 'LC_ALL', 'LANGUAGE', 'TERM', 'SHELL', 'COMSPEC', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  // 代理 P1（2026-09-17）：Node 24 的开关，**必须**透传 —— 只给 HTTP_PROXY 而缺它，
  // 子进程里跑的 node（Bash 里的脚本、Node 型 MCP 服务器）等于没配代理。
  // 与 kernel/mcp.mjs 的 ENV_KEEP 代理段逐字对齐（有集合比对断言防漂移）。
  'NODE_USE_ENV_PROXY',
  'PONOS_HOME',
]
export function childEnv() {
  const out = {}
  for (const k of Object.keys(process.env)) {
    if (ENV_WHITELIST.includes(k)) out[k] = process.env[k]
  }
  return out
}

// Windows 探测 git-bash：Bash 工具语义须与系统提示一致（shell: bash）。
// cmd.exe 的 /d /s /c 引号解析与 Node spawn 的参数包裹互相干扰（$HOME 不展开、
// 引号错乱），且 PATH 混入 Git Unix 工具时行为不可预测；git-bash 与模型所见
// 环境一致。找不到 git-bash 时回退 cmd.exe。
export function findGitBash() {
  const candidates = [
    process.env.ProgramFiles && join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
    process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'),
  ].filter(Boolean)
  return candidates.find((p) => existsSync(p)) || null
}

// 文件路径边界：仅允许读写 --add-dir 注入的目录（cwd / 技能根）内文件
// S4-1 路径加固：realpath 解析真实路径（解符号链接），防链接逃逸出边界。
// 文件不存在时对最近存在的父目录做 realpath，再拼回剩余段（写入新文件场景）。
export function safeRealpath(p) {
  try { return realpathSync(p) } catch { return p }
}
export function realForComparison(p) {
  const r = resolve(p)
  const real = safeRealpath(r)
  if (real !== r) return real
  // 路径不存在：逐级向上找最近存在的祖先做 realpath
  let cur = r
  const tail = []
  for (let i = 0; i < 32; i++) {
    try {
      realpathSync(cur)
      return join(realpathSync(cur), ...tail.reverse())
    } catch {
      const parent = dirname(cur)
      if (parent === cur) return r
      tail.push(basename(cur))
      cur = parent
    }
  }
  return r
}

export function withinBoundary(filePath, allowDirs) {
  const resolved = resolve(filePath)
  const real = realForComparison(resolved).toLowerCase()
  return allowDirs.some((dir) => {
    const base = realForComparison(resolve(dir)).toLowerCase()
    return real === base || real.startsWith(base + sep)
  })
}

// 相对路径解析到 cwd（消除"试 4 种路径格式"的浪费）：绝对路径原样，~ 展开，
// 其余 resolve(cwd, p)。
export function resolvePath(p, cwd) {
  if (!p) return p
  if (p.startsWith('~') || p.startsWith('~/')) return join(process.env.HOME || process.env.USERPROFILE || '', p.slice(p[1] === '/' ? 2 : 1))
  return resolve(cwd || process.cwd(), p)
}
