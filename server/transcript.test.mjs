import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync, existsSync, readdirSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'node:url'
import {
  sanitizePathSegment,
  isUuidFile,
  listSessions,
  loadTranscript,
  searchTranscripts,
  createTranscriptHandlers,
} from './transcript.mjs'

const UUID = '04ddb4e5-13dd-46fe-9cd0-d018e61f2030'
const mk = (d, name, content) => writeFileSync(join(d, name), content, 'utf-8')

/** 构造临时 projects 根目录，返回 { dir, projectDir }；afterEach 清理。 */
function makeProjects(t) {
  const root = mkdtempSync(join(tmpdir(), 'transcript-test-'))
  const proj = join(root, sanitizePathSegment('C:\\Users\\t\\demo-project'))
  mkdirSync(proj, { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, proj }
}

function entry(type, over = {}) {
  return JSON.stringify({ type, sessionId: UUID, timestamp: '2026-08-15T02:12:00.000Z', parentUuid: null, ...over })
}

describe('sanitizePathSegment（内核同款）', () => {
  test('非字母数字替换为 -，普通路径不变形', () => {
    assert.equal(sanitizePathSegment('C:\\Users\\t\\demo-project'), 'C--Users-t-demo-project')
    assert.equal(sanitizePathSegment('plugin:name:server'), 'plugin-name-server')
  })

  test('中文与特殊符号全部替换为 -', () => {
    assert.equal(sanitizePathSegment('中文 路径！'), '------')
  })

  test('超过 200 字符截断前 200 + md5 hash 后缀', () => {
    const long = 'a'.repeat(300)
    const s = sanitizePathSegment(long)
    assert.equal(s.length, 200 + 1 + 12) // 200 + '-' + 12 hex
    assert.equal(s.slice(0, 200), 'a'.repeat(200))
    assert.match(s.slice(201), /^[0-9a-f]{12}$/)
  })

  test('短路径不截断不带 hash', () => {
    const s = sanitizePathSegment('short')
    assert.equal(s, 'short')
  })
})

describe('isUuidFile', () => {
  test('合法 uuid.jsonl 通过', () => {
    assert.ok(isUuidFile(`${UUID}.jsonl`))
    assert.ok(isUuidFile('10EA71F3-BD14-4EAD-9281-5742C2DDE014.jsonl')) // 大写也接受（内核 /i）
  })

  test('非法名拒绝', () => {
    assert.ok(!isUuidFile('not-a-uuid.jsonl'))
    assert.ok(!isUuidFile('ab'.repeat(18) + '.jsonl')) // 非 uuid 格式
    assert.ok(!isUuidFile('random-name.txt'))
    assert.ok(!isUuidFile('subagent.jsonl'))
  })
})

describe('listSessions', () => {
  test('只返回 uuid.jsonl，忽略子目录/非 uuid，按 mtime 倒序', (t) => {
    const { root, proj } = makeProjects(t)
    const id1 = '11111111-1111-4111-8111-111111111111'
    const id2 = '22222222-2222-4222-8222-222222222222'
    mk(proj, `${id1}.jsonl`, entry('user'))
    mk(proj, `${id2}.jsonl`, entry('user'))
    mk(proj, 'not-uuid.jsonl', entry('user'))
    mkdirSync(join(proj, `${id1}`)) // 同名子目录（subagent），必须忽略
    // 显式 mtime 消除同 tick 写入的排序竞态（Windows 时钟粒度下自然 mtime 可能相等
    // → 读序不稳定；与下方 mtime 排序测试同款 utimesSync 惯例。id2 更新 → 应排前）
    const t0 = new Date('2026-08-15T02:12:00.000Z')
    utimesSync(join(proj, `${id1}.jsonl`), t0, t0)
    utimesSync(join(proj, `${id2}.jsonl`), new Date(t0.getTime() + 1000), new Date(t0.getTime() + 1000))

    const res = listSessions(root, 'C:\\Users\\t\\demo-project')
    assert.equal(res.length, 2)
    assert.deepEqual(res.map(s => s.sessionId), [id2, id1]) // 后写的 id2 mtime 更新
    assert.ok(res[0].size > 0)
    assert.match(res[0].mtime, /^\d{4}-\d{2}-\d{2}T/)
    assert.equal(res[0].cwd, 'C:\\Users\\t\\demo-project')
  })

  test('项目目录不存在返回空数组', () => {
    assert.deepEqual(listSessions(join(tmpdir(), 'no-such-dir'), '/x'), [])
  })
})

describe('loadTranscript', () => {
  test('正常读取原始 entry（不做转换）', (t) => {
    const { root, proj } = makeProjects(t)
    const l1 = entry('user', { uuid: 'u1', message: { role: 'user', content: '你好' } })
    const l2 = entry('assistant', { parentUuid: 'u1', uuid: 'u2', message: { role: 'assistant', content: [{ type: 'text', text: '你好！' }] } })
    mk(proj, `${UUID}.jsonl`, l1 + '\n' + l2 + '\n')

    const r = loadTranscript(root, 'C:\\Users\\t\\demo-project', UUID)
    assert.equal(r.ok, true)
    assert.equal(r.truncated, false)
    assert.equal(r.skipped, 0)
    assert.equal(r.entries.length, 2)
    assert.equal(r.entries[0].type, 'user')
    assert.equal(r.entries[0].message.content, '你好') // 原样保留
    assert.equal(r.entries[1].message.content[0].text, '你好！')
  })

  test('跳过空行/损坏行并计数 skipped', (t) => {
    const { root, proj } = makeProjects(t)
    mk(proj, `${UUID}.jsonl`, entry('user') + '\n\n{broken json\n' + entry('system') + '\n')

    const r = loadTranscript(root, 'C:\\Users\\t\\demo-project', UUID)
    assert.equal(r.ok, true)
    assert.equal(r.entries.length, 2)
    assert.equal(r.skipped, 1)
  })

  test('tailFirst：>5MB 只读尾部，truncated=true 且保留最近 entry', (t) => {
    const { root, proj } = makeProjects(t)
    const head = entry('user', { uuid: 'old' }) + '\n'
    const tail = entry('assistant', { parentUuid: 'new-parent', uuid: 'latest' }) + '\n'
    const filler = 'x'.repeat(5 * 1024 * 1024) // 5MB 单行（占位，会被丢弃或留尾）
    mk(proj, `${UUID}.jsonl`, head + filler + '\n' + tail)

    const r = loadTranscript(root, 'C:\\Users\\t\\demo-project', UUID, true)
    assert.equal(r.ok, true)
    assert.equal(r.truncated, true)
    assert.ok(r.entries.length >= 1)
    assert.equal(r.entries[r.entries.length - 1].uuid, 'latest') // 最近的 entry 保留
  })

  test('tailFirst=0 全量读取不截断', (t) => {
    const { root, proj } = makeProjects(t)
    const head = entry('user', { uuid: 'old' }) + '\n'
    mk(proj, `${UUID}.jsonl`, head + 'x'.repeat(5 * 1024 * 1024) + '\n')

    const r = loadTranscript(root, 'C:\\Users\\t\\demo-project', UUID, false)
    assert.equal(r.ok, true)
    assert.equal(r.truncated, false)
    assert.equal(r.entries.length, 1) // 大 filler 行也完整保留（无损坏）
  })

  test('自愈注入过滤（2026-09-11）：展示路径隐藏【系统】/【提示】user 注入，导出路径保留原文', (t) => {
    const { root, proj } = makeProjects(t)
    const l1 = entry('user', { uuid: 'u1', message: { role: 'user', content: '你好' } })
    const heal = entry('user', { uuid: 'h1', message: { role: 'user', content: '【系统】检测到你长时间没有实质进展…' } })
    const remind = entry('user', { uuid: 'h2', message: { role: 'user', content: '【提示】你已连续 3 次调用同一工具…' } })
    const toolResult = entry('user', { uuid: 'tr1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } })
    const stopText = entry('assistant', { parentUuid: 'h2', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: '【检测到…已自动收尾】' }] } })
    mk(proj, `${UUID}.jsonl`, [l1, heal, remind, toolResult, stopText].join('\n') + '\n')

    // 展示路径（默认）：自愈注入被隐藏，其余保留（含最后的可见收尾说明）
    const r = loadTranscript(root, 'C:\\Users\\t\\demo-project', UUID)
    assert.equal(r.ok, true)
    assert.equal(r.hidden, 2, '【系统】+【提示】注入各 1 条被隐藏')
    assert.equal(r.entries.length, 3)
    assert.deepEqual(r.entries.map((e) => e.uuid), ['u1', 'tr1', 'a1'], '用户消息/tool_result/assistant 收尾说明保留')
    // tool_result 为数组 content 不受前缀规则影响；assistant 收尾说明保持可见

    // 导出路径（tailFirst=false）：全量原文（含自愈注入）
    const full = loadTranscript(root, 'C:\\Users\\t\\demo-project', UUID, false)
    assert.equal(full.hidden, 0)
    assert.equal(full.entries.length, 5)
  })

  test('文件不存在返回 { ok:false, error:not found }', (t) => {
    const { root } = makeProjects(t)
    const r = loadTranscript(root, 'C:\\Users\\t\\demo-project', '00000000-0000-4000-8000-000000000000')
    assert.deepEqual(r, { ok: false, error: 'not found' })
  })

  test('非法 sessionId 拒绝', (t) => {
    const { root } = makeProjects(t)
    assert.deepEqual(loadTranscript(root, '/x', 'not-a-uuid'), { ok: false, error: 'invalid sessionId' })
  })

  test('chat 模式兜底：空 cwd 未命中时跨项目目录找到 transcript', (t) => {
    const { root } = makeProjects(t)
    // 模拟内核 chat 模式：会话写在 YFW_HOME 派生目录，而 GUI 请求带空 cwd
    const homeLike = join(root, sanitizePathSegment('C:\\Users\\t\\.yfw'))
    mkdirSync(homeLike, { recursive: true })
    mk(homeLike, `${UUID}.jsonl`, entry('user', { uuid: 'u1', message: { role: 'user', content: 'chat 历史' } }) + '\n')
    const r = loadTranscript(root, '', UUID)
    assert.equal(r.ok, true, '空 cwd 兜底命中')
    assert.equal(r.entries.length, 1)
    assert.equal(r.entries[0].uuid, 'u1')
    // 非空但错误的 cwd 同样兜底
    const r2 = loadTranscript(root, 'C:\\Users\\t\\other-proj', UUID)
    assert.equal(r2.ok, true, '错误 cwd 兜底命中')
    assert.equal(r2.entries.length, 1)
  })

  test('兜底也覆盖 projects 根目录下的 transcript（cwd 为空串的内核产物）', (t) => {
    const { root } = makeProjects(t)
    mk(root, `${UUID}.jsonl`, entry('assistant', { uuid: 'a1', message: { role: 'assistant', content: 'root 级会话' } }) + '\n')
    const r = loadTranscript(root, '', UUID)
    assert.equal(r.ok, true)
    assert.equal(r.entries.length, 1)
    assert.equal(r.entries[0].uuid, 'a1')
  })

  test('兜底多处命中取 mtime 最新者', (t) => {
    const { root, proj } = makeProjects(t)
    const other = join(root, sanitizePathSegment('D:\\newer\\proj'))
    mkdirSync(other, { recursive: true })
    const oldTs = new Date('2026-01-01T00:00:00Z')
    const newTs = new Date('2026-06-01T00:00:00Z')
    mk(proj, `${UUID}.jsonl`, entry('user', { uuid: 'old', message: { role: 'user', content: '旧' } }) + '\n')
    utimesSync(join(proj, `${UUID}.jsonl`), oldTs, oldTs)
    mk(other, `${UUID}.jsonl`, entry('user', { uuid: 'new', message: { role: 'user', content: '新' } }) + '\n')
    utimesSync(join(other, `${UUID}.jsonl`), newTs, newTs)
    const r = loadTranscript(root, 'C:\\nowhere\\else', UUID)
    assert.equal(r.ok, true)
    assert.deepEqual(r.entries.map((e) => e.uuid), ['new'], '取 mtime 最新')
  })

  test('兜底全盘未命中仍返回 not found（含空 cwd）', (t) => {
    const { root } = makeProjects(t)
    assert.deepEqual(loadTranscript(root, '', '00000000-0000-4000-8000-000000000000'), { ok: false, error: 'not found' })
  })
})

describe('searchTranscripts', () => {
  test('跨项目内容子串匹配，大小写不敏感，返回 snippet/matchCount', (t) => {
    const { root, proj } = makeProjects(t)
    mk(proj, `${UUID}.jsonl`, entry('user', { uuid: 'u1', message: { role: 'user', content: '前文 YFW_DEMO_KEYWORD 后文' } }) + '\n')
    const proj2 = join(root, sanitizePathSegment('D:\\other\\proj'))
    mkdirSync(proj2, { recursive: true })
    mk(proj2, '55555555-5555-4555-8555-555555555555.jsonl', entry('user', { message: { role: 'user', content: '无关键字的会话' } }) + '\n')

    const res = searchTranscripts(root, 'yfw_demo_keyword') // 小写 query 命中大写内容
    assert.equal(res.length, 1)
    assert.equal(res[0].projectCwd, sanitizePathSegment('C:\\Users\\t\\demo-project'))
    assert.equal(res[0].sessionId, UUID)
    assert.equal(res[0].matchCount, 1)
    assert.match(res[0].snippet, /YFW_DEMO_KEYWORD/)
    assert.match(res[0].mtime, /^\d{4}-\d{2}-\d{2}T/)
  })

  test('空 query 或目录不存在返回空数组', (t) => {
    const { root, proj } = makeProjects(t)
    mk(proj, `${UUID}.jsonl`, entry('user') + '\n')
    assert.deepEqual(searchTranscripts(root, ''), [])
    assert.deepEqual(searchTranscripts(root, '   '), [])
    assert.deepEqual(searchTranscripts(join(tmpdir(), 'no-such'), 'x'), [])
  })

  test('limit 生效且按 mtime 倒序', (t) => {
    const { root, proj } = makeProjects(t)
    const idA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const idB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const idC = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    mk(proj, `${idA}.jsonl`, entry('user', { message: { role: 'user', content: 'hit keyword' } }) + '\n')
    mk(proj, `${idB}.jsonl`, entry('user', { message: { role: 'user', content: 'hit keyword' } }) + '\n')
    mk(proj, `${idC}.jsonl`, entry('user', { message: { role: 'user', content: 'hit keyword' } }) + '\n')
    // 显式设置不同 mtime，避免同毫秒写入导致排序不稳定
    const t0 = new Date('2026-08-15T00:00:00Z')
    utimesSync(join(proj, `${idA}.jsonl`), t0, t0)
    utimesSync(join(proj, `${idB}.jsonl`), new Date(t0.getTime() + 1000), new Date(t0.getTime() + 1000))
    utimesSync(join(proj, `${idC}.jsonl`), new Date(t0.getTime() + 2000), new Date(t0.getTime() + 2000))

    const res = searchTranscripts(root, 'keyword', { limit: 2 })
    assert.equal(res.length, 2)
    // mtime 倒序：后写的在前
    assert.equal(res[0].sessionId, idC)
    assert.equal(res[1].sessionId, idB)
  })

  test('大文件（>10MB）只搜前 1MB + 尾 1MB，命中尾部 keyword', (t) => {
    const { root, proj } = makeProjects(t)
    const head = entry('user', { uuid: 'head' }) + '\n'
    const tailKw = 'LARGE_FILE_KEYWORD'
    mk(proj, `${UUID}.jsonl`, head + 'x'.repeat(12 * 1024 * 1024) + '\n' + entry('user', { message: { role: 'user', content: tailKw } }) + '\n')

    const res = searchTranscripts(root, tailKw)
    assert.equal(res.length, 1)
    assert.match(res[0].snippet, new RegExp(tailKw))
  })

  test('忽略 uuid 子目录（subagent 目录不搜）', (t) => {
    const { root, proj } = makeProjects(t)
    mk(proj, `${UUID}.jsonl`, entry('user', { message: { role: 'user', content: 'hit me' } }) + '\n')
    mkdirSync(join(proj, UUID)) // 子目录里也放同内容文件，不应被搜到
    mk(join(proj, UUID), 'sub.jsonl', entry('user', { message: { role: 'user', content: 'hit me' } }) + '\n')

    const res = searchTranscripts(root, 'hit')
    assert.equal(res.length, 1)
    assert.equal(res[0].sessionId, UUID)
  })
})

// ---------------------------------------------------------------------------
// 会话删除的磁盘清理（2026-09-16）：deleteTranscript / createTranscriptHandlers
// ---------------------------------------------------------------------------
// 背景：GUI 删会话此前只清 localStorage 兜底键，磁盘转录永远留着（本机实测 2.3G/72 项目目录）。
// 删除是本模块首个**写**动作，所以下面重点覆盖"删不到 / 删多 / 删错"三类失败。
describe('deleteTranscript（会话删除的磁盘清理）', () => {
  const CWD = 'C:\\Users\\t\\demo-project'
  const OTHER_ID = '99999999-9999-4999-8999-999999999999'

  test('删已存在的转录：文件消失，空掉的项目目录也被移除', (t) => {
    const { root, proj } = makeProjects(t)
    mk(proj, `${UUID}.jsonl`, entry('user') + '\n')
    assert.ok(existsSync(join(proj, `${UUID}.jsonl`)))

    const r = createTranscriptHandlers(root).deleteTranscript(UUID, CWD)
    assert.deepEqual(r, { deleted: true, reason: 'deleted' })
    assert.ok(!existsSync(join(proj, `${UUID}.jsonl`)), '转录文件必须真的消失')
    assert.ok(!existsSync(proj), '删空后的项目目录（空壳垃圾）也应被收掉')
  })

  test('删不存在的转录：not-found 且不抛异常', (t) => {
    const { root } = makeProjects(t)
    const api = createTranscriptHandlers(root)
    let r
    assert.doesNotThrow(() => { r = api.deleteTranscript(OTHER_ID, CWD) }, 'IO 失败路径不得抛异常')
    assert.deepEqual(r, { deleted: false, reason: 'not-found' })
    // 项目目录根本不存在时同样只是 not-found（不 mkdir、不抛）
    assert.doesNotThrow(() => { r = api.deleteTranscript(OTHER_ID, 'C:\\nowhere\\gone') })
    assert.deepEqual(r, { deleted: false, reason: 'not-found' })
  })

  test('非法 sessionId 一律拒绝，且同目录其它文件完好无损', (t) => {
    const { root, proj } = makeProjects(t)
    mk(proj, `${UUID}.jsonl`, entry('user') + '\n')
    mk(proj, 'not-uuid.jsonl', entry('user') + '\n') // 非 UUID 命名的文件（不该被任何调用误删）
    const api = createTranscriptHandlers(root)

    for (const bad of ['../x', 'abc', '', '../../etc/passwd']) {
      const r = api.deleteTranscript(bad, CWD)
      assert.deepEqual(r, { deleted: false, reason: 'invalid-id' }, `sessionId=${JSON.stringify(bad)} 必须被拒绝`)
      // 显式断言：目录内其它文件一个都不能少
      assert.ok(existsSync(join(proj, `${UUID}.jsonl`)), `非法 id（${bad}）不得连带删除合法转录`)
      assert.ok(existsSync(join(proj, 'not-uuid.jsonl')), `非法 id（${bad}）不得删除非 UUID 文件`)
      assert.deepEqual(readdirSync(proj).sort(), [`${UUID}.jsonl`, 'not-uuid.jsonl'].sort())
    }
  })

  test('恶意 cwd 无法越出 base：base 之外的文件一个都不动', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'transcript-test-'))
    const base = join(root, 'projects')
    const outside = join(root, 'outside')
    mkdirSync(base, { recursive: true })
    mkdirSync(outside, { recursive: true })
    t.after(() => rmSync(root, { recursive: true, force: true }))
    // base 之外放一个与 sessionId 同名的文件：删除路径一旦可穿越，被删的就是它
    mk(outside, `${UUID}.jsonl`, entry('user') + '\n')

    const api = createTranscriptHandlers(base)
    for (const evilCwd of ['..', '../..', '../../outside', 'C:\\..\\..\\outside', outside, '..\\..\\outside']) {
      const r = api.deleteTranscript(UUID, evilCwd)
      assert.equal(r.deleted, false, `恶意 cwd=${evilCwd} 不得删掉任何文件`)
      // sanitizePathSegment 把分隔符/点全部换成 '-'，穿越目标必然落在 base 内（故这里是 not-found）；
      // deleteTranscript 内的 resolve+relative 出口校验是第二道闸（sanitize 行为变化时兜底），
      // 其 'outside-base' 分支无法经公开 API 触达，此处以"base 之外零改动"为该闸的可观测保证。
      assert.equal(r.reason, 'not-found')
    }
    assert.ok(existsSync(join(outside, `${UUID}.jsonl`)), 'base 之外的转录必须完好')
    assert.deepEqual(readdirSync(outside), [`${UUID}.jsonl`], 'base 之外目录内容必须一字未变')
    assert.deepEqual(readdirSync(base), [], 'base 内也没被误建/误删')
  })

  test('同目录两个转录只删其一：另一个必须还在（防"删多"）', (t) => {
    const { root, proj } = makeProjects(t)
    mk(proj, `${UUID}.jsonl`, entry('user') + '\n')
    mk(proj, `${OTHER_ID}.jsonl`, entry('user') + '\n')

    const r = createTranscriptHandlers(root).deleteTranscript(UUID, CWD)
    assert.deepEqual(r, { deleted: true, reason: 'deleted' })
    assert.ok(!existsSync(join(proj, `${UUID}.jsonl`)))
    assert.ok(existsSync(join(proj, `${OTHER_ID}.jsonl`)), '同目录另一个会话不得被连带删除')
    assert.ok(existsSync(proj), '目录非空 → 不得 rmdir')
    // 删剩的那个仍可正常读取（删除没有破坏同目录其它会话）
    assert.equal(loadTranscript(root, CWD, OTHER_ID).ok, true)
  })
})

// ---------------------------------------------------------------------------
// 删除链路的源码守卫（防接线被改回"只删本地"或删错 id）
// ---------------------------------------------------------------------------
// 为什么静态断言：这条链跨 renderer(chatStore) → bridge → transcript.mjs 三段，中间两段
// 需要起 bridge/浏览器才能真正跑；而失效形态是**静默**的（删不掉 / 删错文件），
// 故按本仓库既有做法（kernel-tests/knowledge-scope-plumbing.test.mjs）用源码文本锁住接线。
// 本仓库约定：源码级断言前必须先剥注释，否则注释里的示例文字会造成假红。
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  // 行注释：前置字符不能是 ' / " / \（排除 https:// 与转义），保留前置字符本身
  .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1')

const readSrc = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

describe('删除链路源码守卫', () => {
  test('chatStore.deleteConversation 用 conversation.sessionId（绝不用 GUI 的 conversation.id）', () => {
    const raw = readSrc('../src/stores/chatStore.ts')
    // 那句误导性注释必须已被改掉（它当初就是这个泄漏的书面理由）：assert 的是旧注释原文
    // "ext 兜底键（transcript 随内核保留，不在此清理）"——新注释里对该结论的历史引用不受影响。
    assert.ok(!raw.includes('ext 兜底键（transcript 随内核保留'), '旧的"不清理磁盘转录"注释必须已被更正')
    const code = stripComments(raw)
    assert.ok(
      code.split('\n').some((l) => l.includes("from '@/lib/transcriptLoader'") && l.includes('deleteTranscriptRemote')),
      '必须从 transcriptLoader 引入 deleteTranscriptRemote（既有请求桥写法，不新造 fetch）'
    )
    const start = code.indexOf('deleteConversation: (id) => {')
    assert.ok(start >= 0, '找不到 deleteConversation 起点：若已重构，请同步更新本守卫')
    const end = code.indexOf('setActiveConversation: (id) => {', start)
    assert.ok(end > start, 'deleteConversation 块的结束锚点缺失')
    const block = code.slice(start, end)
    assert.match(block, /deleteTranscriptRemote\(\s*[^)]*sessionId/, '删磁盘必须用内核 sessionId')
    assert.doesNotMatch(block, /deleteTranscriptRemote\(\s*[^)]*\bid\b/,
      '不得把 GUI 的 conversation.id 当内核 sessionId 传给删除接口（两套 id，传错只会 not-found）')
    assert.match(block, /if\s*\([^)]*\.sessionId\s*\)/, 'sessionId 缺失（历史会话）时必须跳过，不得猜测路径')
    assert.match(block, /\.catch\(\(\) => \{\}\)/, 'fire-and-forget：删除失败不得冒泡成未处理拒绝')
  })

  test('bridge /transcript/delete 带"会话仍在运行"守卫（否则删了会被内核立刻重建）', () => {
    const code = stripComments(readSrc('../server/bridge.mjs'))
    assert.match(code, /url\.pathname === '\/transcript\/delete'/, '端点必须存在')
    const at = code.indexOf("=== '/transcript/delete'")
    const block = code.slice(at, at + 1500)
    assert.match(block, /sessions\.has\(\s*sessionId\s*\)/, '运行中的会话（sessions.has）必须拒绝删除转录')
    assert.match(block, /transcriptApi\.deleteTranscript\(/, '必须真的调用 deleteTranscript')
    assert.match(block, /409/, '拒绝要用 409 表达"状态冲突"，让前端可区分"没找到/非法"')
  })
})
