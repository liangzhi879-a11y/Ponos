// shared/knowledge-pack.test.mjs —— 知识包规则层测试（纯函数，无 IO）
// 重点：**难看的输入**（穿越/保留名/大写扩展名/伪造 source）必须逐条被拒，且错误文案可读。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import {
  PACK_ID_RE, PACK_LIMITS, packSpaceId, sanitizePackEntryPath, classifyPackEntry, isInsideRoot,
  hashContent, parseSemver, compareSemver, normalizeAppVersion, satisfiesMinApp, resolvePackVersion,
  validatePackManifest, buildManifestEntry, buildPackReadme, buildLedgerEntry, packFileKey,
} from './knowledge-pack.mjs'

test('条目名净化：合法名放行，穿越/绝对/盘符/NUL/保留名/歧义尾字符 一律拒', () => {
  assert.deepEqual(sanitizePackEntryPath('content/docs/a.md'), { ok: true, path: 'content/docs/a.md' })
  assert.deepEqual(sanitizePackEntryPath('content\\docs\\a.md'), { ok: true, path: 'content/docs/a.md' }, '反斜杠归一为 /')

  for (const bad of [
    '', '../etc/passwd', 'content/../../x.md', '/abs.md', 'C:/win.md', 'c:\\win.md',
    '//server/share/x.md', 'a/\0b.md', 'content/./a.md', 'a//b.md', 'con.md', 'COM1.txt',
    'content/a.md ', 'content/a.md.', 'content/' + 'x'.repeat(130) + '.md',
  ]) {
    const r = sanitizePackEntryPath(bad)
    assert.equal(r.ok, false, `应拒绝：${JSON.stringify(bad)}`)
    assert.ok(r.error, '拒绝必须带原因')
  }
})

test('条目分类：md=doc，图片/PDF/CSV=asset，可执行与未知类型拒', () => {
  assert.deepEqual(classifyPackEntry('content/a.md'), { ok: true, kind: 'doc' })
  assert.deepEqual(classifyPackEntry('content/图.PNG'), { ok: true, kind: 'asset' }, '扩展名判定大小写无关')
  assert.deepEqual(classifyPackEntry('content/manual.pdf'), { ok: true, kind: 'asset' })
  for (const bad of ['content/run.exe', 'content/app.js', 'content/setup.bat', 'content/index.html', 'content/x.sh', 'README']) {
    const r = classifyPackEntry(bad)
    assert.equal(r.ok, false, `应拒绝：${bad}`)
  }
  assert.match(classifyPackEntry('content/run.exe').error, /可执行/, '错误要说清是"可执行/脚本"而非泛泛拒绝')
})

test('isInsideRoot：同根/子路径通过，前缀相同但非子目录必须挡（/a/notes 与 /a/notes-x）', () => {
  const root = resolve('/tmp/knowledge/packs/demo')
  assert.equal(isInsideRoot(root, join(root, 'content/a.md')), true)
  assert.equal(isInsideRoot(root, root), true)
  assert.equal(isInsideRoot(root, resolve('/tmp/knowledge/packs/demo-x/a.md')), false)
  assert.equal(isInsideRoot(root, resolve('/tmp/other/a.md')), false)
})

test('内容指纹：行尾归一（CRLF==LF），二进制按原字节，长度 16', () => {
  const a = hashContent(Buffer.from('# 标题\r\n内容\r\n'), { name: 'a.md' })
  const b = hashContent(Buffer.from('# 标题\n内容\n'), { name: 'a.md' })
  assert.equal(a, b, '文本类先归一行尾再哈希（否则跨平台重装会误判"用户改过"）')
  assert.equal(a.length, 16)
  assert.notEqual(hashContent(Buffer.from([1, 2, 3]), { name: 'a.bin' }), hashContent(Buffer.from([1, 2, 4]), { name: 'a.bin' }))
})

test('semver：解析/比较/预发布序/非法返回 null', () => {
  assert.deepEqual(parseSemver('1.2.3'), { major: 1, minor: 2, patch: 3, pre: '' })
  assert.equal(parseSemver('1.2.3') !== null, true)
  assert.equal(compareSemver('1.2.0', '1.10.0'), -1)
  assert.equal(compareSemver('1.2.3', '1.2.3'), 0)
  assert.equal(compareSemver('1.2.3-beta.1', '1.2.3'), -1, '预发布小于正式')
  assert.equal(compareSemver('v1.2.3', '1.2.3'), null, '不合法输入给 null，不猜')
  assert.equal(parseSemver('1.2'), null, '两位版本号不是合法 semver（拒绝比容错更可控）')
})

test('应用版本归一：version.mjs 的 "dev 3.0.0" 也能参与兼容判定', () => {
  assert.equal(normalizeAppVersion('dev 3.0.0'), '3.0.0')
  assert.equal(normalizeAppVersion('2.8.0'), '2.8.0')
  assert.equal(normalizeAppVersion('无版本'), '')
  assert.equal(satisfiesMinApp('0.9.0', 'dev 3.0.0'), true)
  assert.equal(satisfiesMinApp('9.0.0', 'dev 3.0.0'), false)
  assert.equal(satisfiesMinApp('', 'dev 3.0.0'), true, '不声明即不限制')
  assert.equal(satisfiesMinApp('0.9.0', '未知版本串'), true, '应用版本不可解析时不拦（否则一个版本串形态问题就挡住全部安装）')
})

test('版本决策：当前版本可用 / versions.json 回退取最高兼容版 / 无兼容版即拒', () => {
  const versions = { '2.0.0': '9.9.9', '1.5.0': '2.9.0', '1.2.0': '0.8.0', '1.1.0': '3.1.0' }
  assert.deepEqual(
    resolvePackVersion({ manifestVersion: '1.2.0', minAppVersion: '2.0.0', appVersion: 'dev 3.0.0', versions }),
    { ok: true, version: '1.2.0', reason: 'current' },
  )
  const fb = resolvePackVersion({ manifestVersion: '3.0.0', minAppVersion: '9.0.0', appVersion: 'dev 3.0.0', versions })
  assert.equal(fb.ok, true)
  assert.equal(fb.reason, 'fallback')
  // versions.json 的方向是「包版本 → 该版本要求的 App 版本」：'1.5.0': '2.9.0' 表示 1.5.0 要 App ≥ 2.9.0。
  // 逐条筛：2.0.0 要 9.9.9 ✗、1.5.0 要 2.9.0 ✓、1.2.0 要 0.8.0 ✓、1.1.0 要 3.1.0 ✗ → 取最高的 1.5.0
  assert.equal(fb.version, '1.5.0')
  const none = resolvePackVersion({ manifestVersion: '3.0.0', minAppVersion: '9.0.0', appVersion: 'dev 3.0.0', versions: { '3.0.0': '9.9.9' } })
  assert.equal(none.ok, false)
  assert.equal(none.reason, 'needs-higher-app')
  assert.match(none.error, /需要应用版本 ≥ 9\.0\.0/)
  assert.equal(resolvePackVersion({ manifestVersion: '1.0.0', appVersion: 'dev 3.0.0' }).ok, true, '无 versions.json 且自身兼容')
})

const goodPack = {
  id: 'demo-pack',
  name: '演示包',
  version: '1.0.0',
  minAppVersion: '0.1.0',
  license: 'CC-BY-4.0',
  source: 'content',
  description: '演示',
  author: '官方',
}

test('manifest 校验：合法包通过并给出 pack 规范化结果', () => {
  const r = validatePackManifest(goodPack, { appVersion: 'dev 3.0.0' })
  assert.equal(r.ok, true)
  assert.deepEqual(r.errors, [])
  assert.equal(r.pack.id, 'demo-pack')
  assert.equal(r.pack.license, 'CC-BY-4.0')
  assert.equal(r.pack.source, 'content')
  assert.equal(r.version.reason, 'current')
})

test('manifest 校验：缺 license / 非法 id / id 不一致 / source 越界 / source 为 . 一律拒', () => {
  const noLicense = validatePackManifest({ ...goodPack, license: '' }, {})
  assert.equal(noLicense.ok, false)
  assert.match(noLicense.errors.join('；'), /license/)

  const badId = validatePackManifest({ ...goodPack, id: 'Demo_Pack' }, {})
  assert.equal(badId.ok, false)
  assert.match(badId.errors.join('；'), /不合法/)

  const mismatch = validatePackManifest(goodPack, { expectId: 'other-pack' })
  assert.equal(mismatch.ok, false)
  assert.match(mismatch.errors.join('；'), /与安装目标「other-pack」不一致/)

  const escape = validatePackManifest({ ...goodPack, source: '../../etc' }, {})
  assert.equal(escape.ok, false)
  assert.match(escape.errors.join('；'), /source 不合法/)

  const dot = validatePackManifest({ ...goodPack, source: '.' }, {})
  assert.equal(dot.ok, false, 'source="." 会把 pack.json/README.md 收进空间')
  assert.match(dot.errors.join('；'), /不得为 "\."/)

  const noSource = validatePackManifest({ ...goodPack, source: '' }, {})
  assert.equal(noSource.ok, false)

  assert.equal(validatePackManifest('不是对象', {}).ok, false)
  assert.equal(validatePackManifest({ ...goodPack, version: 'v1' }, {}).ok, false)
  assert.equal(validatePackManifest({ ...goodPack, minAppVersion: 'latest' }, {}).ok, false)
})

test('manifest 校验：spaces[] 只警告不失败（内核只支持单空间包）', () => {
  const r = validatePackManifest({ ...goodPack, spaces: [{ id: 'a', path: 'docs/a' }] }, { appVersion: 'dev 3.0.0' })
  assert.equal(r.ok, true)
  assert.equal(r.warnings.length, 1)
  assert.match(r.warnings[0], /spaces\[\]/)
  assert.equal(r.pack.spaces, undefined, '不产出未实现字段，避免下游以为它生效')
})

test('manifest 校验：版本不兼容且无回退 → ok:false 且文案可直接展示', () => {
  const r = validatePackManifest({ ...goodPack, minAppVersion: '99.0.0' }, { appVersion: 'dev 3.0.0', versions: {} })
  assert.equal(r.ok, false)
  assert.equal(r.pack, null)
  assert.match(r.errors[0], /需要应用版本 ≥ 99\.0\.0/)
})

test('清单条目/README/台账 片段生成', () => {
  const entry = buildManifestEntry({ id: 'demo-pack', name: '演示包', repo: 'https://example.com/x', tags: ['高企'], docCount: 3, sizeBytes: 1024 })
  assert.deepEqual(Object.keys(entry), ['id', 'name', 'description', 'author', 'repo', 'tags', 'docCount', 'sizeBytes'])
  assert.equal(entry.docCount, 3)
  const readme = buildPackReadme({ name: '演示包', version: '1.0.0', license: 'MIT', docCount: 3 })
  assert.match(readme, /# 演示包/)
  assert.match(readme, /许可证：MIT/)
  assert.match(readme, /不含任何可执行文件/)
  const led = buildLedgerEntry({ id: 'demo-pack', version: '1.0.0', files: { 'demo-pack/content/a.md': 'abc' } })
  assert.equal(led.spaceId, 'pack-demo-pack')
  assert.equal(typeof led.installedAt, 'string')
  assert.equal(packFileKey('demo-pack', 'content/a.md'), 'demo-pack/content/a.md')
  assert.equal(packSpaceId('x'), 'pack-x')
  assert.equal(PACK_ID_RE.test('a-b1'), true)
  assert.equal(PACK_LIMITS.maxTotalBytes, 50 * 1024 * 1024)
})
