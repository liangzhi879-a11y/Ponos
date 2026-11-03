// SEC-04 修复验证（P2 安全）：hooks 子进程**继承完整父环境**。
//
// 【缺陷】`kernel/hooks.mjs` 启动 hook 时：
//     env: { ...process.env, PONOS_HOOK_EVENT: ... }
//   hook 命令来自**项目级配置**（`.ponos/hooks.json` / settings），而项目目录常来自 clone，
//   也可能是别人给的仓库 ⇒ **不可信的代码**继承了完整环境，包括：
//     · 各家 LLM API Key（PONOS_*_AUTH_TOKEN / PONOS_VISION_* / 第三方 PONOS_*_KEY）
//     · 代理与凭据注入变量（HTTP_PROXY 里的 user:pass、NODE_OPTIONS 可注入 --require）
//     · 密码库路径与解锁上下文（PONOS_HOME / PONOS_VAULT_*）
//   一个恶意 hook 只要 `env` 一行就能把密钥打走 —— 而它本来只是"格式检查/通知"这类轻量动作。
//
// 【修法】改成**白名单**：只透传 hook 真正需要的（可执行搜索、临时目录、语言、代理开关），
//   绝不透传任何名字里带 TOKEN / KEY / SECRET / PASSWORD / AUTH / VAULT 的变量。
//
//   ★ 为什么不是"黑名单剔除敏感词"：黑名单永远漏（新变量名、拼接名、第三方前缀）。
//     白名单的失效方向是"hook 少了某项能力"（可诊断、可补），黑名单的失效方向是"密钥泄漏"。
//   ★ 保留 NODE_OPTIONS？**不保留** —— 它能 `--require` 任意模块，等于任意代码执行。
//     hook 需要 Node 特殊选项时应在自己的命令里显式写。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const HOOKS = readFileSync(new URL('../kernel/hooks.mjs', import.meta.url), 'utf8')
const SRC = HOOKS.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

// 取出 runHook 里 spawn 的 env 表达式
function envExpr() {
  const i = SRC.indexOf('function runHook(')
  assert.ok(i > -1, '必须有 runHook')
  const block = SRC.slice(i, i + 2500)
  const m = block.match(/env:\s*(\{[^}]*\}|[A-Za-z_$][\w$]*\([^)]*\))/)
  assert.ok(m, 'runHook 的 spawn 必须显式给 env')
  return m[1]
}

test('★ SEC-04：hook 子进程不得继承完整父环境', () => {
  const expr = envExpr()
  assert.ok(!/\.\.\.process\.env/.test(expr),
    `hook 的 env 不得整体展开 process.env（实得：${expr.slice(0, 120)}）—— `
    + 'hook 命令来自项目级配置（项目目录常来自 clone），不可信代码继承完整环境即可读走全部 API Key')
})

test('★ SEC-04：必须走白名单函数（而不是散落的取值）', () => {
  const expr = envExpr()
  assert.match(expr, /hookEnv|buildHookEnv|safeEnv|whitelistedEnv/i,
    `hook 的 env 必须来自一个**白名单构造器**（实得：${expr.slice(0, 120)}）—— `
    + '白名单的失效方向是"少了某项能力"（可诊断可补），黑名单的失效方向是"密钥泄漏"')
})

test('★ SEC-04：白名单必须**拒绝**任何名字含敏感词的变量', () => {
  const i = SRC.indexOf('function hookEnv')
  const alt = i >= 0 ? i : SRC.search(/function (buildHookEnv|safeEnv|whitelistedEnv)/)
  assert.ok(alt >= 0, '必须有 hookEnv 白名单函数')
  const fn = SRC.slice(alt, alt + 1600)
  assert.match(fn, /TOKEN|KEY|SECRET|PASSWORD|AUTH|VAULT/i,
    '白名单必须显式排除敏感命名（TOKEN/KEY/SECRET/PASSWORD/AUTH/VAULT）—— '
    + '否则新增一个 PONOS_XXX_KEY 又会被顺带透传')
})

test('★ SEC-04：NODE_OPTIONS 不得透传（等于任意代码执行）', () => {
  const fnIdx = SRC.search(/function (hookEnv|buildHookEnv|safeEnv|whitelistedEnv)/)
  assert.ok(fnIdx >= 0, '必须有白名单函数')
  const fn = SRC.slice(fnIdx, fnIdx + 1600)
  assert.ok(!/'NODE_OPTIONS'|"NODE_OPTIONS"/.test(fn),
    'NODE_OPTIONS 不得透传给 hook —— 它能 `--require` 任意模块，等于把"执行任意代码"送给一个'
    + '只该做格式检查的子进程')
})

test('★ SEC-04：hook 正常需要的基础变量必须在白名单里（不能把功能改坏）', () => {
  const fnIdx = SRC.search(/function (hookEnv|buildHookEnv|safeEnv|whitelistedEnv)/)
  const fn = SRC.slice(fnIdx, fnIdx + 1600)
  // 至少要能跑命令、找到临时目录、决定语言
  for (const need of ['PATH', 'HOME|USERPROFILE', 'TEMP|TMP']) {
    assert.match(fn, new RegExp(need),
      `白名单必须包含 ${need} —— 否则 hook 会在正常机器上就"找不到命令/写不了临时文件"`)
  }
})

test('★ SEC-04：PONOS_HOOK_EVENT 仍必须注入（既有协议）', () => {
  const i = SRC.indexOf('function runHook(')
  const block = SRC.slice(i, i + 2500)
  assert.match(block, /PONOS_HOOK_EVENT/,
    'PONOS_HOOK_EVENT 必须继续注入 —— 那是 hook 侧识别事件类型的既有协议，不能因为改白名单而丢')
})

test('★ SEC-04：白名单后 hook 仍能正常执行（行为级：真的跑一次命令）', async () => {
  // 用 node 自身作为 hook 命令，读环境变量并打印 —— 验证"能力没被削掉"且"敏感项确实没了"
  // ★ runHook 未导出；用导出的 createHooks 走同一条路径（也更接近真实调用方式）
  const { createHooks } = await import('../kernel/hooks.mjs')
  process.env.PONOS_FAKE_AUTH_TOKEN = 'SECRET-SHOULD-NOT-LEAK'
  try {
    const rule = {
      command: process.execPath,
      args: ['-e', 'const e=process.env;console.log(JSON.stringify({hasPath:!!e.PATH||!!e.Path,event:e.PONOS_HOOK_EVENT,leak:e.PONOS_FAKE_AUTH_TOKEN??null}))'],
      timeoutMs: 15000,
    }
    const hooks = createHooks({ rules: [{ event: 'test-event', ...rule }] })
    const r = await hooks.run('test-event', {})
    const out = String(r?.stdout || r?.output || JSON.stringify(r))
    assert.match(out, /"hasPath":true/, `hook 必须仍能拿到 PATH 才能找到命令（实得：${out.slice(0, 160)}）`)
    assert.match(out, /"event":"test-event"/, 'PONOS_HOOK_EVENT 必须仍被注入（既有协议）')
    assert.ok(!out.includes('SECRET-SHOULD-NOT-LEAK'),
      '★ 敏感变量（名字含 TOKEN）绝不能被透传给 hook —— 这正是本条缺陷的核心')
  } finally {
    delete process.env.PONOS_FAKE_AUTH_TOKEN
  }
})
