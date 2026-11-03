// 浏览器白名单拦截 → 用户批准流（2026-09-10）
// ---------------------------------------------------------------------------
// 背景：内置浏览器有域名白名单（默认政务/搜索/企业查询/邮箱），goto 非白名单
// 域名被执行器拦截。旧行为只回一句"目标域名不在白名单"错误，模型无从恢复。
// 修复：执行器回 code='whitelist-blocked' + domain → 内核经 can_use_tool 审批
// 通道向用户请求批准（GUI 弹窗 / TUI y/n）→ 批准由 bridge 写入
// browser-whitelist.json（mtime 热重载即时生效）→ 工具结果提示模型重试；
// 拒绝/超时给替代途径引导。本文件用 mock API + 手动 resolveBrowser/
// resolveApproval 驱动该流，钉死审批事件形状与两条分支文案。
process.env.PONOS_MOCK_API = '1'
const { createEngine } = await import('../kernel/engine.mjs')
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionStore } from '../kernel/session.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const v = fn()
    if (v) return v
    await sleep(10)
  }
  return null
}

function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'browser-wl-'))
  const events = []
  const wire = {
    assistant: () => {}, result: () => {},
    controlRequest: (r) => events.push({ type: 'control', ...(r || {}) }),
    bridgeRequest: (r) => events.push({ type: 'br', ...(r || {}) }),
    toolResult: (r) => events.push({ type: 'tool-result', ...(r || {}) }),
    system: () => {}, summary: () => {}, health: () => {}, warning: () => {},
  }
  const session = createSessionStore({ configDir: dir, cwd: dir, sessionId: 'browser-wl-session' })
  const engine = createEngine({
    opts: { model: 'm', addDirs: [dir], skipPermissions: true, systemPrompt: '' },
    wire, session,
  })
  return { engine, session, events, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

// 用 blocked 响应解除浏览器挂起，再等审批事件出现
async function driveBlocked(env, domain = 'example.com') {
  const br = await waitFor(() => env.events.find((e) => e.type === 'br' && e.route === 'browser'))
  assert.ok(br, '应发出 bridge_request(browser)')
  env.engine.resolveBrowser(br.requestId, {
    ok: false, code: 'whitelist-blocked', data: { domain },
    error: `目标域名不在白名单（默认 *.gov.cn/localhost），已拒绝导航: https://${domain}/`,
  })
  const cr = await waitFor(() => env.events.find((e) => e.type === 'control' && e.toolName === 'browser_whitelist_add'))
  assert.ok(cr, '应发出白名单审批 control_request')
  return cr
}

test('白名单拦截 → 审批事件（toolName/toolUseId 形状）+ 批准 → 提示重试', async () => {
  const env = makeEnv()
  try {
    const resultP = env.engine.runTurn({ content: '[mock:browser]' })
    const cr = await driveBlocked(env, 'example.com')
    assert.equal(cr.toolUseId, 'whitelist:example.com')
    assert.equal(cr.requestId, 'req-whitelist:example.com')
    assert.match(String(cr.input?.command || ''), /example\.com/)
    assert.match(String(cr.reason || ''), /白名单拦截/)
    env.engine.resolveApproval(cr.toolUseId, { behavior: 'allow' })
    const result = await resultP
    assert.ok(String(result.text || '').length > 0, '轮次应正常收尾')
    // 工具结果（live 回传 + transcript）含"已批准 + 请重试"引导
    const tr = env.events.find((e) => e.type === 'tool-result')
    assert.ok(tr, '应有工具结果回传')
    assert.match(String(tr.content), /已批准将「example\.com」加入白名单/)
    assert.match(String(tr.content), /请重试/)
    const transcript = readFileSync(env.session.file, 'utf-8')
    assert.match(transcript, /已批准将「example\.com」加入白名单/, 'transcript 落盘同样文案')
  } finally { env.cleanup() }
})

test('白名单拦截 → 用户拒绝 → 替代途径引导（isError）', async () => {
  const env = makeEnv()
  try {
    const resultP = env.engine.runTurn({ content: '[mock:browser]' })
    const cr = await driveBlocked(env, 'blocked-site.cn')
    env.engine.resolveApproval(cr.toolUseId, { behavior: 'deny', message: 'denied' })
    const result = await resultP
    assert.ok(String(result.text || '').length > 0, '轮次应正常收尾')
    const tr = env.events.find((e) => e.type === 'tool-result')
    assert.equal(tr.isError, true)
    assert.match(String(tr.content), /未批准加入白名单/)
    assert.match(String(tr.content), /WebFetch/)
  } finally { env.cleanup() }
})

test('普通浏览器失败（非白名单拦截）→ 原错误文案不变（零回归）', async () => {
  const env = makeEnv()
  try {
    const resultP = env.engine.runTurn({ content: '[mock:browser]' })
    const br = await waitFor(() => env.events.find((e) => e.type === 'br' && e.route === 'browser'))
    env.engine.resolveBrowser(br.requestId, { ok: false, error: 'executor 未连接' })
    const cr = await waitFor(() => env.events.find((e) => e.type === 'control' && e.toolName === 'browser_whitelist_add'))
    assert.equal(cr, null, '非白名单拦截不得触发审批')
    const result = await resultP
    assert.ok(String(result.text || '').length > 0)
    const tr = env.events.find((e) => e.type === 'tool-result')
    assert.equal(tr.isError, true)
    assert.match(String(tr.content), /executor 未连接/)
  } finally { env.cleanup() }
})

// ── 2026-09-17 修复：假审批与假回执（真实事故回归）────────────────────────────
// 事故经过：agent 用浏览器预览自己生成的 HTML（file:///C:/.../mockup.html）→ 执行器拦截
// 时 hostname 为空串 → 内核把它顶替成中文占位符「该域名」弹审批 → 用户同意 → 写入端对中文
// 静默拒绝 → 内核仍回模型"已批准，请重试" ⇒ 重试、再弹、再同意……无限循环，用户永远打不开。
// 修复后：这类地址**根本不弹审批**（弹了必然白弹），直接给可执行的替代途径。
test('无 hostname 的地址（file:// 类）→ 不弹假审批，直接给替代途径（事故回归）', async () => {
  const env = makeEnv()
  try {
    const resultP = env.engine.runTurn({ content: '[mock:browser]' })
    const br = await waitFor(() => env.events.find((e) => e.type === 'br' && e.route === 'browser'))
    assert.ok(br, '应发出 bridge_request(browser)')
    env.engine.resolveBrowser(br.requestId, {
      ok: false, code: 'whitelist-blocked',
      data: { domain: '', protocol: 'file:', url: 'file:///C:/Users/x/scratch/knowledge-module-mockup.html' },
      error: '目标域名不在白名单（默认 *.gov.cn/localhost），已拒绝导航',
    })
    const result = await resultP
    assert.ok(String(result.text || '').length > 0, '轮次应正常收尾')
    const cr = env.events.find((e) => e.type === 'control' && e.toolName === 'browser_whitelist_add')
    assert.equal(cr, undefined, '**不得**弹审批：写入端只接受合法主机名，弹了必然白弹')
    const tr = env.events.find((e) => e.type === 'tool-result')
    assert.equal(tr.isError, true)
    assert.match(String(tr.content), /无法通过/, '明确告知"加入域名白名单"这条路过不去')
    assert.match(String(tr.content), /knowledge-module-mockup\.html/, '指出具体地址，便于用户理解发生了什么')
    assert.match(String(tr.content), /不要重复重试/, '明确劝阻空转重试（旧行为正是在诱导重试）')
    assert.ok(!String(tr.content).includes('该域名'), '空值顶替的中文占位符不得再出现于文案')
  } finally { env.cleanup() }
})

test('非法主机名（同样不可加白名单）→ 不弹审批且说明原因', async () => {
  const env = makeEnv()
  try {
    const resultP = env.engine.runTurn({ content: '[mock:browser]' })
    const br = await waitFor(() => env.events.find((e) => e.type === 'br' && e.route === 'browser'))
    env.engine.resolveBrowser(br.requestId, {
      ok: false, code: 'whitelist-blocked',
      data: { domain: 'bad host!', protocol: 'https:', url: 'https://bad host!/x' },
    })
    const result = await resultP
    assert.ok(String(result.text || '').length > 0)
    const cr = env.events.find((e) => e.type === 'control' && e.toolName === 'browser_whitelist_add')
    assert.equal(cr, undefined, '非法主机名不得弹审批')
    const tr = env.events.find((e) => e.type === 'tool-result')
    assert.equal(tr.isError, true)
    assert.match(String(tr.content), /无法通过/)
    assert.match(String(tr.content), /不是合法域名/)
  } finally { env.cleanup() }
})

test('批准但写入失败 → 如实告知，不再谎报"已批准请重试"（事故的第二半）', async () => {
  const env = makeEnv()
  try {
    const resultP = env.engine.runTurn({ content: '[mock:browser]' })
    const cr = await driveBlocked(env, 'example.com')
    // bridge 回执带真实写盘结果 false（addBrowserWhitelist 被拒/写盘异常）
    env.engine.resolveApproval(cr.toolUseId, { behavior: 'allow', whitelistWritten: false })
    const result = await resultP
    assert.ok(String(result.text || '').length > 0, '轮次应正常收尾')
    const tr = env.events.find((e) => e.type === 'tool-result')
    assert.equal(tr.isError, true, '写入失败必须标错误（旧实现回 isError:false 并说"请重试"）')
    assert.match(String(tr.content), /写入白名单失败/)
    assert.match(String(tr.content), /仍会被拦截/, '明确说明重试无效')
    assert.ok(!String(tr.content).includes('请重试刚才的浏览器操作'), '不得再诱导模型重试')
  } finally { env.cleanup() }
})

test('批准且写入成功（whitelistWritten=true）→ 维持"已批准请重试"', async () => {
  const env = makeEnv()
  try {
    const resultP = env.engine.runTurn({ content: '[mock:browser]' })
    const cr = await driveBlocked(env, 'fine.example')
    env.engine.resolveApproval(cr.toolUseId, { behavior: 'allow', whitelistWritten: true })
    const result = await resultP
    assert.ok(String(result.text || '').length > 0)
    const tr = env.events.find((e) => e.type === 'tool-result')
    assert.equal(tr.isError, false)
    assert.match(String(tr.content), /已批准将「fine\.example」加入白名单/)
    assert.match(String(tr.content), /请重试/)
  } finally { env.cleanup() }
})
