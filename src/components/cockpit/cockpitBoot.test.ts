// src/components/cockpit/cockpitBoot.test.ts
// node --test src/components/cockpit/cockpitBoot.test.ts
//
// 【为什么需要这个测试】2026-09-16 事故复盘：
// 驾驶舱资产 public/cockpit/cockpit.js 是**普通脚本**（不在 TS 编译链、无 import、
// 无任何模块边界），顶层脚本一旦抛异常，其后的 layout() 与 signalReady() 就永不执行。
// 表现为「三角拼贴/按钮图标全空 + 父窗口收不到 yfw:ready → 主题与 overview 都不下发」，
// 整个驾驶舱静默失效，控制台之外毫无痕迹（本次根因是资产里一行 `void vkey;`，
// vkey 从未定义，ReferenceError 打断的正是 buildNeighbors()）。
//
// cockpitAsset.test.ts 只做**文本正则断言**（钉 postMessage 契约与 CSS 关键样式），
// 对"能解析、能通过语法检查、但一跑就抛"的错误完全无感——`node --check` 同样抓不到
// （语法合法）。本文件补上**执行冒烟**：用 node:vm + 极简 DOM stub 把资产真跑一遍，
// 断言启动链确实跑到底。不起端口、不连网络、不引新依赖，因此可以进 `npm test`。
//
// 断言面（对应事故的四条症状）：
//   1. 顶层脚本执行不抛 → 未定义标识符/拼写漂移/API 误用即红；
//   2. 三角拼贴与 6 个按钮图标真的渲染出来了（path 数为 0 正是事故特征）；
//   3. yfw:ready 真的上报（父窗口全靠它才会下发 theme/overview）；
//   4. head 首帧主题脚本可执行并产出 theme-* 类（同样死在顶层会白屏闪主题）；
//   5. 自检：本机制对 `void vkey;` 确实抛 ReferenceError（防测试本身失效）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

/** 元素 stub 用宽松类型：它只是资产的替身，精确建模 DOM 不在本测试职责内 */
type El = any

const JS = readFileSync(new URL('../../../public/cockpit/cockpit.js', import.meta.url), 'utf8')
const HTML = readFileSync(new URL('../../../public/cockpit/index.html', import.meta.url), 'utf8')

function fmtErr(e: unknown): string {
  if (!e) return '(无)'
  const err = e as { name?: string; message?: string; stack?: string }
  const head = (err.stack || '').split('\n').slice(0, 3).join(' | ')
  return `${err.name ?? 'Error'}: ${err.message ?? String(e)} @ ${head}`
}

function makeEl(tag: string): El {
  const el: El = {
    tagName: String(tag).toUpperCase(),
    children: [] as El[],
    parentNode: null as El | null,
    attrs: {} as Record<string, string>,
    dataset: {} as Record<string, string>,
    _classes: new Set<string>(),
    textContent: '',
    innerHTML: '',
    // img 语义：视为"尚未加载完成"，使顶层跳过依赖离屏 canvas 的轮廓校正
    // （那条路径需要真实 getImageData，与本次要守的启动链无关）
    complete: false,
    naturalWidth: 0,
    style: {
      setProperty: () => {},
      removeProperty: () => {},
      getPropertyValue: () => '',
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    focus: () => {},
    blur: () => {},
    setAttribute(k: string, v: unknown) {
      el.attrs[k] = String(v)
      if (k.startsWith('data-')) {
        // data-btn-icon → dataset.btnIcon（资产侧按 dataset 读写）
        el.dataset[k.slice(5).replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())] = String(v)
      }
    },
    getAttribute(k: string) { return el.attrs[k] ?? null },
    appendChild(c: El) { c.parentNode = el; el.children.push(c); return c },
    insertBefore(c: El, anchor: El) {
      c.parentNode = el
      const i = el.children.indexOf(anchor)
      if (i < 0) el.children.push(c); else el.children.splice(i, 0, c)
      return c
    },
    remove() {
      const p = el.parentNode as El | null
      if (p) {
        const i = p.children.indexOf(el)
        if (i >= 0) p.children.splice(i, 1)
        el.parentNode = null
      }
    },
    getBoundingClientRect: () => ({ width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0, x: 0, y: 0 }),
    getContext: () => null,
    querySelector(sel: string) { return queryAll(el, sel, byIdOf(el))[0] ?? null },
    querySelectorAll(sel: string) { return queryAll(el, sel, byIdOf(el)) },
  }
  el.classList = {
    add: (...cs: string[]) => { cs.forEach(c => el._classes.add(c)) },
    remove: (...cs: string[]) => { cs.forEach(c => el._classes.delete(c)) },
    contains: (c: string) => el._classes.has(c),
    toggle: (c: string, on?: boolean) => {
      const want = on === undefined ? !el._classes.has(c) : !!on
      if (want) el._classes.add(c); else el._classes.delete(c)
      return want
    },
  }
  // className 与 classList 共用一份集合：head 脚本写 className、运行时走 classList，
  // isLightTheme() 又读 className —— 三者必须一致，否则主题判定会错
  Object.defineProperty(el, 'className', {
    get() { return [...el._classes].join(' ') },
    set(v: string) {
      el._classes.clear()
      String(v).split(/\s+/).filter(Boolean).forEach((c: string) => el._classes.add(c))
    },
  })
  return el
}

/** 元素 → 其所属文档的 id 注册表（供 `#id` 选择器解析） */
const REGISTRY = new WeakMap<object, Map<string, El>>()
function byIdOf(el: El): Map<string, El> {
  return REGISTRY.get(el) ?? new Map()
}

/** 只覆盖资产实际用到的选择器形态：#id / tag / tag.class / tag[attr] / tag[attr="v"] */
function matchSel(el: El, sel: string, byId: Map<string, El>): boolean {
  const s = sel.trim()
  if (s.startsWith('#')) return el === byId.get(s.slice(1))
  const m = /^([a-zA-Z]+)?(?:\.([\w-]+))?(?:\[([\w-]+)(?:="([^"]*)")?\])?$/.exec(s)
  if (!m) return false
  const [, tag, cls, attr, val] = m
  if (tag && el.tagName !== tag.toUpperCase()) return false
  if (cls && !el._classes.has(cls)) return false
  if (attr) {
    if (!(attr in el.attrs)) return false
    if (val !== undefined && el.attrs[attr] !== val) return false
  }
  return true
}

function descendants(root: El, out: El[] = []): El[] {
  for (const c of root.children as El[]) {
    out.push(c)
    descendants(c, out)
  }
  return out
}

/** 支持后代组合选择器（如 `#triCanvas path[data-idx="3"]`） */
function queryAll(root: El, sel: string, byId: Map<string, El>): El[] {
  const tokens = String(sel).trim().split(/\s+/)
  const last = tokens[tokens.length - 1]
  const res: El[] = []
  for (const el of descendants(root)) {
    if (!matchSel(el, last, byId)) continue
    let i = tokens.length - 2
    let p: El | null = el.parentNode
    while (i >= 0 && p) {
      if (matchSel(p, tokens[i], byId)) i--
      p = p.parentNode
    }
    if (i < 0) res.push(el)
  }
  return res
}

interface Boot {
  doc: El
  msgs: Array<Record<string, unknown>>
  /** 顶层脚本的异常（undefined = 启动链跑通） */
  err: unknown
  /** 空转挂起的 setTimeout/rAF 回调，用于把 ready 上报推出来 */
  flush: (limit?: number) => void
  paths: () => number
  icons: () => number
}

/**
 * 在 vm 沙箱里把驾驶舱资产跑一遍（等价于浏览器里的顶层脚本加载）。
 * @param search location.search（首帧主题来源）
 * @param withJs 是否执行 cockpit.js（false 时只备好环境，供 head 脚本单测）
 */
function boot({ search = '?theme=dark', withJs = true } = {}): Boot {
  const byId = new Map<string, El>()
  const msgs: Array<Record<string, unknown>> = []
  const timers: Array<() => void> = []

  const doc = makeEl('document')
  doc.readyState = 'complete'
  doc.documentElement = makeEl('html')
  doc.body = makeEl('body')
  // 任何 id 都返回稳定实例：资产侧会对 getElementById 结果直接 setAttribute，
  // 返回 null 属于"页面真缺元素"（另一类问题），不在本测试的验证范围内
  doc.getElementById = (id: string) => {
    let el = byId.get(id)
    if (!el) {
      el = makeEl(id === 'triCanvas' ? 'svg' : id === 'logoSvg' ? 'img' : 'div')
      byId.set(id, el)
      doc.appendChild(el)   // 挂进文档树，后代选择器才命中
    }
    return el
  }
  doc.createElement = (t: string) => makeEl(t)
  doc.createElementNS = (_ns: string, t: string) => makeEl(t)
  doc.querySelector = (s: string) => queryAll(doc, s, byId)[0] ?? null
  doc.querySelectorAll = (s: string) => queryAll(doc, s, byId)
  doc.addEventListener = () => {}
  REGISTRY.set(doc, byId)

  const sandbox: El = {
    document: doc,
    location: { search },
    URLSearchParams,
    console,
    performance: { now: () => Date.now() },
    // layout() 读裸 innerWidth/innerHeight（非 window. 前缀），故须直接挂在沙箱上
    innerWidth: 1087,
    innerHeight: 718,
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout: (fn: () => void) => { timers.push(fn); return timers.length },
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: (fn: () => void) => { timers.push(fn); return timers.length },
    cancelAnimationFrame: () => {},
  }
  sandbox.window = sandbox
  sandbox.self = sandbox
  // 资产用 `const host = window.parent` 上报，父窗口消息落在这里
  sandbox.parent = { postMessage: (m: Record<string, unknown>) => { msgs.push(m) } }

  const ctx = vm.createContext(sandbox)
  let err: unknown
  if (withJs) {
    try {
      vm.runInContext(JS, ctx, { filename: 'public/cockpit/cockpit.js' })
    } catch (e) {
      err = e
    }
  }

  const triCanvas = () => doc.getElementById('triCanvas')
  return {
    doc,
    msgs,
    err,
    flush(limit = 100) {
      let n = 0
      while (timers.length && n++ < limit) {
        const fn = timers.shift()!
        try { fn() } catch (e) { msgs.push({ type: '__timer_throw__', e: fmtErr(e) }) }
      }
    },
    paths: () => (triCanvas().children as El[]).filter(c => c.tagName === 'PATH').length,
    icons: () => (triCanvas().children as El[]).filter(
      c => c.tagName === 'G' && 'data-btn-icon' in (c.attrs as Record<string, string>),
    ).length,
  }
}

test('顶层脚本执行不抛异常（未定义标识符即在此拦下）', () => {
  const b = boot()
  // 这条断言是本次事故的"哨兵"：`void vkey;` 之类的 ReferenceError 会让后续断言全部失去意义
  assert.equal(b.err, undefined, `驾驶舱资产顶层脚本抛异常，启动链已中断：${fmtErr(b.err)}`)
})

test('三角拼贴与 6 个按钮图标真的渲染出来（path 数为 0 是事故特征）', () => {
  const b = boot()
  assert.equal(b.err, undefined, `顶层脚本抛异常：${fmtErr(b.err)}`)
  // 阈值取量级判定（浏览器 1087×718 实测 949 条）：0 才是故障特征，
  // 不写死具体条数，避免剖分参数微调就误红
  assert.ok(b.paths() >= 500, `三角拼贴未渲染：path=${b.paths()}（应为数百条背景三角）`)
  assert.equal(b.icons(), 6, '按钮图标数应为 6（驾驶舱六功能，少一个即模块缺失）')
})

test('yfw:ready 真的上报（父窗口靠它才下发 theme/overview）', () => {
  const b = boot()
  assert.equal(b.err, undefined, `顶层脚本抛异常：${fmtErr(b.err)}`)
  b.flush()
  const ready = b.msgs.filter(m => m.type === 'yfw:ready')
  assert.equal(ready.length, 1, `yfw:ready 应恰好上报一次，实收 ${b.msgs.map(m => String(m.type)).join(',') || '(无消息)'}`)
  const throws = b.msgs.filter(m => m.type === '__timer_throw__')
  assert.equal(throws.length, 0, `延迟回调里抛异常：${JSON.stringify(throws)}`)
})

test('head 首帧主题脚本可执行（?theme= 三值 + 缺省回落 dark）', () => {
  const m = /<script>([\s\S]*?)<\/script>/.exec(HTML)
  assert.ok(m, 'index.html 未找到内联首帧主题 <script>')
  const code = m![1]

  for (const [search, expect] of [['', 'theme-dark'], ['?theme=light', 'theme-light'], ['?theme=dark-glass', 'theme-dark-glass']] as const) {
    const b = boot({ search, withJs: false })
    vm.runInContext(code, vm.createContext({ document: b.doc, location: { search }, URLSearchParams }))
    assert.equal(b.doc.documentElement.className, expect, `search="${search}" 时首帧主题应为 ${expect}`)
  }
})

test('自检：本机制对未定义标识符确实报错（防测试自身失效）', () => {
  // 拿事故的真凶做靶子：若哪天 stub 环境"过于宽容"（例如把未定义标识符吞掉），
  // 这条会先红，提醒执行冒烟已失去守门能力
  const ctx = vm.createContext({})
  assert.throws(
    () => vm.runInContext('void vkey;', ctx),
    /vkey is not defined/,
    'vm 执行应抛 ReferenceError（否则执行冒烟形同虚设）',
  )
})
