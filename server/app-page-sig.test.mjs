// server/app-page-sig.test.mjs —— 应用页作用域的**桥侧归一/签名 + 四跳透传静态守卫**（2026-09-16，P2）
//
// 分两层测：
//   ① 纯函数（normalizeAppPageId / appPageSig）：作用域变更靠"签名不一致 → 收割内核 +
//      --resume 重启"生效。判错的后果不是"功能没生效"就是**误杀正在跑的轮次**
//      （签名抖动 = 每轮都重启），两种故障都不报错 —— 故与 knowledge-spaces-sig 同源：
//      `''` / `undefined` / `null` / 纯空白必须**同一签名**，否则一次"清空作用域"就白重启。
//   ② 静态守卫：这条链同样跨三进程（会话字段 → useYFWCLI payload → bridge argv → 内核登记），
//      中间几跳的行为要起 bridge 才能测（见 app-page-spawn.test.mjs 的进程级用例），
//      这里按本仓库既有做法（kernel-tests/knowledge-scope-plumbing.test.mjs）用源码文本断言
//      守住"接线还在"。断言失败的含义很明确：**有人删/改了透传点** → 静默失效而非报错。
//
// 加载方式照 server/provider-env-sig.test.mjs：YFW_BRIDGE_NO_LISTEN=1 + 动态 import，
// 只取纯函数、不起服务、不 spawn 内核。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

process.env.YFW_BRIDGE_NO_LISTEN = '1'
const { normalizeAppPageId, appPageSig } = await import('./bridge.mjs')

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const optional = (rel) => (existsSync(join(ROOT, rel)) ? read(rel) : null)

test('归一：空值/非字符串/纯空白 → null；有值去空白后原样保留', () => {
  assert.equal(normalizeAppPageId('app-a'), 'app-a')
  assert.equal(normalizeAppPageId('  app-a  '), 'app-a', '去空白（否则内核侧收到一个不存在的 id）')
  for (const bad of [undefined, null, '', '   ', 0, 42, {}, [], ['app-a']]) {
    assert.equal(normalizeAppPageId(bad), null, `${JSON.stringify(bad)} 应等价于"无作用域"`)
  }
})

test('★ 签名：同一状态只有一个签名（否则每轮白重启一次内核）', () => {
  const canonical = appPageSig('app-a')
  assert.equal(appPageSig(' app-a '), canonical, '空白不得改变签名')
  assert.equal(appPageSig(undefined), appPageSig(null), '缺值 与 null 同签名')
  assert.equal(appPageSig(''), appPageSig(undefined), '空串 与 缺值 同签名（"清空作用域"只能算一次变更）')
  assert.equal(appPageSig('  '), appPageSig(null), '纯空白同理')
})

test('★ 签名：真正不同的作用域必须不同签名（否则改了不生效）', () => {
  assert.notEqual(appPageSig('app-a'), appPageSig('app-b'), '换应用必须变签名（否则仍接旧应用的工具）')
  assert.notEqual(appPageSig(undefined), appPageSig('app-a'), '无作用域 → 有作用域必须变签名')
})

test('第 1 跳：内核 CLI 登记 --app-page（漏登记 = 参数被静默吞掉）', () => {
  const src = read('kernel/cli.mjs')
  assert.match(src, /case '--app-page'/, '必须显式登记 case：本 CLI 对未知 `--` 参数静默忽略')
  assert.match(src, /appPage: null/, '初值要登记（否则 case 写出来的值不在 out 里）')
  assert.match(src, /const appPageId = chatMode \? null : \(args\.appPage \|\| null\)/,
    'chat 模式恒无作用域（与 appRoots=[] 同源）；其余取 --app-page')
  assert.match(src, /scopeAppId: appPageId,/, '工具池必须收到作用域（否则标志解析了却不用）')
  assert.match(src, /resolveScopedApp\(\{ roots: appRoots, sessionId, scopeAppId: appPageId \}\)/,
    '权限规则注入必须与工具池同源（两套口径 = "工具池给 A、规则按 B 注入"）')
  assert.match(src, /未找到对应应用/, '作用域指向不存在的应用必须 warn（否则只表现为"模型说没有这个工具"）')
})

test('第 2 跳：app-tools 把 scopeAppId 透传给 isAppVisible（漏传 = 作用域形同虚设）', () => {
  const src = read('kernel/app-tools.mjs')
  assert.match(src, /export function buildAppTools\(\{[^}]*scopeAppId = null/s, 'buildAppTools 必须收 scopeAppId')
  assert.match(src, /isAppVisible\(spec, \{ agentId, boundApp, scopeAppId \}\)/, '必须透传（收了不传=白收）')
})

test('第 3 跳：bridge 把会话字段转成 --app-page（参数名逐字一致）+ 两处调用点都传', () => {
  const src = read('server/bridge.mjs')
  assert.match(src, /args\.push\('--app-page'/, '参数名必须与内核登记项逐字一致（拼错=静默失效）')
  assert.match(src, /normalizeAppPageId\(appPageId\)/, '先归一再加参（同一状态只应有一个签名）')
  assert.match(src, /getOrCreateSession\(sid, cwd, resumeId, systemPrompt, model, compactCount, mode = 'task', knowledgeSpaces = null, appPageId = null\)/,
    'getOrCreateSession 必须收这个字段（否则前端传了也到不了 argv）')
  assert.match(src, /_spawnAppPageSig/, '作用域签名：变更后要能触发 --resume 重启内核才生效')
  assert.match(src, /appPageChanged/, '变更判定必须真的进 if（只冻签名不比对 = 改了不生效）')
  // send 与 answer 两条路径**都要传**：漏一处会出现"首条消息按作用域收窄、回答触发重 spawn
  // 后又变回全量工具池"的分裂（只在"卡在提问上的会话被回收后作答"时才暴露）。
  const callSites = src.match(/msg\.knowledgeSpaces, msg\.appPageId\)/g) || []
  assert.equal(callSites.length, 2, `send 与 answer 两处调用点都必须传 appPageId（实际 ${callSites.length} 处）`)
})

test('第 3 跳（前端）：会话字段进 spawn payload（send 与 answer 同源）', () => {
  const src = optional('src/hooks/useYFWCLI.ts')
  if (!src) return   // 纯内核形态（无 GUI）时跳过
  assert.match(src, /conversation\.appPageId \? \{ appPageId: conversation\.appPageId \}/,
    '缺失时不发该键（与 knowledgeSpaces 同款纪律）')
})

test('第 4 跳（类型 + 持久化消毒）：Conversation 声明该字段，消毒函数归一脏值', () => {
  const types = optional('src/types/index.ts')
  if (!types) return
  assert.match(types, /appPageId\?: string/, '类型声明缺失会让透传处被 TS 判为多余属性')
  const mig = optional('src/lib/chatScopeMigration.ts')
  assert.match(mig, /export function sanitizeAppPageId/, 'rehydrate 消毒必须归一脏值（否则持久化里会留下 null/空串）')
  assert.match(mig, /sanitizeAppPageId\(rawAppPage\)/, '消毒函数必须真的被 sanitizeConversations 调用（写了不用=白写）')
})
