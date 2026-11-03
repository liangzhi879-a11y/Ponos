// SEC-07 修复验证（P2 安全）：知识库**写**通道无审计留痕。
//
// 【先说清这一条的边界（诚实记录，避免把"做了半步"说成"做完了"）】
//   台账原文要求"写通道校验 spaceId 属于**该会话已关联空间**"。实测发现这条**无法直接实现**：
//   · `knowledgeSpaces` 是**随报文携带、桥侧零状态**的设计（见其定义处注释）；
//   · 知识路由（含 knowledge-import-routes）**完全不接收 sessionId**。
//   ⇒ 要做会话范围校验，必须给几十处前端调用补参数 + 新增服务端"会话 → 已关联空间"状态 ——
//     那是**设计变更**，不是一次修复。已在台账里如实记为剩余工作。
//
// 【这里落地的半步】把每次**写**都审计留痕。理由：
//   · 写是知识面里唯一会改变用户数据的路径，出事（写错空间 / 误导入敏感目录 /
//     把 dryRun 当成真写入）之后必须能回答"谁在何时往哪个空间写了多少"；
//   · 本仓日志纪律已有先例（readonly-routes 每次**查询**都留痕），唯独**写**没有 —— 不对称。
//
// 【已核实的既有防护（不需要动）】
//   · spaceId 校验很完备：非法字符 / `..` / 结尾点与空格 一律拒，且逐级 realpath 边界检查
//     ⇒ **没有**路径穿越风险（这点已实测确认，不重复实现）；
//   · 敏感路径（.git / node_modules / 工作流目录）与"已在空间目录内的文件"均有拒绝。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const read = (p) => readFileSync(new URL(p, `file://${ROOT}`.replace(/\\/g, '/')), 'utf8')
const strip = (s) => s.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

const IMPORT = strip(read('kernel/knowledge-import.mjs'))

test('★ SEC-07：知识库写操作必须有审计留痕', () => {
  assert.match(IMPORT, /\[knowledge-write\]/,
    '导入/写入必须留一条可检索的审计行 —— 写是唯一改变用户数据的路径，'
    + '而出事后需要能回答"谁在何时往哪个空间写了多少"')
})

test('★ SEC-07：审计必须能区分 dryRun 与真实写入', () => {
  const i = IMPORT.indexOf('[knowledge-write]')
  assert.ok(i > -1, '必须有审计行')
  const block = IMPORT.slice(Math.max(0, i - 600), i + 700)
  assert.match(block, /dryRun/,
    '审计必须写明 dryRun 状态 —— dryRun 与真实写入走同一条代码路径，'
    + '不区分会让人事后误以为"当时真的写了"（或反之）')
})

test('★ SEC-07：审计必须记录目标空间与落盘目录', () => {
  const i = IMPORT.indexOf('[knowledge-write]')
  const block = IMPORT.slice(i, i + 700)
  assert.match(block, /space=/, '审计必须记录目标空间 id')
  assert.match(block, /dir=/, '审计必须记录落盘目录 —— 否则"写到哪儿了"仍不可查')
})

test('★ SEC-07：审计失败不得影响导入结果', () => {
  const i = IMPORT.indexOf('[knowledge-write]')
  // 窗口往前放宽：`try {` 位于 console.log 之前，而中间还有 dryTag 等语句
  // （第一版只取 i-200，被 strip 掉的注释缩短了距离后仍不够，导致把"有 try/catch"判成缺失）
  const block = IMPORT.slice(Math.max(0, i - 900), i + 900)
  assert.match(block, /try\s*\{[\s\S]{0,600}\}\s*catch/,
    '审计必须自带 try/catch —— 日志写不出去绝不能让导入失败'
    + '（与"视觉增强失败回退基础 OCR"同一纪律：增强项不得成为单点故障）')
})

test('★ SEC-07：四态计数必须分开记录（不能只记总数）', () => {
  const i = IMPORT.indexOf('[knowledge-write]')
  const block = IMPORT.slice(i, i + 800)
  for (const k of ['imported=', 'skipped=', 'rejected=', 'failed=']) {
    assert.ok(block.includes(k), `审计必须分别记录 ${k} —— 只记总数无法判断"要不要去换格式重试"`)
  }
})
