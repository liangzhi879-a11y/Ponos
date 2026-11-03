// 演化 P1：只读归因视图的接线测试（runReadonly 路由 + 三源归并）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { runReadonly } from '../kernel/readonly.mjs'

const NOW = Date.parse('2026-10-27T12:00:00.000Z')
const TS = '2026-10-26T10:00:00.000Z'

function seed() {
  const home = mkdtempSync(join(tmpdir(), 'ponos-attr-'))
  mkdirSync(join(home, 'journal'), { recursive: true })
  mkdirSync(join(home, 'projects', 'proj-1'), { recursive: true })
  // journal：一条 detect（detail 是错误文本）
  writeFileSync(join(home, 'journal', '2026-10-26.ndjson'), JSON.stringify({
    at: TS, kind: 'detect', ok: false, detail: "写入失败：ENOENT: no such file, open 'C:\\a\\b.mjs'",
  }) + '\n')
  // 转录：同错误（不同路径 ⇒ 同 fp）
  const row = {
    timestamp: TS,
    message: { content: [{ type: 'tool_result', is_error: true, content: [{ type: 'text', text: "写入失败：ENOENT: no such file, open 'D:\\x\\y.mjs'" }] }] },
  }
  writeFileSync(join(home, 'projects', 'proj-1', 'sess-1.jsonl'), JSON.stringify(row) + '\n')
  return home
}

test('runReadonly(evolution-attribution)：两源同一错误并成一条，count=2', () => {
  const home = seed()
  const { output, code } = runReadonly({ mode: 'evolution-attribution', args: { window: '30d' }, configDir: home })
  assert.equal(code, 0)
  assert.equal(output.items.length, 1, '两源同错应并成 1 条')
  const item = output.items[0]
  assert.equal(item.count, 2)
  assert.deepEqual([...new Set(item.origin.map((o) => o.src))].sort(), ['journal', 'transcript'])
  assert.equal(typeof output.dropped, 'object')
})

test('runReadonly：未知子命令仍返回 code=1（新分支不吞旧行为）', () => {
  const { code } = runReadonly({ mode: 'nope', args: {}, configDir: seed() })
  assert.equal(code, 1)
})

test('CLI 源码：--evolution-attribution 必须**显式登记**（否则静默忽略）', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'kernel', 'cli.mjs'), 'utf8')
  assert.match(src, /evolutionAttribution:\s*false/)
  assert.match(src, /'--evolution-attribution'/)
})
