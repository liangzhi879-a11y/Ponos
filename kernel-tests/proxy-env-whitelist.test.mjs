// 代理变量白名单的**跨模块一致性 + 行为**回归网（P1 网络代理，2026-09-17，方案 Step 4）。
// ---------------------------------------------------------------------------
// 本文件锁三件事：
//   ① **两套白名单不漂移**：`kernel/exec-base.mjs` 的 ENV_WHITELIST（Bash/OCR 子进程，
//      P2-1 后从 `kernel/tools.mjs` 下沉至此）与
//      `kernel/mcp.mjs` 的 ENV_KEEP（第三方 MCP 服务器）里的代理变量集合必须**相等**。
//      漂移的症状是"MCP 能连、Bash 不能连"这类无头案 —— 两边各自看都"有代理支持"。
//   ② **子进程真能拿到代理变量**（行为断言，非只看数组字面量）：
//      只给 HTTP_PROXY 而漏 NODE_USE_ENV_PROXY，子进程里跑的 node 等于没配代理。
//   ③ **桥注入的键 ⊆ 白名单**：桥经 buildChildEnv 注入 `nodeProxyEnv()` 产出的 6~7 个变量，
//      而这些变量要靠子进程白名单才能传下去。若只放行其中一部分，**最危险的是 NO_PROXY**——
//      缺它则回环也走代理，表现为"应用连不上自己的桥"（报错指向代理端口、完全不提代理）。
//      故这里直接拿 shared/proxy-config.mjs 的真实产出做子集断言，而不是手抄一份键名。
//
// 运行：node --test kernel-tests/proxy-env-whitelist.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mcpChildEnv } from '../kernel/mcp.mjs'
import { childEnv } from '../kernel/tools.mjs'
import { nodeProxyEnv } from '../shared/proxy-config.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 从源码文本里提取白名单数组内的代理变量名（大小写不敏感匹配含 PROXY 的项）。 */
function proxyKeysIn(relPath) {
  const src = readFileSync(join(ROOT, relPath), 'utf8')
  const keys = new Set()
  for (const m of src.matchAll(/'([A-Za-z_][A-Za-z0-9_]*)'/g)) {
    if (/proxy/i.test(m[1])) keys.add(m[1])
  }
  return keys
}

test('两套子进程白名单的代理变量集合必须相等（防只改一处）', () => {
  const tools = proxyKeysIn('kernel/exec-base.mjs')
  const mcp = proxyKeysIn('kernel/mcp.mjs')
  // 先把"存在性"钉住，避免两边同时漏掉某变量时"集合仍相等"的假绿
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'NODE_USE_ENV_PROXY']) {
    assert.ok(tools.has(k), `kernel/exec-base.mjs 白名单缺 ${k}`)
    assert.ok(mcp.has(k), `kernel/mcp.mjs 白名单缺 ${k}`)
  }
  assert.deepEqual([...tools].sort(), [...mcp].sort(), '两处白名单的代理变量集合已漂移')
})

test('行为：宿主带代理 env 时，MCP 子进程 env 真能拿到（含 NODE_USE_ENV_PROXY）', () => {
  const keys = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'NODE_USE_ENV_PROXY']
  const VALUE = 'probe-proxy-value'
  const saved = {}
  for (const k of keys) { saved[k] = process.env[k]; process.env[k] = VALUE }
  try {
    // 键名按**大小写不敏感**比对：Windows 的进程 env 本身大小写不敏感（`HTTP_PROXY` 与
    // `http_proxy` 会归并成同一个键），强行要求键名字面一致会在 Windows 上假红。
    // "大小写各注入一份"这一约定由 shared/proxy-config.test.mjs 在**纯函数层**钉住（对象字面量，跨平台稳定）。
    const findCi = (obj, key) => Object.keys(obj).find((x) => x.toLowerCase() === key.toLowerCase())
    for (const [label, env] of [['MCP', mcpChildEnv()], ['Bash', childEnv()]]) {
      for (const k of keys) {
        const name = findCi(env, k)
        assert.ok(name, `${label} 子进程 env 缺 ${k}`)
        assert.equal(env[name], VALUE, `${label} 子进程 env 的 ${k} 值不对`)
      }
      // 只透传白名单：凭据/配置类变量一律不透传（防第三方服务器/子进程窃取宿主密钥）
      process.env.PONOS_AUTH_TOKEN = 'secret-should-not-leak'
      assert.equal(env.PONOS_AUTH_TOKEN, undefined)
    }
    assert.equal(mcpChildEnv().PONOS_AUTH_TOKEN, undefined)
    assert.equal(childEnv().PONOS_AUTH_TOKEN, undefined)
  } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
    delete process.env.PONOS_AUTH_TOKEN
  }
})

test('桥注入的代理键必须全部被两套白名单放行（缺 NO_PROXY 会代理掉回环）', () => {
  const injected = Object.keys(nodeProxyEnv({ mode: 'manual', url: 'http://127.0.0.1:7890', bypass: 'a.com' }))
  assert.ok(injected.length >= 6, `桥应注入代理变量，实际 ${JSON.stringify(injected)}`)
  const tools = proxyKeysIn('kernel/exec-base.mjs')
  const mcp = proxyKeysIn('kernel/mcp.mjs')
  for (const k of injected) {
    assert.ok(tools.has(k), `桥注入了 ${k}，但 kernel/exec-base.mjs 白名单未放行 ⇒ Bash 子进程拿不到`)
    assert.ok(mcp.has(k), `桥注入了 ${k}，但 kernel/mcp.mjs 白名单未放行 ⇒ MCP 服务器拿不到`)
  }
  // off 时桥不注入任何代理变量 ⇒ 白名单放行与否都不改变行为（零回归的机制保证）
  assert.deepEqual(nodeProxyEnv({ mode: 'off' }), {})
})
