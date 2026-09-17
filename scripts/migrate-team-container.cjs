#!/usr/bin/env node
'use strict'
// 把**旧布局**团队（元数据摊在团队根目录下）迁移进 `.yfworking/` 容器。
//
// 为什么是**手动、显式**的：
//   团队根目录常常是共享盘/网盘上的**工作文件夹**（真实例子
//   `Z:\项目人员资料文件夹\梁知\湖北美宝药业股份有限公司`），同时被**其他成员的客户端**扫描。
//   旧版客户端只认团队根下的 `team.json`，一旦把清单挪进容器，**仍在用旧版的成员就再也发现不了
//   这个团队**（表现为"团队凭空消失"）。所以本工具默认只**预演**，必须显式 `--apply` 才动盘，
//   且不删除任何数据（用 rename 移动；失败即回滚）。
//
// 用法：
//   node scripts/migrate-team-container.cjs --dir "Z:\…\湖北美宝药业股份有限公司"            # 预演
//   node scripts/migrate-team-container.cjs --dir "Z:\…\湖北美宝药业股份有限公司" --apply     # 实际迁移
//   node scripts/migrate-team-container.cjs --all                                          # 迁移本机已加入的全部团队
//   node scripts/migrate-team-container.cjs --dir <dir> --rollback                         # 从容器搬回团队根
// 常用参数：--dry-run（默认）/ --apply / --all / --rollback / --json
const { existsSync, readFileSync, readdirSync, mkdirSync, renameSync, statSync, writeFileSync, rmSync } = require('node:fs')
const { join } = require('node:path')

const ROOT = join(__dirname, '..')
const { TEAM_CONTAINER_DIR, TEAM_LAYOUT, hideContainerSync } = require(join(ROOT, 'shared', 'team-source.mjs'))

/** 旧布局里"属于团队"的条目（要搬进容器的那些） */
const TEAM_ITEMS = [
  TEAM_LAYOUT.MANIFEST, TEAM_LAYOUT.MEMBERS_DIR, TEAM_LAYOUT.KEYS_DIR,
  TEAM_LAYOUT.CAS_DIR, TEAM_LAYOUT.VERSIONS_DIR, TEAM_LAYOUT.CLAIMS_DIR,
  TEAM_LAYOUT.KNOWLEDGE_DIR, TEAM_LAYOUT.EXPERIENCE_DIR, TEAM_LAYOUT.POLICY_FILE,
]

const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined }
const has = (n) => process.argv.includes(n)
const asJson = has('--json')
const apply = has('--apply') && !has('--dry-run')
const rollback = has('--rollback')

/**
 * 本机是否有正在运行的 YFWorking 应用进程。
 *
 * 为什么要检测：**旧版代码只认团队根下的 `team.json`**，迁移把清单挪进容器后，
 * 仍在运行的旧进程会立刻读不到团队（表现为"团队名空、成员 0"，严重时像团队凭空消失）。
 * 已在真实环境踩到：应用 14:12 启动、容器化代码 15:10 才进树 ⇒ 迁移后应用立刻看不到清单。
 * 因此迁移完必须提示重启，并把这点说清楚，而不是等用户自己发现"团队没了"。
 */
function runningAppPids() {
  try {
    const { execFileSync } = require('node:child_process')
    const ps = execFileSync('powershell', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe' or Name='electron.exe'\" | Where-Object { $_.CommandLine -match 'bridge\\.mjs|YFWorking|cli\\.mjs' } | Select-Object -ExpandProperty ProcessId"],
      { encoding: 'utf-8', windowsHide: true, timeout: 15000 })
    return ps.split(/\r?\n/).map((s) => s.trim()).filter((s) => /^\d+$/.test(s))
  } catch { return [] }   // 检测失败不阻断迁移（它只是提醒）
}

function targets() {
  if (arg('--dir')) return [arg('--dir')]
  const cfgPath = join(process.env.USERPROFILE || process.env.HOME, '.yfw', 'team', 'config.json')
  if (!existsSync(cfgPath)) return []
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
  return Object.values(cfg.teams || {}).map((t) => t.dir).filter(Boolean)
}

/** 判定目录当前布局 */
function inspect(dir) {
  const container = join(dir, TEAM_CONTAINER_DIR)
  const legacyItems = TEAM_ITEMS.filter((n) => existsSync(join(dir, n)))
  const inContainer = TEAM_ITEMS.filter((n) => existsSync(join(container, n)))
  return { dir, container, legacyItems, inContainer, containerExists: existsSync(container) }
}

/** 迁移：把旧布局条目 rename 进容器。返回 {moved, skipped, errors, rolledBack} */
function migrate(dir) {
  const info = inspect(dir)
  const moved = [], skipped = [], errors = []
  if (!existsSync(dir)) { errors.push(`目录不存在: ${dir}`); return { moved, skipped, errors, rolledBack: false } }
  if (!info.legacyItems.length) { skipped.push('团队根下没有旧布局条目（可能已是新布局）'); return { moved, skipped, errors, rolledBack: false } }
  mkdirSync(info.container, { recursive: true })
  for (const name of info.legacyItems) {
    const from = join(dir, name)
    const to = join(info.container, name)
    if (existsSync(to)) { errors.push(`目标已存在，跳过以避免覆盖: ${TEAM_CONTAINER_DIR}/${name}`); continue }
    try {
      renameSync(from, to)
      moved.push(name)
    } catch (e) {
      errors.push(`移动失败 ${name}: ${(e && e.message) || e}`)
    }
  }
  // 校验：搬完必须"新布局齐、旧位置空"；任何一项没到位就整体回滚（宁可不迁移，也不能半迁移）
  const after = inspect(dir)
  const bad = []
  for (const name of moved) {
    if (!existsSync(join(info.container, name))) bad.push(`容器内缺少 ${name}`)
    if (existsSync(join(dir, name))) bad.push(`团队根下仍残留 ${name}`)
  }
  if (bad.length || errors.length) {
    for (const name of moved) {
      const from = join(info.container, name)
      const to = join(dir, name)
      try { if (existsSync(from) && !existsSync(to)) renameSync(from, to) } catch { /* 回滚失败也要如实报出 */ }
    }
    // 容器若已空则移除（避免留下空壳）；非空就保留（可能有别的成员正在写）
    try {
      if (existsSync(info.container) && readdirSync(info.container).length === 0) rmSync(info.container, { recursive: true, force: true })
    } catch { /* 忽略 */ }
    return { moved: [], skipped, errors: [...errors, ...bad], rolledBack: true }
  }
  hideContainerSync(info.container)
  return { moved, skipped, errors, rolledBack: false }
}

/** 回滚：从容器搬回团队根 */
function unmigrate(dir) {
  const info = inspect(dir)
  const moved = [], errors = []
  if (!info.containerExists) return { moved, errors: ['容器不存在'], skipped: [] }
  for (const name of info.inContainer) {
    const from = join(info.container, name)
    const to = join(dir, name)
    if (existsSync(to)) { errors.push(`团队根下已存在同名条目，跳过: ${name}`); continue }
    try { renameSync(from, to); moved.push(name) } catch (e) { errors.push(`移动失败 ${name}: ${(e && e.message) || e}`) }
  }
  try {
    if (existsSync(info.container) && readdirSync(info.container).length === 0) rmSync(info.container, { recursive: true, force: true })
  } catch { /* 忽略 */ }
  return { moved, errors, skipped: [] }
}

/**
 * 生成"迁移后必须重启"的提示行（纯函数，便于测试）。
 * `pids` 为空表示未检测到运行中的应用。
 */
function restartNoticeLines(pids = [], movedAnything = false) {
  if (!movedAnything) return []
  const head = '─'.repeat(64)
  if (pids.length) {
    return [head,
      `⚠ 检测到 YFWorking 应用正在运行（PID ${pids.join(', ')}）。`,
      '  **请立即重启应用**：布局已改变，运行中的旧进程仍会去团队根下找清单，',
      '  在重启前会表现为"团队名缺失、成员显示为 0"。重启后即恢复正常。']
  }
  return [head, '✓ 未检测到运行中的应用；下次启动即按新布局读取。']
}

// ── CLI（仅直接执行时运行；被测试 require 时不得产生副作用）────────────────────
function main() {
  const results = []
  for (const dir of targets()) {
    const info = inspect(dir)
    if (asJson) {
      results.push({ dir, mode: rollback ? 'rollback' : (apply ? 'apply' : 'dry-run'), ...info, result: apply || rollback ? (rollback ? unmigrate(dir) : migrate(dir)) : null })
      continue
    }
    console.log(`\n── ${dir}`)
    console.log(`   当前布局: ${info.inContainer.length && !info.legacyItems.length ? '新布局（容器内）' : info.legacyItems.length ? '旧布局（散在团队根下）' : '未识别'}`)
    if (info.legacyItems.length) console.log(`   将搬入 ${TEAM_CONTAINER_DIR}/: ${info.legacyItems.join(', ')}`)
    if (info.inContainer.length) console.log(`   容器内已有: ${info.inContainer.join(', ')}`)
    if (!info.legacyItems.length && !rollback) { console.log('   → 无需迁移'); continue }
    if (!apply && !rollback) {
      console.log('   → 【预演】未改动任何文件。确认后加 --apply 执行。')
      console.log('   ⚠ 若仍有成员在用旧版客户端，迁移后他们将**无法再发现**该团队（旧版只认团队根下的 team.json）。')
      continue
    }
    const r = rollback ? unmigrate(dir) : migrate(dir)
    if (r.errors?.length) {
      console.log(`   ❌ ${rollback ? '回滚' : '迁移'}未完成（${r.rolledBack ? '已回滚，数据保持原状' : '未回滚'}）:`)
      for (const e of r.errors) console.log('      · ' + e)
    }
    if (r.moved?.length) console.log(`   ✅ 已${rollback ? '搬回团队根' : `搬入 ${TEAM_CONTAINER_DIR}/`}: ${r.moved.join(', ')}`)
    if (!r.errors?.length && r.moved?.length) console.log(`   ✅ 容器隐藏属性已设置（Windows）`)
  }
  if (asJson) console.log(JSON.stringify(results, null, 2))
  else if (!apply && !rollback) console.log('\n（预演结束；加 --apply 才会真正迁移）')

  // 迁移/回滚**改变了清单所在位置**：仍在跑的旧版进程会立刻读不到团队。
  // 这不是可选项，必须显式提示——否则用户看到的是"团队名空了/成员归零"，却不知道要重启。
  const movedAnything = results.some((r) => r.result?.moved?.length)
  if (apply || rollback) {
    const lines = restartNoticeLines(movedAnything ? runningAppPids() : [], movedAnything)
    if (lines.length) console.log('\n' + lines.join('\n'))
  }
}

module.exports = { TEAM_ITEMS, inspect, migrate, unmigrate, restartNoticeLines }
if (require.main === module) main()
