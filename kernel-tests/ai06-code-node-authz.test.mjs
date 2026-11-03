// AI-06 修复验证（P2 安全）：工作流 `code` 节点执行任意 JS，且**无任何授权判定**。
//
// 【缺陷】`kernel/workflow-nodes.mjs#execCode` 直接 `new vm.Script(code)` 跑节点里的字符串，
//   **没有任何授权/审批**。而同一文件的 `http` 节点早就有 `grant.network` / `permissions.network`
//   的判据（它是 2026-10-15 就补上的）。
//   不对称的后果很具体：
//   · 把一段 `code` 写进工作流，就能在**无人值守入口**（定时 / webhook / 子流程）执行任意代码；
//   · `checkToolPermission` 管的是**工具调用**，code 节点**根本不走工具审批** ⇒ 完全绕过。
//   ⇒ 工作流文件因此等价于"可直接执行的脚本"，而它比脚本更容易被当作"配置"传播。
//
// 【修法】判据与 http 节点**完全对称**（不发明第二套规则）：
//   有本次运行的交互授权 `grant` ⇒ 允许（用户当场同意了这次运行）
//   无 grant（定时/webhook/子流程等）⇒ 唯一放行依据是工作流声明 `permissions.code: true`
//   两样都没有 ⇒ **默认拒绝**
//
//   ★ 为什么默认拒绝而非默认允许：code 的能力**严格大于** http
//     （http 只能出网；code 能读 ctx.vars、能无限循环、能吃满 CPU）。
//     给它比 http 更松的默认值说不通。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const read = (p) => readFileSync(new URL(p, `file://${ROOT}`.replace(/\\/g, '/')), 'utf8')
const strip = (s) => s.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

const NODES = strip(read('kernel/workflow-nodes.mjs'))
const ENGINE = strip(read('kernel/workflow-engine.mjs'))

test('★ AI-06：execCode 必须有授权判定（不能裸跑任意 JS）', () => {
  const i = NODES.indexOf('function execCode(')
  assert.ok(i > -1, '必须有 execCode')
  const block = NODES.slice(i, i + 1800)

  assert.match(block, /grant/,
    'execCode 必须检查本次运行的交互授权（`ctx.grant`）—— '
    + '原来它直接 `new vm.Script(code)` 跑节点字符串，**完全没有任何授权判定**')
  assert.match(block, /codeDeclared/,
    'execCode 必须检查工作流自己声明的 `permissions.code` —— 与 http 节点的 networkDeclared 对称')
})

test('★ AI-06：无授权时必须**默认拒绝**并给出可执行指引', () => {
  const i = NODES.indexOf('function execCode(')
  const block = NODES.slice(i, i + 1800)

  // 拒绝分支必须存在，且返回 isError（不是"静默跳过"）
  assert.match(block, /isError:\s*true/,
    '无授权时必须以 isError 返回 —— 静默跳过会让用户以为"节点没被执行"而不是"被拒绝"')
  // 必须告诉用户如何放行（否则只会卡住）
  assert.match(block, /permissions\.code/,
    '拒绝信息必须说明如何显式放行（工作流里声明 permissions.code: true）')
})

test('★ AI-06：引擎必须把 permissions.code 透传到节点上下文', () => {
  assert.match(ENGINE, /codeDeclared/,
    'workflow-engine 必须把 `permissions.code` 作为 codeDeclared 透传给节点 —— '
    + '否则 execCode 里的判据永远拿不到值、等于没接')
  assert.match(ENGINE, /permissions\?\.code/,
    'codeDeclared 必须取自工作流的 permissions.code（与 networkDeclared 同源）')
})

test('★ AI-06：判据必须与 http 节点对称（不得发明第二套规则）', () => {
  // http 节点用 grant 与 networkDeclared；code 节点应当是同一对概念
  const httpIdx = NODES.indexOf('networkDeclared')
  assert.ok(httpIdx > -1, 'http 节点必须有 networkDeclared 判据（既有的对称基准）')
  const codeIdx = NODES.indexOf('function execCode(')
  const codeBlock = NODES.slice(codeIdx, codeIdx + 1800)
  assert.match(codeBlock, /grant/,
    'code 与 http 必须用同一个概念（grant）判定 —— 两套规则会让维护者记错该守哪条')
})

test('★ AI-06：有授权时不得误拦（反向守卫：不能把功能改坏）', () => {
  const i = NODES.indexOf('function execCode(')
  const block = NODES.slice(i, i + 1800)
  // 拒绝条件必须是"两者都没有"，而不是"任一缺失"（后者会把有 grant 的正常运行也拦掉）
  assert.match(block, /grant\s*==\s*null\s*&&[^)]*codeDeclared\s*!==\s*true/,
    '拒绝条件必须是「无 grant **且** 未声明」—— 写成"任一缺失即拒"会把正常的交互运行也拦掉')
})
