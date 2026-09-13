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

// S3 D2 反转了这条断言的方向：S1 时 KnowledgeSearch 与 MemorySearch 同列禁用表（"两份都必须含"），
// S3 决定 chat 放行它（只读、不写盘、不执行）。断言改成"两份都不得含"，与
// kernel-tests/knowledge-search.test.mjs 的 CHAT_MODE_DISALLOWED 检查构成双保险：
// 前者守**源码文本**（防只改内核漏改 bridge 拷贝），后者守**运行时表**。
test('两份禁用表都不含 KnowledgeSearch（S3 D2 放行，chat 隔离一致）', () => {
  const bridge = read('server/bridge.mjs')
  const tools = read('kernel/tools.mjs')
  const kernelList = /CHAT_MODE_DISALLOWED = \[([^\]]*)\]/.exec(tools)
  const bridgeList = /export const CHAT_DISALLOWED = \[([^\]]*)\]/.exec(bridge)
  assert.ok(kernelList, '内核权威表必须仍存在')
  assert.ok(bridgeList, 'bridge 拷贝表必须仍存在')
  assert.ok(!kernelList[1].includes('KnowledgeSearch'), '内核权威表不得再含 KnowledgeSearch')
  assert.ok(!bridgeList[1].includes('KnowledgeSearch'), 'bridge 拷贝表不得再含 KnowledgeSearch')
})
