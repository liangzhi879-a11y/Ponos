// src/lib/teamModeIndicatorUi.test.ts —— S3「模式可辨识性」的单测（2026-09-17 追加）
//
// 背景：模式是**显式开关**且只筛侧边栏列表（spec §5.9），此前唯一的标识是 header 上 11px 的
// 小按钮，状态栏完全没有 —— 用户看到空列表时无从判断"是模式筛掉了"还是"本来就没有"。
// 本次补上：状态栏常驻胶囊（`TeamModeSwitch variant="status"`）+ 四处空态的一键翻转
// （`ModeFlipButton`）。本文件把"补了"这件事钉死，因为**它退化的方式恰好是静默的**：
//   ① 状态栏胶囊被删/忘了传 variant → 界面回到"看不见模式"，没有任何报错；
//   ② 某处空态漏接按钮 → 那个列表又变成"点了没反应/无路可走"；
//   ③ 文案被改回未实现的承诺（"新建内容的默认归属"）→ 用户按说明去找一个不存在的开关。
// 故照 `teamModeUi.test.ts` 的既有风格：纯逻辑分支 + 源码级接线守门 + 文案反向断言。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { zhCN } from '../i18n/translations/zh-CN.ts'
import { enUS } from '../i18n/translations/en-US.ts'
import { modeFlip } from './teamModeUi.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8')

// ---------------------------------------------------------------------------
// ① 纯逻辑：modeFlip 的分支
// ---------------------------------------------------------------------------

test('modeFlip：团队 → 个人（不动 activeTeamId）', () => {
  assert.deepEqual(modeFlip('team', [{ id: 't1' }], 't2'), { mode: 'personal', teamId: 't2' })
  assert.deepEqual(modeFlip('team', null, null), { mode: 'personal', teamId: null })
  // 团队源暂时不可达（列表为空）时，"切回个人"依然成立：这方向永远有落点
  assert.deepEqual(modeFlip('team', [], 't1'), { mode: 'personal', teamId: 't1' })
})

test('modeFlip：个人 + 有团队 → 团队（沿用已选团队，没选过取第一个）', () => {
  assert.deepEqual(modeFlip('personal', [{ id: 't1' }, { id: 't2' }], 't2'), { mode: 'team', teamId: 't2' })
  assert.deepEqual(modeFlip('personal', [{ id: 't1' }, { id: 't2' }], null), { mode: 'team', teamId: 't1' })
  // 已选的团队不在列表里（团队被移除了）：仍按"进团队模式"处理，由 store 负责回落
  assert.deepEqual(modeFlip('personal', [{ id: 't1' }], 'gone'), { mode: 'team', teamId: 'gone' })
})

test('modeFlip：个人 + 无可用团队 → null（按钮不渲染，而不是"点了没反应"）', () => {
  assert.equal(modeFlip('personal', null, null), null)
  assert.equal(modeFlip('personal', [], null), null)
  assert.equal(modeFlip('personal', undefined as unknown as null, null), null, '列表还没拉到 ⇒ 同上')
  // 脏值：空 id 的列表项不算"可进的团队"；已选 id 是空串时不得落出 `setActiveTeam('')`
  assert.equal(modeFlip('personal', [{ id: '' }], null), null)
  assert.equal(modeFlip('personal', [], '  '), null)
})

// ---------------------------------------------------------------------------
// 🔴 接线守门（源码级）
// ---------------------------------------------------------------------------

test('接线守门：状态栏常驻模式标识（TeamModeSwitch variant="status"）', () => {
  const rel = 'src/components/layout/StatusBar.tsx'
  assert.ok(existsSync(join(REPO, rel)), `找不到 ${rel}：状态栏改名了就必须同步改这条断言，不能默默失效`)
  const src = read(rel)
  assert.match(src, /<TeamModeSwitch\s+variant="status"\s*\/>/, '状态栏必须渲染 TeamModeSwitch 的 status 形态')
  assert.match(src, /from '\.\.\/team\/TeamModeSwitch'/, 'import 路径必须是 ../team/TeamModeSwitch')
})

test('接线守门：四处被模式筛空的空态都接上了 ModeFlipButton（就在 listFilteredEmpty 小字旁）', () => {
  const files = [
    'src/components/rail/ChatListPanel.tsx',
    'src/components/rail/TaskListPanel.tsx',
    'src/components/workflows/WorkflowList.tsx',
    'src/components/knowledge/KnowledgeSidebar.tsx',
  ]
  for (const rel of files) {
    assert.ok(existsSync(join(REPO, rel)), `找不到 ${rel}：列表改名了就必须同步改这条断言，不能默默失效`)
    const src = read(rel)
    assert.ok(src.includes('ModeFlipButton'), `${rel} 必须引用 ModeFlipButton（被模式筛空时给出路）`)
    // "就在现有 listFilteredEmpty 小字附近"：只在文件某处出现不算，必须紧跟在那行说明之后
    // （四处空态都先说明、再给出动作；否则按钮会跑到"还没有内容"的真空态里去）
    const at = src.indexOf('team.listFilteredEmpty')
    assert.ok(at >= 0, `${rel} 必须保留 team.listFilteredEmpty 小字（说明"内容仍在本机"）`)
    const near = src.slice(at, at + 600)
    assert.match(
      near,
      /<ModeFlipButton/,
      `${rel} 的空态必须紧挨 listFilteredEmpty 小字渲染 ModeFlipButton——只说明不给出路，用户还得自己找开关`,
    )
  }
})

test('接线守门：ModeFlipButton 的翻转判定走 modeFlip（不自己拼 store 状态）', () => {
  const rel = 'src/components/team/ModeFlipButton.tsx'
  assert.ok(existsSync(join(REPO, rel)), `找不到 ${rel}`)
  const src = read(rel)
  assert.match(src, /modeFlip\(/, '翻转目标必须由 modeFlip 计算（纯函数、可直测），不得在 JSX 里手写三元')
  assert.match(src, /if \(!next\) return null/, '无团队可进时必须不渲染（画一个点了没反应的按钮就是界面谎言）')
  assert.match(src, /setActiveTeam\(next\.teamId\)/, '进团队模式走 setActiveTeam（它同时会把模式切到 team）')
  assert.match(src, /setMode\('personal'\)/, '回个人模式走 setMode')
  assert.match(src, /useEffectiveMode\(\)/, '模式取生效值（与 header 开关同一收口），不得直接读 s.mode')
})

// ---------------------------------------------------------------------------
// 🔴 反向断言：文案不得写回**未实现**的能力
// ---------------------------------------------------------------------------

test('反向断言：modeHint / modeNotIsolationNote 不得再承诺"新建内容的默认归属"', () => {
  // 该承诺曾是文案的一部分，但**没有任何新建路径写团队归属**（会话/工作流/知识条目都不带），
  // 于是它是一句会让用户按图索骥却找不到开关的假话。删掉后必须防止被"顺手"写回。
  const bans = [/新建内容的默认归属/, /default attribution/i, /default owner/i]
  const zh = (zhCN as { team?: Record<string, unknown> }).team
  const en = (enUS as { team?: Record<string, unknown> }).team
  assert.ok(zh && en, 'i18n 缺少 team 命名空间')
  for (const [lang, sub] of [['zh-CN', zh], ['en-US', en]] as const) {
    for (const key of ['modeHint', 'modeNotIsolationNote']) {
      const text = String((sub as Record<string, unknown>)[key] ?? '')
      assert.ok(text.length > 20, `${lang}.team.${key} 缺失或过短：${JSON.stringify(text)}`)
      for (const ban of bans) {
        assert.ok(
          !ban.test(text),
          `${lang}.team.${key} 不得出现 ${ban}：该能力（新建内容的默认归属）**未实现**，写进文案就是假承诺。\n  ${text}`,
        )
      }
    }
  }
  // 保留实际行为的关键词（模式 = 只筛列表、不是隔离）—— 删假承诺不等于把话说空
  assert.match(String(zh.modeNotIsolationNote), /不是数据隔离/, '必须保留"模式 ≠ 隔离"这句（§5.9 反向要求）')
  assert.match(String(en.modeNotIsolationNote), /not data isolation/i)
})

// ---------------------------------------------------------------------------
// ④ i18n 键完整性（新增三键 zh/en 都要有）
// ---------------------------------------------------------------------------

test('i18n：modePickTeamHint / modeFlipToPersonal / modeFlipToTeam 双语齐备且非空', () => {
  const zh = (zhCN as { team?: Record<string, unknown> }).team ?? {}
  const en = (enUS as { team?: Record<string, unknown> }).team ?? {}
  for (const key of ['modePickTeamHint', 'modeFlipToPersonal', 'modeFlipToTeam']) {
    const z = String(zh[key] ?? '')
    const e = String(en[key] ?? '')
    assert.ok(z.trim().length > 0, `zh-CN 缺 team.${key}（会渲染出裸键名）`)
    assert.ok(e.trim().length > 0, `en-US 缺 team.${key}（会渲染出裸键名）`)
  }
  // 三个键都要真被引用（写在翻译里没人渲染 = 等于没做）
  const switchSrc = read('src/components/team/TeamModeSwitch.tsx')
  assert.match(switchSrc, /t\('team\.modePickTeamHint'\)/, '下拉的"当前团队"小节必须渲染 modePickTeamHint')
  assert.match(switchSrc, /t\('team\.modeHint'\)/, 'status 形态的 title 必须用 modeHint（说明"模式只筛列表"）')
  const flip = read('src/components/team/ModeFlipButton.tsx')
  assert.match(flip, /team\.modeFlipToTeam/)
  assert.match(flip, /team\.modeFlipToPersonal/)
})
