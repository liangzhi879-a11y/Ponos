import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  sanitizePathSegment,
  isUuidFile,
  listSessions,
  loadTranscript,
  searchTranscripts,
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
    // 显式设置不同 mtime，避免同毫秒写入导致排序不稳定（与 searchTranscripts 用例同法）
    const t0 = new Date('2026-08-15T00:00:00Z')
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

  test('文件不存在返回 { ok:false, error:not found }', (t) => {
    const { root } = makeProjects(t)
    const r = loadTranscript(root, 'C:\\Users\\t\\demo-project', '00000000-0000-4000-8000-000000000000')
    assert.deepEqual(r, { ok: false, error: 'not found' })
  })

  test('非法 sessionId 拒绝', (t) => {
    const { root } = makeProjects(t)
    assert.deepEqual(loadTranscript(root, '/x', 'not-a-uuid'), { ok: false, error: 'invalid sessionId' })
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
