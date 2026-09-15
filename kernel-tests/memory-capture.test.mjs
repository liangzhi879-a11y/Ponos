// S5.1：`captureMemoryCandidates` 的**捕获精确度**回归。
//
// 背景（真实库实测，`calib-capture-precision.mjs`）：真实库 81 条条目里，
// capture 自动产出 18 条、其中 **17 条是垃圾**；而 agent **主动沉淀**的 63 条全部有 tag、零垃圾。
// 垃圾三类，分别由两个根因造成：
//   ① **单字弱信号词** `先 / 再 / 最后` + "长度 > 30" 门槛（几乎任何用户消息都满足）
//      ⇒ 任何较长消息都被当成"流程经验"。实测 16 条「流程要点」里**含强信号词的 0 条**，
//      全是对话原文（"不太符合我的要求，我想的是扁平科技风…"）。
//   ② **没有协议文本排除** —— harness 注入块（`【上下文锚定 · 权威事实】`）、
//      技能调用提示（`执行技能 using-superpowers…`）、模板框架（`用户回答：`）被当作用户经验。
//
// 本文件钉住修法（两条都必须，缺一仍漏）：
//   · DEFAULT_MARKERS.workflow 删掉单字弱信号，只留**明确声明式**强信号词
//   · push 统一出口加 `PROTOCOL_TEXT_RE` 协议文本闸
//
// **能力未被删死**：用户仍可在配置 `memory.markers.workflow` 里自定义放开——
// 故最后一条用例专门验证"自定义 markers 依然生效"，防止把收窄做成阉割。
//
// 隔离：mkdtempSync + PONOS_HOME，绝不碰真实 ~/.yfworking / ~/.yfw。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureMemoryCandidates } from '../kernel/memory.mjs'

const tmpDirs = []
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-cap-'))
  tmpDirs.push(dir)
  const prev = process.env.PONOS_HOME
  process.env.PONOS_HOME = dir
  return { dir, restore: () => { if (prev === undefined) delete process.env.PONOS_HOME; else process.env.PONOS_HOME = prev } }
}
after(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }) })

test('S5.1：单字弱信号（先/再/最后）不再单独触发流程捕获', () => {
  const f = fixture()
  try {
    // 三条都是真实库里的垃圾原文（曾经的触发路径：含单字 + 长度 > 30）
    const dirt = [
      // 含「先」「再」两个弱词、长度 141 —— 旧规则必然捕获
      '还是没有，你先自己检查下再交付file:///C:/Users/T203-15/Desktop/x.svg 另外按钮位置不对',
      // 含「最后」、长度 223
      '不太符合我的要求，我想的是扁平科技风的正三角形拼贴可互动界面原型，中间为logo框线，沿logo正三角形密铺网格',
      // 含「再」、长度 122
      '现在得到一个轮廓以及围绕轮廓规则排列的正三角形，每个正三角形内进行了Sierpinski三角拼贴；然而这不符合设计需求。',
    ]
    for (const t of dirt) {
      assert.deepEqual(captureMemoryCandidates({ userText: t, tag: '应用智控' }), [],
        `对话原文不得入库（旧规则会因单字弱信号捕获）: ${t.slice(0, 20)}…`)
    }
  } finally { f.restore() }
})

test('S5.1：协议／系统文本不捕获（harness 注入块、技能提示、模板框架）', () => {
  const f = fixture()
  try {
    const protos = [
      '【上下文锚定 · 权威事实】用户已在上一轮确认了目录结构',           // 注入的上下文块
      '【用户插话——补充信息/调整要求】',                                 // 插话模板
      '执行技能 using-superpowers。首选使用 Read 工具读取 "C:/x/SKILL.md"', // 技能调用提示
      '用户回答：',                                                       // 模板残段
    ]
    for (const t of protos) {
      assert.deepEqual(captureMemoryCandidates({ userText: t, tag: '应用智控' }), [],
        `协议文本不得入库: ${t.slice(0, 20)}…`)
    }
    // 协议文本出现在**其他分支**的触发词旁时同样拦住 —— 真实库形态：
    // `- [会话] 业务要点（请注意）：【用户插话——补充信息/调整要求】` 的 **full** 就是
    // `【用户插话——补充信息/调整要求】` 本身（不含触发词），故起始判据即可拦住。
    assert.deepEqual(captureMemoryCandidates({ userText: '【用户插话——补充信息】' }), [],
      'fact 分支的产物同样受协议闸约束')

    // **约束**：判据是"起始匹配"，不得退化成"含【就拦"——
    // 用户完全可能说"用【】标出待确认项"，那是真经验，误杀即永久丢失。
    const keep = captureMemoryCandidates({ userText: '流程是：先在报告里用【】标出待确认项，再逐条向用户核对' })
    assert.equal(keep.length, 1, '中段含【】的真经验不得被协议闸误杀')
  } finally { f.restore() }
})

test('S5.1：明确声明的经验照旧捕获（收窄不得把能力做没）', () => {
  const f = fixture()
  try {
    const flow = captureMemoryCandidates({ userText: '流程是：先备份 settings.json，再补上缺失的开引号，最后跑一次全量测试' })
    assert.equal(flow.length, 1)
    assert.equal(flow[0].theme, 'workflow')
    assert.ok(flow[0].summary.startsWith('流程要点：'))
    assert.ok(flow[0].full.includes('开引号'))

    assert.equal(captureMemoryCandidates({ userText: '标准做法是每次改完先跑一遍全量测试再提交' }).length, 1)
    assert.equal(captureMemoryCandidates({ userText: '步骤是：先停 bridge，再替换文件，最后重启' }).length, 1)

    // 纠正 / 偏好 / 业务事实三个分支不受影响
    assert.equal(captureMemoryCandidates({ userText: '以后不要用 npm，统一用 pnpm' }).length >= 1, true)
    assert.equal(captureMemoryCandidates({ userText: '我希望报告用中文，粒度细一些' })[0].theme, 'communication')
    assert.equal(captureMemoryCandidates({ userText: '请注意：导出目录必须用绝对路径' })[0].theme, 'workflow')
  } finally { f.restore() }
})

test('S5.1：默认值收窄但不阉割——配置自定义 markers 仍可放开弱信号词', () => {
  const f = fixture()
  try {
    const text = '先跑全量测试，再提交，最后合并' // 默认 markers 下不捕获（只有单字弱信号）
    assert.deepEqual(captureMemoryCandidates({ userText: text }), [])
    // 用户在 settings 里显式要求把「先」当流程信号 → 必须生效（能力保留）
    const custom = captureMemoryCandidates({ userText: text, markers: { workflow: ['先'] } })
    assert.equal(custom.length, 1, '自定义 markers 必须覆盖默认值')
    assert.ok(custom[0].full.includes('再提交'))
  } finally { f.restore() }
})
