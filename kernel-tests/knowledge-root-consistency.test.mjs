// S6：**根一致性**回归 —— agent 在 Bash 里跑内核 CLI 时，必须落到与应用同一个配置根。
//
// 背景（实测踩过的真坑，spec §7.3）：两套 home 解析口径并存
//   · 应用侧 `server/yfw-home.cjs`：`YFWORKING_HOME > PONOS_CONFIG_DIR > ~/.yfworking`
//   · 内核 CLI `kernel/config.mjs`：`PONOS_CONFIG_DIR > PONOS_HOME > ~/.ponos`
//     —— **不认 `YFWORKING_HOME`**
// 而 Bash 工具的 `childEnv()` 有安全白名单（S2-2，防子进程窃取宿主密钥），
// `PONOS_CONFIG_DIR` 被刻意剥离、`YFWORKING_HOME` 从未在白名单里 ⇒ agent 在 Bash 里
// 跑 `--knowledge append` 会退到 `~/.ponos`：**写进去的经验 GUI 完全看不见**，
// 从"路径受阻"变成"写进黑洞"。
//
// 修法（两处必须同时到位，缺一无效）：
//   ① `server/bridge.mjs` 的 `buildChildEnv()` 额外注入语义中性的 `PONOS_HOME`(= YFW_HOME)
//   ② `kernel/tools.mjs` 的 `ENV_WHITELIST` 放行 `PONOS_HOME`
// 为什么不直接放行 `PONOS_CONFIG_DIR`：那是密钥目录名（内含 auth.json），
// 放开等于削弱 S2-2 的原始防护；`PONOS_HOME` 只是一个路径，代价最小。
//
// 本文件是**静态断言 + 行为断言**双管：静态防"有人后来把白名单改回去"，
// 行为侧验证 `childEnv()` 实际透传结果（白名单改了但变量没注入，同样无效）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { childEnv } from '../kernel/tools.mjs'
import { resolveConfigDir } from '../kernel/config.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

test('childEnv() 放行 PONOS_HOME（内核 CLI 认它），仍剥离 PONOS_CONFIG_DIR', () => {
  const saved = { ...process.env }
  try {
    process.env.PONOS_HOME = 'C:/fake/ponos'
    process.env.PONOS_CONFIG_DIR = 'C:/fake/secret-config'
    process.env.YFWORKING_HOME = 'C:/fake/yfw'
    const env = childEnv()
    assert.equal(env.PONOS_HOME, 'C:/fake/ponos', 'Bash 子进程必须知道应用根，否则 CLI 落到 ~/.ponos')
    // 安全侧：密钥目录名**不得**透传（S2-2 防"Bash/OCR 子进程窃取宿主密钥"）
    assert.equal(env.PONOS_CONFIG_DIR, undefined, 'PONOS_CONFIG_DIR 必须仍被剥离')
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  }
})

test('内核解析顺序：PONOS_CONFIG_DIR > PONOS_HOME > ~/.ponos', () => {
  // 应用侧两者都会注入且同值，顺序只影响"只有一把钥匙"的场景 —— 而那正是 Bash 子进程：
  // 它只拿得到 PONOS_HOME（PONOS_CONFIG_DIR 被剥离），故必须能单独生效。
  assert.equal(resolveConfigDir({ PONOS_CONFIG_DIR: '/a', PONOS_HOME: '/b' }), '/a')
  assert.equal(resolveConfigDir({ PONOS_HOME: '/b' }, () => '/home/x'), '/b', '只有 PONOS_HOME 时也必须生效（Bash 子进程的处境）')
  assert.match(resolveConfigDir({}, () => '/home/x'), /\.ponos$/)
})

test('bridge 的 buildChildEnv 同时注入三把钥匙（静态守卫，防回退）', (t) => {
  // 纯内核形态（本仓无 server/）：bridge 是 GUI 侧组件，没有可比对的源码 → 跳过。
  const bridgePath = join(ROOT, 'server', 'bridge.mjs')
  if (!existsSync(bridgePath)) { t.skip('本仓无 server/bridge.mjs（纯内核形态），跳过跨层静态守卫'); return }
  const src = readFileSync(bridgePath, 'utf8')
  const block = src.slice(src.indexOf('function buildChildEnv()'), src.indexOf('function buildChildEnv()') + 2000)
  for (const key of ['PONOS_CONFIG_DIR', 'YFWORKING_HOME', 'PONOS_HOME']) {
    assert.match(block, new RegExp(`${key}: YFW_HOME`), `buildChildEnv 必须注入 ${key}`)
  }
})
