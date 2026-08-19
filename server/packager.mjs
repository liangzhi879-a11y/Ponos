import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync, statSync, copyFileSync, cpSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { PERSONAL_DIR, hashLine } from './experience.mjs'

const HOME = process.env.YFW_TEST_HOME || homedir()
const YFW_HOME = join(HOME, '.yfworking')
const SKILL_EXP_DIR = join(YFW_HOME, 'memory', 'skill_experiences')
const SKILLS_DIR = join(YFW_HOME, 'skills')

// Windows：解析系统 bsdtar 的绝对路径（System32\tar.exe），避免 Git Bash 的 GNU tar
// 把 `-f C:\...` 中的 `C:` 当作远程主机（报 "Cannot connect to C: resolve failed"）。
// 通过绝对路径调用，无需全局改写 process.env.PATH（避免污染 bridge 进程内其它 spawn）。
const SYSTEM_TAR = process.platform === 'win32'
  ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
  : null
export const TAR_CMD = (SYSTEM_TAR && existsSync(SYSTEM_TAR)) ? SYSTEM_TAR : 'tar'

export const TYPE_LABELS = {
  personal: '个人记忆',
  skill_exp: '技能经验库',
  skills: '技能库',
  config: '全局配置',
  chats: '会话历史',
  project: '项目数据',
}

const REDACT_KEYS = ['authToken', 'apiKey', 'secret', 'token']

function redact(obj) {
  if (Array.isArray(obj)) return obj.map(redact)
  if (obj && typeof obj === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(obj)) {
      out[k] = REDACT_KEYS.some(r => k.toLowerCase().includes(r)) ? '' : redact(v)
    }
    return out
  }
  return obj
}

function lineHasSensitive(text, words) {
  return words.some(w => w && text.includes(w))
}

// 统计各类型文件数/字节数（导出前预览）
export function collectTypeStats(included, opts = {}) {
  const stats = {}
  const sources = {
    personal: PERSONAL_DIR,
    skill_exp: SKILL_EXP_DIR,
    skills: SKILLS_DIR,
  }
  for (const t of included) {
    if (sources[t]) {
      const dir = sources[t]
      let files = 0, bytes = 0
      if (existsSync(dir)) {
        for (const f of readdirSync(dir)) {
          const fp = join(dir, f)
          if (statSync(fp).isFile()) { files++; bytes += statSync(fp).size }
        }
      }
      stats[t] = { files, bytes }
    } else if (t === 'chats') {
      stats[t] = { files: opts.chatsJson ? 1 : 0, bytes: opts.chatsJson ? opts.chatsJson.length : 0 }
    } else if (t === 'config') {
      let bytes = 0
      for (const f of ['config.json', 'settings.json']) {
        const fp = join(YFW_HOME, f)
        if (existsSync(fp)) bytes += statSync(fp).size
      }
      stats[t] = { files: bytes ? 1 : 0, bytes }
    } else if (t === 'project') {
      const root = opts.projectCwd ? join(opts.projectCwd, '.yfworking') : null
      stats[t] = { files: root && existsSync(root) ? 1 : 0, bytes: root && existsSync(root) ? 0 : 0 }
    }
  }
  return { included, stats }
}

function importSkillsDir(srcDir, dstDir, conflict, restored) {
  // 技能以子目录组织（my-skill/SKILL.md、_skill_index.json 等），递归逐文件恢复：
  // 目标缺失 → 复制并记录 restored；目标存在 → overwrite 复制 / skip、merge 计冲突
  // （技能文件是任意文件，不做行/JSON 级合并，也不跳过 _ 前缀文件——每个文件都有意义）
  let conflicts = 0
  const walk = (src, dst, rel) => {
    mkdirSync(dst, { recursive: true })
    for (const f of readdirSync(src)) {
      const s = join(src, f)
      const d = join(dst, f)
      const relPath = rel ? `${rel}/${f}` : f
      if (statSync(s).isDirectory()) {
        walk(s, d, relPath)
      } else if (existsSync(d)) {
        if (conflict === 'overwrite') {
          copyFileSync(s, d)
          restored.push(`skills/${relPath}`)
        } else {
          conflicts++ // skip/merge：已存在即冲突，不覆盖
        }
      } else {
        copyFileSync(s, d)
        restored.push(`skills/${relPath}`)
      }
    }
  }
  walk(srcDir, dstDir, '')
  return conflicts
}

export async function exportPackage(opts) {
  const { outPath, included = [], sensitiveWords = [], chatsJson = null, projectCwd = null, configRedact = true, onProgress = () => {} } = opts
  if (!included.length) return { ok: false, error: '未选择任何导出类型' }
  const staging = mkdtempSync(join(tmpdir(), 'yfw-exp-export-'))
  const skipped = []
  try {
    onProgress('收集数据…')
    // personal：敏感词条目级过滤（逐文件重写为仅保留未命中行）
    if (included.includes('personal') && existsSync(PERSONAL_DIR)) {
      const dest = join(staging, 'personal')
      mkdirSync(dest, { recursive: true })
      for (const f of readdirSync(PERSONAL_DIR)) {
        if (!f.endsWith('.md')) continue
        const raw = readFileSync(join(PERSONAL_DIR, f), 'utf-8')
        if (sensitiveWords.length) {
          const lines = raw.split(/\r?\n/)
          let removed = 0
          const kept = lines.filter(l => {
            const hit = l.trim().startsWith('- ') && lineHasSensitive(l, sensitiveWords)
            if (hit) removed++
            return !hit
          })
          if (removed) skipped.push({ type: 'personal', reason: `${f} 过滤 ${removed} 条敏感条目` })
          writeFileSync(join(dest, f), kept.join('\n'), 'utf-8')
        } else {
          copyFileSync(join(PERSONAL_DIR, f), join(dest, f))
        }
      }
    }
    if (included.includes('skill_exp') && existsSync(SKILL_EXP_DIR)) {
      // skill_exp：敏感词条目级过滤（experiences 数组中命中整条剔除）
      const dest = join(staging, 'skill_exp')
      mkdirSync(dest, { recursive: true })
      for (const f of readdirSync(SKILL_EXP_DIR)) {
        const src = join(SKILL_EXP_DIR, f)
        if (!statSync(src).isFile()) continue
        const raw = readFileSync(src, 'utf-8')
        if (!sensitiveWords.length) { copyFileSync(src, join(dest, f)); continue }
        if (f.endsWith('.json')) {
          // 结构 { skill_name, schema_version, description, experiences: [...] }：
          // 能解析出 experiences 数组 → 条目级过滤后重写
          let data = null
          try { data = JSON.parse(raw) } catch { data = null }
          if (data && Array.isArray(data.experiences)) {
            const before = data.experiences.length
            data.experiences = data.experiences.filter(it => !lineHasSensitive(JSON.stringify(it), sensitiveWords))
            const removed = before - data.experiences.length
            if (removed > 0) skipped.push({ type: 'skill_exp', reason: `${f} 过滤 ${removed} 条敏感经验` })
            writeFileSync(join(dest, f), JSON.stringify(data, null, 2), 'utf-8')
            continue
          }
        }
        // 无法条目级过滤（非 JSON / 解析失败 / 无 experiences 数组）：整文件扫描
        if (lineHasSensitive(raw, sensitiveWords)) {
          skipped.push({ type: 'skill_exp', reason: `${f} 命中敏感词，整文件跳过` })
          continue
        }
        copyFileSync(src, join(dest, f))
      }
    }
    if (included.includes('skills') && existsSync(SKILLS_DIR)) {
      cpSync(SKILLS_DIR, join(staging, 'skills'), { recursive: true })
    }
    if (included.includes('config')) {
      const dest = join(staging, 'config')
      mkdirSync(dest, { recursive: true })
      for (const f of ['config.json', 'settings.json']) {
        const fp = join(YFW_HOME, f)
        if (!existsSync(fp)) continue
        const data = JSON.parse(readFileSync(fp, 'utf-8'))
        writeFileSync(join(dest, f), JSON.stringify(configRedact ? redact(data) : data, null, 2), 'utf-8')
      }
      if (!configRedact) skipped.push({ type: 'config', reason: '注意：已包含未脱敏凭据' })
    }
    if (included.includes('chats') && chatsJson) {
      const dest = join(staging, 'chats')
      mkdirSync(dest, { recursive: true })
      let data = null
      try { data = JSON.parse(chatsJson) } catch { /* fallthrough */ }
      // renderer 传的是 zustand persist 的原始 localStorage 值（{"state":{...},"version":0}），
      // 先解包 state；同时兼容直接传裸 {conversations, conversationSets} 的老调用方
      if (data && typeof data === 'object' && data.state && typeof data.state === 'object') data = data.state
      if (!data || !Array.isArray(data.conversations)) {
        skipped.push({ type: 'chats', reason: 'chatsJson 缺失或解析失败，跳过' })
      } else {
        const filter = opts.chatsFilter || null
        let convs = data.conversations
        if (filter) {
          const idSet = new Set(Array.isArray(filter.conversationIds) ? filter.conversationIds : [])
          if (filter.setId) {
            const set = (Array.isArray(data.conversationSets) ? data.conversationSets : []).find(s => s.id === filter.setId)
            if (!set && idSet.size === 0) return { ok: false, error: `chatsFilter.setId 不存在: ${filter.setId}` }
            if (set) for (const c of data.conversations) if (c.setId === filter.setId) idSet.add(c.id)
          }
          convs = data.conversations.filter(c => idSet.has(c.id))
        }
        // 每会话一个文件（完整对象含 setId）；会话集清单单独文件
        const sets = Array.isArray(data.conversationSets) ? data.conversationSets : []
        writeFileSync(join(dest, 'sets.json'), JSON.stringify({ sets }, null, 2), 'utf-8')
        mkdirSync(join(dest, 'sessions'), { recursive: true })
        for (const c of convs) {
          writeFileSync(join(dest, 'sessions', `${c.id}.json`), JSON.stringify(c, null, 2), 'utf-8')
        }
      }
    }
    if (included.includes('project') && projectCwd) {
      const src = join(projectCwd, '.yfworking')
      if (existsSync(src)) cpSync(src, join(staging, 'project'), { recursive: true })
      else skipped.push({ type: 'project', reason: `${src} 不存在，跳过` })
    }

    const stats = {}
    for (const [k, v] of Object.entries(collectTypeStats(included, { chatsJson, projectCwd }).stats)) stats[k] = v
    const manifest = {
      format_version: 1,
      app_version: process.env.npm_package_version || '2.6.0',
      created_at: new Date().toISOString(),
      origin_device: process.env.COMPUTERNAME || 'unknown',
      included,
      stats,
    }
    // 脱敏标记：config 被脱敏过（authToken 等置 ''），导入端据此禁止 overwrite 覆盖真实配置
    if (configRedact && included.includes('config')) manifest.redacted = true
    if (included.includes('chats')) manifest.chat_format = 2
    writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8')

    onProgress('压缩打包…')
    mkdirSync(join(tmpdir(), 'yfw-exp-export'), { recursive: true })
    const tar = spawnSync(TAR_CMD, ['-a', '-c', '-f', outPath, '-C', staging, '.'], { stdio: 'pipe' })
    if (tar.status !== 0) {
      return { ok: false, error: `tar 打包失败: ${tar.stderr?.toString() || tar.status}` }
    }
    return { ok: true, outPath, manifest, skipped }
  } catch (e) {
    return { ok: false, error: e.message }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

function manifestOf(staging) {
  const fp = join(staging, 'manifest.json')
  if (!existsSync(fp)) return null
  try { return JSON.parse(readFileSync(fp, 'utf-8')) } catch { return null }
}

function mergeEntryLines(targetRaw, incomingRaw) {
  // 行级合并：按 hash 去重，保留 frontmatter 用目标文件的（若目标无 frontmatter 用传入的）
  const fm = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(targetRaw) || /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(incomingRaw) || ''
  const head = fm ? fm[0] : ''
  const bodyLines = (targetRaw + '\n' + incomingRaw).split(/\r?\n/).filter(l => l.trim().startsWith('- '))
  const seen = new Set()
  const merged = []
  for (const l of bodyLines) {
    const h = hashLine(l.trim())
    if (seen.has(h)) continue
    seen.add(h)
    merged.push(l.trim())
  }
  return head + merged.join('\n') + '\n'
}

export async function importPackage(zipPath, opts) {
  const { conflict = 'skip', projectCwd = null, onProgress = () => {} } = opts
  // 入参校验：非法 conflict 直接失败，避免三分支全不命中时静默跳过、误报成功
  if (!['skip', 'overwrite', 'merge'].includes(conflict)) {
    return { ok: false, error: 'conflict 必须是 skip/overwrite/merge' }
  }
  const staging = mkdtempSync(join(tmpdir(), 'yfw-exp-import-'))
  const restored = []
  let conflicts = 0
  try {
    onProgress('解包校验…')
    const tar = spawnSync(TAR_CMD, ['-xf', zipPath, '-C', staging], { stdio: 'pipe' })
    if (tar.status !== 0) return { ok: false, error: `解包失败: ${tar.stderr?.toString() || tar.status}` }
    const manifest = manifestOf(staging)
    if (!manifest) return { ok: false, error: '包内缺少 manifest.json 或格式无效，已拒绝导入' }
    if (manifest.format_version !== 1) return { ok: false, error: `不支持的包版本 format_version=${manifest.format_version}（需要 1）` }

    const included = Array.isArray(manifest.included) ? manifest.included : []
    const targets = {
      personal: PERSONAL_DIR,
      skill_exp: SKILL_EXP_DIR,
      config: YFW_HOME,
    }
    for (const t of included) {
      const srcDir = join(staging, t)
      if (!existsSync(srcDir)) continue
      if (t === 'chats') continue // chats 由 renderer 写 localStorage，见 Task 6
      // 脱敏包（config 已置空凭据）不允许 overwrite 覆盖真实配置，降级为 skip
      if (t === 'config' && manifest.redacted && conflict === 'overwrite') {
        conflicts++
        restored.push('config (redacted 包不允许 overwrite，已跳过)')
        continue
      }
      if (t === 'skills') {
        // 技能以子目录组织，递归逐文件恢复（merge 模式安装本地缺失文件，见 §7.3）
        mkdirSync(SKILLS_DIR, { recursive: true })
        conflicts += importSkillsDir(srcDir, SKILLS_DIR, conflict, restored)
      } else if (targets[t]) {
        mkdirSync(targets[t], { recursive: true })
        for (const f of readdirSync(srcDir)) {
          const src = join(srcDir, f)
          const dst = join(targets[t], f)
          if (statSync(src).isFile() && !f.startsWith('_')) {
            if (existsSync(dst)) {
              if (conflict === 'skip') { conflicts++; continue }
              if (conflict === 'overwrite') { copyFileSync(src, dst); restored.push(`${t}/${f}`); continue }
              // merge：行式文件按行去重，其余跳过已存在
              if (conflict === 'merge') {
                if (f.endsWith('.md') && t === 'personal') {
                  writeFileSync(dst, mergeEntryLines(readFileSync(dst, 'utf-8'), readFileSync(src, 'utf-8')), 'utf-8')
                  restored.push(`${t}/${f} (merged)`)
                } else if (f.endsWith('.json')) {
                  // 按顶层 key 浅合并（skill_exp/config 数组类文件走此路）
                  // 预检：目标与 incoming 任一 JSON 非法 → 该文件按 conflict 跳过（conflicts++），
                  // 不提前抛错，避免已合并文件落盘后整体失败残留半状态
                  let a, b
                  try {
                    a = JSON.parse(readFileSync(dst, 'utf-8'))
                    b = JSON.parse(readFileSync(src, 'utf-8'))
                  } catch {
                    conflicts++
                    continue
                  }
                  writeFileSync(dst, JSON.stringify(mergeJson(a, b), null, 2), 'utf-8')
                  restored.push(`${t}/${f} (merged)`)
                } else { conflicts++; }
              }
            } else {
              copyFileSync(src, dst)
              restored.push(`${t}/${f}`)
            }
          }
        }
      } else if (t === 'project' && projectCwd) {
        // 按目录粒度处理：目标 .yfworking 已存在时（跨机导入正常场景），
        // skip/merge 直接跳过并计 conflict，避免 cpSync force:false 抛 ERR_FS_CP_EEXIST 拖垮整个导入
        const target = join(projectCwd, '.yfworking')
        if (existsSync(target)) {
          if (conflict === 'overwrite') {
            cpSync(srcDir, target, { recursive: true, force: true })
            restored.push('project/.yfworking')
          } else {
            conflicts++
            restored.push('project/.yfworking (exists, skipped)')
          }
        } else {
          cpSync(srcDir, target, { recursive: true })
          restored.push('project/.yfworking')
        }
      }
    }

    let chatStoreJson = null
    let chats = null
    if (included.includes('chats')) {
      const sessionsDir = join(staging, 'chats', 'sessions')
      const legacyFile = join(staging, 'chats', 'chat-store.json')
      if (existsSync(sessionsDir)) {
        // 新格式：聚合 sets + conversations（每会话一文件），renderer 侧合并写回
        const setsJsonPath = join(staging, 'chats', 'sets.json')
        let sets = []
        if (existsSync(setsJsonPath)) {
          try {
            const parsed = JSON.parse(readFileSync(setsJsonPath, 'utf-8'))
            if (Array.isArray(parsed.sets)) sets = parsed.sets
          } catch { /* 损坏按空处理 */ }
        }
        const conversations = []
        for (const f of readdirSync(sessionsDir)) {
          const src = join(sessionsDir, f)
          if (!statSync(src).isFile() || !f.endsWith('.json')) continue
          try {
            conversations.push(JSON.parse(readFileSync(src, 'utf-8')))
          } catch {
            conflicts++
            restored.push(`chats/sessions/${f} (损坏，跳过)`)
          }
        }
        chats = { sets, conversations }
        restored.push(`chats/sessions (${conversations.length} 个会话)`)
      } else if (existsSync(legacyFile)) {
        // 旧格式：整体回传 renderer 写回（兼容旧包）
        chatStoreJson = readFileSync(legacyFile, 'utf-8')
        restored.push('chats/chat-store.json (旧格式，整体写回)')
      }
    }

    return { ok: true, manifest, restored, conflicts, chats, chatStoreJson }
  } catch (e) {
    return { ok: false, error: e.message }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

function mergeJson(a, b) {
  const out = { ...a }
  for (const [k, v] of Object.entries(b)) {
    if (Array.isArray(out[k]) && Array.isArray(v)) {
      const seen = new Set(out[k].map(x => JSON.stringify(x)))
      for (const item of v) {
        const s = JSON.stringify(item)
        if (!seen.has(s)) { out[k].push(item); seen.add(s) }
      }
    } else if (out[k] && v && typeof out[k] === 'object' && typeof v === 'object') {
      out[k] = mergeJson(out[k], v)
    } else if (!(k in out) || out[k] === undefined) {
      out[k] = v
    }
  }
  return out
}
