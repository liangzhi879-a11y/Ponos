// src/components/cockpit/cockpitAsset.test.ts
// node --test src/components/cockpit/cockpitAsset.test.ts
//
// 驾驶舱 iframe 是**静态资产**（public/cockpit/*），不在 React/TS 编译链里，
// 因此它和宿主的 postMessage 契约、以及本次交互改动，都没有任何运行时测试能兜住——
// 改名/删字段/改路由时不会有编译错误，只会表现为"点了没反应"。
// 本文件以源码断言的形式钉住契约与关键实现点（漂移即红）：
//   1. 每个模块都声明 cta + route，route 只允许 rail/secondTab/utility 三个键；
//   2. 上报形状与宿主 resolveCockpitNav 的预期一致（type:'yfw:nav' + target）；
//   3. CTA 按钮存在且接线；
//   4. 交互项在位（三角放大 + 邻居衰减 + 邻居表构建 + 悬浮框贴边 + logo 缩小）。
// 断言的是"存在性与形状"，不是像素——视觉仍需人工验收，但结构性回退会被拦住。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const js = readFileSync(new URL('../../../public/cockpit/cockpit.js', import.meta.url), 'utf8')
const html = readFileSync(new URL('../../../public/cockpit/index.html', import.meta.url), 'utf8')

/** 抽出 BUTTON_MODULES 数组字面量 */
function buttonModulesBlock(): string {
  const start = js.indexOf('const BUTTON_MODULES = [')
  assert.ok(start >= 0, 'BUTTON_MODULES 未找到（命名漂移？）')
  const end = js.indexOf('];', start)
  assert.ok(end > start, 'BUTTON_MODULES 未正常闭合')
  return js.slice(start, end)
}

test('每个模块都声明 cta 与 route（功能入口的声明面）', () => {
  const block = buttonModulesBlock()
  const rows = block.split('\n').filter(l => l.includes("id: '"))
  assert.equal(rows.length, 6, '模块数应为 6（驾驶舱六功能）')
  for (const row of rows) {
    assert.match(row, /cta:\s*'/, `模块缺 cta：${row.trim().slice(0, 60)}`)
    assert.match(row, /route:\s*\{/, `模块缺 route：${row.trim().slice(0, 60)}`)
  }
})

test('route 只使用 rail/secondTab/utility 三个键（宿主只认这三个）', () => {
  const block = buttonModulesBlock()
  const routes = [...block.matchAll(/route:\s*\{([^}]*)\}/g)].map(m => m[1])
  assert.equal(routes.length, 6)
  for (const r of routes) {
    const keys = [...r.matchAll(/([A-Za-z]+)\s*:/g)].map(m => m[1])
    assert.ok(keys.length > 0, `空 route：${r}`)
    for (const k of keys) {
      assert.ok(['rail', 'secondTab', 'utility'].includes(k), `route 出现未知键 ${k}：${r}`)
    }
  }
})

test('功能入口覆盖 6 个模块各自的目标（含 rail+secondTab 组合与工具窗）', () => {
  const block = buttonModulesBlock()
  // 会话/任务/智能体/知识库 = rail；用量 = task+usage；设置 = utility
  assert.match(block, /route:\s*\{\s*rail:\s*'chat'\s*\}/)
  assert.match(block, /route:\s*\{\s*rail:\s*'task'\s*\}/)
  assert.match(block, /route:\s*\{\s*rail:\s*'agents'\s*\}/)
  assert.match(block, /route:\s*\{\s*rail:\s*'knowledge'\s*\}/)
  assert.match(block, /route:\s*\{\s*rail:\s*'task',\s*secondTab:\s*'usage'\s*\}/)
  assert.match(block, /route:\s*\{\s*utility:\s*'settings'\s*\}/)
})

test('上报形状与宿主 resolveCockpitNav 预期一致：{type:"yfw:nav", target:route}', () => {
  assert.match(js, /notifyHost\('yfw:nav',\s*\{\s*target:\s*bm\.route\s*\}\)/,
    'navTo 必须以 yfw:nav + target 上报（宿主按此解析）')
  assert.match(js, /function notifyHost\(type,\s*extra\)/, 'notifyHost 需支持附加载荷')
})

test('CTA 按钮存在且已接线（不只是画了个按钮）', () => {
  assert.match(html, /id="dpCta"/, 'index.html 缺 CTA 按钮元素')
  assert.match(js, /getElementById\('dpCta'\)\.addEventListener\('click'/, 'CTA 未绑定点击')
  assert.match(js, /cta\.dataset\.module\s*=\s*moduleId/, 'CTA 未记录当前模块（会永远进第一个模块）')
  assert.match(js, /cta\.textContent\s*=\s*bm\.cta/, 'CTA 文案未随模块变化')
})

test('三角 hover：放大 + 邻居衰减 + 邻接表在渲染期构建', () => {
  assert.match(html, /#triCanvas path\.tri-hover\{\s*transform:scale\(1\.22\)/, 'hover 未放大')
  assert.match(html, /transform-box:fill-box; transform-origin:center;/, '缺少 fill-box 原点（会以 viewBox 左上角缩放，三角被甩飞）')
  assert.match(html, /#triCanvas path\.tri-near\{\s*opacity/, '缺少邻居衰减样式')
  assert.match(html, /transition:transform \.18s ease, opacity \.18s ease/, '缺少缓动过渡（要求"平缓过渡"）')
  const renderIdx = js.indexOf('renderDensity(svg);')
  const buildIdx = js.indexOf('buildNeighbors();')
  assert.ok(buildIdx > 0, 'buildNeighbors 未定义/未调用')
  assert.ok(renderIdx >= 0 && Math.abs(buildIdx - renderIdx) < 2000,
    'buildNeighbors 应在 renderTriCanvas 内紧随 renderDensity 调用（否则邻居表与索引不同步）')
})

test('三角 hover：放大后压住邻居但不遮按钮图标', () => {
  assert.match(js, /svg\.insertBefore\(p,\s*anchor\)/, '未把 hover 三角提升层级（放大一角会被邻居描边切断）')
  assert.match(js, /querySelector\('g\[data-btn-icon\]'\)/, '提升层级必须以按钮图标为锚（否则遮住图标）')
})

test('悬浮详情框贴按钮外侧展开（不再相对 logo 中心偏移）', () => {
  assert.match(js, /const HOVER_GAP\s*=\s*10/, '缺少贴边间隙常量')
  assert.match(js, /el\.classList\.add\('side-'\s*\+\s*effSide\)/, '未按方位切换入场方向')
  for (const s of ['side-left', 'side-right', 'side-top', 'side-bottom']) {
    assert.ok(html.includes(`.hover-panel.${s}`), `index.html 缺 ${s} 入场方向样式`)
  }
  assert.ok(!/\(dx \/ len\) \* 130/.test(js), '旧的相对 logo 中心偏移写法仍在（应已改为贴按钮外缘）')
})

test('中央 logo 尺寸已降低（0.42/346 → 0.30/248）', () => {
  assert.match(js, /Math\.min\(STATE\.W, STATE\.H\) \* 0\.30, 248\)/, 'logo 计算式未收敛')
  assert.ok(!/0\.42, 346/.test(js), '旧 logo 尺寸残留')
})

test('主题分支不含已删除的浅色玻璃', () => {
  assert.ok(!/light-glass/.test(js), 'cockpit.js 仍引用 light-glass')
  assert.ok(!/light-glass/.test(html), 'index.html 仍引用 light-glass')
})
