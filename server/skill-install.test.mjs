// 内置技能更新链（2026-09-12 P2-2）
// ---------------------------------------------------------------------------
// 病灶（实证）：autoInstallSamples 有两处短路——① `.auto-installed.json` 标记存在即整体
// return；② 逐个技能 `existsSync(target)` 即跳过。后果：内置技能的后续更新**永远到不了
// 用户的 ~/.yfw/skills**。live home 的 using-superpowers/SKILL.md 里没有 triggers（源码
// 已加），11 个技能的触发词修复对存量安装等于没做。
// 修复：marker 改为指纹台账（files: '<id>/<相对路径>' → 上次写入内容的 sha256 前 16 位），
// 逐文件比对；比对基准必须是**占位符重写后**的内容，否则每个含 {{YFW_SKILLS}} 的技能
// 都会被误判成"用户改过"而永不更新——这是本文件里专门有一条用例守着的原因。
// 本测试直接 import 模块（bridge.mjs 顶层会 listen + 自愈 taskkill，不能 import）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installBuiltinSkills, copyWithRewrite } from './skill-install.mjs'

// 源根：两个目录形态技能 + 一个共享库；content 里带 {{YFW_SKILLS}}（重写路径的真实形态）
function makeEnv({ withPlaceholder = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'skill-install-'))
  const src = join(dir, 'src')
  const dst = join(dir, 'dst')
  mkdirSync(join(src, 'alpha'), { recursive: true })
  mkdirSync(join(src, 'beta'), { recursive: true })
  mkdirSync(join(src, '_common'), { recursive: true })
  writeFileSync(join(src, 'alpha', 'SKILL.md'),
    '---\nname: alpha\ndescription: 甲技能\nversion: 1.0.0\ntriggers:\n  - 甲\n---\n'
    + (withPlaceholder ? '读取 {{YFW_SKILLS}}/alpha/lib.md\n' : '读取 lib.md\n'))
  writeFileSync(join(src, 'alpha', 'lib.md'), '甲的实现\n')
  writeFileSync(join(src, 'beta', 'SKILL.md'), '---\nname: beta\ndescription: 乙技能\n---\n乙正文\n')
  writeFileSync(join(src, '_common', 'shared.md'), '共享库 {{YFW_SKILLS}}\n')
  // 非技能目录（无 SKILL.md）不得被装
  mkdirSync(join(src, 'not-a-skill'), { recursive: true })
  writeFileSync(join(src, 'not-a-skill', 'README.md'), '不是技能\n')
  return {
    dir, src, dst,
    manifestPath: join(dst, '.auto-installed.json'),
    run: () => installBuiltinSkills({ srcRoot: src, dstRoot: dst, manifestPath: join(dst, '.auto-installed.json') }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

const read = (p) => readFileSync(p, 'utf-8')

test('首次安装：目录形态技能 + _common 全部落地，非技能目录不装，占位符被重写', () => {
  const env = makeEnv()
  try {
    mkdirSync(env.dst, { recursive: true })
    const r = env.run()
    assert.deepEqual(r.installed.sort(), ['_common', 'alpha', 'beta'], `首次应装 3 项（实际 ${JSON.stringify(r)}）`)
    assert.deepEqual(r.updated, [], '首次不应有更新项')
    assert.ok(existsSync(join(env.dst, 'alpha', 'SKILL.md')), 'alpha 应落地')
    assert.ok(existsSync(join(env.dst, 'alpha', 'lib.md')), 'alpha 的子文件应一并拷贝')
    assert.ok(!existsSync(join(env.dst, 'not-a-skill')), '无 SKILL.md 的目录不得当技能装')
    // {{YFW_SKILLS}} 必须被重写成真实目标根（'/' 归一），否则装完的技能仍指向未替换的占位符
    const md = read(join(env.dst, 'alpha', 'SKILL.md'))
    assert.ok(!md.includes('{{YFW_SKILLS}}'), `占位符必须被重写（实际：${md.split('\n').pop()}）`)
    assert.ok(md.includes(env.dst.replace(/\\/g, '/') + '/alpha/lib.md'), '重写后的路径应指向真实技能根')
    // 索引条目照旧写入（面板读它；_common 是共享库，不进索引）
    const idx = JSON.parse(read(join(env.dst, '_skill_index.json')))
    assert.deepEqual(idx.map((s) => s.id).sort(), ['alpha', 'beta'], '目录形态技能应写索引')
    // 台账记的是"写下去的字节"：key 覆盖面完整
    const marker = JSON.parse(read(env.manifestPath))
    assert.ok(marker.files['alpha/SKILL.md'] && marker.files['alpha/lib.md'] && marker.files['_common/shared.md'],
      `台账应逐文件记指纹（实际 ${Object.keys(marker.files).join(', ')}）`)
  } finally { env.cleanup() }
})

test('幂等：紧接着再扫一遍 → 全 unchanged，且不重写任何文件（零抖动）', () => {
  const env = makeEnv()
  try {
    mkdirSync(env.dst, { recursive: true })
    env.run()
    const mdPath = join(env.dst, 'alpha', 'SKILL.md')
    const before = read(mdPath)
    const r2 = env.run()
    assert.equal(r2.installed.length, 0, `第二遍不应再装（实际 installed=${r2.installed.join(',')}）`)
    assert.equal(r2.updated.length, 0, `第二遍不应更新（实际 updated=${r2.updated.join(',')}）`)
    assert.equal(r2.unchanged, 3, `第二遍应三项全 unchanged（实际 ${r2.unchanged}）`)
    assert.equal(read(mdPath), before, '内容未变就不该被重写')
    assert.ok(!existsSync(join(env.dst, 'alpha', 'SKILL.md.bak')), '无差异不应产生 .bak')
  } finally { env.cleanup() }
})

test('含占位符的技能能被更新（不是"永远判成用户改过"）—— 比对基准是重写后的内容', () => {
  const env = makeEnv()
  try {
    mkdirSync(env.dst, { recursive: true })
    env.run()
    // 源升级：带占位符的文件内容变化 → 必须走 updated（这正是被两处短路吞掉的那类更新）
    writeFileSync(join(env.src, 'alpha', 'SKILL.md'),
      '---\nname: alpha\ndescription: 甲技能\nversion: 1.1.0\ntriggers:\n  - 甲\n  - 甲二\n---\n读取 {{YFW_SKILLS}}/alpha/lib.md\n新步骤\n')
    const r = env.run()
    assert.deepEqual(r.updated, ['alpha'], `含占位符的技能必须能更新（实际 ${JSON.stringify(r)}）`)
    assert.equal(r.kept.length, 0, '用户没改过就不该判 kept')
    assert.match(read(join(env.dst, 'alpha', 'SKILL.md')), /新步骤/, '新版内容应落地')
    assert.ok(existsSync(join(env.dst, 'alpha', 'SKILL.md.bak')), '覆盖前应备份旧版为 SKILL.md.bak')
    assert.match(read(join(env.dst, 'alpha', 'SKILL.md.bak')), /version: 1\.0\.0/, '备份应是旧版内容')
    // 触发词修复随索引可见（version 应刷到 1.1.0）
    const idx = JSON.parse(read(join(env.dst, '_skill_index.json')))
    assert.equal(idx.find((s) => s.id === 'alpha')?.version, '1.1.0', '索引版本应随更新刷新')
  } finally { env.cleanup() }
})

test('用户改过的技能绝不被覆盖（且不产生 .bak 假象）', () => {
  const env = makeEnv()
  try {
    mkdirSync(env.dst, { recursive: true })
    env.run()
    // 用户手改 alpha/SKILL.md（台账里的指纹随之对不上）
    const userText = '---\nname: alpha\ndescription: 我自己改的\n---\n我的本地改动\n'
    writeFileSync(join(env.dst, 'alpha', 'SKILL.md'), userText)
    // 源同时升级 → 冲突：必须保用户版本
    writeFileSync(join(env.src, 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: 甲技能\nversion: 2.0.0\n---\n官方新版\n')
    const r = env.run()
    assert.deepEqual(r.kept, ['alpha'], `用户改过的技能应整体跳过（实际 ${JSON.stringify(r)}）`)
    assert.equal(r.updated.length, 0, 'kept 的技能不得同时算作 updated')
    assert.equal(read(join(env.dst, 'alpha', 'SKILL.md')), userText, '用户内容必须原样保留')
    assert.ok(!existsSync(join(env.dst, 'alpha', 'SKILL.md.bak')), '跳过时不该留下 .bak')
    // beta 没被动过，照常 update 路径可用；这里源没变，故 unchanged
    assert.equal(r.unchanged, 2, `其余两项应 unchanged（实际 ${r.unchanged}）`)
  } finally { env.cleanup() }
})

test('台账缺失（旧安装/首次）时按 unknown 处理：未知差异照常更新，不误判成用户改动', () => {
  const env = makeEnv()
  try {
    // 模拟"旧版安装器装的"：文件在、台账不在 → 无 fingerprint 可依，按内置内容更新
    mkdirSync(join(env.dst, 'alpha'), { recursive: true })
    writeFileSync(join(env.dst, 'alpha', 'SKILL.md'), '---\nname: alpha\n---\n旧安装器的老版本\n')
    const r = env.run()
    assert.ok(r.updated.includes('alpha'), `无台账的存量技能应被更新（实际 ${JSON.stringify(r)}）`)
    assert.equal(r.kept.length, 0, '无台账不得当成"用户改过"')
    assert.match(read(join(env.dst, 'alpha', 'SKILL.md')), /甲技能/, '应更新为内置新版')
  } finally { env.cleanup() }
})

test('覆盖前逐个备份：辅助文件（非 SKILL.md）被改写时也留 .bak，无副本可退', () => {
  const env = makeEnv({ withPlaceholder: false })
  try {
    // 旧安装形态：文件在、台账无（首扫"未知漂移"= 风险最高的一类）
    mkdirSync(join(env.dst, 'alpha'), { recursive: true })
    writeFileSync(join(env.dst, 'alpha', 'SKILL.md'), '---\nname: alpha\n---\n老版本\n')
    writeFileSync(join(env.dst, 'alpha', 'lib.md'), '用户手改过的实现（旧安装时就在这）\n')
    const r = env.run()
    assert.ok(r.updated.includes('alpha'), '无台账的存量技能应更新')
    assert.ok(existsSync(join(env.dst, 'alpha', 'SKILL.md.bak')), 'SKILL.md 应有 .bak')
    assert.ok(existsSync(join(env.dst, 'alpha', 'lib.md.bak')), '被改写的辅助文件同样应有 .bak')
    assert.match(read(join(env.dst, 'alpha', 'lib.md.bak')), /用户手改过的实现/, '.bak 里应是覆盖前的原文')
    assert.match(read(join(env.dst, 'alpha', 'lib.md')), /甲的实现/, '新内容照常落地')
  } finally { env.cleanup() }
})

test('行尾不算内容差异：已装内容仅 CRLF/LF 不同 → unchanged（不为行尾churn烧 .bak）', () => {
  const env = makeEnv({ withPlaceholder: false })
  try {
    mkdirSync(env.dst, { recursive: true })
    env.run()
    // 把已装文件改成 LF（源是 CRLF/或反之），内容一字不差 → 不得判成要更新
    const p = join(env.dst, 'beta', 'SKILL.md')
    const lf = readFileSync(p, 'utf-8').replace(/\r\n/g, '\n')
    writeFileSync(p, lf, 'utf-8')
    const r = env.run()
    assert.equal(r.updated.length, 0, `仅行尾不同不该更新（实际 updated=${r.updated.join(',')}）`)
    assert.equal(read(p), lf, '内容一字不差时不该被改写')
    assert.ok(!existsSync(join(env.dst, 'beta', 'SKILL.md.bak')), '不该为此产生 .bak')
  } finally { env.cleanup() }
})

test('台账与比对同基准：更新后再把行尾改一遍，仍判 unchanged（否则会永久 kept）', () => {
  const env = makeEnv()
  try {
    mkdirSync(env.dst, { recursive: true })
    env.run()
    // 真内容变化 → updated，写入台账
    writeFileSync(join(env.src, 'beta', 'SKILL.md'), '---\nname: beta\ndescription: 乙技能\n---\n乙正文 v2\n')
    assert.deepEqual(env.run().updated, ['beta'])
    // 用户把行尾改掉（内容不变）→ 必须仍是 unchanged，而不是被当成用户改动永久 kept
    const p = join(env.dst, 'beta', 'SKILL.md')
    writeFileSync(p, readFileSync(p, 'utf-8').replace(/\r\n/g, '\n'), 'utf-8')
    const r = env.run()
    assert.equal(r.kept.length, 0, `行尾变化不得被判成用户改动（实际 kept=${r.kept.join(',')}）`)
    assert.equal(r.updated.length, 0, '内容未变不该再更新')
  } finally { env.cleanup() }
})

test('源根不存在：返回空统计而不是抛错（boot 路径不得被它带崩）', () => {
  const env = makeEnv()
  try {
    const r = installBuiltinSkills({ srcRoot: join(env.dir, 'nope'), dstRoot: env.dst, manifestPath: env.manifestPath })
    assert.deepEqual({ i: r.installed.length, u: r.updated.length, f: r.failed.length }, { i: 0, u: 0, f: 0 })
  } finally { env.cleanup() }
})

test('copyWithRewrite：文本做占位符重写、二进制原样（导出给单技能安装路径复用）', () => {
  const env = makeEnv()
  try {
    const src = join(env.dir, 'c1')
    const dst = join(env.dir, 'c2')
    mkdirSync(join(src, 'sub'), { recursive: true })
    writeFileSync(join(src, 'a.md'), 'x {{YFW_SKILLS}} y')
    writeFileSync(join(src, 'sub', 'b.bin'), Buffer.from([0, 1, 2, 255]))
    mkdirSync(dst, { recursive: true })
    copyWithRewrite(src, dst, '{{YFW_SKILLS}}', '/real/root')
    assert.equal(read(join(dst, 'a.md')), 'x /real/root y', '文本应重写占位符')
    assert.deepEqual([...readFileSync(join(dst, 'sub', 'b.bin'))], [0, 1, 2, 255], '二进制应原样')
  } finally { env.cleanup() }
})
