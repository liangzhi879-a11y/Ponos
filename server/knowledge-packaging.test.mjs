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
test('两份禁用表都不含 KnowledgeSearch（S3 D2 放行，chat 隔离一致）', () => {  const bridge = read('server/bridge.mjs')
  const tools = read('kernel/tools.mjs')
  const kernelList = /CHAT_MODE_DISALLOWED = \[([^\]]*)\]/.exec(tools)
  const bridgeList = /export const CHAT_DISALLOWED = \[([^\]]*)\]/.exec(bridge)
  assert.ok(kernelList, '内核权威表必须仍存在')
  assert.ok(bridgeList, 'bridge 拷贝表必须仍存在')
  assert.ok(!kernelList[1].includes('KnowledgeSearch'), '内核权威表不得再含 KnowledgeSearch')
  assert.ok(!bridgeList[1].includes('KnowledgeSearch'), 'bridge 拷贝表不得再含 KnowledgeSearch')
})

// S3 D1：注入灰度开关的**透传契约**（源码级，不启动 bridge —— 本仓库有"测试起桥误杀运行中
// 应用"的前车之鉴，任何 server 测试都不得 spawn bridge）。断言的是"读了键 + 传了 env"，
// 判定逻辑的权威在内核（kernel/knowledge-inject.mjs 的 resolveInjectMode）。
test('bridge 读 config.json 的 knowledgeInjectMode 并透传 PONOS_KNOWLEDGE_INJECT_MODE', () => {
  const src = read('server/bridge.mjs')
  assert.match(src, /knowledgeInjectMode === 'unified' \? 'unified' : 'legacy'/, '缺省/非法必须回落 legacy')
  assert.match(src, /PONOS_KNOWLEDGE_INJECT_MODE/, '必须把开关透传给内核（判定在内核侧）')
  assert.match(src, /PONOS_KNOWLEDGE_INJECT_MAX_BYTES/, '预算也要透传（总预算沿用既有配置项）')
})

// 零回归锁：legacy 是缺省，bridge **不得**无条件注入 unified 变量（否则等于强制开了新路径）
test('bridge 只在 unified 时才传 mode（缺省不传 = 老用户行为不变）', () => {
  const src = read('server/bridge.mjs')
  const m = /c\.injectMode === 'unified' \? \{ PONOS_KNOWLEDGE_INJECT_MODE: 'unified' \} : \{\}/.exec(src)
  assert.ok(m, '透传必须条件化：仅 unified 时注入 env')
})

// ── S4 Task 4：知识包生态的接线守卫（源码级，不起任何进程）────────────────────
// 只断言"新注入点确实被传给 handleKnowledgeRoute"，防"实现写了但没接上"——这类漏接在
// 单测里永远绿（单测自己传 home），只有真机点一下市场的安装才会炸成 500。
test('bridge 把 home/config/fetcher 透传给 handleKnowledgeRoute（且只被 packs 路由消费）', () => {
  const src = read('server/bridge.mjs')
  assert.match(src, /home: YFW_HOME,/, 'home 必须显式透传（否则路由回落到 resolveYfwHome 再解析一次 env）')
  assert.match(src, /config: knowledgePackConfig,/, 'config 必须传懒读函数（高频读路由上不白读 config.json）')
  assert.match(src, /fetcher: globalThis\.fetch,/, 'fetcher 必须可注入（测试不得真联网）')
  assert.match(src, /function knowledgePackConfig\(\)/, 'knowledgePackConfig 定义必须存在')
})

test('knowledge-routes 的新路由表齐（市场/详情/安装/卸载/导出）且既有路由未被改写', () => {
  const src = read('server/knowledge-routes.mjs')
  for (const p of ['/knowledge/packs', '/knowledge/packs/detail', '/knowledge/packs/install', '/knowledge/packs/uninstall', '/knowledge/packs/export']) {
    assert.ok(src.includes(`'${p}'`), `路由表缺少 ${p}`)
  }
  // 既有读路由的路径与状态码语义不得改动（"纯增量"）：逐个仍是薄转发
  for (const p of ['/knowledge/spaces', '/knowledge/tree', '/knowledge/doc', '/knowledge/entries', '/knowledge/search', '/knowledge/links', '/knowledge/graph', '/knowledge/stats', '/knowledge/reindex']) {
    assert.ok(src.includes(`p === '${p}'`), `既有路由 ${p} 不得被改写/删除`)
  }
})

test('knowledge-routes 不 import kernel/*（kernel ⊥ server 双向禁止）', () => {
  const src = read('server/knowledge-routes.mjs')
  assert.ok(!/from '\.\.\/kernel\//.test(src), 'server 侧不得 import kernel/')
  assert.match(src, /from '\.\.\/shared\/knowledge-pack\.mjs'/, '判定规则来自中性层 shared/')
  assert.match(src, /from '\.\/knowledge-pack-install\.mjs'/, '安装引擎必须是独立可测模块')
})

test('安装引擎不 import kernel/，也不 import bridge（测试可独立 import）', () => {
  const src = read('server/knowledge-pack-install.mjs')
  assert.ok(!/from '\.\.\/kernel\//.test(src), '安装引擎不得 import kernel/')
  assert.ok(!/from '\.\/bridge\.mjs'/.test(src), '不得 import bridge（其顶层 listen 会让测试挂）')
  assert.match(src, /from '\.\.\/shared\/pack-zip\.mjs'/, 'zip 编解码用 Task 1 的自研实现（零新依赖）')
})
