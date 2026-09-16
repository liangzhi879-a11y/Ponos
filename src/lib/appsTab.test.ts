// src/lib/appsTab.test.ts —— 应用页三标签的归一与 per-app 隔离
// 运行：node --test --test-timeout=300000 src/lib/appsTab.test.ts
//
// 断言的都是**实测会出事的**两条：脏值回落（否则受控 Tabs 全不高亮、内容区空白）
// 与 per-appId 不串味（否则在 A 应用切到"命令"，打开 B 应用也落在"命令"，
// 而 B 的默认落点必须是 agent——那是"生成后立刻看到质检在跑"的前提）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { APPS_TABS, DEFAULT_APPS_TAB, readAppsTab, sanitizeAppsTab, writeAppsTab } from './appsTab.ts'

/** 最小 localStorage 替身（node 下没有这个全局；只测本模块用到的两个方法） */
function withFakeStorage<T>(fn: (mem: Map<string, string>) => T): T {
  const mem = new Map<string, string>()
  const g = globalThis as unknown as { localStorage?: unknown }
  const prev = g.localStorage
  g.localStorage = {
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k: string, v: string) => { mem.set(k, String(v)) },
    removeItem: (k: string) => { mem.delete(k) },
    clear: () => mem.clear(),
    key: () => null,
    get length() { return mem.size },
  }
  try {
    return fn(mem)
  } finally {
    if (prev === undefined) delete g.localStorage
    else g.localStorage = prev
  }
}

test('APPS_TABS 与默认值：三标签、默认 agent', () => {
  assert.deepEqual([...APPS_TABS], ['agent', 'diagnose', 'commands'])
  assert.equal(DEFAULT_APPS_TAB, 'agent')
})

test('sanitizeAppsTab：合法值原样通过', () => {
  for (const v of APPS_TABS) assert.equal(sanitizeAppsTab(v), v)
})

test('sanitizeAppsTab：未知值 / 脏值 / 非字符串 ⇒ agent', () => {
  // 旧版本可能存在的其它 key、手改、别的页面同名键写进来的内容，全都算脏值
  for (const v of ['Agent', 'agent ', '', 'console', 'settings', 'json', 0, 1, null, undefined, {}, [], true]) {
    assert.equal(sanitizeAppsTab(v), 'agent', `${JSON.stringify(v)} 应回落 agent`)
  }
})

test('readAppsTab：缺键 ⇒ agent（首次进入任何应用都必须落在 agent）', () => {
  withFakeStorage(() => {
    assert.equal(readAppsTab('app-001'), 'agent')
  })
})

test('readAppsTab：盘上是脏值 ⇒ agent（不把脏值透给受控 Tabs）', () => {
  withFakeStorage((mem) => {
    mem.set('yfworking.apps.tab.app-001', 'nonsense')
    assert.equal(readAppsTab('app-001'), 'agent')
  })
})

test('read/write 往返：写什么读出什么', () => {
  withFakeStorage(() => {
    for (const tab of APPS_TABS) {
      assert.equal(writeAppsTab('app-001', tab), tab)
      assert.equal(readAppsTab('app-001'), tab)
    }
  })
})

test('writeAppsTab：写入脏值时盘上落的是归一后的值（不会把脏值带进下一次读）', () => {
  withFakeStorage((mem) => {
    assert.equal(writeAppsTab('app-001', 'bogus'), 'agent')
    assert.equal(mem.get('yfworking.apps.tab.app-001'), 'agent')
    assert.equal(readAppsTab('app-001'), 'agent')
  })
})

test('per-appId 隔离：A 应用切到 commands 不影响 B 应用（B 仍 agent）', () => {
  withFakeStorage(() => {
    writeAppsTab('app-001', 'commands')
    writeAppsTab('app-002', 'diagnose')
    assert.equal(readAppsTab('app-001'), 'commands')
    assert.equal(readAppsTab('app-002'), 'diagnose')
    assert.equal(readAppsTab('app-003'), 'agent', '没写过的应用不受影响')

    // A 再切回 agent，也不该动到 B
    writeAppsTab('app-001', 'agent')
    assert.equal(readAppsTab('app-002'), 'diagnose')
  })
})

test('appId 为空白 ⇒ 不读写（不产生形如 "yfworking.apps.tab." 的空键）', () => {
  withFakeStorage((mem) => {
    assert.equal(readAppsTab(''), 'agent')
    assert.equal(writeAppsTab('   ', 'commands'), 'commands', '返回值仍归一回显，只是不落盘')
    assert.equal(mem.size, 0, '空白 appId 不得写入任何键')
  })
})

test('localStorage 缺失（node/隐私模式）⇒ 读回落 agent、写不抛', () => {
  const g = globalThis as unknown as { localStorage?: unknown }
  const prev = g.localStorage
  delete g.localStorage
  try {
    assert.equal(readAppsTab('app-001'), 'agent')
    assert.equal(writeAppsTab('app-001', 'commands'), 'commands')
    assert.equal(readAppsTab('app-001'), 'agent')
  } finally {
    if (prev !== undefined) g.localStorage = prev
  }
})

test('localStorage 抛异常（配额/被禁用）⇒ 读回落 agent、写不抛', () => {
  const g = globalThis as unknown as { localStorage?: unknown }
  const prev = g.localStorage
  g.localStorage = {
    getItem: () => { throw new Error('denied') },
    setItem: () => { throw new Error('quota exceeded') },
  }
  try {
    assert.equal(readAppsTab('app-001'), 'agent')
    assert.equal(writeAppsTab('app-001', 'commands'), 'commands')
  } finally {
    if (prev === undefined) delete g.localStorage
    else g.localStorage = prev
  }
})
