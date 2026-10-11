// kernel/skill-dirs.mjs —— 技能声明的**工作目录**（P3「skill 执行过程中脚本调用不能有路径限制，
// 整个流程需要打通」的落地件，2026-09-21）
// ---------------------------------------------------------------------------
// ## 病灶（已量化，见 docs/待处理清单.md 该条）
// 唯一的文件边界判据是 `kernel/tools.mjs` 的 `allowDirs = [cwd, ...addDirs]`，而 `Bash` 工具
// **不受**它约束（只传 cwd）⇒ 技能里的 python 脚本能读能写外部目录；真正被卡住的是 agent 用
// `Read/Write/Edit/Grep/Glob` 直接碰外部路径（拒绝文案"拒绝访问：路径超出会话目录边界"）。
// 实测三类撞法：① 读外部资料源（企微 `WXWork` / OneDrive / 桌面）；② 写外部工作区
// （`_common/onedrive_utils.py` 的 `SAFE_WORKSPACE_ROOT`）；③ 写经验库（`~/.ponos/memory/…`）。
//
// ## 为什么是"声明式显式授权"而不是放开边界
// 该边界同时护住 Read/Write/Edit/Grep 与 OCR/Vision，放开等于把越界防护整块取消。本方案
// **不取消边界**，只把"该放行的"变成**技能自己声明 + 内核校验 + 会话启动时可见地注入**：
//   · 声明处：`SKILL.md` frontmatter 的 `extra_dirs:`（YAML 列表，与 triggers/subskills 同款解析）；
//   · 校验处：本模块（唯一判据，tools 层复用同一函数，**不另写一份**）；
//   · 注入处：`kernel/cli.mjs` 在技能发现后调 `engine.tools.setSkillExtraDirs(...)`；
//   · 可见处：init 帧回显 `extra_dirs` + 启动日志 + Skill 工具回执列出已授权目录 + 撞边界时
//     拒绝文案列出"本会话可用根目录"。
// 默认行为**逐字不变**：未声明 `extra_dirs` 的技能、以及所有既有会话，边界与改造前完全一致。
//
// ## 校验规则（缺一即等于把边界悄悄放开，改本文件请连带改 skill-extra-dirs.test.mjs）
//   ① 支持 `~`（家目录）展开；其余必须**已是绝对路径**（相对路径会被 resolve 成"会话目录里的
//      某处"，等于让声明改变会话内的相对语义，直接拒）；
//   ② 规范化（resolve + realpath）后**不得是盘根/文件系统根**——`C:\` 之类的声明范围等于整块
//      磁盘，"收敛"成某个子目录是主观选择，拒绝并把原因写清更有用；
//   ③ 不得是**用户主目录本身**（同上，范围过宽；要哪片就声明哪片，如 `~/Documents/WXWork`）；
//   ④ 必须**存在且是目录**（声明一个不存在的目录，只会在真正用到时才炸，且原因难归因）；
//   ⑤ 去重（realpath 归一后比对；Windows 大小写不敏感）、**单技能上限 8 / 会话上限 16**
//      （上限是防"一个技能声明半台机器"与提示词/扫描面被撑爆）；
//   ⑥ 被全局停用的技能**不贡献**任何目录（cli 传进来的 skills 已过 `excludeDisabled`）——
//      停用语义必须一路贯通到文件边界，否则"停了它还能开目录"。
import { existsSync, statSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, parse, resolve } from 'node:path'
// 平台能力层（2026-10-09 迁移）：大小写语义只有一处真源（shared/platform-capabilities.*），
// 本模块不再自写 `platform === 'win32'`。模块级缓存一次（进程内 platform 不变）；显式传入
// `platform` 的注入口（见 validateExtraDir 签名）按平台各缓存一份，避免在函数里反复建对象。
import { platformCapabilities } from '../shared/platform-capabilities.mjs'
const CAPS = platformCapabilities()
const CAPS_BY_PLATFORM = new Map([[CAPS.platform, CAPS]])
function capsOf(platform) {
  const key = platform === undefined || platform === null ? CAPS.platform : String(platform)
  let caps = CAPS_BY_PLATFORM.get(key)
  if (!caps) CAPS_BY_PLATFORM.set(key, (caps = platformCapabilities({ platform: key })))
  return caps
}

/** 单技能可声明的工作目录上限。 */
export const MAX_EXTRA_DIRS_PER_SKILL = 8
/** 整个会话可新增的工作目录上限（多技能累加；超出部分记入 rejected 并明说原因）。 */
export const MAX_EXTRA_DIRS = 16
/** SKILL.md frontmatter 里声明工作目录的字段名（解析在 kernel/skills.mjs）。 */
export const SKILL_EXTRA_DIRS_KEY = 'extra_dirs'

/** 路径比对键：大小写是否敏感**由能力层判定**（Windows 不敏感；与 exec-base 的 realForComparison 同口径）。 */
function keyOf(p, platform) {
  const s = String(p || '')
  return capsOf(platform).path.caseInsensitive ? s.toLowerCase() : s
}

/**
 * `~` 展开（仅 `~` 与 `~/`、`~\` 前缀；不展开环境变量——声明里写死绝对路径更可审计，
 * 且 env 展开会把"声明的内容"变成"取决于运行时环境的内容"，边界就不可复核了）。
 * 返回原样字符串（未展开时），由调用方继续判定。
 */
export function expandHomePath(value, home = homedir()) {
  const s = String(value ?? '').trim()
  if (!s) return ''
  if (s === '~') return resolve(home)
  if (s.startsWith('~/') || s.startsWith('~\\')) return resolve(home, s.slice(2))
  return s
}

/**
 * 单条工作目录声明的校验（**唯一判据**；cli 的会话级解析与 tools 的注入守卫都调它）。
 *
 * @param {string} raw 声明原文（可带 `~`）
 * @param {{home?: string, platform?: string}} [opts]
 * @returns {{ok: true, dir: string, reason?: string} | {ok: false, reason: string}} ok.dir = realpath 归一后的目录
 */
export function validateExtraDir(raw, { home = homedir(), platform = CAPS.platform } = {}) {
  const expanded = expandHomePath(raw, home)
  if (!expanded) return { ok: false, reason: '空值' }
  if (!isAbsolute(expanded)) {
    return { ok: false, reason: '必须是绝对路径（或 ~ 开头；相对路径会变成"会话目录内某处"，语义含混，一律不接受）' }
  }
  const abs = resolve(expanded)
  const root = parse(abs).root
  if (keyOf(abs, platform) === keyOf(root, platform)) {
    return { ok: false, reason: `不得声明盘根（${root}）——范围等于整块磁盘` }
  }
  if (keyOf(abs, platform) === keyOf(resolve(home), platform)) {
    return { ok: false, reason: '不得声明用户主目录本身（范围过宽），请改为其中的具体子目录' }
  }
  if (!existsSync(abs)) return { ok: false, reason: '目录不存在' }
  let st
  try {
    st = statSync(abs)
  } catch (e) {
    return { ok: false, reason: `无法访问（${e?.message || e}）` }
  }
  if (!st.isDirectory()) return { ok: false, reason: '不是目录（声明的必须是目录）' }
  let real = abs
  try {
    real = realpathSync(abs)
  } catch {
    real = abs // 目录存在但 realpath 失败（权限/占用）：用解析后的路径，边界判定仍会走 realForComparison
  }
  return { ok: true, dir: real }
}

/**
 * 会话级解析：把一串技能（`discoverSkills` 的输出，已过停用过滤）的 `extra_dirs` 声明
 * 收敛为**可授权目录清单** + **被拒清单**（被拒的也要带原因，供日志/回执可见）。
 *
 * @param {{skills?: Array<{id?: string, extraDirs?: string[]}>, home?: string, platform?: string,
 *          maxPerSkill?: number, maxTotal?: number}} [p]
 * @returns {{dirs: Array<{skill: string, dir: string}>, rejected: Array<{skill: string, value: string, reason: string}>}}
 */
export function resolveSkillExtraDirs({
  skills = [],
  home = homedir(),
  platform = CAPS.platform,
  maxPerSkill = MAX_EXTRA_DIRS_PER_SKILL,
  maxTotal = MAX_EXTRA_DIRS,
} = {}) {
  const dirs = []
  const rejected = []
  const seen = new Set()
  for (const s of Array.isArray(skills) ? skills : []) {
    const skillId = String(s?.id ?? '')
    const declared = Array.isArray(s?.extraDirs) ? s.extraDirs : []
    let accepted = 0
    for (const raw of declared) {
      const value = String(raw ?? '')
      if (accepted >= maxPerSkill) {
        rejected.push({ skill: skillId, value, reason: `超出单技能声明上限（${maxPerSkill} 条）` })
        continue
      }
      if (dirs.length >= maxTotal) {
        rejected.push({ skill: skillId, value, reason: `超出会话授权目录上限（${maxTotal} 条）` })
        continue
      }
      const v = validateExtraDir(raw, { home, platform })
      if (!v.ok) {
        rejected.push({ skill: skillId, value, reason: v.reason })
        continue
      }
      // 重复声明（含两个技能声明同一目录）：静默合并——它不是错误，重复授权也不产生额外能力。
      if (seen.has(keyOf(v.dir, platform))) continue
      seen.add(keyOf(v.dir, platform))
      dirs.push({ skill: skillId, dir: v.dir })
      accepted++
    }
  }
  return { dirs, rejected }
}
