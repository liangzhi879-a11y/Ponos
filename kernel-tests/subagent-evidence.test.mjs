// 跨 Agent 证据面测试（mock API，无网络）
// ---------------------------------------------------------------------------
// 覆盖：Edit 计入产物、reads 采集与限量回传、lane transcript 可被 Read 展开。
// 与 subagent.test.mjs 分开：本文件需要**独立于会话目录的 configDir 布局**
// （transcript 落在会话目录之外，越界/放行才有区分度）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEngine } from '../kernel/engine.mjs'
import { createSessionStore } from '../kernel/session.mjs'
import { makeWire } from '../kernel/protocol.mjs'

process.env.PONOS_MOCK_API = '1'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const extractTaskId = (content) => String(content).match(/task_id: ([0-9a-f-]+)/)?.[1]

// 与 subagent.test.mjs 的 makeEnv 关键差异：**configDir 不在 addDirs 内**。
// 这样 lane transcript（<configDir>/projects/<cwd>/<taskId>.jsonl）落在会话目录之外，
// "未放行 ⇒ 越界 / 放行 ⇒ 可读"才有区分度（若 configDir 在会话目录内，测试恒通过、测不出东西）。
// 对照既有 subagent.test.mjs:32-45 —— 它是 dir = mkdtempSync(...)；configDir = join(dir,'home')；
// cwd: dir；addDirs: [dir] ⇒ laneFile 落在 dir/home/... ，**本就在 addDirs 内**，故既有测试
// 无法验证跨出边界的情形。本文件必须分离 work / home 两个目录，这是不能照抄它的原因。
function makeEnv() {
  const events = []
  const wire = makeWire({ write(s) { events.push(JSON.parse(s)) } })
  const root = mkdtempSync(join(tmpdir(), 'ponos-evidence-'))
  const workDir = join(root, 'work')
  const configDir = join(root, 'home')
  mkdirSync(workDir, { recursive: true })
  const store = createSessionStore({ configDir, cwd: workDir, sessionId: 'main-session' })
  const engine = createEngine({
    opts: { model: 'mock-model', configDir, addDirs: [workDir], skipPermissions: true },
    wire,
    session: store,
  })
  engine.setSystemPrompt('你是 Ponos-turbo 测试内核。')
  const laneFile = (taskId) => join(configDir, 'projects', workDir.replace(/[^a-zA-Z0-9]/g, '-'), `${taskId}.jsonl`)
  const waitNotif = async (taskId, timeoutMs = 8000, nth = 1) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const ns = events.filter((e) => e.type === 'system' && e.subtype === 'task_notification' && e.task_id === taskId)
      if (ns.length >= nth) return ns[nth - 1]
      await sleep(10)
    }
    return null
  }
  return { events, engine, store, root, workDir, configDir, laneFile, waitNotif, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('Edit 产物计入 outputs（原先只认 Write）', async () => {
  const env = makeEnv()
  const prev = process.env.PONOS_MOCK_WRITE_DIR
  try {
    process.env.PONOS_MOCK_WRITE_DIR = env.workDir
    // Edit 需要目标文件已存在（Edit 是"先读后改"，old_string 必须精确命中）
    writeFileSync(join(env.workDir, 'mock-c.txt'), 'old\n', 'utf-8')
    const r = await env.engine.spawnSubAgent(
      { subagent_type: 'general-purpose', prompt: '[mock:edit]', run_in_background: true },
      { toolUseId: 'tool_use_ev_1' },
    )
    const taskId = extractTaskId(r.content)
    assert.ok(taskId)
    const n = await env.waitNotif(taskId)
    assert.ok(n, '完成通知应到达')
    // Edit 的目标文件必须进 outputs（改造前恒为空数组）
    assert.deepEqual(n.outputs, [`${env.workDir}/mock-c.txt`])
  } finally {
    if (prev === undefined) delete process.env.PONOS_MOCK_WRITE_DIR
    else process.env.PONOS_MOCK_WRITE_DIR = prev
    env.cleanup()
  }
})
