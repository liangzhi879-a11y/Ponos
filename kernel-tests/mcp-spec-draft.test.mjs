import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildMcpSpecDraft, domainOf, writeMcpSpecDraft } from '../kernel/mcp-spec-draft.mjs'

const NOW = '2026-10-27T12:00:00.000Z'

test('P5c 草稿：域名取 subject，否则回落到 evidence 里的 URL', () => {
  assert.equal(domainOf({ subject: 'API.Example.com' }), 'api.example.com')
  assert.equal(domainOf({ refs: [{ url: 'https://pay.vendor.io/v1/orders' }] }), 'pay.vendor.io')
  assert.equal(domainOf({}), '')
})

test('P5c 草稿：三条硬约束 —— 空凭据槽位 / writeOps:false / 只出草稿不碰 mcp.json', () => {
  const r = buildMcpSpecDraft({ candidate: { subject: 'api.example.com' }, nowIso: NOW })
  assert.equal(r.ok, true)
  assert.equal(r.spec.server.auth.credentialSlot, '', '凭据槽位必须是空值（不复制凭据到第二个文件）')
  assert.equal(r.spec.server.auth.type, 'none')
  assert.equal(r.spec.writeOps, false, '外部系统默认只读，允许写是人的决定')
  assert.equal(r.spec.kind, 'mcp')
  assert.match(r.spec.generatedAt, /^2026-10-27/)
  assert.match(JSON.stringify(r.spec), /drafts?/i.test(JSON.stringify(r.spec)) ? /drafts?/i : /mcp/)
  assert.equal(/'token'|'apiKey'|Bearer/i.test(JSON.stringify(r.spec)), false, '草稿里不许出现任何凭据形态')
})

test('P5c 草稿：evidence 只留 sessionId/seq/url 三字段（不夹带会话正文）', () => {
  const r = buildMcpSpecDraft({
    candidate: { subject: 'd.com', refs: [{ sessionId: 's1', seq: 3, url: 'https://d.com/a', text: '用户正文不该进来' }] },
    nowIso: NOW,
  })
  assert.deepEqual(r.spec.evidence[0], { sessionId: 's1', seq: 3, url: 'https://d.com/a' })
})

test('P5c 落盘：写到 evolution/drafts/mcp-<fp>/spec.json；同名不覆盖', () => {
  const home = mkdtempSync(join(tmpdir(), 'mcp-draft-'))
  const draft = buildMcpSpecDraft({ candidate: { subject: 'api.example.com' }, nowIso: NOW })
  assert.equal(draft.ok, true)

  const first = writeMcpSpecDraft({ home, draft })
  assert.equal(first.ok, true, JSON.stringify(first))
  const onDisk = JSON.parse(readFileSync(first.path, 'utf8'))
  assert.equal(onDisk.kind, 'mcp')
  assert.equal(onDisk.writeOps, false)

  const second = writeMcpSpecDraft({ home, draft })
  assert.equal(second.ok, false)
  assert.equal(second.reason, 'exists', '同一域名重复挖掘不得把人改过的草稿冲掉')
  rmSync(home, { recursive: true, force: true })
})

test('P5c 落盘：目录名白名单（拼错也逃不出 drafts/）；无域名不出草稿', () => {
  const home = mkdtempSync(join(tmpdir(), 'mcp-draft2-'))
  mkdirSync(join(home, 'evolution'), { recursive: true })
  assert.equal(writeMcpSpecDraft({ home, draft: { dirName: '../evil', spec: {} } }).reason, 'bad-dirname')
  assert.equal(writeMcpSpecDraft({ home, draft: { dirName: 'mcp-0123abcd', spec: {} } }).ok, true)
  assert.equal(buildMcpSpecDraft({ candidate: {} }).reason, 'no-domain')
  rmSync(home, { recursive: true, force: true })
})
