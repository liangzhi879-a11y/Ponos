// kernel-readonly 冒烟：真实 spawn kernel 只读子命令（PONOS_MOCK_API=1 + 临时 home，
// 与 kernel-bridge.test.mjs 同款隔离）。npm test server/*.test.mjs glob 收录。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { kernelReadonlySync, resolveKernelCli } from './kernel-readonly.mjs'
import { resolveKernelPaths } from '../electron/kernel-paths.cjs'

const SERVER_DIR = dirname(fileURLToPath(import.meta.url))

test('resolveKernelCli：能定位 kernel cli.mjs，且与 resolveKernelPaths install 候选锁步', () => {
  const p = resolveKernelCli()
  assert.ok(p.endsWith('cli.mjs'), p)
  // 与 findYFWorking 共用同一 appDir 推导（模块上层）→ 结果必须等于 kernel-paths 的 install 命中
  const rp = resolveKernelPaths({ appDir: join(SERVER_DIR, '..') })
  assert.equal(p, rp.install.kernel || rp.kernel)
})

test('resolveKernelCli：备选布局上溯一级候选命中（旧实现仅查 <server>/.. → 会漂移）', () => {
  const base = mkdtempSync(join(tmpdir(), 'yfw-kr-alt-'))
  try {
    const appDir = join(base, 'app') // appDir 内无任何 install 候选
    const altKernel = join(base, 'kernel', 'cli.mjs') // 备选部署布局：上溯一级
    mkdirSync(dirname(altKernel), { recursive: true })
    writeFileSync(altKernel, 'export {}', 'utf8')
    // 锁步前提：kernel-paths 认定该上溯一级候选
    assert.equal(resolveKernelPaths({ appDir }).install.kernel, altKernel)
    assert.equal(resolveKernelCli({ appDir }), altKernel)
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test('resolveKernelCli：install 全缺回退 home runtime 缓存（findYFWorking ③，杜绝误 502）', () => {
  const base = mkdtempSync(join(tmpdir(), 'yfw-kr-cache-'))
  const prevHome = process.env.YFWORKING_HOME
  try {
    const appDir = join(base, 'bare') // 无 kernel/ 亦无 kernel-dist/
    mkdirSync(appDir, { recursive: true })
    const cachedKernel = join(base, 'home', 'runtime', 'ponos-kernel', 'cli.mjs')
    mkdirSync(dirname(cachedKernel), { recursive: true })
    writeFileSync(cachedKernel, 'export {}', 'utf8')
    process.env.YFWORKING_HOME = join(base, 'home') // resolveYfwHome 调用期读取，无模块级缓存
    // 锁步前提：kernel-paths 在此布局回落缓存（旧 resolveKernelCli 于此直接 throw → 端点误 502）
    assert.equal(resolveKernelPaths({ appDir }).kernel, cachedKernel)
    assert.equal(resolveKernelCli({ appDir }), cachedKernel)
  } finally {
    if (prevHome === undefined) delete process.env.YFWORKING_HOME
    else process.env.YFWORKING_HOME = prevHome
    rmSync(base, { recursive: true, force: true })
  }
})

test('resolveKernelCli：YFWORKING_KERNEL 逃生口仍最高优先（与 findYFWorking 同序）', () => {
  const base = mkdtempSync(join(tmpdir(), 'yfw-kr-env-'))
  const prevKernel = process.env.YFWORKING_KERNEL
  try {
    const fake = join(base, 'override-cli.mjs')
    writeFileSync(fake, 'export {}', 'utf8')
    process.env.YFWORKING_KERNEL = fake
    assert.equal(resolveKernelCli(), fake) // 仓库 kernel/ 存在也不得压过显式覆盖
  } finally {
    if (prevKernel === undefined) delete process.env.YFWORKING_KERNEL
    else process.env.YFWORKING_KERNEL = prevKernel
    rmSync(base, { recursive: true, force: true })
  }
})

test('kernelReadonlySync：--agents / --usage 真实 spawn 返回 JSON', () => {
  const home = mkdtempSync(join(tmpdir(), 'yfw-kr-home-'))
  try {
    const env = { ...process.env, PONOS_MOCK_API: '1', PONOS_CONFIG_DIR: home, YFWORKING_HOME: home }
    delete env.PONOS_HOME // 防宿主演进内核解析链（kernel-bridge.test.mjs 同款隔离）
    const agents = JSON.parse(kernelReadonlySync(['--agents'], { env, cwd: process.cwd() }))
    assert.ok(Array.isArray(agents) && agents.length >= 2)
    const usage = JSON.parse(kernelReadonlySync(['--usage'], { env, cwd: process.cwd() }))
    assert.equal(typeof usage.totals.input_tokens, 'number')
  } finally { rmSync(home, { recursive: true, force: true }) }
})
