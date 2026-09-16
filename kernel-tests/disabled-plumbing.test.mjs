// kernel-tests/disabled-plumbing.test.mjs
// 停用链路的**静态接线守卫**（2026-09-15，P1 D 条款）。
//
// ## 这类守卫为什么必要（不是形式主义）
//
// 本仓库已有两次同类事故：新增参数 `--spaces`、`--confirm` **忘记在 cli 登记**，而内核 CLI 对
// 未知 `--` 参数是**静默忽略**的 —— 表现为"功能配了但没生效"，无任何报错。
// 停用链路是一条 6 跳的链（注册表文件 → cli 读 → 提示词技能清单 / Skill 工具池 / resolveAgents），
// 任一跳漏接都仍然"单测全绿"（每个函数单独都对），故这里按源码断言把每一跳钉住：
//
//   ① cli 真的读了注册表，并把 skills 停用清单传给提示词技能清单与工具池；
//   ② engine 把 disabledSkills 透传给 createToolRegistry（少这一跳：工具层不拦，后门还在）；
//   ③ tools.mjs 的 Skill 工具按名调用时判定停用（只在清单处过滤 = 留后门）；
//   ④ skills.mjs 的 discoverSkillsAll 支持 disabled（提示词与工具池的唯一汇聚点）；
//   ⑤ agents.mjs 的 resolveAgents 过滤停用（内置 agent 也能停）；
//   ⑥ GUI：agentStore 开关写注册表、SkillsPanel 走 disabledStore（乐观更新 + 失败回滚）。
//
// 真进程证据在 disabled-e2e.test.mjs（行为层），本文件只保证"线还接着"。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const cli = read('../kernel/cli.mjs')
const engine = read('../kernel/engine.mjs')
const tools = read('../kernel/tools.mjs')
const skills = read('../kernel/skills.mjs')
const agents = read('../kernel/agents.mjs')
const agentStore = read('../src/stores/agentStore.ts')
const skillsPanel = read('../src/components/skills/SkillsPanel.tsx')

test('① cli：读注册表，且技能清单过滤用的是它读出来的 agents/skills', () => {
  assert.match(cli, /readDisabled\(\{ configDir \}\)/, 'cli 必须读 <configDir>/disabled.json')
  assert.match(cli, /excludeDisabled\(discoverSkills\(/, '提示词技能清单必须按停用清单过滤')
  assert.match(cli, /if \(!disabledReg\.ok\) log\.warn/, '读失败要出声（否则"停用没生效"无从排查）')
})

test('② engine：把 disabledSkills 透传给工具注册表（少这一跳 = 按名调用后门仍在）', () => {
  assert.match(engine, /disabledSkills: opts\.disabledSkills \?\? null/,
    'engine 必须透传；漏了的话提示词里没了、Skill 工具仍能按名加载')
  assert.match(cli, /disabledSkills: disabledReg\.skills,/, 'cli → engine 的那一跳也要在')
})

test('③ tools.mjs：Skill 工具按名调用时判停用，且"可用清单"同口径', () => {
  assert.match(tools, /const disabledSkillIds = Array\.isArray\(disabledSkills\)/, '入参归一')
  assert.match(tools, /if \(isDisabled\(disabledSkillIds, id\)\)/, '按名调用必须拦（防沿用历史记忆直调）')
  assert.match(tools, /已被全局停用/, '拒绝要说清原因与恢复方式，别让模型以为"技能不存在"而换名重试')
  assert.match(tools, /flatRoots: flatSkillRootsArg, disabled: disabledSkillIds/, '"技能不存在"的可用清单也必须排除停用项')
})

test('④ skills.mjs：discoverSkillsAll 支持 disabled（唯一汇聚点）', () => {
  assert.match(skills, /export function discoverSkillsAll\(\{ roots = \[\], flatRoots = undefined, disabled = undefined \}/,
    '签名必须暴露 disabled')
  assert.match(skills, /return excludeDisabled\(out, disabled\)/, '缺省不过滤（公开口零回归），显式传入才过滤')
})

test('⑤ agents.mjs：resolveAgents 内部自读注册表（多调用点不会漏传）', () => {
  assert.match(agents, /const off = disabled !== undefined \? disabled : readDisabled\(\{ configDir \}\)\.agents/,
    '函数内自读：靠调用方传迟早漏一个（本文件头注的 ① 类事故）')
  assert.match(agents, /return excludeDisabled\(\[\.\.\.byId\.values\(\)\], off\)/, '内置 agent 同样被过滤（不再是豁免区）')
})

test('⑥ GUI：agent 开关写注册表（专业/内置 agent 都真的停得掉）', () => {
  // 注意（2026-09-15 批次二 H 更新）：本守卫原先断言 "saveDisabled({ agents: all.filter(...) })"，
  // 那是**覆盖式**写法；H 批次改为"本 store 侧重算 ∪ 外来项"，改走 disabledStore 统一出口
  // （那里有乐观更新 + 失败回滚），故这里改为断言新的调用链。
  assert.match(agentStore, /void syncDisabledAgents\(id,/, 'toggleAgent 必须调用它')
  assert.match(agentStore, /await useDisabledStore\.getState\(\)\.setDisabledAgents\(next\)/,
    '必须经 disabledStore 写注册表（复用其失败回滚，避免界面与内核不一致）')
  assert.match(agentStore, /setAgentTools:/, 'A 条款：工具范围必须可写（对任何类型 agent）')
})

test('⑥ GUI：技能开关走 disabledStore（乐观更新 + 失败回滚 + 出声）', () => {
  assert.match(skillsPanel, /useDisabledStore\(s => s\.setSkillDisabled\)/, '技能开关必须接注册表')
  assert.match(skillsPanel, /if \(err\) alert\(t\('skills\.toggleFailed'/, '失败必须出声（静默失败 = 用户长期以为已停用）')
  assert.match(skillsPanel, /const skillDisabled = disabledSkills\.includes\(skill\.id\)/, '停用态从注册表派生')
})

test('⑥ GUI：disabledStore 失败必须回滚（否则界面与内核不一致）', () => {
  const store = read('../src/stores/disabledStore.ts')
  assert.match(store, /if \(err\) set\(\{ skills: prev \}\)/, '写失败要回滚：留在"已停用"界面就是假开关')
  assert.match(store, /if \(err\) set\(\{ agents: prev \}\)/, 'agent 侧同理')
  assert.match(store, /const next = toggleDisabledId\(prev, id, disabled\)/, '复用纯函数（与单测同口径）')
})

test('⑦ 关键不变量：桥写的目录 = 内核读的目录（YFW_HOME ≡ PONOS_CONFIG_DIR）', () => {
  const bridge = read('../server/bridge.mjs')
  assert.match(bridge, /configDir: YFW_HOME \}\)/, '桥必须写到 YFW_HOME 根')
  assert.match(bridge, /PONOS_CONFIG_DIR: YFW_HOME/, '不变量前提：内核子进程的 PONOS_CONFIG_DIR 必须等于 YFW_HOME')
  // 内核侧 configDir 解析优先级（PONOS_CONFIG_DIR > PONOS_HOME > ~/.ponos）
  assert.match(cli, /PONOS_CONFIG_DIR/, '内核必须仍以 PONOS_CONFIG_DIR 为首选')
})

// ── H 条款（批次二）：内核独有 agent 的入口 + 跨区域停用不被覆盖 ────────────────

test('H① bridge 把 /agents 接到 agent 目录 handler，且 configDir 传 YFW_HOME', () => {
  const bridge = read('../server/bridge.mjs')
  assert.match(bridge, /import \{ handleAgentsRoute \} from '\.\/agents-routes\.mjs'/, '必须复用纯 handler（可直调测试）')
  assert.match(bridge, /const r = await handleAgentsRoute\(\{ method: req\.method, pathname: url\.pathname, configDir: YFW_HOME \}\)/,
    '接线必须传 configDir: YFW_HOME（内核读同一份注册表，口径才一致）')
  // 两条独立断言（不要求相邻：中间隔着闭合括号，写"相邻"会让守卫假红灯——已踩过一次）
  assert.match(bridge, /if \(r\) return reply\(r\.status, \{ 'Content-Type': 'application\/json' \}, JSON\.stringify\(r\.body\)\)/,
    '必须判空后 reply（`if (r)`），未匹配时 handler 返回 null')
  const iAgents = bridge.indexOf('handleAgentsRoute({')
  const iSample = bridge.indexOf("url.pathname === '/sample-skills'")
  assert.ok(iAgents > 0 && iAgents < iSample, '/agents 的接分发必须在普通技能路由之前，避免被提前 return 吃掉')
})

test('H② agent 目录路由**刻意绕过停用过滤** + 返回 disabled 标记（否则开关单向不可逆）', () => {
  const route = read('../server/agents-routes.mjs')
  assert.match(route, /resolveAgents\(\{ configDir, disabled: \[\] \}\)/,
    '**关键**：传 disabled:[] 拿完整目录。若按停用过滤，停用项会从列表消失 ⇒ 用户永远点不回来')
  assert.match(route, /disabledIds = readDisabled\(\{ configDir \}\)\.agents/, 'disabled 状态取自同一份注册表')
  assert.match(route, /disabled: off\.has\(a\.id\)/, '每项必须带 disabled 标记供界面渲染"已停用"态')
})

test('H③ 内核侧给 agent 打 builtin 标记（界面据此分组，不靠猜）', () => {
  assert.match(agents, /const builtinIds = new Set\(BUILTIN_AGENTS\.map\(\(a\) => a\.id\)\)/, '要能区分硬编码内置')
  assert.match(agents, /\.map\(\(a\) => \(\{ \.\.\.a, builtin: builtinIds\.has\(a\.id\) \}\)\)/, '标记为纯增量字段（不影响既有消费者）')
})

test('H④ GUI：内核独有 agent 分区只列"本 store 没有的"（避免同一 agent 两个开关）', () => {
  const section = read('../src/components/agents/KernelAgentsSection.tsx')
  assert.match(section, /selectKernelOnlyAgents\(list, localIds\)/, '必须按本 store 的 id 过滤')
  assert.match(section, /fetchKernelAgents\(\)/, '列表来自内核（不再抄一份会漂移的名单）')
  assert.match(section, /setDisabledAgents\(next\)/, '开关写停用注册表（这 5 个 agent 没有 .md，只能走这条路）')
  assert.match(section, /if \(err\) alert\(t\('skills\.toggleFailed'/, '失败必须出声（否则留下"界面已停用、内核照旧派发"的假状态）')
  const panel = read('../src/components/agents/AgentsPanel.tsx')
  assert.match(panel, /<KernelAgentsSection \/>/, '必须真的挂进 Agent 页面')
})

test('H⑤ **回归守卫**：agentStore 同步停用清单时必须保留"外来 id"（内核独有 agent）', () => {
  assert.match(agentStore, /foreignDisabledAgents\(useDisabledStore\.getState\(\)\.agents, localIds\)/,
    '**核心**：必须取出不属于本 store 的停用项')
  assert.match(agentStore, /const next = \[\.\.\.new Set\(\[\.\.\.localDisabled, \.\.\.foreign\]\)\]/,
    '取并集而非覆盖：覆盖会把"已停用的 researcher"静默抹掉（用户无法归因）')
  assert.doesNotMatch(agentStore, /saveDisabled\(\{ agents: all\.filter\(a => !a\.enabled\)\.map\(a => a\.id\) \}\)/,
    '旧的全量覆盖写法必须已移除（那正是 bug 本身）')
})

test('B 条款：收藏技能改为紧凑卡片行（不再复用整卡渲染）', () => {
  const panel = read('../src/components/skills/SkillsPanel.tsx')
  assert.match(panel, /<PinnedSkillsRow/, '收藏区必须用紧凑卡片组件')
  assert.doesNotMatch(panel, /\{pinnedList\.map\(s => renderSkillItem\(s\)\)\}/,
    '改前用与主体列表相同的整卡渲染 —— 收藏几个就把主体列表挤下去大半屏（用户明确要求不占过多版面）')
  const row = read('../src/components/skills/PinnedSkillsRow.tsx')
  assert.match(row, /togglePinSkill|onUnpin/, '紧凑卡片要能取消收藏')
  assert.match(row, /isDisabled/, '停用徽标也要在收藏区可见（"还能不能用"是关键信息）')
})

// ── C 条款（批次二）：卡片详情 + 只读展开（触发规则 / 关联脚本）──────────────

test('C① 详情面板挂进技能卡片，且同时只展开一个（避免把列表撑长）', () => {
  const panel = read('../src/components/skills/SkillsPanel.tsx')
  assert.match(panel, /<SkillDetailPanel/, '详情面板必须真的挂进卡片')
  assert.match(panel, /const \[detailId, setDetailId\] = useState<string \| null>\(null\)/,
    '只存一个 id：同时展开多个详情会把列表撑得极长（与 B 的"不占版面"目标冲突）')
  assert.match(panel, /setDetailId\(detailId === skill\.id \? null : skill\.id\)/, '再点一次应折叠')
})

test('C② 详情逻辑落在 .ts 而非 .tsx（.tsx 无法被 node --test import）', () => {
  // 这条守卫来自实测踩坑：`node --test` 跑 .ts 时 import 一个 .tsx 会
  // ERR_UNKNOWN_FILE_EXTENSION（本仓库无 vitest/tsx）。故有判断逻辑的部分必须抽到 .ts。
  const lib = read('../src/lib/skillDetail.ts')
  assert.match(lib, /export async function fetchSkillDetail/, '数据层必须在 .ts 里（可被直接测试）')
  assert.match(lib, /export async function openLocalPath/, '"系统打开"也放这里（含"环境不支持"的分支判断）')
  const panel = read('../src/components/skills/SkillDetailPanel.tsx')
  assert.match(panel, /from '@\/lib\/skillDetail'/, '组件必须从 .ts 数据层引入，不得自带一份实现（否则测的是另一份代码）')
})

test('C③ 只读纪律：详情链路不得出现写文件调用（决策 D2）', () => {
  const route = read('../server/skill-detail-routes.mjs')
  assert.doesNotMatch(route, /writeFileSync|appendFileSync|renameSync|unlinkSync|rmSync/, '路由必须只读')
  const lib = read('../src/lib/skillDetail.ts')
  assert.doesNotMatch(lib, /method:\s*'(PUT|POST|PATCH|DELETE)'/, '客户端只有 GET（"管理"= 系统打开文件）')
  const loader = read('../kernel/skills.mjs')
  const fn = loader.slice(loader.indexOf('export function loadSkillDetail'))
  assert.doesNotMatch(fn, /writeFileSync|appendFileSync|renameSync|unlinkSync/, 'loadSkillDetail 必须只读')
})

test('C④ **判据统一**：父子归属判断只能走 skillTree，不得在面板里另写内联副本', () => {
  // 这条守卫的由来（2026-09-15 批次二 C 实测出的两个真缺陷）：
  //   面板里同一条"谁是父级"的判据曾有 **3 份各自实现**：
  //     · 顶层过滤 `skills.filter(s => !s.parent && ...)`
  //     · 渲染循环 `const isParent = (s.subskills || []).length > 0`
  //     · 收藏小卡 `(s.subskills || []).length > 0 || skills.some(c => c.parent === s.id)`
  //   三者语义不一致 ⇒ 只被 `parent` 反指的父级（本仓库官方支持的写法，如
  //   `yfwx-project-eval` 声明 `parent: yfwx-suite`）在渲染路径被判为"非父级" ⇒ **子技能不渲染**；
  //   且 `!s.parent` 过滤 + `if (s.parent) return null` 双重丢弃 ⇒ 父级未安装的**孤儿技能在界面上
  //   彻底消失**（不报错、不提示，用户无法归因）。
  // 结论：判据必须只有一处真相（`src/lib/skillTree.ts`），本守卫防止再退回多份副本。
  const panel = read('../src/components/skills/SkillsPanel.tsx')
  assert.doesNotMatch(panel, /const isParent = \(s\.subskills/,
    '不得再内联"是否父级"的判据（必须调 isParentSkill）')
  assert.doesNotMatch(panel, /if \(s\.parent\) return null/,
    '**关键**：这句会让孤儿技能（parent 指向不存在的技能）被二次丢弃 ⇒ 在界面上彻底消失')
  assert.doesNotMatch(panel, /skills\.filter\(s => !s\.parent/,
    '顶层过滤不得内联（必须走 topLevelSkills，它会保留孤儿）')
  assert.match(panel, /topLevelSkills\(skills, matches\)/, '顶层过滤必须走纯函数')
  assert.match(panel, /isParentSkill\(s, skills\)/, '渲染处父级判据必须走纯函数')
  assert.match(panel, /childrenToShow\(s, skills, matches,/, '子项清单必须走纯函数（含去重/剔除不存在/排除自指）')
  assert.match(panel, /defaultFolderOf|resolveFolder/, '分类口径必须走纯函数')

  // 纯逻辑本身可被直接测试（.ts 才能被 node --test import）
  const tree = read('../src/lib/skillTree.ts')
  assert.match(tree, /export function topLevelSkills/)
  assert.match(tree, /export function isParentSkill/)
  assert.match(tree, /export function isOrphanChild/)
  assert.match(tree, /export function childrenToShow/)
})
