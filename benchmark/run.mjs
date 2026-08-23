#!/usr/bin/env node
// YFW-turbo 内核横向评估平台 —— 评测主入口
// ---------------------------------------------------------------------------
// 用法：
//   node benchmark/run.mjs                    # 全量：4 agents × 全部任务
//   node benchmark/run.mjs --agents yfw,claude # 指定被测对象
//   node benchmark/run.mjs --tasks T001,T003   # 指定任务
//   node benchmark/run.mjs --limit 1           # 每 agent 只跑前 N 个任务（冒烟）
//   node benchmark/run.mjs --smoke             # 冒烟：每 agent 1 个任务验证链路
// 输出：results/<timestamp>/（每 agent×task 一条 JSON + summary.json + 日志）
// 报告：node benchmark/report.mjs results/<timestamp>
// ---------------------------------------------------------------------------
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, copyFileSync, rmSync } from 'node:fs'
import { join, basename } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { CONFIG } from './config.mjs'
import { ensureWorkspace, collectDiff, repoGit } from './lib/workspace.mjs'
import { applyBasePatch, EXCLUDED_PATCH_FILES } from './lib/base-patches.mjs'
import { runYFW } from './harness/yfw.mjs'
import { runClaude, runPi, runDeepseek } from './harness/adapters.mjs'
import { diagnoseAgents, printDiagnosis, costOf } from './lib/llm-api.mjs'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const root = CONFIG.root

// ── 参数解析 ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
function argVal(name) {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : null
}
const agents = (argVal('--agents') || CONFIG.agents.join(',')).split(',').map((s) => s.trim()).filter(Boolean)
// 启动门禁跳过开关：--force 允许缺 key/baseUrl 仍继续（调试/离线冒烟用）
const force = argv.includes('--force')
const tasksFilter = argVal('--tasks')?.split(',').map((s) => s.trim()).filter(Boolean) || null
const limit = argVal('--limit') ? Number(argVal('--limit')) : CONFIG.maxTasksPerAgent
// 多轮稳定评测：--runs N 时每 (agent × task) 跑 N 次，聚合条目取中位数
// （toolCalls/durationMs），status 全部 pass 才记 pass，各轮原始文件 .r<k> 留档。
// LLM 采样存在随机性（单次 toolCalls 可波动 ±20），多轮中位数消除噪声后可比。
const runs = argVal('--runs') ? Math.max(1, Number(argVal('--runs'))) : 1
const smoke = argv.includes('--smoke')
// B3 增量续跑：--resume（自动沿用最近结果目录）或 --resume <dir>（指定目录）。
// 已存在结果的 agent×task 跳过不重跑；返回值以 `--` 开头时视为无值（用最新目录）
function flagOrValue(name) {
  const i = argv.indexOf(name)
  if (i < 0) return null
  const v = argv[i + 1]
  return v && !v.startsWith('--') ? v : ''
}
const resumeSpec = flagOrValue('--resume')
// dashboard 控制文件：JSON { cmd: 'pause'|'resume'|'abort', by }。任务边界检查，
// 收到 pause 阻塞等待、abort 抛出中断（评测由 dashboard 子进程拉起时使用）
const controlFile = argVal('--control-file')

// ── 控制检查点（任务之间）────────────────────────────────────────────────────
// 在单个任务开始前调用：pause 时循环等待（不打断正在跑的任务），abort 抛错。
// control 文件由 dashboard 写入 { cmd }，run 侧只在读到非 pause/abort 时放行。
async function checkControl(label) {
  if (!controlFile) return
  for (;;) {
    let cmd = null
    try {
      cmd = JSON.parse(readFileSync(controlFile, 'utf8')).cmd
    } catch { /* 文件不存在/损坏 → 放行 */ }
    if (cmd === 'abort') {
      throw new Error(`[control] ${label} 收到 abort，评测中断`)
    }
    if (cmd === 'pause') {
      console.log(`[control] ${label} 暂停中（等待 dashboard 继续/终止）...`)
      await new Promise((r) => setTimeout(r, 1500))
      continue
    }
    return
  }
}

// ── 任务集加载 ────────────────────────────────────────────────────────────────
function loadTasks() {
  const tasksDir = join(root, 'tasks')
  const tasks = []
  for (const name of readdirSync(tasksDir).sort()) {
    const dir = join(tasksDir, name)
    const metaFile = join(dir, 'task.json')
    if (!existsSync(metaFile)) continue
    const meta = JSON.parse(readFileSync(metaFile, 'utf8'))
    // base="HEAD" 解析为主仓库当前 HEAD 的 commit hash——静态 "HEAD" 会随
    // worktree 创建时刻冻结（复用旧 worktree 时 checkout 到陈旧版本），
    // 必须每次评测解析为最新，否则历史内核跑在已修复形态上仍出旧缺陷
    if (meta.base === 'HEAD') meta.base = repoGit(CONFIG.repo, ['rev-parse', 'HEAD']).trim()
    const prompt = readFileSync(join(dir, 'prompt.md'), 'utf8')
    const verifyFile = join(dir, 'verify.mjs')
    if (!existsSync(verifyFile)) throw new Error(`task ${meta.id}: verify.mjs missing`)
    tasks.push({ ...meta, dir, prompt, verifyFile, name })
  }
  return tasks
}

// ── agent 调度表（内核完善后在此注册新适配器）──────────────────────────────
const AGENT_RUNNERS = {
  yfw: runYFW,
  claude: runClaude,
  pi: runPi,
  deepseek: runDeepseek,
}

// ── 单任务执行 ────────────────────────────────────────────────────────────────
async function runOne({ agent, task, ts, onLog }) {
  const branch = `bench-${agent}-${task.id}`
  const wsRoot = join(root, CONFIG.dirs.workspace)
  mkdirSync(wsRoot, { recursive: true })

  // 1. 隔离工作区（git worktree，checkout 到任务 base commit）
  //    SWE-bench 任务（type=swebench）的仓库是外部项目（vendors/swebench-repos/
  //    下的克隆），base 是外部仓库历史 commit；其余任务用内核仓库
  const taskRepo = task.repo || CONFIG.repo
  let ws
  try {
    ws = ensureWorkspace({ repo: taskRepo, wsRoot, branch, base: task.base })
  } catch (e) {
    return { agent, task: task.id, status: 'workspace-error', error: String(e) }
  }

  // 2. yfw 专属：任务 base 的历史内核兼容补丁（如 T001/T002 工具透传缺陷），
  //    运行前应用，不影响 agent 改动统计（diff 中排除，basePatched 单独记录）。
  //    仅内核仓库任务适用（SWE-bench 任务打的是外部项目，无历史内核补丁）
  const basePatched = agent === 'yfw' && !task.repo ? applyBasePatch(task.id, ws) : null

  // 3. 跑 agent（同一提示词）。yfw 内核入口从内核仓库启动（kernel/cli.mjs），
  //    --add-dir 指向任务工作区；SWE-bench 任务工作区是外部仓库，须显式传
  //    kernelDir=内核仓库，否则内核启动文件找不到（ERR_MODULE_NOT_FOUND）。
  //    B1：per-task timeoutMs（task.json 可声明）覆盖全局默认——"基线×3+缓冲"
  //    以任务自身预算形式落地，防单任务拖垮全量（T004 30+ 分钟事件）
  const runner = AGENT_RUNNERS[agent]
  const started = Date.now()
  let run
  let spawnError = null
  try {
    run = await runner({ ws, prompt: task.prompt, timeoutMs: task.timeoutMs || CONFIG.timeoutMs, onLog, kernelDir: agent === 'yfw' ? CONFIG.repo : undefined })
  } catch (e) {
    // B2：runner 抛异常 = 进程异常死亡/spawn 失败 → 标记 salvage，残留改动照常验收
    spawnError = String(e)
    run = { exitCode: -9, stdout: '', stderr: spawnError, usage: null, toolCalls: 0, timedOut: false }
  }
  const durationMs = Date.now() - started

  // 4. B1：超时后跳过 verify（改动残留不可信，直接标 timeout，不产出假 pass/fail）；
  //    B2：进程异常死亡（spawnError / 非 0 退出码）仍跑 verify 但结果带 salvage 标注
  const timedOut = !!run.timedOut
  const salvaged = !!spawnError || (run.exitCode !== 0 && !timedOut && run.exitCode !== -3) // -3=pi/deepseek 未构建，非异常
  let verify = { ok: false, stdout: '', stderr: '(task timeout，跳过验收)' }
  if (!timedOut) {
    verify = await verifyTask(task, ws, onLog)
  }

  // 5. 采集改动（仅排除纯环境补丁文件 engine.mjs/permissions.mjs；
  //    api.mjs 虽也打补丁但可能是任务合法目标，必须计入 agent 改动）
  const diff = collectDiff(taskRepo, ws, basePatched ? EXCLUDED_PATCH_FILES : [])

  // 5. 指标汇总
  const cost = costOf(run.usage)
  const selfTested = /(node --test|npm test|run test|verify)/i.test(run.stdout + '\n' + run.stderr)
  // 可信度：usage=0 且 toolCalls=0 说明 agent 未实际执行（协议/配置/链路问题），
  // 结果标记 invalid 而非 pass/fail——否则 verify 在残留改动上会产出"假 PASS"
  const executed = (run.usage?.input_tokens || run.usage?.output_tokens || 0) > 0 || (run.toolCalls || 0) > 0

  return {
    agent, task: task.id, base: task.base,
    status: timedOut ? 'timeout' : (executed ? (verify.ok ? 'pass' : 'fail') : 'invalid'),
    executed,
    durationMs,
    exitCode: run.exitCode,
    timedOut,
    salvaged,
    usage: run.usage,
    toolCalls: run.toolCalls,
    cost,
    selfTested,
    basePatched,
    verify: { ok: verify.ok, stdout: verify.stdout.slice(0, 2000), stderr: verify.stderr.slice(0, 2000) },
    diff: { stat: diff.stat.slice(0, 2000), nameStatus: diff.nameStatus.slice(0, 2000), untracked: diff.untracked.slice(0, 1000), patch: diff.patch },
    stdoutTail: run.stdout.slice(-3000),
    stderrTail: run.stderr.slice(-1500),
  }
}

/** 在任务工作区上运行验收脚本 */
async function verifyTask(task, ws, onLog) {
  const { execFile } = await import('node:child_process')
  // 超时 300s：SWE-bench 任务 verify 需逐个跑 FAIL_TO_PASS + PASS_TO_PASS 的
  // pytest（10+ 用例），Python 冷启动/import sympy 较慢；120s 上限实测误杀
  // 正常修复（yfw×SWE004 EXIT:null 假失败，手动重跑 58s 即通过）。
  return new Promise((resolve) => {
    execFile(process.execPath, [task.verifyFile, ws], { cwd: ws, timeout: 300000, env: process.env },
      (err, stdout, stderr) => {
        resolve({ ok: !err, stdout: stdout || '', stderr: (stderr || '') + (err ? '\nEXIT:' + err.code : '') })
      })
  })
}

// ── 主流程 ────────────────────────────────────────────────────────────────────
async function main() {
  // API 通道诊断（启动即打印各 agent 密钥/模型/端点状态）
  const diag = diagnoseAgents(agents, { checkBin: true })
  printDiagnosis(diag)
  // 启动门禁：所选 agent 配置不完整（缺 key/baseUrl/可执行文件）时拒绝启动。
  // 实测教训：无 baseUrl 时 yfw 内核首轮即报"未检测到可用协议"、usage=0 整批
  // 结果作废——与其产出垃圾数据，不如先补齐配置（--force 可跳过）。
  const bad = diag.filter((d) => !d.ok && !force)
  if (bad.length) {
    console.error('\n[FATAL] 以下被测对象配置不完整，拒绝启动评测：')
    for (const d of bad) console.error(`  - ${d.agent}: ${d.reason}`)
    console.error('请配置 benchmark/.env（模板见 benchmark/.env.example），或加 --force 跳过检查。')
    process.exit(1)
  }
  const tasks = loadTasks()
  const picked = tasksFilter
    ? tasks.filter((t) => tasksFilter.includes(t.id))
    : tasks
  if (smoke) {
    // 冒烟：每 agent 只跑第一个任务（验证链路通）
    const first = picked[0]
    for (const agent of agents) {
      const resultsDir = join(root, CONFIG.dirs.results, `smoke-${Date.now()}`)
      mkdirSync(resultsDir, { recursive: true })
      const log = []
      const r = await runOne({ agent, task: first, ts: Date.now(), onLog: (k, l) => log.push(`[${k}] ${l}`) })
      r.log = log.join('\n').slice(-8000)
      writeFileSync(join(resultsDir, `${agent}-${first.id}.json`), JSON.stringify(r, null, 2))
      console.log(`[smoke] ${agent} × ${first.id}: ${r.status} (${r.durationMs}ms)`)
    }
    console.log('冒烟完成。结果见 benchmark/results/')
    return
  }

  // B3 增量续跑：--resume 复用既有结果目录（跳过已完成），否则新建本轮目录
  const hasJson = (d) => {
    try { return readdirSync(join(root, CONFIG.dirs.results, d)).some((f) => f.endsWith('.json')) } catch { return false }
  }
  let resultsDir
  let ts
  if (resumeSpec !== null) {
    const base = join(root, CONFIG.dirs.results)
    if (resumeSpec) {
      resultsDir = join(base, resumeSpec.replace(/^results[/\\]/, ''))
      if (!existsSync(resultsDir)) { console.error(`[FATAL] resume 结果目录不存在：${resultsDir}`); process.exit(1) }
    } else {
      const existing = readdirSync(base).filter((d) => hasJson(d)).sort()
      if (!existing.length) { console.error('[FATAL] 无既有结果目录可 resume'); process.exit(1) }
      resultsDir = join(base, existing[existing.length - 1])
      console.log('[resume] 沿用最近结果目录：', resultsDir)
    }
  } else {
    ts = new Date().toISOString().replace(/[:.]/g, '-')
    resultsDir = join(root, CONFIG.dirs.results, ts)
    mkdirSync(resultsDir, { recursive: true })
    writeFileSync(join(resultsDir, 'meta.json'), JSON.stringify({
      ts, agents, tasks: picked.map((t) => t.id), model: CONFIG.model, repo: CONFIG.repo,
    }, null, 2))
  }

  const summary = []
  // active.json 心跳：dashboard 据此显示"评测中 + 已耗时"（每任务开始写、结束删）
  const activeFile = join(resultsDir, 'active.json')
  const writeActive = (agent, task) => writeFileSync(activeFile, JSON.stringify({ agent, task, since: Date.now() }, null, 2))
  const clearActive = () => { try { rmSync(activeFile, { force: true }) } catch { /* 忽略 */ } }
  try {
    for (const agent of agents) {
      const tasksForAgent = limit ? picked.slice(0, limit) : picked
      for (const task of tasksForAgent) {
        const log = []
        const label = `${agent} × ${task.id}`
        // B3：resume 模式下已有结果 → 跳过（读回并入 summary，供 report/dashboard 续用）
        const outFile = join(resultsDir, `${agent}-${task.id}.json`)
        if (resumeSpec !== null && existsSync(outFile)) {
          console.log(`[resume] 跳过 ${label}（已有结果）`)
          try { summary.push(JSON.parse(readFileSync(outFile, 'utf-8'))) } catch { /* 损坏则忽略 */ }
          continue
        }
        await checkControl(label) // 控制检查点：pause 等待 / abort 中断
        if (runs > 1) {
          // 多轮稳定评测：跑 N 次，聚合中位数，各轮留档
          const rounds = []
          for (let k = 1; k <= runs; k++) {
            const roundLog = []
            const rlabel = `${label} round ${k}/${runs}`
            await checkControl(rlabel)
            console.log(`[run] ${rlabel} ...`)
            writeActive(agent, `${task.id}#${k}`)
            const r = await runOne({ agent, task, ts, onLog: (kk, l) => roundLog.push(`[${kk}] ${l}`) })
            r.log = roundLog.join('\n').slice(-12000)
            writeFileSync(join(resultsDir, `${agent}-${task.id}.r${k}.json`), JSON.stringify(r, null, 2))
            rounds.push(r)
            console.log(`[run] ${rlabel}: ${r.status} (${r.durationMs}ms)`)
          }
          const median = (arr) => {
            const s = [...arr].sort((a, b) => a - b)
            const m = Math.floor(s.length / 2)
            return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2)
          }
          const allPass = rounds.every((r) => r.status === 'pass')
          const agg = {
            agent, task: task.id, base: task.base, status: allPass ? 'pass' : 'fail',
            rounds: rounds.map((r) => ({ status: r.status, toolCalls: r.toolCalls, durationMs: r.durationMs })),
            toolCalls: median(rounds.map((r) => r.toolCalls ?? 0)),
            durationMs: median(rounds.map((r) => r.durationMs ?? 0)),
            usage: rounds[0]?.usage ?? null,
            selfTested: rounds.every((r) => r.selfTested),
            diff: rounds[0]?.diff ?? null,
            basePatched: rounds[0]?.basePatched ?? null,
          }
          writeFileSync(join(resultsDir, `${agent}-${task.id}.json`), JSON.stringify(agg, null, 2))
          summary.push(agg)
          console.log(`[run] ${label}: 聚合 ${allPass ? 'pass' : 'fail'} (中位 ${agg.toolCalls} 工具 / ${agg.durationMs}ms)`)
          continue
        }
        console.log(`[run] ${label} ...`)
        writeActive(agent, task.id)
        const r = await runOne({ agent, task, ts, onLog: (k, l) => log.push(`[${k}] ${l}`) })
        r.log = log.join('\n').slice(-12000)
        writeFileSync(join(resultsDir, `${agent}-${task.id}.json`), JSON.stringify(r, null, 2))
        summary.push(r)
        console.log(`[run] ${label}: ${r.status} (${r.durationMs}ms)`)
      }
    }
  } finally {
    clearActive() // 评测结束（含异常中断）清理心跳
    // 中断（abort/异常）时也写部分 summary，便于 dashboard/report 读取已完成的轮次
    if (summary.length && !existsSync(join(resultsDir, 'summary.json'))) {
      writeFileSync(join(resultsDir, 'summary.json'), JSON.stringify(summary, null, 2))
    }
  }
  writeFileSync(join(resultsDir, 'summary.json'), JSON.stringify(summary, null, 2))
  console.log(`\n评测完成：${summary.filter((s) => s.status === 'pass').length}/${summary.length} 通过`)
  console.log(`结果目录：benchmark/results/${ts}`)
  console.log('生成报告：node benchmark/report.mjs results/' + ts)
}

main().catch((e) => { console.error(e); process.exit(1) })
