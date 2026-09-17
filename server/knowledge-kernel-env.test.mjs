// 知识库侧内核环境变量测试（2026-09-17 修复）。
// 纪律：不起 bridge、不起内核子进程（本仓库有"测试起桥误杀运行中应用"的前车之鉴），
// 故这里只做三层：① 纯函数行为 ② 源码治理断言 ③ 与内核解析顺序的契约断言。
//
// 背景：内核 CLI 的 resolveConfigDir 只认 `PONOS_CONFIG_DIR > PONOS_HOME > ~/.ponos`
// （**不认 YFWORKING_HOME**）。`server/knowledge-routes.mjs` 的两个默认实现原先是裸的
// `kernelReadonly`/`spawnKernelStreaming`，env 缺省 `process.env` —— 桥进程里没有
// `PONOS_CONFIG_DIR`，于是内核回落 `~/.ponos`：面板读到旧根数据、导入写进旧根，而
// `~/.yfw/knowledge/spaces` 一直空着。会话侧没这问题（buildChildEnv 注入了同一个根）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { knowledgeKernelEnv } from './knowledge-routes.mjs'
import { resolveConfigDir } from '../kernel/config.mjs'

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf-8')

test('knowledgeKernelEnv：两根键都指向传入 home，并保留进程原有环境', () => {
  const home = 'C:/Users/someone/.yfw'
  const env = knowledgeKernelEnv(home)
  assert.equal(env.PONOS_CONFIG_DIR, home)
  assert.equal(env.PONOS_HOME, home, 'Bash 子进程走第二把钥匙，必须是同一个根')
  assert.equal(env.PATH, process.env.PATH, '其余环境变量原样保留（内核仍需 PATH/HOME 等）')
})

test('knowledgeKernelEnv：缺省取真实 home（生产链路零配置）', () => {
  const env = knowledgeKernelEnv()
  assert.ok(env.PONOS_CONFIG_DIR && env.PONOS_CONFIG_DIR === env.PONOS_HOME)
  assert.ok(!/\.ponos$/.test(env.PONOS_CONFIG_DIR.replace(/\\/g, '/')),
    '缺省绝不能是内核的回落根 ~/.ponos')
})

test('契约：注入的键确实是内核认的键（resolveConfigDir 优先级）', () => {
  const home = 'C:/Users/someone/.yfw'
  const env = knowledgeKernelEnv(home)
  assert.equal(resolveConfigDir(env, () => 'C:/Users/someone'), home,
    '注入了 PONOS_CONFIG_DIR，内核就必须解析到这个根')
  // 反向锁：只注 YFWORKING_HOME 是**不够**的（这正是当初踩空的原因）
  assert.equal(resolveConfigDir({ YFWORKING_HOME: home }, () => 'C:/Users/someone'),
    join('C:/Users/someone', '.ponos'),
    'YFWORKING_HOME 不被内核识别——修 env 时必须用 PONOS_* 两个键')
})

test('治理：路由的两个默认实现都带上 kernelEnv（只改调用点等于把地雷留给下一个人）', () => {
  const src = read('./knowledge-routes.mjs')
  assert.match(src, /callKernel = callKernel \|\| \(\(args, opts = \{\}\) => kernelReadonly\(args, \{ \.\.\.opts, env: opts\.env \|\| env \}\)\)/,
    'callKernel 默认实现必须注入 env')
  assert.match(src, /spawnStream = spawnStream \|\| \(\(argv, opts = \{\}\) => spawnKernelStreaming\(argv, \{ \.\.\.opts, env: opts\.env \|\| env \}\)\)/,
    'spawnStream 默认实现必须注入 env（异步导入走这条路）')
  assert.match(src, /const env = kernelEnv \|\| knowledgeKernelEnv\(home\)/,
    'env 必须以 home 为根构造')
  assert.doesNotMatch(src, /callKernel = kernelReadonly,/, '不得退回裸的默认实现')
  assert.doesNotMatch(src, /spawnStream = spawnKernelStreaming,/, '不得退回裸的默认实现')
})

test('治理：bridge 生产链路显式传 kernelEnv（且惰性构造，不摊到所有请求）', () => {
  const src = read('./bridge.mjs')
  assert.match(src, /kernelEnv: buildChildEnv\(\),/,
    'bridge 调 handleKnowledgeRoute 时必须传完整子进程环境')
  assert.match(src, /if \(url\.pathname\.startsWith\('\/knowledge'\)\) \{[\s\S]{0,4000}?handleKnowledgeRoute\(\{/,
    '只在命中 /knowledge 时才构造（loadConfig 每次读盘）')
  // 顺带锁住扫码件导入依赖：bundled python 路径由 buildChildEnv 注入
  assert.match(src, /env\.YFWORKING_PYTHON = pythonExe/)
})

test('治理：异步导入任务把 env 透传给 spawnStream（否则 wrapper 兜不住）', () => {
  const src = read('./import-jobs.mjs')
  assert.match(src, /spawnStream\(argv, \{\s*\n\s*env, cwd, timeoutMs, maxBuffer,/)
})

test('治理：handleImport 显式把 env 交给 startImportJob（不依赖 spawnStream 的 wrapper 兜底）', () => {
  const src = read('./knowledge-routes.mjs')
  // 为什么单独钉：`spawnStream` 可能被调用方换成裸实现（测试/未来新调用方），
  // 那时 wrapper 不存在，env 只能靠这条显式传递。
  assert.match(src, /async function handleImport\(\{ readJsonBody, callKernel, spawnStream, home, env = null \}\)/,
    'handleImport 必须接受 env')
  assert.match(src, /startImportJob\(\{[\s\S]{0,400}?env: env \|\| undefined,/,
    'startImportJob 必须收到 env，且不能传 null（spawn 的默认值只在 undefined 时生效）')
  assert.match(src, /return await handleImport\(\{ readJsonBody, callKernel, spawnStream, home, env \}\)/,
    '路由必须把 env 传下去')
})
