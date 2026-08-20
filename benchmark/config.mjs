// benchmark 评测配置（YFW-turbo 内核横向评估平台）
// ---------------------------------------------------------------------------
// 被测对象：yfw（本内核）/ claude（Claude Code）/ pi（pi agent）/ deepseek（deepseek-harness）
// 所有 agent 在「同一代码库起点」上运行同一任务集，输出可比指标。
// ---------------------------------------------------------------------------

export const CONFIG = {
  // 内核仓库位置（git 历史是任务集来源，worktree 是隔离工作区）
  repo: 'C:/Users/T203-15/yfworking-dev',

  // 评测根目录（本文件所在目录）
  root: new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]):/, '$1:'),

  // 模型名（透传给各 agent；ANTHROPIC_MODEL 已在 shell env，这里作为 yfw 显式传参）
  model: process.env.ANTHROPIC_MODEL || 'deepseek-v4-flash',

  // 每 (agent × task) 的超时上限（ms）。真实评测单个任务可能数分钟。
  timeoutMs: 15 * 60 * 1000,

  // 运行控制
  agents: ['yfw', 'claude', 'pi', 'deepseek'], // 默认全部；可用 --agents 覆盖
  maxTasksPerAgent: null, // 默认全部；可用 --limit 覆盖（null=不限制）

  // 成本单价（$/1M token），用于 cost 列；只做换算，不要求精确
  pricePerMInput: 0.2,
  pricePerMOutput: 1.2,

  // 目录
  dirs: {
    workspace: 'workspace', // 隔离工作区（git worktree）
    results: 'results', // 评测输出
    vendors: 'vendors', // 参考实现源码（claude-code-src / pi-src / deepseek-src）
  },

  // 各 agent 的启动命令（基准：在 workspace 内运行；YFW 走 stdin NDJSON 契约）
  agentCmd: {
    // node kernel/cli.mjs，stdin 喂 NDJSON，--dangerously-skip-permissions 自动审批
    yfw: (ws) => ({
      cmd: process.execPath,
      args: [
        'kernel/cli.mjs',
        '--print',
        '--output-format', 'stream-json',
        '--input-format', 'stream-json',
        '--dangerously-skip-permissions',
        '--model', process.env.ANTHROPIC_MODEL || 'deepseek-v4-flash',
        '--add-dir', ws,
      ],
      cwd: ws,
      stdinProtocol: 'ndjson', // 交互式：先等 system(init)，再写 user
    }),
    // claude CLI（全局已装 2.1.234），非交互 -p 模式
    claude: (ws) => ({
      cmd: 'claude',
      args: ['-p', '__PROMPT__', '--dangerously-skip-permissions', '--output-format', 'jsonl', '--verbose'],
      cwd: ws,
      stdinProtocol: 'stdio', // 一次性传 prompt
    }),
    // pi coding-agent（需先构建：vendors/pi-src/pi-main 内 npm run build -w @earendil-works/pi-coding-agent）
    pi: (ws) => ({
      cmd: 'node',
      args: ['__PI_CLI__', '__PROMPT__'],
      cwd: ws,
      stdinProtocol: 'stdio',
    }),
    // deepseek-harness（tsx 直接跑，无构建）
    deepseek: (ws) => ({
      cmd: 'node',
      args: ['--import', 'tsx/esm', '__DSH_BIN__', '__PROMPT__'],
      cwd: ws,
      stdinProtocol: 'stdio',
    }),
  },
}
