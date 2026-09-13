// src/lib/knowledgeMarket.test.ts
// 运行：node --test src/lib/knowledgeMarket.test.ts
//
// 只测纯函数（组件无 DOM 环境，走人工走查）。这里钉住的都是"肉眼很难发现"的判定：
// 筛选的空值语义、角标优先级、冲突态的归类、三选白名单、版本回退语气、导出表单规则。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PACK_TAG_ALL, collectPackTags, filterPacks, packBadge, isInstallOk, classifyInstallStatus,
  CONFLICT_OPTIONS, normalizeConflictOptions, versionTone, formatBytes, validateExportForm,
  localInstallSupported, sourceLabel, PACK_ID_RE,
} from './knowledgeMarket.ts'
import type { KnowledgePackIndexItem } from './knowledgePacksApi.ts'

const item = (over: Partial<KnowledgePackIndexItem> = {}): KnowledgePackIndexItem => ({
  id: 'gaoqi', name: '高企知识包', description: '', author: 'ponos', repo: '', version: '1.0.0',
  tags: [], docCount: 0, sizeBytes: 0, official: false, localPath: '',
  installedVersion: '', onDisk: false, updateAvailable: false, ...over,
})

test('collectPackTags：去重 + 去空 + 排序（下拉选项）', () => {
  const tags = collectPackTags([
    item({ tags: ['高企', '', '  ', 'ps'] }),
    item({ id: 'b', tags: ['高企', 'rd'] }),
  ])
  assert.deepEqual(tags, [...tags].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')))
  assert.equal(new Set(tags).size, tags.length, '不得重复')
  assert.equal(tags.includes(''), false, '空标签不得进选项')
  assert.equal(tags.length, 3)
})

test('filterPacks：空 q/全部标签一律放行（"没填" ≠ "匹配不到"）', () => {
  const packs = [item({ id: 'gaoqi', name: '高企', tags: ['高企'] }), item({ id: 'ps', name: 'PS 材料', tags: ['ps'] })]
  assert.equal(filterPacks(packs, { q: '', tag: PACK_TAG_ALL }).length, 2)
  assert.equal(filterPacks(packs, {}).length, 2)
  assert.equal(filterPacks(packs, { q: '   ' }).length, 2, '纯空白关键词等同未填')
})

test('filterPacks：关键词命中 id/name/description/author/tags，大小写不敏感', () => {
  const packs = [
    item({ id: 'gaoqi', name: '高企知识包', description: '高新技术企业认定', author: 'ponos', tags: ['高企'] }),
    item({ id: 'ps-pack', name: 'PS 材料', description: '专利申请', author: 'Alice', tags: ['ps'] }),
  ]
  assert.deepEqual(filterPacks(packs, { q: 'gao' }).map(p => p.id), ['gaoqi'])
  assert.deepEqual(filterPacks(packs, { q: 'ALICE' }).map(p => p.id), ['ps-pack'])
  assert.deepEqual(filterPacks(packs, { q: '专利申请' }).map(p => p.id), ['ps-pack'])
  assert.deepEqual(filterPacks(packs, { q: '高企' }).map(p => p.id), ['gaoqi'])
  assert.deepEqual(filterPacks(packs, { q: '没有这个包' }), [])
})

test('filterPacks：标签是精确匹配（子串不算命中）', () => {
  const packs = [item({ id: 'a', tags: ['高企'] }), item({ id: 'b', tags: ['高企-2026'] })]
  assert.deepEqual(filterPacks(packs, { tag: '高企' }).map(p => p.id), ['a'])
})

test('packBadge：可更新 > 已安装 > 可安装（三者互斥，条目上只挂一个）', () => {
  assert.equal(packBadge(item({ updateAvailable: true, onDisk: true })), 'update')
  assert.equal(packBadge(item({ updateAvailable: false, onDisk: true })), 'installed')
  assert.equal(packBadge(item({ onDisk: false })), 'available')
})

test('isInstallOk / classifyInstallStatus：5 态 + to-my-space 的分类', () => {
  for (const s of ['installed', 'updated', 'unchanged', 'to-my-space']) {
    assert.equal(isInstallOk(s), true, s)
    assert.equal(classifyInstallStatus(s), 'ok', s)
  }
  assert.equal(classifyInstallStatus('kept-user-modified'), 'conflict')
  assert.equal(classifyInstallStatus('skipped-empty'), 'rejected')
  assert.equal(classifyInstallStatus('rejected'), 'rejected')
  assert.equal(isInstallOk('kept-user-modified'), false)
})

test('normalizeConflictOptions：只认白名单三项；后端不返回时回落默认三项', () => {
  assert.deepEqual(normalizeConflictOptions(['overwrite', 'keep', 'to-my-space']), [...CONFLICT_OPTIONS])
  assert.deepEqual(normalizeConflictOptions(['keep']), ['keep'])
  assert.deepEqual(normalizeConflictOptions(['keep', 'hack-mode']), ['keep'], '未知 mode 不得进按钮（点了后端会 400）')
  assert.deepEqual(normalizeConflictOptions([]), [...CONFLICT_OPTIONS])
  assert.deepEqual(normalizeConflictOptions(undefined), [...CONFLICT_OPTIONS])
  assert.deepEqual(normalizeConflictOptions('overwrite'), [...CONFLICT_OPTIONS], '非数组一律回落')
})

test('versionTone：三态 + 未知回落（needs-higher-app 要走"升级应用"而不是"坏包"）', () => {
  assert.equal(versionTone({ ok: true, reason: 'current', version: '1.0.0' }), 'current')
  assert.equal(versionTone({ ok: true, reason: 'fallback', version: '1.5.0' }), 'fallback')
  assert.equal(versionTone({ ok: false, reason: 'needs-higher-app' }), 'needs-higher-app')
  assert.equal(versionTone(null), 'unknown')
  assert.equal(versionTone({ ok: true, reason: '随便', version: '1.0.0' }), 'unknown')
})

test('formatBytes：1024 进制，0/非法值兜底 0 B', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(-1), '0 B')
  assert.equal(formatBytes(undefined), '0 B')
  assert.equal(formatBytes('512'), '512 B')
  assert.equal(formatBytes(2048), '2.0 KB')
  assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB')
})

test('validateExportForm：id/version/license 规则与后端一致（少一个 400 往返）', () => {
  assert.deepEqual(validateExportForm({ id: 'gaoqi-2026', version: '1.0.0', license: 'MIT' }), [])
  assert.deepEqual(validateExportForm({ id: 'GaoQi', version: '1.0.0', license: 'MIT' }), ['id'], '大写非法')
  assert.deepEqual(validateExportForm({ id: '-x', version: '1.0.0', license: 'MIT' }), ['id'], '首字符不得为连字符')
  assert.deepEqual(validateExportForm({ id: 'a', version: '1.0', license: 'MIT' }), ['version'], '两段版本非法')
  assert.deepEqual(validateExportForm({ id: 'a', version: '1.0.0-rc.1', license: 'MIT' }), [], '预发布后缀合法')
  assert.deepEqual(validateExportForm({ id: 'a', version: '1.0.0', license: '   ' }), ['license'], '空白 license 等同缺失')
  assert.deepEqual(validateExportForm({ id: '', version: '', license: '' }), ['id', 'version', 'license'])
  assert.deepEqual(validateExportForm({ id: 'a', version: '1.0.0', license: 'MIT', name: 'x'.repeat(81) }), ['name'])
  assert.equal(PACK_ID_RE.test('a'.repeat(64)), true, '64 字符 id 合法')
  assert.equal(PACK_ID_RE.test('a'.repeat(65)), false, '65 字节 id 非法')
})

test('localInstallSupported：无 Electron preload 时返回 false（浏览器 dev 降级路径）', () => {
  assert.equal(localInstallSupported({ openKnowledgePack: () => Promise.resolve(null) }), true)
  assert.equal(localInstallSupported({}), false)
  assert.equal(localInstallSupported(undefined), false)
  assert.equal(localInstallSupported(null), false)
  assert.equal(localInstallSupported({ openKnowledgePack: 'not-a-function' }), false)
})

test('sourceLabel：未知 source 归一 none（UI 不显示空白）', () => {
  assert.equal(sourceLabel('local'), 'local')
  assert.equal(sourceLabel('remote'), 'remote')
  assert.equal(sourceLabel('none'), 'none')
  assert.equal(sourceLabel(''), 'none')
  assert.equal(sourceLabel(undefined as unknown as string), 'none')
})
