// src/lib/knowledgeDeleteUi.test.ts —— 删除管理纯逻辑的单测（2026-09-14）
//
// 这些函数是"判错了会出丑/出事"的分支：权限镜像判错会画出点不动的按钮；
// 错误码映射漏项会让用户只看到 `protected-space` 这种没法照做的提示；
// 确认名比对判错会让"删库"变成一次手滑即可完成。故都放在 `src/lib/*Ui.ts`
// （而非 .tsx 组件内）—— 组件里就进不了 `node --test`。
//
// 注意：**权威权限判定在内核**（kernel 的 deleteGate），这里只测"界面预判"这一份。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  canDeleteSpace, canDeleteDoc, deleteErrorKey, isSpaceConfirmOk, trashItemSummary,
} from './knowledgeDeleteUi.ts'

test('canDeleteSpace: 只认 source=user（白名单，默认落在保守侧）', () => {
  assert.equal(canDeleteSpace({ source: 'user' }), true)
  // 内置经验库 / 会话记忆 / 技能经验：**不可删整库**（用户明确要求）
  assert.equal(canDeleteSpace({ source: 'experience' }), false)
  assert.equal(canDeleteSpace({ source: 'memory' }), false)
  assert.equal(canDeleteSpace({ source: 'skill_exp' }), false)
  // 只读知识包
  assert.equal(canDeleteSpace({ source: 'pack' }), false)
  // 未知来源 / 缺字段 / null：默认**不可删**。
  // 白名单而非黑名单的理由就在这行：将来新增一种来源时，默认值必须落在"删不了"那一侧。
  assert.equal(canDeleteSpace({ source: 'brand-new-source' }), false)
  assert.equal(canDeleteSpace({}), false)
  assert.equal(canDeleteSpace(null), false)
  assert.equal(canDeleteSpace(undefined), false)
})

test('canDeleteDoc: 除只读知识包外包都行（与 canDeleteSpace 的不对称是有意的）', () => {
  assert.equal(canDeleteDoc({ source: 'user' }), true)
  // 内置库不能删库、但**必须能删条目** —— 记错的一条经验要能清掉，
  // 否则用户只能去文件系统里删，风险更大
  assert.equal(canDeleteDoc({ source: 'experience' }), true)
  assert.equal(canDeleteDoc({ source: 'memory' }), true)
  assert.equal(canDeleteDoc({ source: 'skill_exp' }), true)
  // 知识包是只读来源：条目也不能删
  assert.equal(canDeleteDoc({ source: 'pack' }), false)
  // 未知来源默认可删条目（与整库相反）：退一步的代价只是"点了报 403"，内核仍会拦
  assert.equal(canDeleteDoc({}), true)
  assert.equal(canDeleteDoc(null), true)
})

test('deleteErrorKey: 已登记的码逐一映射；未登记走 unknown（不给空白）', () => {
  const known: Array<[string, string]> = [
    ['readonly-space', 'readonlySpace'],
    ['protected-space', 'protectedSpace'],
    ['bad-path', 'badPath'],
    ['bad-space', 'badSpace'],
    ['missing-space', 'missingSpace'],
    ['bad-trash-id', 'badTrashId'],
    ['bad-record', 'badRecord'],
    ['confirm-mismatch', 'confirmMismatch'],
    ['unknown-space', 'unknownSpace'],
    ['not-found', 'notFound'],
    ['unknown-trash-id', 'unknownTrashId'],
    ['payload-missing', 'payloadMissing'],
    ['space-exists', 'spaceExists'],
    ['name-exhausted', 'nameExhausted'],
    ['bad-root', 'badRoot'],
    ['HTTP_ERROR', 'network'],
  ]
  for (const [code, key] of known) assert.equal(deleteErrorKey(code), key, code)
  // 新码出现时界面仍要能说清"哪里不对"：空白会被当成"这个按钮坏了"
  assert.equal(deleteErrorKey('who-knows'), 'unknown')
  assert.equal(deleteErrorKey(''), 'unknown')
  assert.equal(deleteErrorKey(null), 'unknown')
  assert.equal(deleteErrorKey(undefined), 'unknown')
})

test('isSpaceConfirmOk: trim 首尾、内部保留、大小写敏感', () => {
  // 正常
  assert.equal(isSpaceConfirmOk('研发资料', '研发资料'), true)
  // 首尾空白被 trim（与内核同口径 —— 复制库名常带空格；不 trim 会造成"点了没反应"）
  assert.equal(isSpaceConfirmOk(' 研发资料 ', '研发资料'), true)
  assert.equal(isSpaceConfirmOk('\t研发资料\n', '研发资料'), true)
  // 内部空格**不** trim：那是另一个名字
  assert.equal(isSpaceConfirmOk('研发 资料', '研发资料'), false)
  // 大小写敏感（空间 id 就是目录名；Windows 不敏感、macOS/Linux 敏感，统一按敏感处理）
  assert.equal(isSpaceConfirmOk('ABC', 'abc'), false)
  assert.equal(isSpaceConfirmOk('abc', 'abc'), true)
  // 空 / 缺失 / 空白
  assert.equal(isSpaceConfirmOk('', '研发资料'), false)
  assert.equal(isSpaceConfirmOk('   ', '研发资料'), false)
  assert.equal(isSpaceConfirmOk(null, '研发资料'), false)
  assert.equal(isSpaceConfirmOk(undefined, '研发资料'), false)
  // 空间 id 缺失时一律 false（防止 space=null 时"空串===空串"意外放行删库）
  assert.equal(isSpaceConfirmOk('', ''), false)
  assert.equal(isSpaceConfirmOk('  ', ''), false)
  assert.equal(isSpaceConfirmOk('x', null), false)
  assert.equal(isSpaceConfirmOk('x', undefined), false)
})

test('trashItemSummary: 库/文档区分；>1 文件才报文件数；始终带体积', () => {
  const fmt = (n: unknown) => `${Number(n) || 0}B`
  // 空间项：不显示 relPath；只 1 个文件时不啰嗦文件数
  assert.equal(trashItemSummary({ kind: 'space', spaceName: '研发资料', fileCount: 1, bytes: 12 }, fmt), 'space · 研发资料 · 12B')
  // 文档项 + 多文件（导入进来的目录），文件数要显示
  assert.equal(trashItemSummary({ kind: 'doc', spaceName: '研发资料', fileCount: 7, bytes: 2048 }, fmt), 'doc · 研发资料 · 7 · 2048B')
  // 缺字段不能崩、也不能出现 "undefined" / "NaN"
  const s = trashItemSummary({}, fmt)
  assert.equal(s.includes('undefined'), false)
  assert.equal(s.includes('NaN'), false)
  // `bytes: null` / `fileCount: NaN` 是**故意喂进去的坏值**（台账被手工改过、或后端字段缺失）：
  // 类型上不该出现，所以这里显式 cast —— 用 cast 表达"这是防御性用例"，
  // 而不是把签名放宽成 `bytes?: number | null`（那是把脏值的成本转嫁给所有正常调用点）。
  const junk = { kind: 'doc', spaceName: null, fileCount: Number.NaN, bytes: null as unknown as number }
  assert.equal(trashItemSummary(junk, fmt), 'doc · 0B')
})
