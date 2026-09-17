// src/lib/teamOnboardingUi.test.ts —— S3「开通/加入/邀请措辞」的单测（2026-09-17）
//
// 本文件里最重要的是**反向断言②**（spec §5.9 强制小字 + §11「UI 措辞风险」）：
//   ① 邀请/验证码文案**不得**出现"已加密 / 仅受邀可读"这类**肯定式承诺**（源码级扫描，防回归）；
//   ② 强制小字必须真的存在于双语翻译里，且被邀请界面引用（不是"写在某个没人渲染的常量里"）。
// 其余用例覆盖：两种码的格式判据、3 步向导的可推进判据、L1/L2 两档团队源、
// 加入失败态的**逐项区分**（错码 / 过期 / 已用过必须三套不同文案）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'
import { zhCN } from '../i18n/translations/zh-CN.ts'
import { enUS } from '../i18n/translations/en-US.ts'
import {
  IDENT_CODE_LEN, VERIFY_CODE_LEN, digitsOnly, formatCode, checkIdentCode, checkVerifyCode,
  wizardBlockers, canAdvance, nextStep, prevStep, WIZARD_STEPS,
  TEAM_SOURCE_OPTIONS, sourceOption, sourceUnavailableKey,
  TEAM_LAYOUT_ENTRIES, JOIN_FAILURE, joinFailure, JOIN_NETWORK_FAILURE,
  INVITE_DISCLOSURE_KEYS, inviteDisclosureKeys, FORBIDDEN_PERMISSION_CLAIMS,
  findForbiddenClaims, collectStrings, stripComments, CODE_ISSUE_KEYS,
} from './teamOnboardingUi.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8')

// ---------------------------------------------------------------------------
// 码：格式化与校验
// ---------------------------------------------------------------------------

test('两个短数字：9 位识别码 / 6 位验证码，展示成可口头传的分组', () => {
  assert.equal(IDENT_CODE_LEN, 9)
  assert.equal(VERIFY_CODE_LEN, 6)
  assert.equal(formatCode('483920517', IDENT_CODE_LEN), '483 920 517')
  assert.equal(formatCode('739204', VERIFY_CODE_LEN), '739 204')
  assert.equal(formatCode(' 483-920 517 ', IDENT_CODE_LEN), '483 920 517', '从聊天记录复制来的杂质要被清掉')
  assert.equal(formatCode('4839', IDENT_CODE_LEN), '483 9', '没输完也要能分组显示（不补零）')
  assert.equal(formatCode('', IDENT_CODE_LEN), '')
  assert.equal(digitsOnly('ab12-34'), '1234')
})

test('checkIdentCode / checkVerifyCode：空 / 位数 / 非数字三类失败互不混淆', () => {
  assert.deepEqual(checkIdentCode('483920517'), { ok: true, digits: '483920517', len: 9, issueKey: null })
  assert.deepEqual(checkVerifyCode('739204'), { ok: true, digits: '739204', len: 6, issueKey: null })

  const empty = checkIdentCode('   ')
  assert.equal(empty.ok, false)
  assert.equal(empty.issue, 'empty')
  assert.equal(empty.issueKey, CODE_ISSUE_KEYS.empty)

  const short = checkVerifyCode('7392')
  assert.equal(short.issue, 'length', '位数不够 = 还没输完，不是"格式错误"')
  assert.equal(short.issueKey, CODE_ISSUE_KEYS.length)

  const nondigit = checkVerifyCode('73920x')
  assert.equal(nondigit.issue, 'nondigit')
  assert.equal(nondigit.issueKey, CODE_ISSUE_KEYS.nondigit)

  const long = checkIdentCode('4839205177')
  assert.equal(long.ok, false)
  assert.equal(long.issue, 'length')
  assert.equal(checkVerifyCode(undefined).ok, false)
})

// ---------------------------------------------------------------------------
// 3 步向导（§5.9：① 名字+身份 ② 团队源 ③ 初始化 + 识别码 + 邀请）
// ---------------------------------------------------------------------------

test('向导：3 步、步数与顺序约束（第 ① 步不要求目录——"先建实体，再配源"）', () => {
  assert.deepEqual([...WIZARD_STEPS], [1, 2, 3])
  assert.deepEqual(wizardBlockers(1, {}), ['team.wizardNeedName'])
  assert.equal(canAdvance(1, { name: '研发' }), true, '第 ① 步只校验团队名：目录是第 ② 步的事')
  assert.deepEqual(wizardBlockers(2, { sourceKind: 'l1-shared-dir' }), ['team.wizardNeedDir'])
  assert.deepEqual(wizardBlockers(2, { sourceKind: 'l2-server', dir: '/x/team' }), ['team.wizardNeedL1'], '选了未实现的 L2 不得放行')
  assert.equal(canAdvance(2, { sourceKind: 'l1-shared-dir', dir: '/x/team' }), true)
  assert.deepEqual(wizardBlockers(3, {}), [], '第 ③ 步是"已建成 + 邀请"，没有必填项')
  assert.equal(nextStep(1), 2)
  assert.equal(nextStep(2), 3)
  assert.equal(nextStep(3), 3, '没有第 4 步')
  assert.equal(prevStep(1), 1)
  assert.equal(prevStep(3), 2)
})

test('团队源两档：L1 可用；L2 必须画出来但不可用（定案 14：只留结构不做实现）', () => {
  assert.equal(TEAM_SOURCE_OPTIONS.length, 2)
  const l1 = sourceOption('l1-shared-dir')
  const l2 = sourceOption('l2-server')
  assert.equal(l1?.available, true)
  assert.equal(l1?.kind, 'l1-shared-dir')
  assert.equal(l2?.available, false, 'L2 本轮不实现 ⇒ 不能是可选项')
  assert.equal(sourceUnavailableKey('l2-server'), 'team.sourceL2Unavailable')
  assert.equal(sourceUnavailableKey('l1-shared-dir'), null)
  assert.equal(sourceUnavailableKey('s3-ftp'), 'team.sourceUnknown')
  // 每个选项都要有标题与说明（否则界面渲染出一个没有解释的禁用项，用户只会以为坏了）
  for (const o of TEAM_SOURCE_OPTIONS) {
    assert.ok(o.labelKey.startsWith('team.'), `${o.kind} 缺标题键`)
    assert.ok(o.hintKey.startsWith('team.'), `${o.kind} 缺说明键`)
  }
})

test('目录布局：§7.2 六项齐全，且 keys/ 是唯一可能含密钥材料的位置', () => {
  assert.deepEqual(
    TEAM_LAYOUT_ENTRIES.map((e) => e.path),
    ['team.json', 'members/', 'keys/', 'cas/', 'versions/', 'claims/'],
  )
  assert.deepEqual(TEAM_LAYOUT_ENTRIES.filter((e) => e.keyMaterial).map((e) => e.path), ['keys/'])
  for (const e of TEAM_LAYOUT_ENTRIES) assert.ok(e.hintKey.startsWith('team.layout'), `${e.path} 缺说明键`)
})

// ---------------------------------------------------------------------------
// 加入失败态：错码 / 过期 / 已用过必须三套文案
// ---------------------------------------------------------------------------

test('加入失败态逐项区分：错码、过期、已用过是三套不同文案，且"不可重试"语义正确', () => {
  const bad = joinFailure('bad-code')
  const expired = joinFailure('expired')
  const used = joinFailure('already-used')
  const keys = [bad.titleKey, expired.titleKey, used.titleKey]
  assert.equal(new Set(keys).size, 3, '三者必须文案不同——否则用户会反复重试一个永远不会成功的码')
  for (const k of keys) assert.ok(k.startsWith('team.joinErr'), `${k} 命名不合约定`)
  assert.equal(bad.retriable, true, '码打错 → 改一个数字重试是有意义的')
  assert.equal(expired.retriable, false, '过期 → 重试同一个码永远失败，界面不该诱导重试')
  assert.equal(used.retriable, false, '一次性已消费 → 同上')
  // 每个内置错误码都要有 hint（§10 S3-4：未匹配时给出**可操作**提示）
  for (const [code, copy] of Object.entries(JOIN_FAILURE)) {
    assert.ok(copy.hintKey.startsWith('team.joinErr'), `${code} 缺可操作提示键`)
  }
  assert.ok(JOIN_FAILURE['ident-not-found'])
  assert.ok(JOIN_FAILURE['ident-ambiguous'])
  assert.ok(JOIN_FAILURE['no-envelope'])
  assert.ok(JOIN_FAILURE['search-root-missing'])
  // 未知码不静默
  assert.equal(joinFailure('who-knows').titleKey, 'team.joinErrUnknown')
  assert.equal(joinFailure(undefined).titleKey, 'team.joinErrUnknown')
  assert.ok(JOIN_NETWORK_FAILURE.titleKey.startsWith('team.joinErr'))
})

test('邀请披露键：三件事（ACL/验证码作用/无强制力）成套给出，且不重名', () => {
  const keys = inviteDisclosureKeys()
  assert.equal(keys.length, 3)
  assert.equal(new Set(keys).size, 3)
  assert.deepEqual(keys, [INVITE_DISCLOSURE_KEYS.acl, INVITE_DISCLOSURE_KEYS.code, INVITE_DISCLOSURE_KEYS.enforcement])
  assert.ok(INVITE_DISCLOSURE_KEYS.modeNotIsolation.startsWith('team.'))
})

// ---------------------------------------------------------------------------
// 🔴 反向断言②：措辞不得制造虚假安全感
// ---------------------------------------------------------------------------

test('判定规则自检：肯定式承诺必命中，否认句式不得误报', () => {
  // 允许重叠命中（便于排障时看到"哪几句都不对"），故按包含断言而不是逐字比对
  const zhHits = findForbiddenClaims('数据已加密，仅受邀者可读')
  for (const c of ['已加密', '仅受邀', '受邀者可读']) assert.ok(zhHits.includes(c), `应命中「${c}」，实际 ${zhHits}`)
  const enHits = findForbiddenClaims('All files are encrypted and invite-only')
  for (const c of ['are encrypted', 'invite-only']) assert.ok(enHits.includes(c), `应命中「${c}」，实际 ${enHits}`)
  assert.deepEqual(findForbiddenClaims(''), [])
  // 合法文案：**必须**能说"验证码不是加密钥匙"（否则只能回避这个词、反而说不清边界）
  assert.deepEqual(findForbiddenClaims('验证码只用于成员登记，不是数据加密的钥匙'), [])
  assert.deepEqual(
    findForbiddenClaims('The code is not an encryption key; access is decided by folder ACLs.'),
    [],
  )
  assert.ok(FORBIDDEN_PERMISSION_CLAIMS.length >= 10, '禁用清单太少就形同虚设')
})

test('stripComments：注释里的"引用禁令原文"不算违规，代码里的承诺仍然命中', () => {
  // 注释（含块注释/行注释）必须被剥掉：否则维护者不敢在注释里引用禁令原文
  const commented = '// 不得暗示"数据已加密"或"仅受邀者可读"\n/* 同上：仅受邀 */\nconst x = 1\n'
  assert.deepEqual(findForbiddenClaims(stripComments(commented)), [], '注释不是文案，不该报')
  // 但代码里的字符串**必须**照旧命中（这是这条守卫存在的意义）
  assert.ok(findForbiddenClaims(stripComments('const s = t("数据已加密")')).includes('已加密'))
  assert.ok(findForbiddenClaims(stripComments("const s = 'only invited users'")).includes('only invited users'))
  // 字面量里的 `//`（URL）不能被当成注释截断
  assert.match(stripComments("const u = 'http://x/已加密'"), /http:\/\/x/)
  assert.equal(stripComments('a // note'), 'a  ')
})

/** 递归收集 src/components/team 下的 .tsx/.ts（排除测试）。 */
function collectTeamSources(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) { collectTeamSources(p, acc); continue }
    if (!/\.tsx?$/.test(name)) continue
    if (/\.test\.tsx?$/.test(name)) continue
    acc.push(p)
  }
  return acc
}

test('反向断言②（UI 源码级）：团队界面与数据层不得出现"已加密/仅受邀可读"式承诺', () => {
  const files = [
    ...collectTeamSources(join(REPO, 'src/components/team')),
    join(REPO, 'src/lib/teamApi.ts'),
    join(REPO, 'src/lib/teamModeUi.ts'),
    join(REPO, 'src/stores/teamStore.ts'),
  ]
  assert.ok(files.length >= 3, `扫描范围异常（只找到 ${files.length} 个文件），这条守卫等于没守`)
  const offenders: string[] = []
  for (const f of files) {
    // **先剥注释**：注释是写给人看的（含"不得暗示『已加密』"这类禁令原文），到不了用户眼前；
    // 守卫要盯的是渲染出去的字符串（理由与边界见 stripComments 的注释）。
    for (const hit of findForbiddenClaims(stripComments(readFileSync(f, 'utf8')))) {
      offenders.push(`${relative(REPO, f).replace(/\\/g, '/')} → "${hit}"`)
    }
  }
  assert.deepEqual(
    offenders, [],
    'spec §5.9 强制约束：应用层"邀请"**不具有强制力**（读取权限由 OS ACL/网盘权限决定）⇒ ' +
    '文案不得暗示"已加密/仅受邀可读"。注：`src/lib/teamOnboardingUi.ts` 持有禁用清单字面量，' +
    '故不在本扫描范围内（清单本身由 findForbiddenClaims 的自检用例钉住）：\n  ' + offenders.join('\n  '),
  )
})

test('反向断言②（文案级）：双语 team.* 文案无违规承诺，且强制小字确实存在', () => {
  const zhTeam = (zhCN as { team?: Record<string, unknown> }).team
  const enTeam = (enUS as { team?: Record<string, unknown> }).team
  assert.ok(zhTeam && enTeam, 'i18n 缺少 team 命名空间')

  for (const [lang, sub] of [['zh-CN', zhTeam], ['en-US', enTeam]] as const) {
    for (const s of collectStrings(sub)) {
      const hits = findForbiddenClaims(s)
      assert.deepEqual(hits, [], `${lang} 文案出现违规承诺：${hits.join(',')} —— ${s}`)
    }
  }

  // 强制小字（§5.9 原文：「访问权限由共享目录 / 网盘的操作系统权限控制，请另行设置。」）
  // 披露键是**全路径**（`team.inviteAclNote`），子树查表要去掉 `team.` 前缀
  const sub = (k: string) => String((zhTeam as Record<string, unknown>)[k.replace(/^team\./, '')] ?? '')
  const acl = sub(INVITE_DISCLOSURE_KEYS.acl)
  assert.match(acl, /操作系统权限|OS 权限/, '小字必须点明权限来源是操作系统/网盘权限')
  assert.match(acl, /请另行设置/, 'small print 必须给出动作（请另行设置），不能只是免责')
  const codeNote = sub(INVITE_DISCLOSURE_KEYS.code)
  assert.match(codeNote, /成员登记/, '验证码必须说明"仅为成员登记"（spec §5.9 明文）')
  assert.match(codeNote, /一次性|只能用一次/, '验证码一次性必须写明')
  const modeNote = sub(INVITE_DISCLOSURE_KEYS.modeNotIsolation)
  assert.match(modeNote, /不是|不等于/, '模式语义必须明说"模式 ≠ 隔离"（§5.9）')
  // 英文侧也要有对应的两条关键披露（只查"存在且非空"，措辞由 findForbiddenClaims 守）
  for (const k of inviteDisclosureKeys()) {
    const en = String((enTeam as Record<string, unknown>)[k.replace(/^team\./, '')] ?? '')
    assert.ok(en.length > 20, `en-US 缺披露文案 ${k}`)
  }

  // 键名对齐（zh/en 各一份，无缺漏）
  const keysOf = (o: Record<string, unknown>, prefix = ''): string[] =>
    Object.entries(o).flatMap(([k, v]) => {
      const p = prefix ? `${prefix}.${k}` : k
      return v && typeof v === 'object' && !Array.isArray(v) ? keysOf(v as Record<string, unknown>, p) : [p]
    })
  const zhKeys = keysOf(zhTeam).sort()
  const enKeys = keysOf(enTeam).sort()
  assert.deepEqual(enKeys, zhKeys, 'zh-CN / en-US 的 team.* 键必须一一对应（缺一个就渲染出裸键名）')
  assert.ok(zhKeys.length > 40, `team.* 键只有 ${zhKeys.length} 个，疑似漏加`)
})

test('反向断言②（接线级）：邀请界面与模式开关必须渲染强制小字', () => {
  const invite = read('src/components/team/InviteMemberPanel.tsx')
  assert.match(invite, /INVITE_DISCLOSURE_KEYS\.acl/, '邀请界面必须渲染 ACL 小字')
  assert.match(invite, /INVITE_DISCLOSURE_KEYS\.code/, '邀请界面必须说明验证码仅为成员登记')
  assert.match(invite, /INVITE_DISCLOSURE_KEYS\.enforcement/, '邀请界面必须说明应用层登记无强制力')
  const modeSwitch = read('src/components/team/TeamModeSwitch.tsx')
  assert.match(modeSwitch, /INVITE_DISCLOSURE_KEYS\.modeNotIsolation/, '模式开关必须明说"模式 ≠ 隔离"')
})
