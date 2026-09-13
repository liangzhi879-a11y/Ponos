// 长会话 containment（R6）：开关边界 + **CSS 接线**的回归锁。
// 运行：node --test src/lib/longListContainment.test.ts
//
// 这里不测 DOM（node 里没有；真实排版行为已由 Electron 探针逐项实测，数字记在模块头与
// globals.css 注释里）。测的是两件在 node 里能钉死、且**会真的坏掉**的事：
//   ① 门槛边界：少一条消息就不得启用（短会话挂着只有估算误差、没有收益）；
//   ② CSS 规则真的存在，且认的就是这个类名 —— 这是本设计最容易**静默**失效的地方：
//      改了 CONTAINMENT_CLASS 却忘了改 globals.css（或有人清理"没人用"的规则），
//      优化会无声消失：不报错、无外观差异、没有类型错误，只有滚动性能悄悄退回去。
//      这条测试就是防它——所以它断言的是"规则体里同时有两处声明"，而不是类名拼写本身。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  CONTAINMENT_CLASS,
  CONTAINMENT_MIN_MESSAGES,
  shouldContainMessageList,
  viewportClassName,
} from './longListContainment.ts'

test('门槛边界：59 条不启用、60 条启用', () => {
  assert.equal(shouldContainMessageList(CONTAINMENT_MIN_MESSAGES - 1), false)
  assert.equal(shouldContainMessageList(CONTAINMENT_MIN_MESSAGES), true)
})

test('冷启动/空会话/加载中（条数为 0、NaN、undefined）一律不启用', () => {
  assert.equal(shouldContainMessageList(0), false)
  assert.equal(shouldContainMessageList(NaN), false)
  assert.equal(shouldContainMessageList(undefined as unknown as number), false)
})

test('长会话启用（含远超阈值的实机量级）', () => {
  assert.equal(shouldContainMessageList(61), true)
  assert.equal(shouldContainMessageList(400), true)
})

test('类名是单一 CSS 标识符，可直接进选择器', () => {
  assert.match(CONTAINMENT_CLASS, /^[a-z][a-z0-9-]*$/)
})

test('容器类名：长会话恰好追加一个类，短会话原样返回（不产生多余空格）', () => {
  const base = 'flex-1 min-h-0 overflow-y-auto pl-1'
  assert.equal(viewportClassName(base, 59), base)
  assert.equal(viewportClassName(base, 60), `${base} ${CONTAINMENT_CLASS}`)
  // 原样返回而不是拼接空串：类名串逐字符相同 ⇒ React 侧 className 值不变，不触发 DOM 写入
  assert.equal(viewportClassName(base, 0), base)
})

test('globals.css 里真的有一条规则同时认这个类名与 [data-message-id]，且声明齐全', () => {
  const css = readFileSync(fileURLToPath(new URL('../styles/globals.css', import.meta.url)), 'utf8')
  // 只认选择器里**同时**出现类名与消息节点属性的规则体——避免"类名被别的规则用到了"假通过
  const bodies: string[] = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(css)) !== null) {
    const sel = m[1].replace(/\/\*[\s\S]*?\*\//g, '')
    if (sel.includes(`.${CONTAINMENT_CLASS}`) && sel.includes('[data-message-id]')) bodies.push(m[2])
  }
  assert.ok(bodies.length > 0, `globals.css 缺少 .${CONTAINMENT_CLASS} [data-message-id] 规则——优化会静默失效`)
  const body = bodies.join(';')
  assert.match(body, /content-visibility\s*:\s*auto\b/, '缺 content-visibility:auto（离屏子树不会跳过排版）')
  const intrinsic = /contain-intrinsic-size\s*:\s*auto\s+(\d+(?:\.\d+)?)px/.exec(body)
  assert.ok(intrinsic, '缺 contain-intrinsic-size:auto <N>px（跳过的节点必须有估算高度，否则总高为 0）')
  const px = Number(intrinsic[1])
  assert.ok(px > 0 && px <= 1024, `估算高度 ${px}px 不合理`)
})
