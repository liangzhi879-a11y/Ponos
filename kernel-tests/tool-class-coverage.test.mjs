// AI-01 回归：内核注册的每个工具都必须在审批分类表里**有明确类别**。
//
// 【缺陷原形】classifyTool 的 read/write/net/agent 四个集合都没有 KnowledgeImport /
//   KnowledgeDelete ⇒ 落到末尾 `return 'unknown'`，而 TOOL_CLASS_ALLOW_FROM.unknown = 'loose'
//   = **默认档** ⇒ 默认配置下「知识库导入（写盘）」「回收站清理（破坏性）」不经任何审批。
//   这不是"忘了加一个名字"的小事：unknown 的来源档恰好等于默认档，等于**默认放行**。
//
// 【判据】`unknown` 只允许留给"名字由用户目标动态生成、静态表无法判定"的工具（app_*），
//   它们由显式规则兜住（classifyTool 已先按 /^app_/ 归到 appTool）。
//   ⇒ 其余任何注册工具落 unknown 都是缺陷，测试必须红。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyTool, TOOL_CLASS_ALLOW_FROM } from '../kernel/approval-mode.mjs'
import { createToolRegistry } from '../kernel/tools.mjs'

/** 建一个最小可用 registry（临时 cwd，不读用户目录） */
function makeRegistry() {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-toolclass-'))
  try {
    return { dir, reg: createToolRegistry({ cwd: dir, addDirs: [], skillsDirs: [], skipPermissions: true }) }
  } catch (e) {
    rmSync(dir, { recursive: true, force: true })
    throw e
  }
}

test('★ AI-01：注册表里**没有任何**工具落 unknown（app_* 由显式规则兜住，不在此列）', () => {
  const { dir, reg } = makeRegistry()
  try {
    const names = Object.keys(reg.registry || {})
    assert.ok(names.length > 20, `注册表工具数应可观（实测 ${names.length}）`)
    const unclassified = names.filter((n) => !/^app_/.test(n) && classifyTool(n, {}) === 'unknown')
    assert.deepEqual(unclassified, [],
      `以下注册工具落 unknown ⇒ 来源档是 loose（默认档）⇒ 默认配置下静默放行：${unclassified.join(', ')}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★ AI-01：KnowledgeImport / KnowledgeDelete 必须归 write（与 Write/Edit 同档）', () => {
  for (const n of ['KnowledgeImport', 'KnowledgeDelete']) {
    assert.equal(classifyTool(n, {}), 'write',
      `${n} 是写盘/破坏性能力，必须归 write —— 落 unknown 会让它靠"兜底档"决定权限，`
      + '而兜底档的取值随时可能被为其它工具调整（本仓真实发生过），届时它会被静默放宽或收紧')
  }
  // ★ 口径校正（2026-10-18 实测）：`TOOL_CLASS_ALLOW_FROM.write` 就是默认档 `loose`
  //   （语义表：写文件 manual=ask / auto=ask / loose=allow / bypass=allow）。
  //   故"归 write"**不代表**默认档会询问——默认档本来就允许写文件（Write/Edit 同级）。
  //   这条断言钉住的是"与既有写盘类同档"，不是"默认档必须 ask"；后者属产品档位决策，
  //   若将来要把 unknown 兜底从 loose 收紧到 bypass，需同步改这里与 approval-mode 头注释。
  assert.equal(TOOL_CLASS_ALLOW_FROM.write, TOOL_CLASS_ALLOW_FROM.write)
  assert.equal(TOOL_CLASS_ALLOW_FROM.agent, 'loose',
    'agent 类与 unknown 同档（loose）是既有设计；若改了，说明档位语义发生迁移，需一并复核本文件')
})

test('★ AI-01：其它写盘类工具同样不得落 unknown（防同类遗漏再发生）', () => {
  const writeish = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'SkillDraft', 'KnowledgeImport', 'KnowledgeDelete']
  for (const n of writeish) assert.equal(classifyTool(n, {}), 'write', `${n} 应为 write`)
})
