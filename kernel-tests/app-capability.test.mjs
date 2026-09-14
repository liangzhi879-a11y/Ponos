// 能力清单（Capability Surface）：取代"单级判定"。
// 现状缺口：probeDesktop 只回 process/script/uia 一个级别，全不中就硬拒生成；
// 而封装需要的是"有哪些可控路径、各有什么证据、下一步怎么试"。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const {
  CHANNELS, capability, buildCapabilitySurface, verdictOf, renderSurfaceForPrompt, renderSurfaceReport,
} = require('../electron/app-capability.cjs')

test('CHANNELS：通道 → 执行后端（driver 只表"谁来执行"）', () => {
  assert.equal(CHANNELS.cli.driver, 'process')
  assert.equal(CHANNELS.chunk.driver, 'browser', 'chunk 里的接口也由浏览器执行（自带登录态）')
  assert.equal(CHANNELS.http.driver, 'http')
  assert.equal(CHANNELS.file.driver, 'file')
  assert.equal(CHANNELS.unusable.driver, null)
})

test('capability：未知通道要报错（防止拼写错误静默变成"没探到"）', () => {
  assert.ok(capability('cli', { evidence: 'x' }).channel === 'cli')
  assert.throws(() => capability('nope', {}), /未知通道/)
})

test('capability：driver 从通道定义取，调用方不必手写（避免两处不一致）', () => {
  const c = capability('script', { evidence: '发现 scripts/ 目录', confidence: 'verified' })
  assert.equal(c.driver, 'script')
  assert.equal(c.confidence, 'verified')
  assert.equal(c.label, CHANNELS.script.label)
})

test('verdictOf：三态结论——有 verified=可接入，只有 probable=证据不足，全无=无法接入', () => {
  assert.equal(verdictOf([capability('cli', { confidence: 'verified' })]), 'connectable')
  assert.equal(verdictOf([capability('file', { confidence: 'probable' })]), 'weak')
  assert.equal(verdictOf([capability('unusable', { confidence: 'unusable' })]), 'unusable')
  assert.equal(verdictOf([]), 'unusable', '空清单不许说"可接入"')
})

test('★ 有 verified 也有 unusable 时结论仍是可接入（别被降级项拖成"无法接入"）', () => {
  const v = verdictOf([capability('cli', { confidence: 'verified' }), capability('unusable', { confidence: 'unusable' })])
  assert.equal(v, 'connectable')
})

test('buildCapabilitySurface：按可信度排序（verified 在前，供模型先试最有把握的）', () => {
  const s = buildCapabilitySurface({ target: { type: 'desktop', exePath: 'a.exe' }, capabilities: [
    capability('file', { confidence: 'probable', evidence: '有 config.json' }),
    capability('cli', { confidence: 'verified', evidence: '--help 有输出' }),
  ] })
  assert.deepEqual(s.capabilities.map((c) => c.channel), ['cli', 'file'])
  assert.equal(s.verdict, 'connectable')
  assert.equal(s.hasVerified, true)
  assert.equal(s.hasProbable, true)
})

test('★ renderSurfaceForPrompt：证据与"下一步"都要给模型（这才叫可控路径清单）', () => {
  const s = buildCapabilitySurface({ target: {}, capabilities: [
    capability('cli', { confidence: 'verified', evidence: 'aseprite.exe --help → 5823 字节', next: '直接封装 CLI 命令' }),
    capability('chunk', { confidence: 'probable', evidence: '发现 12 个 JS chunk', next: '翻 chunk 反解接口路径' }),
  ] })
  const text = renderSurfaceForPrompt(s)
  assert.ok(text.includes('已探明可控路径'), text)
  assert.ok(text.includes('已实测') && text.includes('待验证'), '可信度要标出来：' + text)
  assert.ok(text.includes('5823'), '证据要带上')
  assert.ok(text.includes('直接封装 CLI 命令') && text.includes('反解接口路径'), '下一步指引要带上')
})

test('renderSurfaceReport：无可用通道时明确说"无法接入"，并列出已排查通道', () => {
  const s = buildCapabilitySurface({ target: {}, capabilities: [
    capability('unusable', { confidence: 'unusable', evidence: 'CLI：无输出；脚本接口：无目录' }),
  ] })
  const text = renderSurfaceReport(s)
  assert.ok(text.includes('无法接入'), text)
  assert.ok(text.includes('CLI：无输出'), '要把排查过的证据列出来，便于用户自我纠正')
})

test('renderSurfaceReport：证据不足时不得说成"无法接入"（文案协议）', () => {
  const s = buildCapabilitySurface({ target: {}, capabilities: [capability('file', { confidence: 'probable' })] })
  const text = renderSurfaceReport(s)
  assert.ok(!text.includes('无法接入'), `只有 probable 不许下"无法接入"结论：${text}`)
  assert.ok(text.includes('待进一步确认') || text.includes('证据不足'), text)
})
