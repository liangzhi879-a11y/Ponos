// server/knowledge-pack-install.test.mjs —— 安装/卸载/导出引擎测试（S4 Task 3）
// ---------------------------------------------------------------------------
// 纪律：
//   · **绝不碰真实 home**：每个用例 `mkdtempSync` 一个临时 home 并显式注入，不读环境变量；
//   · **不联网**：所有网络路径注入假 fetcher（`globalThis.fetch` 一次都不用）；
//   · **不起 bridge、不起内核子进程**：检索可检索性用 `import` 内核 store 同进程验证。
// 安全用例是本文件的重点（安装 = 往用户目录写文件）：穿越 / 体积炸弹 / 无 license / 可执行
// 扩展名 / 符号链接条目，每条都断言**被拒 + 无残留**（staging 目录不存在、packs/ 无半成品）。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { readZip, writeZip, crc32 } from '../shared/pack-zip.mjs'
import { createKnowledgeStore } from '../kernel/knowledge.mjs'
import {
  installPack, uninstallPack, listInstalledPacks, inspectArchive, exportSpaceAsPack,
  readIndex, readLocalIndex, fetchPackDetail, fetchPackArchive, fetchPackVersions,
  resolveRegistry, buildDownloadUrl, readLedger, writeLedger,
  packsRoot, spacesRoot, ledgerPath, backupsRoot,
} from './knowledge-pack-install.mjs'

let home = ''
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ponos-packs-'))
})

const j = (o) => JSON.stringify(o)

/** 正常包：`<id>/pack.json` + `README.md` + `content/<n>.md` */
function packZip({
  id = 'gaoqi-2026', version = '1.0.0', license = 'MIT', source = 'content',
  docs = { 'a.md': '# 高新技术企业认定\n\n条件一：研发费用占比。\n' }, manifestExtra = {},
} = {}) {
  const manifest = { id, name: '高企 2026', version, license, source, description: '示例包', ...manifestExtra }
  if (manifestExtra.license === null) delete manifest.license
  return writeZip([
    { name: 'pack.json', data: j(manifest) },
    { name: 'README.md', data: '# 读我\n' },
    ...Object.entries(docs).map(([rel, text]) => ({ name: `${source}/${rel}`, data: text })),
  ])
}

/**
 * 手写"恶意 zip"：`writeZip` 会拒绝非法条目名（它自己也做净化），故安全用例必须能造出
 * **合法 zip 容器 + 恶意条目名/属性**——这正是不受信输入的形态。method 0（stored）。
 */
function rawZip(entries, { externalAttrs = 0, usizeOverride = null } = {}) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf-8')
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf-8')
    const crc = crc32(data)
    const lfh = Buffer.alloc(30)
    lfh.writeUInt32LE(0x04034b50, 0)
    lfh.writeUInt16LE(20, 4)
    lfh.writeUInt16LE(0x800, 6)
    lfh.writeUInt16LE(0, 8)                       // stored
    lfh.writeUInt32LE(crc, 14)
    lfh.writeUInt32LE(data.length, 18)
    lfh.writeUInt32LE(usizeOverride ?? data.length, 22)
    lfh.writeUInt16LE(nameBuf.length, 26)
    locals.push(lfh, nameBuf, data)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0x800, 8)
    cd.writeUInt16LE(0, 10)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(data.length, 20)
    cd.writeUInt32LE(usizeOverride ?? data.length, 24)   // 声明解压尺寸（体积防线读的是这里）
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt16LE(0, 30)
    cd.writeUInt16LE(0, 32)
    cd.writeUInt16LE(0, 34)
    cd.writeUInt16LE(0, 36)
    cd.writeUInt32LE(externalAttrs >>> 0, 38)
    cd.writeUInt32LE(offset, 42)
    centrals.push(cd, nameBuf)
    offset += 30 + nameBuf.length + data.length
  }
  const cdBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cdBuf, eocd])
}

const stagingLeftovers = () => {
  const kdir = join(home, 'knowledge')
  return existsSync(kdir) ? readdirSync(kdir).filter((n) => n.startsWith('.packs-staging-')) : []
}
const assertNoResidue = (id = 'gaoqi-2026') => {
  assert.deepEqual(stagingLeftovers(), [], 'staging 目录必须清理干净（失败不留残留）')
  assert.equal(existsSync(join(packsRoot(home), id)), false, 'packs/ 下不得有半成品目录')
}

// ── 正常路径 ────────────────────────────────────────────────────────────────

test('安装 zip → 落盘为只读空间且**可被内核检索**（同进程 store，不起子进程）', () => {
  const r = installPack({ home, archiveBuffer: packZip(), source: 'offline' })
  assert.equal(r.status, 'installed')
  assert.equal(r.packId, 'gaoqi-2026')
  assert.equal(r.spaceId, 'pack-gaoqi-2026')
  assert.equal(r.version, '1.0.0')
  assert.equal(r.docCount, 1)
  assert.equal(existsSync(join(packsRoot(home), 'gaoqi-2026', 'content', 'a.md')), true)
  assert.equal(existsSync(join(packsRoot(home), 'gaoqi-2026', 'pack.json')), true)

  const store = createKnowledgeStore({ root: join(home, 'knowledge') })
  store.load()
  const space = store.getSpaces().find((s) => s.id === 'pack-gaoqi-2026')
  assert.ok(space, '安装后空间应被 discoverSpaces 发现')
  assert.equal(space.writable, false, '知识包空间必须只读')
  assert.equal(space.packVersion, '1.0.0')
  const found = store.search({ query: '研发费用占比', topK: 5 })
  assert.ok(found.items.some((i) => i.docId.startsWith('pack-gaoqi-2026/')), '装完即可检索到——staleness 自动吸收，不需要触发索引')

  const led = readLedger(home)
  assert.equal(led.packs['gaoqi-2026'].version, '1.0.0')
  assert.deepEqual(Object.keys(led.packs['gaoqi-2026'].files).sort(), ['gaoqi-2026/README.md', 'gaoqi-2026/content/a.md', 'gaoqi-2026/pack.json'])
})

test('目录来源安装：与 zip 同标准（离线安装第二形态）', () => {
  const src = mkdtempSync(join(tmpdir(), 'ponos-src-'))
  mkdirSync(join(src, 'content'), { recursive: true })
  writeFileSync(join(src, 'pack.json'), j({ id: 'dir-pack', name: '目录包', version: '2.0.0', license: 'Apache-2.0', source: 'content' }))
  writeFileSync(join(src, 'content', 'x.md'), '# 来自目录\n')
  const r = installPack({ home, srcDir: src })
  assert.equal(r.status, 'installed')
  assert.equal(existsSync(join(packsRoot(home), 'dir-pack', 'content', 'x.md')), true)
})

test('重复安装同一内容 → unchanged（幂等，不写盘、不动台账时间戳）', () => {
  const zip = packZip()
  assert.equal(installPack({ home, archiveBuffer: zip }).status, 'installed')
  const before = readFileSync(join(packsRoot(home), 'gaoqi-2026', 'content', 'a.md'))
  const r2 = installPack({ home, archiveBuffer: zip })
  assert.equal(r2.status, 'unchanged')
  assert.deepEqual(readFileSync(join(packsRoot(home), 'gaoqi-2026', 'content', 'a.md')), before)
})

test('内容有变化且未被用户改过 → updated，且**备份先于覆盖**（同 id 只留最新 1 份）', () => {
  installPack({ home, archiveBuffer: packZip({ version: '1.0.0' }) })
  const r = installPack({ home, archiveBuffer: packZip({ version: '1.1.0', docs: { 'a.md': '# 高新技术企业认定\n\n条件一：研发费用占比 ≥ 3%。\n' } }) })
  assert.equal(r.status, 'updated')
  assert.ok(r.backupPath && existsSync(r.backupPath), '覆盖前必须留备份')
  assert.match(readFileSync(join(packsRoot(home), 'gaoqi-2026', 'content', 'a.md'), 'utf-8'), /≥ 3%/)
  assert.equal(readFileSync(join(r.backupPath, 'content', 'a.md'), 'utf-8').includes('≥ 3%'), false, '备份里是旧内容')

  const r2 = installPack({ home, archiveBuffer: packZip({ version: '1.2.0' }) })
  assert.equal(r2.status, 'updated')
  const backups = readdirSync(backupsRoot(home)).filter((n) => n.startsWith('gaoqi-2026-'))
  assert.equal(backups.length, 1, '同 id 只保留最新 1 份备份（有界增长）')
})

test('用户改过包内文件 → kept-user-modified，**一个字节都不写**（默认 mode=safe）', () => {
  installPack({ home, archiveBuffer: packZip({ version: '1.0.0' }) })
  const target = join(packsRoot(home), 'gaoqi-2026', 'content', 'a.md')
  writeFileSync(target, '# 我自己加的归档说明\n')
  const r = installPack({ home, archiveBuffer: packZip({ version: '1.1.0', docs: { 'a.md': '# 官方新内容\n' } }) })
  assert.equal(r.status, 'kept-user-modified')
  assert.deepEqual(r.conflicts, ['content/a.md'], '冲突清单用包内相对路径（含 source 前缀）指名道姓')
  assert.deepEqual(r.options, ['overwrite', 'keep', 'to-my-space'])
  assert.equal(readFileSync(target, 'utf-8'), '# 我自己加的归档说明\n', '冲突态必须原样保留用户改动')
  assert.equal(listInstalledPacks(home).find((p) => p.id === 'gaoqi-2026').version, '1.0.0', '台账版本不动')

  // mode=overwrite：用户显式选择覆盖 → 仍先备份
  const r2 = installPack({ home, archiveBuffer: packZip({ version: '1.1.0', docs: { 'a.md': '# 官方新内容\n' } }), mode: 'overwrite' })
  assert.equal(r2.status, 'updated')
  assert.ok(existsSync(r2.backupPath))
  assert.equal(readFileSync(target, 'utf-8'), '# 官方新内容\n')
})

test('未受管目录（台账无记录）→ 一律 kept-user-modified，绝不静默覆盖', () => {
  mkdirSync(join(packsRoot(home), 'gaoqi-2026', 'content'), { recursive: true })
  writeFileSync(join(packsRoot(home), 'gaoqi-2026', 'content', 'a.md'), '# 手工拷贝进来的\n')
  const r = installPack({ home, archiveBuffer: packZip() })
  assert.equal(r.status, 'kept-user-modified')
  assert.equal(readFileSync(join(packsRoot(home), 'gaoqi-2026', 'content', 'a.md'), 'utf-8'), '# 手工拷贝进来的\n')
})

test('mode=to-my-space：复制进可写空间，不写台账、不进 packs/', () => {
  const r = installPack({ home, archiveBuffer: packZip(), mode: 'to-my-space' })
  assert.equal(r.status, 'to-my-space')
  assert.equal(existsSync(join(spacesRoot(home), 'gaoqi-2026', 'a.md')), true)
  assert.equal(existsSync(join(packsRoot(home), 'gaoqi-2026')), false)
  assert.deepEqual(Object.keys(readLedger(home).packs), [])
  const again = installPack({ home, archiveBuffer: packZip(), mode: 'to-my-space' })
  assert.equal(again.status, 'rejected', '同名空间已存在 → 拒绝（纯增量）')
})

test('source 下无文件 → skipped-empty（不落盘）', () => {
  const zip = writeZip([{ name: 'pack.json', data: j({ id: 'empty-pack', name: '空包', version: '1.0.0', license: 'MIT', source: 'content' }) }])
  const r = installPack({ home, archiveBuffer: zip })
  assert.equal(r.status, 'skipped-empty')
  assertNoResidue('empty-pack')
})

// ── 安全：恶意输入逐条被拒 + 无残留 ──────────────────────────────────────────

test('Zip Slip：条目名含 `../` → 拒绝安装且无残留', () => {
  const evil = rawZip([
    { name: 'pack.json', data: j({ id: 'evil-pack', name: 'e', version: '1.0.0', license: 'MIT', source: 'content' }) },
    { name: 'content/ok.md', data: '# ok\n' },
    { name: '../../../../etc/evil.md', data: '# pwned\n' },
  ])
  const r = installPack({ home, archiveBuffer: evil })
  assert.equal(r.status, 'rejected')
  assert.ok(r.errors.some((e) => e.includes('上跳路径段')), r.errors.join('|'))
  assertNoResidue('evil-pack')

  // 直接验证"没有写到 packs 之外"：knowledge/ 下只有 packs 目录
  assert.deepEqual(existsSync(packsRoot(home)) ? readdirSync(packsRoot(home)) : [], [])
})

test('Zip Slip 变体：绝对路径 / 盘符 / NUL 条目名 → 逐条被拒', () => {
  for (const name of ['/etc/passwd.md', 'C:/windows/x.md', 'content/a\0.md']) {
    const evil = rawZip([
      { name: 'pack.json', data: j({ id: 'evil2', name: 'e', version: '1.0.0', license: 'MIT', source: 'content' }) },
      { name, data: '# x\n' },
    ])
    const r = installPack({ home, archiveBuffer: evil })
    assert.equal(r.status, 'rejected', `条目名 ${JSON.stringify(name)} 必须被拒`)
    assertNoResidue('evil2')
  }
})

test('符号链接条目（externalAttrs = S_IFLNK）→ 整包拒绝', () => {
  const evil = rawZip([
    { name: 'pack.json', data: j({ id: 'ln-pack', name: 'e', version: '1.0.0', license: 'MIT', source: 'content' }) },
    { name: 'content/link.md', data: '../../outside.md' },
  ], { externalAttrs: 0xa1ff0000 })
  const r = installPack({ home, archiveBuffer: evil })
  assert.equal(r.status, 'rejected')
  assert.ok(r.errors.some((e) => e.includes('符号链接')), r.errors.join('|'))
  assertNoResidue('ln-pack')
})

test('体积防线：中央目录声明 200MB 解压量（zip bomb）→ 解压前即拒', () => {
  const bomb = rawZip([
    { name: 'pack.json', data: j({ id: 'bomb', name: 'b', version: '1.0.0', license: 'MIT', source: 'content' }) },
    { name: 'content/huge.md', data: '# 实际很小\n' },
  ], { usizeOverride: 200 * 1024 * 1024 })
  const r = installPack({ home, archiveBuffer: bomb })
  assert.equal(r.status, 'rejected')
  assert.ok(r.errors.some((e) => e.includes('超过单文件上限') || e.includes('声明解压尺寸')), r.errors.join('|'))
  assertNoResidue('bomb')
  // 同一份字节直接喂 reader：确认"解压前先拦"是 reader 的行为（不是安装器事后统计）
  assert.throws(() => readZip(bomb, { maxFileBytes: 2 * 1024 * 1024, maxTotalBytes: 50 * 1024 * 1024 }), /上限/)
})

test('可执行/脚本扩展名 → 拒绝（"包内无代码执行面"这条安全模型的前提）', () => {
  for (const bad of ['content/run.js', 'content/tool.exe', 'content/x.ps1', 'content/a.html']) {
    const evil = rawZip([
      { name: 'pack.json', data: j({ id: 'code-pack', name: 'c', version: '1.0.0', license: 'MIT', source: 'content' }) },
      { name: 'content/ok.md', data: '# ok\n' },
      { name: bad, data: 'x' },
    ])
    const r = installPack({ home, archiveBuffer: evil })
    assert.equal(r.status, 'rejected', `${bad} 必须被拒`)
    assert.ok(r.errors.some((e) => /可执行|不支持/.test(e)), r.errors.join('|'))
    assertNoResidue('code-pack')
  }
})

test('无 license / 缺 source / id 不合法 / id 与目标不一致 → 拒绝并给可读原因', () => {
  const noLicense = writeZip([
    { name: 'pack.json', data: j({ id: 'no-lic', name: 'n', version: '1.0.0', source: 'content' }) },
    { name: 'content/a.md', data: '# a\n' },
  ])
  let r = installPack({ home, archiveBuffer: noLicense })
  assert.equal(r.status, 'rejected')
  assert.ok(r.errors.some((e) => e.includes('license')), r.errors.join('|'))

  const noSource = writeZip([
    { name: 'pack.json', data: j({ id: 'no-src', name: 'n', version: '1.0.0', license: 'MIT' }) },
    { name: 'content/a.md', data: '# a\n' },
  ])
  assert.equal(installPack({ home, archiveBuffer: noSource }).status, 'rejected')

  const badId = writeZip([
    { name: 'pack.json', data: j({ id: '../escape', name: 'n', version: '1.0.0', license: 'MIT', source: 'content' }) },
    { name: 'content/a.md', data: '# a\n' },
  ])
  r = installPack({ home, archiveBuffer: badId })
  assert.equal(r.status, 'rejected')
  assert.ok(r.errors.some((e) => e.includes('id')), r.errors.join('|'))

  // 清单说 A、内容其实是 B（在线路径 expectId 来自清单）
  r = installPack({ home, archiveBuffer: packZip({ id: 'gaoqi-2026' }), expectId: 'other-pack' })
  assert.equal(r.status, 'rejected')
  assert.ok(r.errors.some((e) => e.includes('不一致')), r.errors.join('|'))
  assertNoResidue()
})

test('source 必须是包内存在的子目录；"." 被拒（否则 pack.json/README.md 会混进空间文档）', () => {
  const dot = writeZip([
    { name: 'pack.json', data: j({ id: 'dot-pack', name: 'd', version: '1.0.0', license: 'MIT', source: '.' }) },
    { name: 'a.md', data: '# a\n' },
  ])
  const r = installPack({ home, archiveBuffer: dot })
  assert.equal(r.status, 'rejected')
  assert.ok(r.errors.some((e) => e.includes('不得为 "."')), r.errors.join('|'))

  const ghost = writeZip([
    { name: 'pack.json', data: j({ id: 'ghost', name: 'g', version: '1.0.0', license: 'MIT', source: 'nope' }) },
    { name: 'content/a.md', data: '# a\n' },
  ])
  assert.equal(installPack({ home, archiveBuffer: ghost }).status, 'skipped-empty')
})

test('非 zip 字节流 / CRC 篡改 → 拒绝且不留残留', () => {
  let r = installPack({ home, archiveBuffer: Buffer.from('这不是 zip') })
  assert.equal(r.status, 'rejected')
  assert.ok(r.errors[0].includes('zip'), r.errors.join('|'))
  assertNoResidue()

  const zip = packZip()
  // 篡改 content/a.md 的压缩数据字节（stored/deflate 都可能；这里改一处必然触发 CRC 或解压失败）
  const idx = zip.indexOf(Buffer.from('高新技术企业认定', 'utf-8'))
  assert.ok(idx > 0)
  zip[idx] = 0x58
  r = installPack({ home, archiveBuffer: zip })
  assert.equal(r.status, 'rejected')
  assert.ok(r.errors.some((e) => /CRC|解压失败|校验/.test(e)), r.errors.join('|'))
  assertNoResidue()
})

test('版本不兼容且无可回退 → 拒绝（提示需要更高版本应用）', () => {
  const zip = writeZip([
    { name: 'pack.json', data: j({ id: 'new-app', name: 'n', version: '2.0.0', license: 'MIT', source: 'content', minAppVersion: '9.0.0' }) },
    { name: 'content/a.md', data: '# a\n' },
  ])
  const r = installPack({ home, archiveBuffer: zip, appVersion: '3.0.0' })
  assert.equal(r.status, 'rejected')
  assert.ok(r.errors.some((e) => e.includes('需要应用版本 ≥ 9.0.0')), r.errors.join('|'))
  assertNoResidue('new-app')
})

// ── 卸载 / 列表 ────────────────────────────────────────────────────────────

test('卸载：只删自己装的目录 + 清台账；**不碰用户空间**', () => {
  mkdirSync(join(spacesRoot(home), 'my-notes'), { recursive: true })
  writeFileSync(join(spacesRoot(home), 'my-notes', 'note.md'), '# 我的笔记\n')
  installPack({ home, archiveBuffer: packZip() })

  const r = uninstallPack({ home, packId: 'gaoqi-2026' })
  assert.equal(r.ok, true)
  assert.equal(r.removedCount, 3)
  assert.equal(existsSync(join(packsRoot(home), 'gaoqi-2026')), false)
  assert.deepEqual(Object.keys(readLedger(home).packs), [])
  assert.equal(readFileSync(join(spacesRoot(home), 'my-notes', 'note.md'), 'utf-8'), '# 我的笔记\n', '卸载不得波及用户笔记')

  const store = createKnowledgeStore({ root: join(home, 'knowledge') })
  store.load()
  assert.equal(store.getSpaces().some((s) => s.id === 'pack-gaoqi-2026'), false, '下次 load 自动移除该空间')
})

test('卸载：id 非法 / 不存在 → ok:false，不动盘', () => {
  assert.equal(uninstallPack({ home, packId: '../etc' }).ok, false)
  assert.equal(uninstallPack({ home, packId: 'nope' }).ok, true, '不存在的包视作已卸载（幂等）')
  assert.deepEqual(uninstallPack({ home, packId: 'nope' }).removed, [])
})

test('listInstalledPacks：台账 ∪ 磁盘（未受管目录也要列出，才能被卸载）', () => {
  installPack({ home, archiveBuffer: packZip() })
  mkdirSync(join(packsRoot(home), 'manual-pack', 'content'), { recursive: true })
  writeFileSync(join(packsRoot(home), 'manual-pack', 'pack.json'), j({ id: 'manual-pack', name: '手工', version: '0.1.0', source: 'content' }))
  writeFileSync(join(packsRoot(home), 'manual-pack', 'content', 'm.md'), '# m\n')
  const list = listInstalledPacks(home)
  assert.deepEqual(list.map((p) => p.id), ['gaoqi-2026', 'manual-pack'])
  assert.equal(list[1].source, 'untracked')
  assert.equal(list[1].files, 2)
})

test('台账损坏 → 空台账（保守：宁判"未受管"也不覆盖）', () => {
  mkdirSync(join(home, 'knowledge'), { recursive: true })
  writeFileSync(ledgerPath(home), '{ 半截 JSON')
  assert.deepEqual(readLedger(home).packs, {})
  // 裸映射形态（spec §3.1 原样）也要认，否则用户按文档手写的台账被整体丢弃
  writeLedger(home, { packs: { 'gaoqi-2026': { version: '1.0.0', files: { 'gaoqi-2026/a.md': 'abc' } } } })
  const raw = JSON.parse(readFileSync(ledgerPath(home), 'utf-8'))
  assert.equal(readLedger(home).packs['gaoqi-2026'].files['gaoqi-2026/a.md'], 'abc')
  assert.equal(raw.schemaVersion, 1)
})

// ── 导出 ───────────────────────────────────────────────────────────────────

test('导出空间 → pack.json + README + zip + 清单片段；zip 能被自家 reader 读回', () => {
  const space = join(spacesRoot(home), 'my-space')
  mkdirSync(join(space, 'sub'), { recursive: true })
  writeFileSync(join(space, 'a.md'), '# 政策汇编\n')
  writeFileSync(join(space, 'sub', 'b.md'), '# 附件说明\n')
  writeFileSync(join(space, 'notes.txt'), 'txt 也在白名单（纯数据）\n')
  writeFileSync(join(space, 'danger.js'), 'alert(1)\n')       // 不在白名单 → 跳过并记录

  const r = exportSpaceAsPack({
    home, spaceId: 'my-space', spaceRoot: space,
    meta: { id: 'my-space-pack', version: '1.0.0', license: 'MIT', author: '张三', repo: 'https://github.com/x/y', tags: ['政策'] },
  })
  assert.equal(r.ok, true)
  assert.equal(r.packJson.source, 'content')
  assert.equal(r.docCount, 2)
  assert.deepEqual(r.skipped.map((s) => s.rel), ['danger.js'])
  assert.equal(existsSync(r.zipPath), true)
  assert.match(r.manifestEntry.repo, /github\.com/)

  const back = readZip(readFileSync(r.zipPath))
  const names = back.entries.map((e) => e.name).sort()
  assert.deepEqual(names, ['my-space-pack/README.md', 'my-space-pack/content/a.md', 'my-space-pack/content/notes.txt', 'my-space-pack/content/sub/b.md', 'my-space-pack/pack.json'])

  // 自家产物必须能被自家安装器装回去（round-trip）
  const ins = installPack({ home, archiveBuffer: readFileSync(r.zipPath), expectId: 'my-space-pack' })
  assert.equal(ins.status, 'installed')
  assert.equal(ins.docCount, 2)
  assert.equal(existsSync(join(packsRoot(home), 'my-space-pack', 'content', 'sub', 'b.md')), true)

  const store = createKnowledgeStore({ root: join(home, 'knowledge') })
  store.load()
  assert.ok(store.getSpaces().some((s) => s.id === 'pack-my-space-pack'))
})

test('导出：缺 license/version → 拒绝且不产出文件', () => {
  const space = mkdtempSync(join(tmpdir(), 'ponos-sp-'))
  writeFileSync(join(space, 'a.md'), '# a\n')
  const r = exportSpaceAsPack({ home, spaceId: 's', spaceRoot: space, meta: { id: 'p', version: '1.0.0' } })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.includes('license')))
  assert.equal(existsSync(join(home, 'knowledge', 'exports', 'p-1.0.0.zip')), false)
})

// ── 清单读取（全程假 fetcher，绝不真联网） ─────────────────────────────────

function fakeFetcher(routes) {
  const calls = []
  const fn = async (url, init) => {
    calls.push(String(url))
    const hit = routes[String(url)]
    if (hit === undefined) return new Response('not found', { status: 404 })
    if (typeof hit === 'string') return new Response(hit, { status: 200, headers: { 'content-type': 'text/plain' } })
    return new Response(typeof hit === 'string' ? hit : JSON.stringify(hit), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  fn.calls = calls
  return fn
}

test('readIndex：本地离线清单存在即**不联网**（本地优先）', async () => {
  mkdirSync(join(home, 'knowledge'), { recursive: true })
  writeFileSync(join(home, 'knowledge', 'packs-index.local.json'), j({
    updatedAt: '2026-09-01T00:00:00Z',
    packs: [{ id: 'local-pack', name: '本地包', version: '1.0.0', tags: ['内网'], localPath: '/mnt/packs/local-pack' }],
  }))
  const fetcher = fakeFetcher({})
  const r = await readIndex({ home, fetcher, registry: 'https://example.invalid/knowledge-packs' })
  assert.equal(r.source, 'local')
  assert.deepEqual(r.packs.map((p) => p.id), ['local-pack'])
  assert.equal(r.packs[0].localPath, '/mnt/packs/local-pack')
  assert.deepEqual(fetcher.calls, [], '本地清单存在时不得发起任何网络请求')
})

test('readIndex：无本地清单 → 走远程（假 fetcher），坏 id 被丢弃并告警', async () => {
  const reg = 'https://example.invalid/knowledge-packs'
  const fetcher = fakeFetcher({
    [`${reg}/index.json`]: { updatedAt: 'x', packs: [{ id: 'ok-pack', name: 'o', version: '2.0.0' }, { id: '../../etc', name: 'evil' }, { id: 'OK_PACK' }] },
  })
  const r = await readIndex({ home, fetcher, registry: reg })
  assert.equal(r.source, 'remote')
  assert.deepEqual(r.packs.map((p) => p.id), ['ok-pack'])
  assert.equal(r.warnings.length, 2)
  assert.deepEqual(fetcher.calls, [`${reg}/index.json`])
})

test('readIndex：远程非 2xx → 结构化错误（不抛）', async () => {
  const reg = 'https://example.invalid/knowledge-packs'
  const r = await readIndex({ home, fetcher: fakeFetcher({}), registry: reg })
  assert.equal(r.ok, false)
  assert.match(r.error, /HTTP 404/)
})

test('readLocalIndex / resolveRegistry：本地清单优先于 config，config 优先于默认常量', () => {
  assert.deepEqual(readLocalIndex(home), { exists: false, packs: [], updatedAt: null, path: join(home, 'knowledge', 'packs-index.local.json') })
  let rr = resolveRegistry({ home, config: {} })
  assert.equal(rr.origin, 'default')
  assert.match(rr.registry, /knowledge-packs$/)
  rr = resolveRegistry({ home, config: { knowledgePackRegistry: 'https://mirror.corp/kp' } })
  assert.equal(rr.registry, 'https://mirror.corp/kp')
  assert.equal(rr.origin, 'config')
  mkdirSync(join(home, 'knowledge'), { recursive: true })
  writeFileSync(join(home, 'knowledge', 'packs-index.local.json'), j({ packs: [] }))
  assert.equal(resolveRegistry({ home, config: { knowledgePackRegistry: 'https://mirror.corp/kp' } }).origin, 'local')
})

test('fetchPackDetail：versions.json 回退 + README 缺失不算错', async () => {
  const reg = 'https://example.invalid/knowledge-packs'
  const fetcher = fakeFetcher({
    [`${reg}/packs/new-app/pack.json`]: { id: 'new-app', name: '新包', version: '2.0.0', license: 'MIT', source: 'content', minAppVersion: '9.0.0' },
    [`${reg}/packs/new-app/versions.json`]: { '2.0.0': '9.0.0', '1.4.0': '1.0.0' },
  })
  const r = await fetchPackDetail({ fetcher, registry: reg, id: 'new-app', appVersion: '3.0.0' })
  assert.equal(r.ok, true)
  assert.equal(r.version.version, '1.4.0')
  assert.equal(r.version.reason, 'fallback')
  assert.equal(r.readme, '')

  const bad = await fetchPackDetail({ fetcher, registry: reg, id: '../etc' })
  assert.equal(bad.ok, false)
  assert.deepEqual(fetcher.calls, [`${reg}/packs/new-app/pack.json`, `${reg}/packs/new-app/README.md`, `${reg}/packs/new-app/versions.json`], 'id 非法时不得发起请求')
})

test('fetchPackDetail：versions.json 缺失 → 明确 needs-higher-app（不装）', async () => {
  const reg = 'https://example.invalid/knowledge-packs'
  const fetcher = fakeFetcher({
    [`${reg}/packs/new-app/pack.json`]: { id: 'new-app', name: 'n', version: '2.0.0', license: 'MIT', source: 'content', minAppVersion: '9.0.0' },
  })
  const r = await fetchPackDetail({ fetcher, registry: reg, id: 'new-app', appVersion: '3.0.0' })
  assert.equal(r.ok, false)
  assert.match(r.error, /需要应用版本 ≥ 9.0.0/)
})

test('fetchPackArchive：正常拿到 Buffer；Content-Length 超限即拒（不读 body）', async () => {
  const reg = 'https://example.invalid/knowledge-packs'
  const buf = packZip({ id: 'gaoqi-2026' })
  const okFetcher = async () => new Response(buf, { status: 200 })
  const r = await fetchPackArchive({ fetcher: okFetcher, registry: reg, id: 'gaoqi-2026', version: '1.0.0' })
  assert.equal(r.ok, true)
  assert.equal(r.buffer.length, buf.length)
  assert.equal(r.url, `${reg}/packs/gaoqi-2026/gaoqi-2026-1.0.0.zip`)

  let bodyRead = false
  const huge = 200 * 1024 * 1024
  const r2 = await fetchPackArchive({
    fetcher: async () => ({
      ok: true, status: 200, headers: { get: () => String(huge) },
      arrayBuffer: async () => { bodyRead = true; return new ArrayBuffer(0) },
    }),
    registry: reg, id: 'gaoqi-2026', version: '1.0.0',
  })
  assert.equal(r2.ok, false)
  assert.equal(r2.tooLarge, true)
  assert.equal(bodyRead, false, 'Content-Length 超限时不得读取 body')
})

test('buildDownloadUrl：URL 由基址 + 已校验 id/version 组装，且与基址同源', () => {
  const reg = 'https://example.invalid/knowledge-packs/'
  const u = buildDownloadUrl({ registry: reg, id: 'ok-pack', version: '1.0.0' })
  assert.equal(u, 'https://example.invalid/knowledge-packs/packs/ok-pack/ok-pack-1.0.0.zip')
  assert.equal(new URL(u).origin, 'https://example.invalid')
  // 清单里的任意 URL 一律不接受（防 SSRF / 钓鱼指向）
  assert.throws(() => buildDownloadUrl({ registry: reg, file: 'https://evil.example/x.zip' }), /下载路径不合法/)
  assert.throws(() => buildDownloadUrl({ registry: reg, id: '../etc', file: 'index.json' }), /id 不合法/)
  assert.throws(() => buildDownloadUrl({ registry: reg, version: '../../x', file: `a.zip` }), /版本号不合法/)
  assert.throws(() => buildDownloadUrl({ registry: '', file: 'index.json' }), /未配置 registry/)
})

test('fetchPackVersions：缺失返回 versions:null（不是错误）', async () => {
  const reg = 'https://example.invalid/knowledge-packs'
  const r = await fetchPackVersions({ fetcher: fakeFetcher({}), registry: reg, id: 'ok-pack' })
  assert.deepEqual(r, { ok: true, versions: null })
})

// ── inspect 单测（不落盘形态） ─────────────────────────────────────────────

test('inspectArchive 是纯校验：合法包返回 payload/docCount，非法包返回 errors 而非抛', () => {
  const ok = inspectArchive(packZip())
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.payload.map((f) => f.name), ['content/a.md'])
  assert.equal(ok.docCount, 1)
  assert.equal(inspectArchive(Buffer.from('x')).ok, false)
  assert.equal(inspectArchive(rawZip([{ name: '../a.md', data: 'x' }])).ok, false)
})
