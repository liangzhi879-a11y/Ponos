// src/lib/dirPicker.test.ts
// node --test src/lib/dirPicker.test.ts
//
// 覆盖 spec 的 A2/A3/A6 以及"不信任 bridge 形状"的归一分支。
// 这些逻辑的错法都很安静：面包屑少一级用户就少一条跳转路径、历史栈越界会白屏、
// 脏快捷入口渲染出来点下去必报错 —— 都属于"没人测就等于没有"。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  breadcrumbSegments,
  canGoBack,
  canGoForward,
  cleanPathInput,
  currentPath,
  FOLD_PLACEHOLDER,
  foldBreadcrumb,
  goBack,
  goForward,
  initHistory,
  isSameOrUnder,
  normalizeFolders,
  normalizePath,
  pushHistory,
} from './dirPicker.ts'

test('normalizePath：统一分隔符、去尾斜杠、保留根、保留 UNC', () => {
  assert.equal(normalizePath('C:\\Users\\me\\'), 'C:/Users/me')
  assert.equal(normalizePath('  D:/a/b//c/  '), 'D:/a/b/c')
  assert.equal(normalizePath('C:/'), 'C:/', '盘符根不得被剥成 C:')
  assert.equal(normalizePath('/'), '/')
  assert.equal(normalizePath('//server/share/docs/'), '//server/share/docs', 'UNC 前缀不得被折叠')
  assert.equal(normalizePath(''), '')
})

test('A2 面包屑：每级可点且 path 正确（Windows 盘符）', () => {
  const segs = breadcrumbSegments('C:/Users/me/Documents')
  assert.deepEqual(segs.map(s => s.label), ['C:', 'Users', 'me', 'Documents'])
  assert.deepEqual(segs.map(s => s.path), ['C:/', 'C:/Users', 'C:/Users/me', 'C:/Users/me/Documents'])
})

test('A2 面包屑：POSIX 根与 UNC 根', () => {
  assert.deepEqual(breadcrumbSegments('/home/me').map(s => s.path), ['/', '/home', '/home/me'])
  const unc = breadcrumbSegments('//svr/share/docs')
  assert.equal(unc[0].path, '//svr/share', 'UNC 根应含服务器与共享名')
  assert.deepEqual(unc.map(s => s.path), ['//svr/share', '//svr/share/docs'])
})

test('A2 面包屑：正好落在盘符根时只有一段（不得凭空生出空段）', () => {
  assert.deepEqual(breadcrumbSegments('D:/').map(s => s.path), ['D:/'])
  // 无尾斜杠的裸盘符也应归一成根（否则点它会跳到"当前盘工作目录"，行为不确定）
  assert.deepEqual(breadcrumbSegments('C:').map(s => s.path), ['C:/'])
})

test('A2 面包屑：空/空白输入 ⇒ 空数组（不崩、不产假段）', () => {
  assert.deepEqual(breadcrumbSegments(''), [])
  assert.deepEqual(breadcrumbSegments('   '), [])
})

test('A6 折叠：深层路径保留「首级 + … + 末两级」，末级始终可见', () => {
  const segs = breadcrumbSegments('C:/Users/me/a/b/c/d')
  assert.equal(segs.length, 7)
  const folded = foldBreadcrumb(segs, 4)
  assert.equal(folded.length, 4)
  assert.equal(folded[0].path, segs[0].path, '首级保留')
  assert.equal(folded[1].path, FOLD_PLACEHOLDER.path, '中间是省略号且不可点')
  assert.deepEqual(folded.slice(2).map(s => s.path), segs.slice(-2).map(s => s.path), '末两级保留')
  assert.notEqual(folded[folded.length - 1].path, '', '末级必须可点（那是用户当前位置）')
})

test('A6 折叠：未超长时不折叠；maxItems 过小则原样返回（不产生无意义折叠）', () => {
  const segs = breadcrumbSegments('C:/a/b')
  assert.deepEqual(foldBreadcrumb(segs, 4), segs)
  assert.deepEqual(foldBreadcrumb(segs, 2), segs, 'maxItems<3 无法表达"首+…+末"，应原样返回')
  assert.deepEqual(foldBreadcrumb([], 4), [])
})

test('A3 历史栈：进入 a→b→c，后退两次到 a，前进一次到 b', () => {
  let h = initHistory('C:/a')
  h = pushHistory(h, 'C:/a/b')
  h = pushHistory(h, 'C:/a/b/c')
  assert.equal(currentPath(h), 'C:/a/b/c')
  assert.equal(canGoBack(h), true)
  assert.equal(canGoForward(h), false)

  h = goBack(h)
  assert.equal(currentPath(h), 'C:/a/b')
  assert.equal(canGoForward(h), true)
  h = goBack(h)
  assert.equal(currentPath(h), 'C:/a')
  assert.equal(canGoBack(h), false, '到最早就不该再后退')
  assert.equal(goBack(h).index, h.index, '越界后退应原地不动（不报错、不丢状态）')

  h = goForward(h)
  assert.equal(currentPath(h), 'C:/a/b')
})

test('A3 历史栈：后退后再跳转 ⇒ 截断前进分支（与浏览器一致）', () => {
  let h = initHistory('C:/a')
  h = pushHistory(h, 'C:/a/b')
  h = pushHistory(h, 'C:/a/c')
  h = goBack(h)
  h = pushHistory(h, 'C:/a/d')
  assert.equal(currentPath(h), 'C:/a/d')
  assert.equal(canGoForward(h), false, '新跳转后不应还能前进到旧的 c')
  assert.deepEqual(h.stack, ['C:/a', 'C:/a/b', 'C:/a/d'])
})

test('A3 历史栈：重复跳同一路径不产生新历史（否则点"没反应"却撑满历史）', () => {
  let h = initHistory('C:/a')
  const before = h
  h = pushHistory(h, 'C:/a')
  assert.equal(h, before, '同路径应原样返回同一对象')
  h = pushHistory(h, 'C:/a/')
  assert.equal(currentPath(h), 'C:/a')
  assert.equal(h.stack.length, 1, '仅尾斜杠差异不应算新历史')
  // 空路径不入栈
  assert.equal(pushHistory(h, '').stack.length, 1)
})

test('A3 历史栈：超上限时丢弃最早项且 index 仍指向当前', () => {
  let h = initHistory('C:/0')
  for (let i = 1; i < 130; i++) h = pushHistory(h, `C:/${i}`)
  assert.ok(h.stack.length <= 100, '历史上限应生效')
  assert.equal(currentPath(h), 'C:/129')
  assert.equal(h.index, h.stack.length - 1, 'index 必须仍指向栈顶')
})

test('initHistory：空路径 ⇒ 空栈（currentPath 为空串而非 undefined）', () => {
  const h = initHistory('')
  assert.deepEqual(h, { stack: [], index: 0 })
  assert.equal(currentPath(h), '')
  assert.equal(canGoBack(h), false)
  assert.equal(canGoForward(h), false)
})

test('A5/D2 快捷入口归一：只放行合法项，脏数据丢弃，重复去重', () => {
  const out = normalizeFolders({
    folders: [
      { name: '桌面', path: 'C:\\Users\\me\\Desktop', kind: 'desktop' },
      { name: '文档', path: 'C:/Users/me/Documents', kind: 'documents' },
      { name: '重复', path: 'C:/Users/me/Documents', kind: 'x' },   // 与上一项同目录 ⇒ 去重
      { name: '', path: 'C:/x' },                                    // 空名 ⇒ 丢弃
      { name: '无路径' },                                            // 缺 path ⇒ 丢弃
      { path: 'C:/y' },                                              // 缺 name ⇒ 丢弃
      null, 'junk', 42,                                              // 非对象 ⇒ 丢弃
      { name: '主目录', path: 'C:/Users/me' },                       // kind 缺省 ⇒ other
    ],
  })
  assert.deepEqual(out.map(f => f.name), ['桌面', '文档', '主目录'])
  assert.equal(out[0].path, 'C:/Users/me/Desktop', '路径应被归一为正斜杠')
  assert.equal(out[2].kind, 'other', 'kind 缺省应兜底为 other，不得是 undefined')
})

test('快捷入口归一：形状完全不对时不抛异常，返回空列表', () => {
  for (const bad of [null, undefined, 'x', 42, {}, { folders: 'x' }, { folders: null }]) {
    assert.deepEqual(normalizeFolders(bad), [], `输入 ${JSON.stringify(bad)} 应得空列表`)
  }
})

test('地址栏清洗：剥成对引号（资源管理器复制常带引号）、去空白、统一斜杠', () => {
  assert.equal(cleanPathInput('"C:\\Users\\me\\Desktop"'), 'C:/Users/me/Desktop')
  assert.equal(cleanPathInput("  'C:/a'  "), 'C:/a')
  // 只剥**成对**引号：单边引号是用户输入的一部分，不能吃掉
  assert.equal(cleanPathInput('"C:/a'), '"C:/a')
  assert.equal(cleanPathInput('C:\\a\\'), 'C:/a')
  assert.equal(cleanPathInput('   '), '')
  assert.equal(cleanPathInput(''), '')
})

test('isSameOrUnder：高亮判定不把 /a 误判为 /ab 的父级', () => {
  assert.equal(isSameOrUnder('C:/Users/me', 'C:/Users/me'), true)
  assert.equal(isSameOrUnder('C:/Users/me/Desktop', 'C:/Users/me'), true)
  assert.equal(isSameOrUnder('C:/Users/memo', 'C:/Users/me'), false, '前缀相似但非同层，不得误判')
  assert.equal(isSameOrUnder('C:/other', 'C:/Users/me'), false)
  assert.equal(isSameOrUnder('', 'C:/a'), false)
  assert.equal(isSameOrUnder('C:/a', ''), false)
})

test('端到端推演：从快捷入口起手不再逐级爬（A5）', () => {
  // 旧行为：从 C:/ 逐级点进 Users/me/Documents（3 次跳转）
  // 新行为：点"文档"一次直达，且历史栈只记一跳、可回退
  let h = initHistory('C:/')
  h = pushHistory(h, 'C:/Users/me/Documents')
  assert.equal(currentPath(h), 'C:/Users/me/Documents')
  const crumbs = breadcrumbSegments(currentPath(h))
  assert.equal(crumbs.length, 4, '面包屑仍能反映真实层级（可从任一级继续跳）')
  h = goBack(h)
  assert.equal(currentPath(h), 'C:/', '一次后退即回到起点')
})
