// src/lib/bridgeBase.test.ts
// 桥基地址解析的守门测试（2026-09-16）。
//
// 背景：仓库曾有 **4 个模块**各自硬编码 `http://127.0.0.1:3939`，而桥真实监听
// `YFW_BRIDGE_PORT || 51517`（server/bridge.mjs / electron/main.cjs / vite.config.ts 三处一致）
// ⇒ 默认配置下这些功能**全部连不上桥**，界面只说「无法连接本地服务」。
// 更糟的是：这些模块的单测**全绿**——因为测试都 stub 了 fetch，从不校验真实地址。
//
// 所以本文件把「真值一致性」钉死，两层防护：
//   ① **不变量**：兜底端口必须等于桥源码里的默认端口（桥改端口而前端不改 = 立刻变红）
//   ② **架构守卫**：扫描 src/ 全部非测试源码，禁止任何硬编码 `http://127.0.0.1:<port>`
//      —— 这类"照抄邻居模块"的复发，靠人 review 拦不住，靠扫描才拦得住。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'
import { resolveBridgeBase, BRIDGE_BASE_FALLBACK } from './bridgeBase.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')

test('不变量：兜底端口必须与桥源码里的默认端口一致', () => {
  // 从桥源码读真值，而不是在测试里再写一遍 51517——
  // 否则桥改了端口，测试跟着一起"错得一致"，等于没测。
  const bridgeSrc = readFileSync(join(REPO, 'server', 'bridge.mjs'), 'utf8')
  const m = bridgeSrc.match(/YFW_BRIDGE_PORT\s*\|\|\s*['"](\d+)['"]/)
  assert.ok(m, '应在 server/bridge.mjs 找到 `YFW_BRIDGE_PORT || \'<port>\'` 形式的默认端口')
  const bridgeDefaultPort = m![1]

  assert.equal(
    new URL(BRIDGE_BASE_FALLBACK).port,
    bridgeDefaultPort,
    `兜底端口(${BRIDGE_BASE_FALLBACK}) 必须等于桥默认端口(${bridgeDefaultPort})，否则默认配置下前端连不上桥`,
  )
})

test('兜底地址不得是历史坏端口 3939', () => {
  assert.doesNotMatch(BRIDGE_BASE_FALLBACK, /:3939\b/, '3939 是历史坏端口（见文件头背景）')
})

test('resolveBridgeBase：注入值优先（测试可打桩）', () => {
  assert.equal(resolveBridgeBase('http://127.0.0.1:1'), 'http://127.0.0.1:1')
  assert.equal(resolveBridgeBase('http://example.test:9'), 'http://example.test:9')
})

test('resolveBridgeBase：无注入时不抛（node --test 无 vite define），且返回可用地址', () => {
  // 这条覆盖"生产的默认路径"——当初 4 个模块正是只在默认路径上出错，
  // 而所有测试都在注入路径上，所以全绿。
  let url = ''
  assert.doesNotThrow(() => { url = resolveBridgeBase() }, '渲染路径上抛出会整页白屏')
  assert.match(url, /^https?:\/\/[^/]+$/, `应是干净的基地址（无尾斜杠/无路径），实得: ${url}`)
  assert.ok(new URL(url).port, '应带端口')
})

/** 递归收集 src 下的 .ts/.tsx（排除测试文件与本模块自身） */
function collectSources(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) { collectSources(p, acc); continue }
    if (!/\.tsx?$/.test(name)) continue
    if (/\.test\.tsx?$/.test(name)) continue          // 测试里可以提到坏端口（作反面教材）
    if (name === 'bridgeBase.ts') continue            // 兜底常量就住在这里
    acc.push(p)
  }
  return acc
}

test('架构守卫：src 下不得再出现硬编码的桥基地址', () => {
  const files = collectSources(join(REPO, 'src'))
  assert.ok(files.length > 20, `扫描范围异常（只找到 ${files.length} 个文件），守卫形同虚设`)
  const offenders: string[] = []
  for (const f of files) {
    const src = readFileSync(f, 'utf8')
    const m = src.match(/https?:\/\/(?:127\.0\.0\.1|localhost):\d{2,5}/)
    if (m) offenders.push(`${relative(REPO, f).replace(/\\/g, '/')} → ${m[0]}`)
  }
  assert.deepEqual(
    offenders,
    [],
    '发现硬编码桥地址（应改用 bridgeBase.ts 的 resolveBridgeBase()）：\n  ' + offenders.join('\n  '),
  )
})

test('架构守卫：mcpApi 的兜底常量必须来自 bridgeBase（不得各写一份）', () => {
  const src = readFileSync(join(REPO, 'src', 'lib', 'mcpApi.ts'), 'utf8')
  assert.match(src, /BRIDGE_BASE_FALLBACK/, 'MCP_BASE 应 re-export 共享兜底常量，避免两处口径分叉')
})
