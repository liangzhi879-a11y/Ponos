// kernel-tests/skill-extra-dirs.test.mjs —— 技能声明的工作目录（P3，2026-09-21）
// ---------------------------------------------------------------------------
// 待办原话：「skill 的执行过程中，脚本的调用不能有路径限制，整个流程需要打通」。
// 量化结论（本轮不动）：`Bash` **不受** `allowDirs` 约束 ⇒ 技能里的 python 脚本本来就能读能写
// 外部目录；真正被卡住的是 agent 用 `Read/Write/Edit/Grep/Glob` 直接碰会话外路径。
// 故本任务**不取消边界**，而是给技能一条**声明式显式授权**通道：
//   `SKILL.md` frontmatter `extra_dirs:` → kernel/skill-dirs.mjs 校验 → cli 注入工具边界
//   （kernel/cli.mjs 的 `engine.tools.setSkillExtraDirs`）+ init 帧回显 + Skill 回执可见。
//
// 本文件钉住四类证据（缺一即回归）：
//   ① **默认不退化**：未声明/未注入时，会话外路径的 Read/Write 仍被拒（与既有
//      knowledge-read-boundary.test.mjs 同口径，那条断言不许放宽）；
//   ② **正例**：显式授权后该目录 Read/Write/Edit/Grep/Glob **全部打通**（不是只有 Read）；
//   ③ **反例**：授权目录之外仍被拒；非法/越界声明（盘根、主目录、相对路径、不存在、非目录）
//      被拒或收敛，且**不会**因为声明而把边界放开；声明数量有上限；
//   ④ **可见性 + 链路**：init 帧回显（真内核 spawn）、Skill 回执列出已授权目录、cli/tools 的
//      接线有静态守卫（漏接是静默失效，行为断言只能覆盖链尾）。
//
// 隔离纪律：全部夹具在 mkdtempSync 临时目录内，绝不读写真实 home；spawn 用例显式传
// PONOS_CONFIG_DIR/PONOS_HOME。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createToolRegistry } from '../kernel/tools.mjs'
import { discoverSkills, loadSkillDetail } from '../kernel/skills.mjs'
import { resolveSkillExtraDirs, validateExtraDir, expandHomePath, MAX_EXTRA_DIRS, MAX_EXTRA_DIRS_PER_SKILL } from '../kernel/skill-dirs.mjs'

const NEEDLE_EXT = 'NEEDLE_EXTERNAL_OK'
const NEEDLE_OTHER = 'NEEDLE_OTHER_SECRET'
const DENIED = /拒绝访问：路径超出会话目录边界/
const KERNEL_CLI = fileURLToPath(new URL('../kernel/cli.mjs', import.meta.url))
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

/** 从拒绝文案里取出"本会话可用根目录"清单（授权可见性的断言口径）。 */
function rootsOf(content) {
  const m = String(content).match(/本会话可用根目录：(.+?)。/)
  return m ? m[1].split('、') : []
}
const samePath = (a, b) => String(a).toLowerCase() === String(b).toLowerCase()

/**
 * 夹具：
 *   <dir>/work/                ← cwd（会话目录）
 *   <dir>/external/            ← 技能 demo 声明的工作目录（本任务的目标目录）
 *   <dir>/other/              ← 未声明的外部目录（对照组）
 *   <dir>/home/sub/            ← 假家目录（校验 ~ 展开/主目录拒绝用，绝不碰真实 home）
 *   <dir>/skills/demo/SKILL.md  声明 extra_dirs: [external]
 *   <dir>/skills/plain/SKILL.md 不声明任何目录
 */
function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'skill-extra-dirs-'))
  const cwd = join(dir, 'work')
  const external = join(dir, 'external')
  const other = join(dir, 'other')
  const home = join(dir, 'home')
  const skillsRoot = join(dir, 'skills')
  for (const d of [cwd, external, other, join(home, 'sub'), join(skillsRoot, 'demo'), join(skillsRoot, 'plain')]) {
    mkdirSync(d, { recursive: true })
  }
  writeFileSync(join(external, 'external.txt'), `${NEEDLE_EXT}\n第二行\n`, 'utf-8')
  writeFileSync(join(other, 'secret.txt'), `${NEEDLE_OTHER}\n`, 'utf-8')
  const skillMd = (id, extraDirs) => ['---', `name: ${id}`, `description: 测试技能 ${id}`, ...extraDirs, '---', '', `# ${id}`, ''].join('\n')
  writeFileSync(join(skillsRoot, 'demo', 'SKILL.md'), skillMd('demo', ['extra_dirs:', `  - ${external}`]), 'utf-8')
  writeFileSync(join(skillsRoot, 'plain', 'SKILL.md'), skillMd('plain', []), 'utf-8')
  return { dir, cwd, external, other, home, skillsRoot, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** 构造 registry：与产出环境同口径（技能根经 --skills-dir / addDirs 传入）。 */
function makeTools(env, opts = {}) {
  return createToolRegistry({
    cwd: env.cwd, addDirs: [], skipPermissions: true,
    skillsDirs: [env.skillsRoot], flatSkillRoots: [env.skillsRoot], ...opts,
  })
}

/** cli 那一步：技能发现（含停用过滤后的清单）→ 会话级解析。 */
const resolveFromSkills = (env, extra = {}) =>
  resolveSkillExtraDirs({ skills: discoverSkills({ root: env.skillsRoot, allowFlat: true }), ...extra })

// ── ① 元数据解析：extra_dirs 是技能 frontmatter 字段 ──────────────────────────
test('skills.mjs：discoverSkills 解析 extra_dirs（YAML 列表），未声明则为空数组', () => {
  const env = makeEnv()
  try {
    const skills = discoverSkills({ root: env.skillsRoot, allowFlat: true })
    const demo = skills.find((s) => s.id === 'demo')
    const plain = skills.find((s) => s.id === 'plain')
    assert.deepEqual(demo.extraDirs, [env.external], '声明的目录必须被解析出来（否则整条链从源头断）')
    assert.deepEqual(plain.extraDirs, [], '未声明 = 空数组（默认不放开的前提）')
    assert.equal(loadSkillDetail({ roots: [env.skillsRoot], id: 'demo' }).extraDirs.length, 1, '详情也要透出（界面据此预览"会申请哪些目录"）')
  } finally { env.cleanup() }
})

// ── ② 校验：合法收敛、非法拒绝（纯函数层）────────────────────────────────────
test('validateExtraDir：合法目录 → ok 且返回 realpath 归一结果', () => {
  const env = makeEnv()
  try {
    const v = validateExtraDir(env.external)
    assert.equal(v.ok, true, v.reason)
    assert.equal(v.dir, realpathSync(env.external), '必须归一（去符号链接/相对段），否则边界比对会被绕')
  } finally { env.cleanup() }
})

test('validateExtraDir：盘根 / 主目录 / 相对路径 / 不存在 / 非目录 一律拒绝（含原因）', () => {
  const env = makeEnv()
  try {
    const fsRoot = parse(env.dir).root
    const cases = [
      [fsRoot, /盘根/],
      [env.home, /主目录/],
      ['~', /主目录/],
      ['relative/dir', /绝对路径/],
      [join(env.dir, 'nope'), /不存在/],
      [join(env.other, 'secret.txt'), /不是目录/],
      ['', /空值/],
    ]
    for (const [input, re] of cases) {
      const v = validateExtraDir(input, { home: env.home })
      assert.equal(v.ok, false, `必须拒绝：${input}`)
      assert.match(v.reason, re, `${input} 的拒绝原因要能归因：${v.reason}`)
    }
    // 正面锚：家目录下的具体子目录可用（~ 展开）——只拒"范围过宽"，不拒"指得准"
    const ok = validateExtraDir('~/sub', { home: env.home })
    assert.equal(ok.ok, true, ok.reason)
    assert.equal(ok.dir, realpathSync(join(env.home, 'sub')))
    assert.equal(expandHomePath('~/sub', env.home), join(env.home, 'sub'))
  } finally { env.cleanup() }
})

test('resolveSkillExtraDirs：去重 + 单技能上限 + 会话上限（上限是"声明半台机器"的护栏）', () => {
  const env = makeEnv()
  try {
    assert.equal(MAX_EXTRA_DIRS_PER_SKILL, 8)
    assert.equal(MAX_EXTRA_DIRS, 16)
    // 去重：同一目录的两种写法（含 .. 段）只算一条
    const dup = resolveSkillExtraDirs({ skills: [{ id: 'd', extraDirs: [env.external, join(env.external, '..', 'external')] }] })
    assert.equal(dup.dirs.length, 1, '重复声明不得重复授权')
    assert.equal(dup.rejected.length, 0, '重复不是错误（不产生噪声）')
    // 单技能上限
    const many = Array.from({ length: 9 }, (_, i) => {
      const d = join(env.dir, `cap-per-${i}`)
      mkdirSync(d, { recursive: true })
      return d
    })
    const per = resolveSkillExtraDirs({ skills: [{ id: 'big', extraDirs: many }] })
    assert.equal(per.dirs.length, 8)
    assert.equal(per.rejected.length, 1, '第 9 条必须被拒（不是静默丢弃）')
    assert.match(per.rejected[0].reason, /单技能声明上限/)
    // 会话上限（默认 16）：17 个合法目录 → 前 16 生效，第 17 条被拒
    const lots = Array.from({ length: 17 }, (_, i) => {
      const d = join(env.dir, `cap-total-${i}`)
      mkdirSync(d, { recursive: true })
      return d
    })
    const r = resolveSkillExtraDirs({ skills: [{ id: 'a', extraDirs: lots.slice(0, 8) }, { id: 'b', extraDirs: lots.slice(8, 16) }, { id: 'c', extraDirs: lots.slice(16) }] })
    assert.equal(r.dirs.length, 16, `会话总量必须收敛到 ${MAX_EXTRA_DIRS}`)
    assert.match(r.rejected[0].reason, /会话授权目录上限/)
    assert.equal(r.rejected[0].value, lots[16], '被拒的是**第 17 条**（前面已授权的不能被回收）')
  } finally { env.cleanup() }
})

test('停用语义贯通：被全局停用的技能不贡献任何目录（"停了它还能开目录"是后门）', async () => {
  const env = makeEnv()
  try {
    // 与 cli 同一条路：discoverSkillsAll(disabled) 过滤后再解析
    const { discoverSkillsAll } = await import('../kernel/skills.mjs')
    const kept = discoverSkillsAll({ roots: [env.skillsRoot], flatRoots: [env.skillsRoot], disabled: ['demo'] })
    assert.deepEqual(kept.map((s) => s.id), ['plain'], '停用清单必须一路贯到发现层')
    assert.deepEqual(resolveSkillExtraDirs({ skills: kept }).dirs, [], 'demo 被停用 ⇒ 它声明的目录一个都不授权')
  } finally { env.cleanup() }
})

// ── ③ 工具层：默认不退化 / 授权后打通 / 之外仍拒 ──────────────────────────────
test('反例①：未注入授权时，会话外目录的 Read/Write 仍被拒（默认行为不得退化）', () => {
  const env = makeEnv()
  try {
    const tools = makeTools(env)
    const r = tools.registry.Read.run({ file_path: join(env.external, 'external.txt') })
    assert.equal(r.isError, true, '构造即"零授权"：没声明/没注入前，外部路径照旧不可读')
    assert.match(String(r.content), DENIED)
    assert.doesNotMatch(String(r.content), new RegExp(NEEDLE_EXT), '拒绝时不得回吐内容')
    const w = tools.registry.Write.run({ file_path: join(env.external, 'new.txt'), content: 'x' })
    assert.equal(w.isError, true, '写侧同理')
    assert.match(String(w.content), DENIED)
    assert.throws(() => readFileSync(join(env.external, 'new.txt')), '被拒的写入不得落盘')
  } finally { env.cleanup() }
})

test('反例①-b：拒绝文案列出本会话可用根（授权可见：撞边界时用户能一眼看到边界在哪）', () => {
  const env = makeEnv()
  try {
    const r = makeTools(env).registry.Read.run({ file_path: join(env.external, 'external.txt') })
    assert.match(String(r.content), /本会话可用根目录/, '必须列出可用根，否则用户无从判断该不该授权')
    const roots = rootsOf(r.content)
    assert.ok(roots.some((d) => samePath(d, env.cwd)), '会话目录必须在列出的根里')
    assert.ok(!roots.some((d) => samePath(d, realpathSync(env.external))), '未授权的目录不得被虚报为可用根')
  } finally { env.cleanup() }
})

test('正例②：显式授权后，该目录 Read/Write/Edit/Grep/Glob 全部打通（不是只有 Read）', async () => {
  const env = makeEnv()
  try {
    const tools = makeTools(env)
    const granted = resolveFromSkills(env)
    assert.deepEqual(granted.dirs, [{ skill: 'demo', dir: realpathSync(env.external) }], 'demo 的声明应被授权')
    tools.setSkillExtraDirs(granted)

    const r = tools.registry.Read.run({ file_path: join(env.external, 'external.txt') })
    assert.equal(r.isError, undefined, `授权后必须可 Read：${r.content}`)
    assert.match(String(r.content), new RegExp(NEEDLE_EXT))

    const w = tools.registry.Write.run({ file_path: join(env.external, 'out.txt'), content: 'written\n' })
    assert.equal(w.isError, undefined, `授权后必须可 Write（写外部工作区/经验库正是本任务的病灶②③）：${w.content}`)
    assert.equal(readFileSync(join(env.external, 'out.txt'), 'utf-8'), 'written\n', '必须真的落盘')

    const e = tools.registry.Edit.run({ file_path: join(env.external, 'out.txt'), old_string: 'written', new_string: 'edited' })
    assert.equal(e.isError, undefined, `授权后必须可 Edit：${e.content}`)
    assert.equal(readFileSync(join(env.external, 'out.txt'), 'utf-8'), 'edited\n')

    const g = await tools.registry.Grep.run({ pattern: NEEDLE_EXT, path: env.external })
    assert.ok(!g.isError, `授权目录应能作为 Grep 的 path 收窄：${g.content}`)
    assert.match(String(g.content), /external\.txt/)
    const gl = await tools.registry.Glob.run({ pattern: '**/*.txt', path: env.external })
    assert.ok(!gl.isError, `Glob 同理：${gl.content}`)
    assert.match(String(gl.content), /external\.txt/)
  } finally { env.cleanup() }
})

test('反例③：授权 external 后，未授权目录（other）依然被拒（授权是逐目录的，不是"全放开"）', () => {
  const env = makeEnv()
  try {
    const tools = makeTools(env)
    tools.setSkillExtraDirs(resolveFromSkills(env))
    const r = tools.registry.Read.run({ file_path: join(env.other, 'secret.txt') })
    assert.equal(r.isError, true, '未在授权清单里的目录必须照旧拒绝')
    assert.match(String(r.content), DENIED)
    assert.doesNotMatch(String(r.content), new RegExp(NEEDLE_OTHER), '不得回吐未授权目录的内容')
    const w = tools.registry.Write.run({ file_path: join(env.other, 'x.txt'), content: 'x' })
    assert.equal(w.isError, true, '写侧同样逐目录')
    // 兄弟目录也不行（外部目录的父目录未被授权 = 不能顺势上溯）
    const up = tools.registry.Read.run({ file_path: join(env.dir, 'external', 'external.txt') })
    assert.equal(up.isError, undefined, '同一目录（路径写法不同）应仍然可用')
    assert.equal(tools.registry.Read.run({ file_path: join(env.dir, 'skills', 'demo', 'SKILL.md') }).isError, true,
      '父目录未被授权 ⇒ 不能借兄弟路径上溯')
  } finally { env.cleanup() }
})

test('反例④：注入侧再校验——盘根/不存在/非目录/相对路径即使被硬塞也不生效', () => {
  const env = makeEnv()
  try {
    const tools = makeTools(env)
    tools.setSkillExtraDirs({
      dirs: [
        { skill: 'bad', dir: parse(env.dir).root },
        { skill: 'bad', dir: join(env.other, 'secret.txt') },
        { skill: 'bad', dir: join(env.dir, 'nope') },
        { skill: 'bad', dir: 'relative/dir' },
      ],
      rejected: [],
    })
    const r = tools.registry.Read.run({ file_path: join(env.other, 'secret.txt') })
    assert.equal(r.isError, true, '脏清单不得生效（边界只可能更窄，不可能更宽）')
    assert.match(String(r.content), DENIED)
    const roots = rootsOf(r.content)
    assert.ok(!roots.some((d) => samePath(d, parse(env.dir).root)), '盘根不得出现在可用根清单里')
    assert.ok(!roots.some((d) => samePath(d, join(env.dir, 'nope'))), '不存在的目录不得被授权')
  } finally { env.cleanup() }
})

test('反例⑤：注入侧也受会话总量上限约束（第 17 个目录不生效）', () => {
  const env = makeEnv()
  try {
    const tools = makeTools(env)
    const dirs = Array.from({ length: MAX_EXTRA_DIRS + 1 }, (_, i) => {
      const d = join(env.dir, `inject-cap-${i}`)
      mkdirSync(d, { recursive: true })
      return { skill: 'big', dir: d }
    })
    tools.setSkillExtraDirs({ dirs, rejected: [] })
    assert.equal(tools.registry.Write.run({ file_path: join(dirs[0].dir, 'a.txt'), content: 'a' }).isError, undefined, '上限内的应生效')
    const over = tools.registry.Write.run({ file_path: join(dirs[MAX_EXTRA_DIRS].dir, 'b.txt'), content: 'b' })
    assert.equal(over.isError, true, `第 ${MAX_EXTRA_DIRS + 1} 个目录必须被上限挡下`)
    assert.match(String(over.content), DENIED)
  } finally { env.cleanup() }
})

test('授权变更后派生边界同步重建：Write 能写 ⇒ Read/Grep 也必须能读（防半生效）', async () => {
  const env = makeEnv()
  try {
    const tools = makeTools(env)
    tools.setSkillExtraDirs(resolveFromSkills(env))
    // 不带 path 的 Grep 也必须覆盖到授权目录（扫描根由 allowDirs 派生）
    const g = await tools.registry.Grep.run({ pattern: NEEDLE_EXT })
    assert.ok(!g.isError, g.content)
    assert.match(String(g.content), /external\.txt/, '只放行 Write 而 Read/Grep 仍拒 = 半生效（最难察觉）')
  } finally { env.cleanup() }
})

// ── ④ 可见性：Skill 回执 + init 帧回显 ───────────────────────────────────────
test('Skill 回执：列出本会话已授权的目录（模型才会走正式读路径，而不是绕 Bash）', () => {
  const env = makeEnv()
  try {
    const tools = makeTools(env)
    tools.setSkillExtraDirs(resolveFromSkills(env))
    const r = tools.registry.Skill.run({ skill: 'demo' })
    assert.equal(r.isError, false, r.content)
    assert.match(r.content, /技能「demo」已加载/, '既有前缀不得变（老断言/老会话零回归）')
    assert.match(r.content, /已额外授权的工作目录/, '必须告诉模型这些目录已授权')
    assert.ok(r.content.includes(realpathSync(env.external)), '目录要写全（模型据此直接用绝对路径读写）')
  } finally { env.cleanup() }
})

test('Skill 回执：声明被拒时说明原因（否则用户只会看到"还是被拒"，无从归因）', () => {
  const env = makeEnv()
  try {
    const tools = makeTools(env)
    tools.setSkillExtraDirs({ dirs: [], rejected: [{ skill: 'demo', value: parse(env.dir).root, reason: '不得声明盘根（C:\\）——范围等于整块磁盘' }] })
    const r = tools.registry.Skill.run({ skill: 'demo' })
    assert.match(r.content, /未获授权/, '被拒声明必须出声')
    assert.match(r.content, /盘根/)
  } finally { env.cleanup() }
})

test('零回归：未声明 extra_dirs 的技能，回执不含授权段（措辞逐字如旧）', () => {
  const env = makeEnv()
  try {
    const tools = makeTools(env)
    tools.setSkillExtraDirs(resolveFromSkills(env))
    const r = tools.registry.Skill.run({ skill: 'plain' })
    assert.doesNotMatch(r.content, /已额外授权的工作目录/)
    assert.doesNotMatch(r.content, /未获授权/)
  } finally { env.cleanup() }
})

// ── ⑤ 真内核 spawn：init 帧回显 + 默认不放开 ────────────────────────────────
/** 起真内核，等 init 帧后关 stdin（不需要模型回合：链路证据在启动段）。 */
async function runInit({ args = [], env = {} } = {}) {
  const fixture = makeEnv()
  const proc = spawn(process.execPath, [
    KERNEL_CLI, '--print', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose',
    '--dangerously-skip-permissions', '--add-dir', fixture.cwd,
    '--skills-dir', fixture.skillsRoot, ...args,
  ], {
    env: { ...process.env, PONOS_MOCK_API: '1', PONOS_CONFIG_DIR: fixture.dir, PONOS_HOME: fixture.dir, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let out = ''
  let buf = ''
  const events = []
  proc.stdout.on('data', (d) => {
    out += d
    buf += d
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const line of lines) {
      if (!line.trim()) continue
      try { events.push(JSON.parse(line)) } catch { /* 半行/脏行跳过 */ }
    }
  })
  try {
    const deadline = Date.now() + 20000
    while (Date.now() < deadline && !events.some((e) => e.type === 'system' && e.subtype === 'init')) {
      await new Promise((r) => setTimeout(r, 20))
    }
    try { proc.stdin.end() } catch {}
    await new Promise((res) => { proc.on('close', res); setTimeout(res, 8000) })
    return { init: events.find((e) => e.type === 'system' && e.subtype === 'init'), out, fixture }
  } finally {
    try { proc.kill() } catch {}
  }
}

test('真内核：init 帧回显 extra_dirs（声明生效与否一眼可判，不用靠撞边界反查）', async () => {
  const r = await runInit()
  try {
    assert.ok(r.init, `未收到 init 帧：${r.out.slice(-400)}`)
    assert.deepEqual(r.init.extra_dirs, [{ skill: 'demo', dir: realpathSync(r.fixture.external) }],
      `demo 的声明必须跨"SKILL.md → 发现 → 校验 → 注入 → 回显"全链生效：${r.out.slice(-400)}`)
    assert.deepEqual(r.init.extra_dirs_rejected, [], '合法夹具不应有被拒项')
  } finally { r.fixture.cleanup() }
})

test('真内核：非法声明（盘根）被拒并回显原因；未声明的技能不贡献目录', async () => {
  const fixture = makeEnv()
  const fsRoot = parse(fixture.dir).root
  mkdirSync(join(fixture.skillsRoot, 'evil'), { recursive: true })
  writeFileSync(join(fixture.skillsRoot, 'evil', 'SKILL.md'), ['---', 'name: evil', 'description: 越界声明', 'extra_dirs:', `  - ${fsRoot}`, '---', ''].join('\n'), 'utf-8')
  const p = spawn(process.execPath, [
    KERNEL_CLI, '--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--dangerously-skip-permissions', '--add-dir', fixture.cwd, '--skills-dir', fixture.skillsRoot,
  ], {
    env: { ...process.env, PONOS_MOCK_API: '1', PONOS_CONFIG_DIR: fixture.dir, PONOS_HOME: fixture.dir },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let out = ''
  let buf = ''
  const events = []
  p.stdout.on('data', (d) => {
    out += d
    buf += d
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const line of lines) {
      if (!line.trim()) continue
      try { events.push(JSON.parse(line)) } catch { /* skip */ }
    }
  })
  try {
    const deadline = Date.now() + 20000
    while (Date.now() < deadline && !events.some((e) => e.type === 'system' && e.subtype === 'init')) {
      await new Promise((r) => setTimeout(r, 20))
    }
    try { p.stdin.end() } catch {}
    await new Promise((res) => { p.on('close', res); setTimeout(res, 8000) })
    const init = events.find((e) => e.type === 'system' && e.subtype === 'init')
    assert.ok(init, `未收到 init 帧：${out.slice(-400)}`)
    const granted = (init.extra_dirs || []).map((d) => d.skill)
    assert.deepEqual(granted, ['demo'], '只有合法声明生效（evil 的盘根声明不得进授权清单）')
    const bad = (init.extra_dirs_rejected || []).find((x) => x.skill === 'evil')
    assert.ok(bad, '被拒的声明必须出现在回显里（否则用户不知道为何"声明了没用"）')
    assert.match(bad.reason, /盘根/)
  } finally {
    try { p.kill() } catch {}
    fixture.cleanup()
  }
})

// ── ⑥ 静态接线守卫（漏接是静默失效，行为断言覆盖不到链头）───────────────────
test('链路守卫：cli 必须解析并把授权注入工具边界，且 init 帧回显（漏任一处 = 静默失效）', () => {
  const cli = read('../kernel/cli.mjs')
  assert.match(cli, /const skillExtraDirs = chatMode \? \{ dirs: \[\], rejected: \[\] \} : resolveSkillExtraDirs\(\{ skills \}\)/,
    '技能发现之后必须做会话级解析（skills 已过停用过滤）')
  assert.match(cli, /engine\.tools\.setSkillExtraDirs\(skillExtraDirs\)/, 'engine.mjs 不转发该参数 ⇒ 必须经 cli 注入（同 setKnowledgeReadDirs 约定）')
  assert.match(cli, /extra_dirs: skillExtraDirs\.dirs\.map/, 'init 帧回显：授权是否到位要可判定')
  assert.match(cli, /extra_dirs_rejected: skillExtraDirs\.rejected\.map/, '被拒声明也要回显')
})

test('链路守卫：tools 注入必须"复用同一校验 + 追加 allowDirs + 重建派生边界"', () => {
  const tools = read('../kernel/tools.mjs')
  assert.match(tools, /import \{ validateExtraDir, MAX_EXTRA_DIRS \} from '\.\/skill-dirs\.mjs'/,
    '校验函数必须复用（自写第二份判据 = 迟早漂移）')
  // 只看 setSkillExtraDirs 的函数体（对全文 match 会变成恒真断言——本仓库明令禁止）
  const start = tools.indexOf('setSkillExtraDirs(payload)')
  assert.ok(start > 0, 'setSkillExtraDirs 必须存在')
  const tail = tools.indexOf('addReadAllowFiles(', start)
  const body = tools.slice(start, tail > start ? tail : start + 4000)
  assert.match(body, /if \(extraDirEntries\.length >= MAX_EXTRA_DIRS\) break/, '注入侧也要有上限（不能只靠上层）')
  assert.match(body, /const v = validateExtraDir\(e\?\.dir\)/, '每条都要过同一校验函数')
  assert.match(body, /allowDirs\.push\(v\.dir\)/, '授权必须落到 allowDirs（读写兼备），否则 Write 仍被拒')
  assert.match(body, /applyKnowledgeReadDirs\(\)/, '注入后必须重建只读/扫描派生边界，防"Write 能写、Read/Grep 仍拒"')
  assert.doesNotMatch(body, /skipBoundary/, '不得靠"关掉边界校验"来实现（默认不放开是硬约束）')
  assert.doesNotMatch(body, /readAllowDirs\s*=/, '不得在注入点另写一份只读边界（边界单一来源）')
})

test('链路守卫：skills.mjs 负责解析 extra_dirs（唯一字段名），且不做授权判定', () => {
  const skills = read('../kernel/skills.mjs')
  assert.match(skills, /extraDirs: parseYamlList\(yaml, 'extra_dirs'\)/, '字段名必须与 skill-dirs 的 SKILL_EXTRA_DIRS_KEY 一致')
  assert.doesNotMatch(skills, /withinBoundary|allowDirs/, '解析层不得持有边界（授权判定只在 cli/skill-dirs/tools）')
})
