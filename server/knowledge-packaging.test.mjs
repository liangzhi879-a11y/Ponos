// 打包与接线契约测试：纯读文件断言，不启动任何进程。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf-8')

test('electron-builder files 含 shared/**/*（server 侧需要 ../shared）', () => {
  const yml = read('electron-builder.yml')
  assert.match(yml, /shared\/\*\*\/\*/, 'files 必须收录 shared/')
})

test('package.json 的 test glob 含 shared/**/*.test.mjs', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.match(pkg.scripts.test, /shared\/\*\*\/\*\.test\.mjs/)
})

test('bridge.mjs 已接入 handleKnowledgeRoute 且 import 正确', () => {
  const src = read('server/bridge.mjs')
  assert.match(src, /import \{ handleKnowledgeRoute \} from '\.\/knowledge-routes\.mjs'/)
  assert.match(src, /handleKnowledgeRoute\(\{/)
})

test('两份 CHAT_MODE_DISALLOWED 都含 KnowledgeSearch（chat 隔离一致）', () => {
  const bridge = read('server/bridge.mjs')
  const tools = read('kernel/tools.mjs')
  assert.match(tools, /CHAT_MODE_DISALLOWED[\s\S]{0,400}KnowledgeSearch/)
  assert.match(bridge, /KnowledgeSearch/)
})
