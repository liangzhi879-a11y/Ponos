// scripts/verify-s4-security.mjs —— S4 Task 7 的**命令级安全实测**
// （不是单测复述：这里跑的是"引擎 + 真实临时目录"的端到端路径，
// 每条都打印可肉眼核对的证据——返回状态、拒绝原因、以及"盘上到底留了什么"）。
//
// 三条（计划 Task 7 验证节指定）：
//   ① 恶意 zip（`../` 条目）→ 被拒 + `packs/` 无残留 + staging 已清
//   ② 无 license 的包 → 被拒 + 无残留
//   ③ 目标已存在且用户改过 → `kept-user-modified` + **文件内容与 mtime 一个字节未变**
//
// 隔离：一律 `mkdtempSync`，显式注入 home；**绝不碰真实 `~/.yfworking`**（全局约束 3）。
// 运行：node scripts/verify-s4-security.mjs（失败退出码 1，可串进验收链）
// 为什么入库到 scripts/ 而不是留在 SDD 工作区：`.superpowers` 在 `.gitignore` 里（`.gitignore:37`），
// 报告与证据放那里会随 clone 丢失；S4 的三条安全证据是验收凭据，必须能被复核者复跑。
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeZip } from '../shared/pack-zip.mjs'
import { installPack, packsRoot } from '../server/knowledge-pack-install.mjs'

const newHome = () => mkdtempSync(join(tmpdir(), 's4-evi-'))
const bytes = (s) => Buffer.from(s, 'utf-8')
const manifest = (over = {}) => JSON.stringify({
  id: 'evi-pack', name: '实测包', version: '1.0.0', license: 'MIT', source: 'content', ...over,
})
/** 目录树快照（证明"不留残留"：连 staging 都不该有） */
const tree = (dir) => (existsSync(dir)
  ? readdirSync(dir).map((n) => (statSync(join(dir, n)).isDirectory() ? `${n}/` : n)).sort()
  : null)

let failed = 0
const check = (cond, label) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}`)
  if (!cond) failed++
}

// ── ① 恶意 zip：条目名 `../evil.md`（Zip Slip） ─────────────────────────────
// writer 自己就会拒非法条目名，故这里手工构造中央目录/本地头，绕过 writer 的净化——
// 这正是"攻击者给的 zip"的形态：**必须**由读侧的语义防护挡下。
{
  const home = newHome()
  // 用合法 writer 产出 zip，再原地把条目名改写成穿越形态。**必须等长**：
  // zip 的本地头/中央目录都记着 nameLen，改长度就得重算偏移与长度字段。
  // 'content/evil.md'（15）→ '../content/evil'（15）：首段是 `..`，解压后落在包目录**之外**。
  const zip = writeZip([
    { name: 'content/evil.md', data: bytes('# evil') },
    { name: 'pack.json', data: bytes(manifest()) },
  ])
  const mutated = Buffer.from(zip)
  const from = Buffer.from('content/evil.md', 'utf-8')
  const to = Buffer.from('../content/evil', 'utf-8')
  let hits = 0
  for (let i = 0; i + from.length <= mutated.length; i++) {
    if (mutated.subarray(i, i + from.length).equals(from)) { mutated.write(to.toString('latin1'), i, 'latin1'); hits++ }
  }
  const r = installPack({ home, archiveBuffer: mutated, source: 'offline', mode: 'safe' })
  console.log('\n[①] 恶意 zip（`../` 条目）')
  console.log(`     条目名改写处数 = ${hits}（中央目录 + 本地头两处）`)
  console.log(`     status = ${r.status}`)
  console.log(`     errors = ${JSON.stringify(r.errors)}`)
  check(r.status === 'rejected', '① status = rejected（穿越条目被拒）')
  check((r.errors || []).some((e) => /\.\.|非法|条目/.test(e)), '① 拒绝原因里能看到条目名问题')
  check(!existsSync(packsRoot(home)), '① packs/ 未创建（一个字节都没落盘）')
  check(JSON.stringify(tree(join(home, 'knowledge'))) === '[]'
    || tree(join(home, 'knowledge')) === null, `① knowledge/ 无残留（staging 已清）：${JSON.stringify(tree(join(home, 'knowledge')))}`)
}

// ── ② 无 license 的包 ──────────────────────────────────────────────────────
{
  const home = newHome()
  const zip = writeZip([
    { name: 'content/a.md', data: bytes('# A') },
    { name: 'pack.json', data: bytes(JSON.stringify({ id: 'evi-pack', name: '无证包', version: '1.0.0', source: 'content' })) },
  ])
  const r = installPack({ home, archiveBuffer: zip, source: 'offline', mode: 'safe' })
  console.log('\n[②] 无 license 的包')
  console.log(`     status = ${r.status}`)
  console.log(`     errors = ${JSON.stringify(r.errors)}`)
  check(r.status === 'rejected', '② status = rejected（license 是硬失败项，不得降级为警告）')
  check((r.errors || []).some((e) => /license|许可/i.test(e)), '② 拒绝原因指向 license')
  check(!existsSync(packsRoot(home)), '② packs/ 未创建（无残留）')
  check(JSON.stringify(tree(join(home, 'knowledge'))) === '[]'
    || tree(join(home, 'knowledge')) === null, '② knowledge/ 无残留（staging 已清）')
}

// ── ③ 目标已存在且用户改过 → kept-user-modified 且不写盘 ───────────────────
{
  const home = newHome()
  const zip = writeZip([
    { name: 'content/a.md', data: bytes('# A\n原始内容\n') },
    { name: 'content/b.md', data: bytes('# B\n') },
    { name: 'README.md', data: bytes('# README\n') },
    { name: 'pack.json', data: bytes(manifest()) },
  ])
  const first = installPack({ home, archiveBuffer: zip, source: 'offline', mode: 'safe' })
  console.log('\n[③] 已存在 + 用户改过 → kept-user-modified')
  console.log(`     首次安装 status = ${first.status}（version=${first.version}）`)

  // 用户手改包内文件：内容 + mtime 都要在"二次安装"后保持不变
  const target = join(packsRoot(home), 'evi-pack', 'content', 'a.md')
  const before = readFileSync(target, 'utf-8')
  writeFileSync(target, '# A\n用户改过的内容\n')
  const mtimeBefore = statSync(target).mtimeMs
  const contentBefore = readFileSync(target, 'utf-8')

  const second = installPack({ home, archiveBuffer: zip, source: 'offline', mode: 'safe' })
  const contentAfter = readFileSync(target, 'utf-8')
  const mtimeAfter = statSync(target).mtimeMs
  console.log(`     二次安装 status = ${second.status}`)
  console.log(`     conflicts = ${JSON.stringify(second.conflicts)}`)
  console.log(`     options = ${JSON.stringify(second.options)}`)
  console.log(`     内容未变 = ${contentAfter === contentBefore}（mtime ${mtimeBefore} → ${mtimeAfter}）`)
  check(second.status === 'kept-user-modified', '③ status = kept-user-modified')
  check((second.conflicts || []).some((f) => f.includes('a.md')), '③ conflicts 指向被改过的文件')
  check(JSON.stringify(second.options) === '["overwrite","keep","to-my-space"]', '③ 三选原样返回给前端')
  check(contentAfter === contentBefore, '③ 文件内容一个字节未变（未静默覆盖）')
  check(mtimeBefore === mtimeAfter, '③ mtime 未变（确实没写盘，不是"写完又改回"）')
  check(existsSync(join(home, 'knowledge', 'pack-backups')) === false, '③ 未指定 mode 时不创建备份目录')
  console.log(`     （首次安装留盘内容：${JSON.stringify(tree(join(packsRoot(home), 'evi-pack')))}；用户改写前 = ${JSON.stringify(before)}）`)
}

if (failed) { console.error(`\n${failed} 项失败`); process.exit(1) }
console.log('\n三条安全实测全部通过')
