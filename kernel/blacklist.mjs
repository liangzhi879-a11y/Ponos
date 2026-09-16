// Ponos-turbo 硬黑名单（灾难级命令的绝对底线）
// ---------------------------------------------------------------------------
// 与 highrisk.mjs 的分工：highrisk 回答"要不要问用户"（普通高危 → ask，档位可放宽）；
// blacklist 回答"是否属于灾难级操作"——任何审批档位（含 bypass）下都必须问，
// 且弹窗带灾难级警示。两者语义不同、词表也不同，故分文件维护，互不影响。
//
// 判定方式是**命令位置的结构化匹配**，而不是整串子串匹配：只有出现在命令头部
// （可含 sudo/runas/bash -c 等包装器）的位置才算命中，这样 `grep shutdown app.log`、
// `echo reboot` 这类"词只出现在参数里"的调用不会被误伤。对包装器（bash -c "…"、
// sudo …、powershell -Command …）做有限深度的递归扫描（MAX_DEPTH），封住最常见的
// 绕过写法。纯函数、零依赖。
//
// 注意：本模块只覆盖"毁灭性"五族（根/家目录递归删、格式化/分区、dd 写裸设备、
// 关机/重启、mkfs）。删除普通目录、git push --force 等仍归 highrisk 管。

// 命令位置：每段 shell 命令的头部（跳过前缀 flag 与包装器后）落在这里才算命中
const DELETE_TOOLS = new Set(['rm', 'rd', 'rmdir', 'del', 'erase', 'remove-item', 'ri'])
const POWER_TOOLS = new Set(['shutdown', 'reboot', 'halt', 'poweroff', 'stop-computer', 'restart-computer'])
// 包装器：头部是它 → 递归扫描其参数（内层命令同样可能灾难）
const WRAPPERS = new Set([
  'sudo', 'runas', 'doas', 'env', 'nohup', 'command', 'eval', 'time', 'nice', 'setsid', 'xargs', 'start',
  'bash', 'sh', 'zsh', 'dash', 'ash', 'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'wsl',
])
const SHELL_SPLIT = /\s*(?:&&|\|\||;|\||\n|\r)\s*/
const MAX_DEPTH = 3
const MAX_SEGMENTS = 200

// 灾难族标识（测试与文档引用；不含判定逻辑）
export const CATASTROPHIC_FAMILIES = [
  'root-or-home-recursive-delete', // rm -rf / ~ $HOME、rd /s /q C:\
  'mkfs',                          // mkfs / mkfs.ext4 …
  'format-partition',              // format X: / diskpart
  'dd-raw-device',                 // dd of=/dev/sda | \\.\PhysicalDrive0
  'power-control',                 // shutdown / reboot / poweroff / Stop-Computer
]

export const CATASTROPHIC_REASON = '命中硬黑名单（灾难级操作），任何审批档位下均需用户确认，请谨慎放行'

// 去引号后按空白切分；引号内空白不切（保证 `"rm -rf /"` 保持为一个 token，
// 交给递归扫描再展开）。成对引号/未闭合引号都按字面处理，不抛。
function tokenize(segment) {
  const out = []
  let cur = ''
  let quote = null
  for (const ch of segment) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === ' ' || ch === '\t') { if (cur) { out.push(cur); cur = '' } continue }
    cur += ch
  }
  if (cur) out.push(cur)
  return out
}

// 递归删除标志：rm 的 -r/-R/-f/--recursive/--force、Windows rd|del 的 /s、PowerShell 的 -Recurse/-Force
function hasRecursiveFlag(tokens) {
  return tokens.some((t) => {
    const s = t.toLowerCase()
    if (s === '--recursive' || s === '--force' || s === '-recurse' || s === '/s') return true
    if (/^-[a-z]*[rf][a-z]*$/.test(s)) return true // -rf / -fr / -Rf / -fR
    return false
  })
}

// 目标是否"根/家目录本身"（不含其子路径：rm -rf ~/proj 不算灾难）
function isRootOrHomeTarget(token) {
  const s = token.replace(/^["']+|["']+$/g, '')
  if (/^(?:\/|\/\*|\/\/)$/.test(s)) return true                                  // / 、/* 、//
  if (/^~\/?\*?$/.test(s)) return true                                          // ~ 、~/ 、~/*
  if (/^\$(?:\{)?HOME(?:\})?\/?\*?$/.test(s)) return true                        // $HOME 、${HOME}/*
  if (/^%(?:USERPROFILE|HOMEPATH|HOMEDRIVE)%[\\/]?\*?$/i.test(s)) return true    // %USERPROFILE%
  if (/^[a-zA-Z]:[\\/]?\*?$/.test(s)) return true                                // C:\ 、D:/ 、C:\*
  return false
}

function isRawDeviceTarget(token) {
  return /^of=(?:\/dev\/(?:sd|hd|nvme|disk|rdisk|vd|mmcblk|loop)|\/dev\/\*|\\\\\.\\PhysicalDrive)/i.test(token)
}

// 扫描一段命令：先定位命令头部（跳过前缀 flag 与包装器），再按头部判定；
// 头部是包装器时把参数里的内层命令展开（引号内空白在 tokenize 时被保留，
// 这里按空白再切一次）后递归。
//
// 返回值是**命中族 id 或 null**（不是 boolean）：族 id 供 engine 做「同族重试硬拒」
// （P0-3）——判定逻辑与词表只有这一份，避免"是否灾难"与"属哪一族"两处漂移。
function scanSegment(segment, depth) {
  const tokens = tokenize(segment)
  if (!tokens.length) return null
  let i = 0
  while (i < tokens.length) {
    const low = tokens[i].toLowerCase()
    if (/^-/.test(low)) { i++; continue }        // 前缀 flag（sudo -n / cmd /c 的 /c 走下面）
    if (/^\/[ck]$/i.test(low)) { i++; continue } // cmd /c、powershell /c
    if (WRAPPERS.has(low)) {
      if (depth >= MAX_DEPTH) return null
      const inner = tokens.slice(i + 1)
      // 引号包裹的整条命令会是一个含空白的 token → 按空白再切一次即为内层 token 序列
      const flat = inner.flatMap((t) => (/\s/.test(t) ? tokenize(t) : [t]))
      return flat.length ? scanSegment(flat.join(' '), depth + 1) : null
    }
    break
  }
  if (i >= tokens.length) return null
  const head = tokens[i].toLowerCase().replace(/\.exe$/, '')
  const rest = tokens.slice(i + 1)
  if (DELETE_TOOLS.has(head)) {
    return hasRecursiveFlag(rest) && rest.some(isRootOrHomeTarget) ? 'root-or-home-recursive-delete' : null
  }
  if (head.startsWith('mkfs')) return 'mkfs'
  // format 必须带盘符才算格式化（`npm run format`、`git format-patch` 不算）
  if (head === 'format' || head === 'format.com') {
    return rest.some((t) => !/^-/.test(t) && /^[a-zA-Z]:/.test(t)) ? 'format-partition' : null
  }
  if (head === 'diskpart' || head === 'fdisk' || head === 'parted') return 'format-partition'
  if (head === 'dd') return rest.some(isRawDeviceTarget) ? 'dd-raw-device' : null
  if (POWER_TOOLS.has(head) || head === 'init') {
    if (POWER_TOOLS.has(head)) return 'power-control'
    return rest.some((t) => t === '0' || t === '6') ? 'power-control' : null // init 0 / init 6（关机 / 重启）
  }
  if (head === 'systemctl') {
    return rest.some((t) => ['reboot', 'poweroff', 'halt', 'shutdown'].includes(t.toLowerCase())) ? 'power-control' : null
  }
  return null
}

// 命中族 id（CATASTROPHIC_FAMILIES 之一）或 null。同一份判定，粒度更细。
//
// 用途（P0-3，2026-09-16）：engine 记录「本轮用户已拒绝过哪些族」，同族重试**不再弹窗**
// 而是直接拒绝——抵挡"拒绝后改写/升权再试"（`rm -rf /` → `rm -rf /*` / `sudo rm -rf /`）。
// 字面比对挡不住改写，故族粒度是这套拦截的必要条件。
export function catastrophicFamily(command) {
  if (!command || typeof command !== 'string') return null
  const raw = command.trim()
  if (!raw) return null
  const segments = raw.split(SHELL_SPLIT).slice(0, MAX_SEGMENTS)
  for (const seg of segments) {
    if (!seg.trim()) continue
    try {
      const family = scanSegment(seg, 0)
      if (family) return family
    } catch { /* 判定失败按"非灾难"处理，交由 highrisk/正常审批兜底 */ }
  }
  return null
}

// true = 灾难级（任何档位都必须经过用户确认）。与 catastrophicFamily 同判定，仅粒度不同。
export function matchesCatastrophic(command) {
  return catastrophicFamily(command) !== null
}
