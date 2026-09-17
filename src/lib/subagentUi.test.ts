// src/lib/subagentUi.test.ts
// node --test src/lib/subagentUi.test.ts（Node 24 原生 TS，相对导入必须带 .ts）
//
// 子代理并发上限的 UI 归约（第 10 项，2026-09-17）。除纯函数行为外，还用**源码级接线断言**
// 锁住"设置页真的会读/会存/会显示"——防的是"字段加了、UI 没接、保存时不带"这类静默失效
// （方案 A 的 WorkflowList 接线就吃过这个亏，故沿用同一手法）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  MAX_SUBAGENT_VALUES, normalizeMaxSubAgentsUi, toConfigMaxSubAgents,
  fromConfigMaxSubAgents, maxSubAgentsOptions, maxSubAgentsLabelKey,
} from './subagentUi.ts'

const readSrc = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf-8')

test('normalizeMaxSubAgentsUi：非法/缺省一律退回 auto（绝不落到"不限"）', () => {
  for (const v of [null, undefined, '', 'auto', 'abc', NaN, {}, []]) {
    assert.equal(normalizeMaxSubAgentsUi(v), 'auto', `${JSON.stringify(v)} → auto`)
  }
  assert.equal(normalizeMaxSubAgentsUi(0), '0', '0 = 不限')
  assert.equal(normalizeMaxSubAgentsUi(-5), '0')
  assert.equal(normalizeMaxSubAgentsUi(4), '4')
  assert.equal(normalizeMaxSubAgentsUi('6'), '6')
  assert.equal(normalizeMaxSubAgentsUi(3.7), '3')
  assert.equal(normalizeMaxSubAgentsUi(200), '32', '钳到上界 32')
  assert.equal(normalizeMaxSubAgentsUi(0.4), '1', '不得截成 0（0 语义相反 = 不限）')
  assert.equal(normalizeMaxSubAgentsUi(5), '5', '手工改过的 config 值要保留，不静默改写')
})

test('toConfigMaxSubAgents / fromConfigMaxSubAgents：与桥侧三值语义互逆', () => {
  // 这三条是与 shared/subagent-concurrency.mjs 的契约（跨语言，靠断言锁）
  assert.equal(toConfigMaxSubAgents('auto'), null, 'auto → null（不注入 env，内核按系统配置推导）')
  assert.equal(toConfigMaxSubAgents('0'), 0, '0 → 0（不限）')
  assert.equal(toConfigMaxSubAgents('4'), 4, 'N → N')
  assert.equal(toConfigMaxSubAgents('abc'), null, '非法 → 自动')
  // 互逆（合法域内）
  for (const v of ['auto', '0', '1', '4', '32']) {
    assert.equal(normalizeMaxSubAgentsUi(toConfigMaxSubAgents(v)), v, `${v} 往返应一致`)
  }
  assert.equal(fromConfigMaxSubAgents(null), 'auto', '旧 config 无此键（undefined/null）→ 自动')
  assert.equal(fromConfigMaxSubAgents(0), '0', '显式 0 与缺键必须区分开（不限 ≠ 自动）')
  assert.equal(fromConfigMaxSubAgents(6), '6')
})

test('maxSubAgentsOptions / maxSubAgentsLabelKey：自定义值不被吞掉，数字档不需翻译', () => {
  assert.deepEqual(maxSubAgentsOptions('auto'), [...MAX_SUBAGENT_VALUES])
  // 手工改过 config.json（如 5）时，5 必须出现在选项里，否则设置页会把用户的值显示成别的档
  const opts = maxSubAgentsOptions(5)
  assert.ok(opts.includes('5'), '自定义值须保留在选项中')
  assert.equal(opts[0], 'auto', 'auto 恒在首位（默认项）')
  assert.equal(maxSubAgentsLabelKey('auto'), 'settings.subAgentsAuto')
  assert.equal(maxSubAgentsLabelKey('0'), 'settings.subAgentsUnlimited')
  assert.equal(maxSubAgentsLabelKey('4'), null, '数字档直接显示数字，无需翻译')
})

test('接线不变量：设置页读 / 存 / 渲染三处都在（防止"字段加了但没接"）', () => {
  const view = readSrc('../components/settings/SettingsView.tsx')
  assert.match(view, /from '@\/lib\/subagentUi'/, '设置页必须引用归约模块')
  // 读：以磁盘配置为准
  assert.match(view, /maxSubAgents: normalizeMaxSubAgentsUi\(cfg\.maxSubAgents\)/,
    '打开设置页时必须从 config 读入（否则显示的不是真实值）')
  // 存：保存时带上（漏了这行 = 改了没用，且不会报错）
  assert.match(view, /maxSubAgents: toConfigMaxSubAgents\(settings\.maxSubAgents\)/,
    '保存时必须把 UI 值转成落盘值（否则设置不生效）')
  // 渲染：有控件与说明
  assert.match(view, /t\('settings\.maxSubAgents'\)/, '必须有该设置的控件标签')
  assert.match(view, /t\('settings\.maxSubAgentsDesc'\)/, '必须有说明文案（用户要知道默认按系统推导）')
})

test('接线不变量：默认值与类型、i18n 两侧齐备', () => {
  const store = readSrc('../stores/settingsStore.ts')
  assert.match(store, /maxSubAgents: 'auto'/, '默认必须是"自动"（内核按系统配置推导）')

  const types = readSrc('../types/index.ts')
  assert.match(types, /maxSubAgents: string/, 'AppSettings 需声明（UI 用字符串档位）')
  assert.match(types, /maxSubAgents\?: number \| null/, 'ConfigV2 需声明（落盘/注入用数字或 null）')

  for (const loc of ['../i18n/translations/zh-CN.ts', '../i18n/translations/en-US.ts']) {
    const src = readSrc(loc)
    for (const key of ['maxSubAgents:', 'maxSubAgentsDesc:', 'subAgentsAuto:', 'subAgentsUnlimited:']) {
      assert.ok(src.includes(key), `${loc} 缺少文案键 ${key}（否则设置页会露出 key 原文）`)
    }
  }
})
