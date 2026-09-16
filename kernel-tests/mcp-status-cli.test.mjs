// kernel-tests/mcp-status-cli.test.mjs
// 内核「真实接入状态上报」接线（Task 3/10）：真起内核，断言它确实发出 mcp_status。
//
// 为什么必须单独测这条线（单元测试覆盖不到）：面板顶部显示的"接入 N 个服务器 / 工具全名清单"
// 全部依赖这一个上报。注册表可能有测试、桥的路由也可能有测试，但**"cli.mjs 到底有没有把它接上"
// 只有真起内核才知道** —— 若这行被重构掉，界面会永远停在"内核尚未启动"，
// 而所有单元测试仍然全绿。这正是本批要修的那类"功能没坏但没接线"的沉默失效。
// 参照仓库既有先例 anchor-applied-cli.test.mjs（同款 spawn + 等事件范式）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadMcpServers, mcpConfigSig } from '../kernel/mcp.mjs'

const KERNEL_CLI = fileURLToPath(new URL('../kernel/cli.mjs', import.meta.url))
const STUB = fileURLToPath(new URL('./fixtures/mcp-stub-server.mjs', import.meta.url))
const STUB_TOOLS = 5   // 桩服务器暴露 echo / boom / hang / die / plain

/** 起内核（mock API，无网络无费用），返回事件收集器；事件按 NDJSON 逐行解析（一行可能被切两半） */
function spawnKernel(home) {
  const proc = spawn(process.execPath, [KERNEL_CLI, '--print', '--output-format', 'stream-json',
    '--input-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', '--add-dir', home], {
    env: { ...process.env, PONOS_MOCK_API: '1', PONOS_CONFIG_DIR: home, YFW_HOME: home },
    cwd: home, stdio: ['pipe', 'pipe', 'pipe'],
  })
  const events = []
  let buf = ''
  let stderr = ''
  proc.stdout.on('data', (d) => {
    buf += d
    const lines = buf.split('\n'); buf = lines.pop()
    for (const l of lines) { if (!l.trim()) continue; try { events.push(JSON.parse(l)) } catch { /* 半行 */ } }
  })
  proc.stderr.on('data', (d) => stderr += d)
  return { proc, events, stderr: () => stderr }
}

async function waitFor(k, pred, timeoutMs) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const hit = k.events.find(pred)
    if (hit) return hit
    if (k.proc.exitCode !== null) break
    await new Promise((r) => setTimeout(r, 100))
  }
  return null
}

test('内核启动后发出 mcp_status：接入总数、工具全名、失败与关闭清单、可比的配置签名', { timeout: 90000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'yfw-mcp-status-'))
  const servers = {
    pub: { command: process.execPath, args: [STUB], timeoutMs: 15000, expose: { mode: 'public' } },
    priv: { command: process.execPath, args: [STUB], timeoutMs: 15000, expose: { mode: 'private' } },
    bnd: { command: process.execPath, args: [STUB], timeoutMs: 15000, expose: { mode: 'bound', bindAgents: ['researcher'] } },
    off: { enabled: false },                                          // 关闭的占位条目（界面据此显示"已关闭"）
    bad: { command: 'definitely-not-real-xyz-987', timeoutMs: 5000 }, // 失败隔离
  }
  writeFileSync(join(home, 'mcp.json'), JSON.stringify({ servers }, null, 2), 'utf-8')
  const k = spawnKernel(home)
  try {
    const ev = await waitFor(k, (e) => e?.type === 'system' && e?.subtype === 'mcp_status', 60_000)
    assert.ok(ev, `内核未发出 mcp_status ⇒ 面板会永远显示"内核尚未启动"。stderr 尾部：${k.stderr().slice(-500)}`)

    // 事件即快照（桥直接缓存整条事件，故字段必须在**顶层**——前端与桥读的是同一份形状）
    assert.ok(ev.servers && typeof ev.servers === 'object', 'servers 应在事件顶层（桥与前端读同一份形状）')
    assert.deepEqual(Object.keys(ev.servers).sort(), ['bnd', 'priv', 'pub'],
      '三台启用的服务器都要被发现（发现阶段不做可见性过滤：面板要能展示"台子上有什么"）')
    for (const n of ['pub', 'priv', 'bnd']) {
      assert.equal(ev.servers[n].tools.length, STUB_TOOLS, `${n} 应发现 ${STUB_TOOLS} 个工具`)
      // 工具全名是"调用入口"的可见证据：界面要能把这些名字显示给用户
      assert.ok(ev.servers[n].tools.every((t) => t.startsWith(`mcp__${n}__`)),
        `${n} 的工具名应以 mcp__${n}__ 前缀（实际：${ev.servers[n].tools.join(',')}）`)
    }
    assert.equal(ev.servers.pub.expose, 'public')
    assert.equal(ev.servers.priv.expose, 'private')
    assert.equal(ev.servers.bnd.expose, 'bound')

    assert.deepEqual(ev.disabled, ['off'], '关闭的服务器要进 disabled（面板"已关闭"清单靠它）')
    assert.ok(ev.failed?.bad, '坏命令要进 failed 并带原因（面板显示"启动失败：…"）')
    assert.equal(ev.failed.off, undefined,
      '关闭的服务器**不得**出现在 failed —— 那是"试了没成"，说明它被尝试连接了（关闭必须是"根本不连接"）')

    // 签名可比对上"磁盘现状"：桥据此把 stale 判成"配置比内核新"，即"下一条消息生效"
    const expectSig = mcpConfigSig(loadMcpServers(join(home, 'mcp.json')))
    assert.equal(ev.configSig, expectSig,
      '签名必须等于按同一份配置算出的值，否则界面会永远显示"待生效"（永远提示"下一条消息生效"）')
  } finally {
    try { k.proc.kill() } catch { /* 已退出 */ }
    await new Promise((r) => setTimeout(r, 500))
    rmSync(home, { recursive: true, force: true })
  }
})
