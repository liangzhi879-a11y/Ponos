// Task 4b 守卫扫描（本仓既有同类做法）：引擎**发**两帧、且两帧不进 transcript。
// 行为验证留到前端联调（T6/T7）与手测（T11）；此处只钉"接线存在 + 未写入会话"。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const engineSrc = readFileSync(new URL('../kernel/engine.mjs', import.meta.url), 'utf8')
const sessionSrc = readFileSync(new URL('../kernel/session.mjs', import.meta.url), 'utf8')

test('engine 发出两条帧，且用自增 wire seq', () => {
  assert.match(engineSrc, /wire\.toolOutputDelta\(/)
  assert.match(engineSrc, /wire\.fileChange\(/)
  assert.match(engineSrc, /MUTATING_FILE_TOOLS/)
  assert.match(engineSrc, /nextWireSeq/)
})

test('delta/file_change 不得写入 transcript（session 侧不得引用这两个 type）', () => {
  assert.equal(/tool_output_delta|file_change/.test(sessionSrc), false)
})
