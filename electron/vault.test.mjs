// electron/vault.test.mjs —— 密码库核心单测
// node --test electron/vault.test.mjs
//
// 本文件钉的是 spec 的验收标准 A1–A6（docs/superpowers/specs/2026-09-15-password-vault-design.md §7）。
// 加密器是注入的（D10），所以这里能用"假加密器"完整覆盖生产里最难复现的分支：
// 加密不可用、加密抛错、密文解不开、文件损坏——这些分支一旦在生产里走错，
// 后果是"密码以明文落盘"或"用户密码库被清空"，两者都不可接受，必须由单测守着。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createVault, vaultPathOf, ERR } from './vault.cjs'

/** 可逆假加密器：前缀 'X' + base64（够验证"落盘不可直接读"，且行为确定） */
function fakeCrypto() {
  return {
    isAvailable: () => true,
    encryptString: s => Buffer.from('X' + Buffer.from(s, 'utf8').toString('base64'), 'utf8'),
    decryptString: b => Buffer.from(Buffer.from(b).toString('utf8').slice(1), 'base64').toString('utf8'),
  }
}

function freshHome() {
  return mkdtempSync(join(tmpdir(), 'yfw-vault-'))
}

function withVault(fn, { crypto = fakeCrypto() } = {}) {
  const home = freshHome()
  try { return fn({ home, vault: createVault({ home, crypto }), crypto }) }
  finally { rmSync(home, { recursive: true, force: true }) }
}

test('A1 增删改查往返一致；磁盘字节不含明文', () => {
  withVault(({ home, vault }) => {
    const c = vault.upsert({ name: '某系统', url: 'https://ex.com', username: 'zhang3', password: 'P@ssw0rd!', notes: '备注', tags: ['工作'] })
    assert.equal(c.ok, true)
    assert.ok(c.entry.id)
    assert.equal(c.entry.password, undefined, '出站条目不得带 password')

    const got = vault.list()
    assert.equal(got.ok, true)
    assert.equal(got.entries.length, 1)
    assert.equal(got.entries[0].username, 'zhang3')
    assert.equal(got.entries[0].password, undefined, 'A5：list 不得下发 password')

    assert.deepEqual(vault.reveal(c.entry.id), { ok: true, password: 'P@ssw0rd!' })

    // A1：落盘全文（含信封）不得出现任何明文秘密
    const bytes = readFileSync(join(home, 'vault.enc'), 'utf8')
    for (const secret of ['P@ssw0rd!', 'zhang3', '某系统', 'ex.com', '备注']) {
      assert.ok(!bytes.includes(secret), `落盘文件泄漏了明文：${secret}`)
    }
    const env = JSON.parse(bytes)
    assert.deepEqual(Object.keys(env).sort(), ['cipher', 'scheme', 'updatedAt', 'v'].sort())

    // 更新：不传 password ⇒ 保持原密码（避免"改备注要重打密码"）
    const u = vault.upsert({ id: c.entry.id, name: '某系统2', notes: '改了' })
    assert.equal(u.ok, true)
    assert.equal(u.entry.createdAt, c.entry.createdAt, 'createdAt 应保持')
    assert.deepEqual(vault.reveal(c.entry.id), { ok: true, password: 'P@ssw0rd!' })

    // 更新：显式 '' ⇒ 清空（语义与"未传"区分开）
    assert.equal(vault.upsert({ id: c.entry.id, name: '某系统2', password: '' }).ok, true)
    assert.deepEqual(vault.reveal(c.entry.id), { ok: true, password: '' })

    assert.deepEqual(vault.remove(c.entry.id), { ok: true })
    assert.deepEqual(vault.list().entries, [])
  })
})

test('A2 加密不可用 ⇒ 拒绝写入，且不产生任何文件（fail-closed）', () => {
  const home = freshHome()
  try {
    const vault = createVault({ home, crypto: { isAvailable: () => false, encryptString: () => { throw new Error('should not be called') }, decryptString: () => { throw new Error('should not be called') } } })
    const r = vault.upsert({ name: 'x', password: 'secret' })
    assert.equal(r.ok, false)
    assert.equal(r.error, ERR.UNAVAILABLE)
    assert.ok(!existsSync(vaultPathOf(home)), '不可用时不得落任何文件（更不得落明文）')
    assert.ok(!existsSync(vaultPathOf(home) + '.tmp'), '不得留临时文件')
    // 空库场景下 status 也如实报"不可用"，UI 才能给出可执行提示
    assert.deepEqual(vault.status(), { ok: true, available: false, count: 0 })
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('加密不可用但文件已存在 ⇒ 报 unavailable（而非 corrupt），且文件字节不变', () => {
  const home = freshHome()
  try {
    const good = createVault({ home, crypto: fakeCrypto() })
    good.upsert({ name: 'a', password: 'p' })
    const before = readFileSync(vaultPathOf(home))

    const vault = createVault({ home, crypto: { isAvailable: () => false, encryptString: () => { throw new Error('x') }, decryptString: () => { throw new Error('x') } } })
    const l = vault.list()
    assert.equal(l.ok, false)
    // 两种故障必须可区分：不可用 = 环境问题（可重试/可修）；corrupt = 文件问题
    assert.equal(l.error, ERR.UNAVAILABLE)
    assert.deepEqual(readFileSync(vaultPathOf(home)), before, '读失败不得改动原文件')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('A3 写入失败不破坏既有库（含临时文件清理）', () => {
  const home = freshHome()
  try {
    let calls = 0
    const flaky = {
      isAvailable: () => true,
      encryptString: s => { calls++; if (calls > 1) throw new Error('disk on fire'); return Buffer.from('X' + Buffer.from(s).toString('base64')) },
      decryptString: b => Buffer.from(Buffer.from(b).toString('utf8').slice(1), 'base64').toString('utf8'),
    }
    const vault = createVault({ home, crypto: flaky })
    assert.equal(vault.upsert({ name: 'first', password: 'p1' }).ok, true)

    const r = vault.upsert({ name: 'second', password: 'p2' })
    assert.equal(r.ok, false)
    assert.equal(r.error, ERR.UNAVAILABLE)

    // 旧库仍可读、内容完好
    const l = vault.list()
    assert.equal(l.ok, true)
    assert.equal(l.entries.length, 1)
    assert.equal(l.entries[0].name, 'first')
    assert.deepEqual(vault.reveal(l.entries[0].id), { ok: true, password: 'p1' })
    assert.ok(!readdirSync(home).some(f => f.endsWith('.tmp')), '失败后不得留临时文件')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('A4 文件损坏 ⇒ 报错、绝不返回空库、原字节不变', () => {
  for (const [label, bytes] of [
    ['非 JSON', 'this is not json'],
    ['缺 cipher', JSON.stringify({ v: 1, scheme: 'electron-safe-storage' })],
    ['未知 scheme', JSON.stringify({ v: 1, scheme: 'future-thing', cipher: 'AAAA' })],
    ['密文解不开', JSON.stringify({ v: 1, scheme: 'electron-safe-storage', cipher: 'bm90LXJlYWw=' })],
  ]) {
    const home = freshHome()
    try {
      writeFileSync(vaultPathOf(home), bytes)
      const vault = createVault({ home, crypto: fakeCrypto() })
      const l = vault.list()
      assert.equal(l.ok, false, `${label}：应报错`)
      assert.notEqual(l.error, undefined)
      assert.deepEqual(l.entries, [], `${label}：不得把损坏当成空库（会诱导用户以为密码没了）`)
      assert.equal(readFileSync(vaultPathOf(home), 'utf8'), bytes, `${label}：原文件必须原样保留`)
      // 损坏态下写入必须被拦住：否则一次 upsert 就把坏库覆盖成"只有一条"的新库
      const u = vault.upsert({ name: 'x', password: 'y' })
      assert.equal(u.ok, false, `${label}：损坏态不得写入`)
      assert.equal(readFileSync(vaultPathOf(home), 'utf8'), bytes, `${label}：写入尝试不得改动原文件`)
    } finally { rmSync(home, { recursive: true, force: true }) }
  }
})

test('入参校验与不存在条目（不允许"悄悄新建"）', () => {
  withVault(({ vault }) => {
    assert.equal(vault.upsert({ name: '', password: 'p' }).error, ERR.INVALID)
    assert.equal(vault.upsert({ name: '   ', password: 'p' }).error, ERR.INVALID)
    assert.equal(vault.upsert({ name: 'ok' }).error, ERR.INVALID, '新增必须给密码')
    // 带 id 却查不到 ⇒ not_found（静默新建会造重复条目，用户以为改成功了）
    assert.equal(vault.upsert({ id: 'no-such-id', name: 'n', password: 'p' }).error, ERR.NOT_FOUND)
    assert.equal(vault.reveal('no-such-id').error, ERR.NOT_FOUND)
    assert.equal(vault.remove('no-such-id').error, ERR.NOT_FOUND)
    assert.equal(vault.list().entries.length, 0, '以上失败都不得产生条目')
  })
})

test('错误信息不泄漏密码（D8）', () => {
  const home = freshHome()
  try {
    const vault = createVault({
      home,
      crypto: { isAvailable: () => true, encryptString: () => { throw new Error('boom') }, decryptString: () => { throw new Error('boom') } },
    })
    const r = vault.upsert({ name: 'n', password: 'TOPSECRET-VALUE' })
    assert.equal(r.ok, false)
    assert.ok(!JSON.stringify(r).includes('TOPSECRET-VALUE'), '错误载荷里出现了明文密码')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('核心模块无任何 console 输出（A6：明文不得进日志）', () => {
  const src = readFileSync(new URL('./vault.cjs', import.meta.url), 'utf8')
  assert.ok(!/console\s*\./.test(src), 'vault.cjs 出现 console 调用：日志可能带上字段值')
})

test('回归：库里有本版本不认识的条目 ⇒ 报错且不可写回（否则被静默截断丢弃）', () => {
  // 审查发现（H1）：早期实现用 filter(isEntryShaped) 静默丢掉不合形状的条目，
  // list 仍返回 ok:true，下一次 upsert 就把"被截断的库"覆盖回去 —— 条目永久消失。
  // 触发不需要攻击：跨版本读写过的库、手工还原的备份都可能带上不认识的条目。
  const home = freshHome()
  try {
    const crypto = fakeCrypto()
    const payload = JSON.stringify({
      entries: [
        { id: 'ok-1', name: 'keepme', url: '', username: '', password: 'p1', notes: '', tags: [], createdAt: '', updatedAt: '' },
        { id: 123, name: 'shape-mismatch' },   // id 不是字符串 ⇒ 本版本无法识别
      ],
    })
    writeFileSync(vaultPathOf(home), JSON.stringify({ v: 1, scheme: 'electron-safe-storage', cipher: Buffer.from(crypto.encryptString(payload)).toString('base64') }))
    const before = readFileSync(vaultPathOf(home))

    const vault = createVault({ home, crypto })
    const l = vault.list()
    assert.equal(l.ok, false, '不得返回 ok:true（否则用户看不出少了一条）')
    assert.equal(l.error, ERR.CORRUPT)
    assert.deepEqual(l.entries, [])

    const u = vault.upsert({ name: 'new', password: 'p' })
    assert.equal(u.ok, false, '不可写回：写回会把无法识别的条目永久丢弃')
    assert.deepEqual(readFileSync(vaultPathOf(home)), before, '原文件必须字节不变')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('回归：信封版本不认识 ⇒ 拒绝（照旧结构写回等于降级毁数据）', () => {
  const home = freshHome()
  try {
    const crypto = fakeCrypto()
    const payload = JSON.stringify({ entries: [] })
    writeFileSync(vaultPathOf(home), JSON.stringify({ v: 99, scheme: 'electron-safe-storage', cipher: Buffer.from(crypto.encryptString(payload)).toString('base64') }))
    const before = readFileSync(vaultPathOf(home))
    const vault = createVault({ home, crypto })
    assert.equal(vault.list().error, ERR.CORRUPT)
    assert.equal(vault.upsert({ name: 'x', password: 'y' }).ok, false)
    assert.deepEqual(readFileSync(vaultPathOf(home)), before)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('回归：密码不能是 null/数字（String(null) 会存成字面量 "null"）', () => {
  withVault(({ vault }) => {
    for (const bad of [null, 123, {}, [], true]) {
      const r = vault.upsert({ name: 'n', password: bad })
      assert.equal(r.ok, false, `password=${JSON.stringify(bad)} 应被拒绝`)
      assert.equal(r.error, ERR.INVALID)
    }
    assert.deepEqual(vault.list().entries, [], '被拒绝的输入不得落库')
  })
})

test('回归：加密返回空密文 ⇒ 放弃写入，不得把好库换成解不开的坏库', () => {
  const home = freshHome()
  try {
    const good = createVault({ home, crypto: fakeCrypto() })
    good.upsert({ name: 'keepme', password: 'p1' })
    const before = readFileSync(vaultPathOf(home))

    // 加密"成功"但产出空内容：只判断"没抛错"就会当成功并 rename 覆盖。
    // 解密能力保持正常（否则会在读阶段先报 corrupt，测不到写入路径）。
    const real = fakeCrypto()
    const vault = createVault({
      home,
      crypto: { isAvailable: () => true, encryptString: () => Buffer.alloc(0), decryptString: b => real.decryptString(b) },
    })
    const r = vault.upsert({ name: 'new', password: 'p2' })
    assert.equal(r.ok, false)
    assert.equal(r.error, ERR.IO)
    assert.deepEqual(readFileSync(vaultPathOf(home)), before, '原库必须保持可读')
    assert.equal(good.list().entries.length, 1)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('回归：加密结果解不回原文 ⇒ 放弃写入（语义级回读）', () => {
  const home = freshHome()
  try {
    const vault = createVault({
      home,
      crypto: { isAvailable: () => true, encryptString: () => Buffer.from('garbage'), decryptString: () => 'not-the-payload' },
    })
    const r = vault.upsert({ name: 'n', password: 'p' })
    assert.equal(r.ok, false)
    assert.equal(r.error, ERR.IO)
    assert.ok(!existsSync(vaultPathOf(home)), '不得落任何文件')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('回归：读取失败（非 ENOENT）不得被当成空库', () => {
  // 用"目录占住 vault.enc 路径"制造可复现的读取失败（EISDIR）：
  // 若把它当成空库，下一次 upsert 就会用新库覆盖原路径
  const home = freshHome()
  try {
    mkdirSync(vaultPathOf(home))
    const vault = createVault({ home, crypto: fakeCrypto() })
    const l = vault.list()
    assert.equal(l.ok, false, '不得返回空库')
    assert.equal(l.error, ERR.IO, '归 io（环境/权限问题），不是 corrupt（文件坏了）')
    const u = vault.upsert({ name: 'n', password: 'p' })
    assert.equal(u.ok, false)
    assert.ok(existsSync(vaultPathOf(home)), '原路径不得被覆盖')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('回归：Linux basic_text 后端（硬编码密钥）⇒ 判为不可用，不假装加密', () => {
  // 审查提出的 T5 口子：safeStorage 在无钥匙串的 Linux 上可能退化到 basic_text，
  // 那种"加密"文件谁拿到谁能解。宁可报告不可用，也不能让用户以为已受保护。
  const home = freshHome()
  try {
    const real = fakeCrypto()
    const vault = createVault({
      home,
      crypto: { ...real, getSelectedStorageBackend: () => 'basic_text' },
    })
    assert.equal(vault.status().available, false)
    const r = vault.upsert({ name: 'n', password: 'p' })
    assert.equal(r.ok, false)
    assert.equal(r.error, ERR.UNAVAILABLE)
    assert.ok(!existsSync(vaultPathOf(home)), '不得落文件')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('其它后端（如 dpapi）照常可用，不误伤', () => {
  withVault(({ vault }) => {
    assert.equal(vault.status().available, true)
    assert.equal(vault.upsert({ name: 'n', password: 'p' }).ok, true)
  }, { crypto: { ...{ isAvailable: () => true, encryptString: s => Buffer.from('X' + Buffer.from(s).toString('base64')), decryptString: b => Buffer.from(Buffer.from(b).toString('utf8').slice(1), 'base64').toString('utf8') }, getSelectedStorageBackend: () => 'dpapi' } })
})

test('secrets：CRUD、空值即删除、只回键名不回值', () => {
  withVault(({ vault }) => {
    assert.deepEqual(vault.listSecretKeys(), { ok: true, keys: [] })
    assert.equal(vault.setSecret('provider:p1:token', 'sk-live-abc').ok, true)
    assert.equal(vault.setSecret('legacy:apiKey', 'old-key').ok, true)
    assert.deepEqual(vault.listSecretKeys().keys.sort(), ['legacy:apiKey', 'provider:p1:token'])
    assert.deepEqual(vault.getSecret('provider:p1:token'), { ok: true, value: 'sk-live-abc' })
    assert.deepEqual(vault.getSecrets(), { ok: true, secrets: { 'provider:p1:token': 'sk-live-abc', 'legacy:apiKey': 'old-key' } })
    // 空值等价删除（调用方不必区分"清空"与"删除"）
    assert.equal(vault.setSecret('legacy:apiKey', '').ok, true)
    assert.deepEqual(vault.listSecretKeys().keys, ['provider:p1:token'])
    assert.equal(vault.getSecret('legacy:apiKey').error, ERR.NOT_FOUND)
    assert.equal(vault.deleteSecret('provider:p1:token').ok, true)
    assert.deepEqual(vault.listSecretKeys().keys, [])
  })
})

test('secrets：磁盘字节不含明文密钥（与密码同等标准）', () => {
  withVault(({ home, vault }) => {
    vault.setSecret('provider:p1:token', 'sk-TOPSECRET-TOKEN')
    const bytes = readFileSync(join(home, 'vault.enc'), 'utf8')
    assert.ok(!bytes.includes('sk-TOPSECRET-TOKEN'), '密钥明文落盘了')
    assert.ok(!bytes.includes('provider:p1:token'), '连键名都不应出现在密文外壳里')
  })
})

test('secrets：非字符串值被拒（不当成可字符串化的输入）', () => {
  withVault(({ vault }) => {
    for (const bad of [null, 123, {}, []]) {
      const r = vault.setSecret('k', bad)
      assert.equal(r.ok, false, `value=${JSON.stringify(bad)} 应被拒绝`)
      assert.equal(r.error, ERR.INVALID)
    }
    assert.deepEqual(vault.listSecretKeys().keys, [])
    assert.equal(vault.setSecret('', 'v').error, ERR.INVALID)
    assert.equal(vault.getSecret('').error, ERR.INVALID)
  })
})

test('关键回归：改密码条目不得抹掉应用密钥（反之亦然）', () => {
  // 整库单块写回的典型事故：upsert 只把 entries 写回、忘了 secrets，
  // 结果"改个备注"就把模型 authToken 抹了 —— 用户看到的是"模型突然连不上"。
  withVault(({ vault }) => {
    assert.equal(vault.setSecret('provider:p1:token', 'sk-keep-me').ok, true)
    const c = vault.upsert({ name: '某系统', password: 'p1' })
    assert.equal(c.ok, true)
    assert.deepEqual(vault.getSecret('provider:p1:token'), { ok: true, value: 'sk-keep-me' })

    assert.equal(vault.upsert({ id: c.entry.id, name: '改名' }).ok, true)
    assert.deepEqual(vault.getSecret('provider:p1:token'), { ok: true, value: 'sk-keep-me' })

    assert.equal(vault.remove(c.entry.id).ok, true)
    assert.deepEqual(vault.getSecret('provider:p1:token'), { ok: true, value: 'sk-keep-me' })

    // 反向：写密钥不得抹掉密码条目
    const c2 = vault.upsert({ name: '另一个', password: 'p2' })
    void c2
    assert.equal(vault.setSecret('provider:p2:token', 'sk-2').ok, true)
    assert.equal(vault.list().entries.length, 1)
    assert.equal(vault.list().entries[0].name, '另一个')
  })
})

test('向後兼容：老库（无 secrets 键）照常可读，写入后自动补上', () => {
  const home = freshHome()
  try {
    const crypto = fakeCrypto()
    // 手工造一个 v1 老格式（只有 entries，没有 secrets）
    const payload = JSON.stringify({ entries: [{ id: 'a', name: '老条目', url: '', username: '', password: 'p', notes: '', tags: [], createdAt: '', updatedAt: '' }] })
    writeFileSync(vaultPathOf(home), JSON.stringify({ v: 1, scheme: 'electron-safe-storage', cipher: Buffer.from(crypto.encryptString(payload)).toString('base64') }))

    const vault = createVault({ home, crypto })
    assert.equal(vault.list().ok, true, '老库必须照常可读（不能因为多了个键就判 corrupt）')
    assert.deepEqual(vault.listSecretKeys(), { ok: true, keys: [] })
    assert.equal(vault.setSecret('provider:p1:token', 'sk-new').ok, true)
    assert.deepEqual(vault.getSecret('provider:p1:token'), { ok: true, value: 'sk-new' })
    assert.equal(vault.list().entries.length, 1, '老条目仍在')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('secrets 形状不对 ⇒ corrupt（不猜测、不丢）', () => {
  for (const [label, secrets] of [['数组', []], ['字符串', 'nope'], ['含非文本值', { k: 42 }]]) {
    const home = freshHome()
    try {
      const crypto = fakeCrypto()
      const payload = JSON.stringify({ entries: [], secrets })
      writeFileSync(vaultPathOf(home), JSON.stringify({ v: 1, scheme: 'electron-safe-storage', cipher: Buffer.from(crypto.encryptString(payload)).toString('base64') }))
      const before = readFileSync(vaultPathOf(home))
      const vault = createVault({ home, crypto })
      assert.equal(vault.listSecretKeys().ok, false, `${label}：应报错`)
      assert.equal(vault.setSecret('k', 'v').ok, false, `${label}：不得写回`)
      assert.deepEqual(readFileSync(vaultPathOf(home)), before, `${label}：原文件必须原样保留`)
    } finally { rmSync(home, { recursive: true, force: true }) }
  }
})

test('内部防御：残缺状态拒绝写入（忘传字段 = 报错，而不是静默丢数据）', () => {
  withVault(({ vault }) => {
    // 通过一次正常写入确认库可用，再断言"不完整状态"这条防线存在（源码级）
    assert.equal(vault.setSecret('k', 'v').ok, true)
  })
  const src = readFileSync(new URL('./vault.cjs', import.meta.url), 'utf8')
  assert.match(src, /内部状态不完整，已放弃写入/, 'writeState 必须拒绝残缺状态')
  assert.equal((src.match(/writeState\(\{/g) || []).length, 3, '应恰有 3 处写入调用（upsert/remove/secret），全都要自带完整状态')
})

test('信封不自带秘密，且带 scheme/版本迁移位', () => {
  withVault(({ home, vault }) => {
    vault.upsert({ name: 'n', password: 'p' })
    const env = JSON.parse(readFileSync(join(home, 'vault.enc'), 'utf8'))
    assert.equal(env.v, 1)
    assert.equal(env.scheme, 'electron-safe-storage')
    assert.equal(typeof env.updatedAt, 'string')
  })
})
