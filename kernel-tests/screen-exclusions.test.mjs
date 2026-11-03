import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as mod from '../kernel/screen-exclusions.mjs'

const { DEFAULT_EXCLUSIONS, isExcluded } = mod

test('缺省清单覆盖凭证类与私信类（S4 的默认护栏）', () => {
  assert.ok(DEFAULT_EXCLUSIONS.processes.includes('keepass'))
  assert.ok(DEFAULT_EXCLUSIONS.processes.includes('1password'))
  assert.ok(DEFAULT_EXCLUSIONS.processes.some((p) => p.includes('bitwarden')))
  assert.ok(DEFAULT_EXCLUSIONS.processes.includes('weixin'))
  assert.ok(DEFAULT_EXCLUSIONS.processes.includes('wxwork'))
})

test('进程名匹配：大小写不敏感 + 忽略 .exe 后缀', () => {
  assert.equal(isExcluded({ process: 'KeePass' }, DEFAULT_EXCLUSIONS), true)
  assert.equal(isExcluded({ process: 'KeePassXC.exe' }, DEFAULT_EXCLUSIONS), true)
  assert.equal(isExcluded({ process: 'notepad.exe' }, DEFAULT_EXCLUSIONS), false)
})

test('标题模式匹配：支持通配 *，大小写不敏感', () => {
  assert.equal(isExcluded({ title: '密码 - 记事本' }, DEFAULT_EXCLUSIONS), true)
  assert.equal(isExcluded({ title: 'Password Vault' }, DEFAULT_EXCLUSIONS), true)
  assert.equal(isExcluded({ title: 'Ponos' }, DEFAULT_EXCLUSIONS), false)
})

test('★ 正则元字符必须按字面量处理，且**绝不抛异常**（`?` 是漏网之鱼，2026-10-14 实测抓到）', () => {
  // 转义类原为 [.+^${}()|[\]\\]，漏了 `?` ⇒ patternToRegExp('?x') 造出 /^?x$/
  // → SyntaxError: Nothing to repeat，**抛出**异常（违反本模块"不抛异常"的自述），
  // 且与 PS 侧（[regex]::Escape 会把 `?` 转义）真实分叉。
  for (const list of [{ titlePatterns: ['?x'] }, { titlePatterns: ['?'] }, { titlePatterns: ['a?b'] }]) {
    assert.doesNotThrow(() => isExcluded({ title: 'x' }, list), `${JSON.stringify(list)} 不得抛异常`)
  }
  assert.equal(isExcluded({ title: '?x' }, { titlePatterns: ['?x'] }), true, '`?` 必须是字面量（应匹配）')
  assert.equal(isExcluded({ title: 'x' }, { titlePatterns: ['?x'] }), false, '`?` 不得当量词（不应匹配 x）')
  assert.equal(isExcluded({ title: 'a?b' }, { titlePatterns: ['a?b'] }), true, '`?` 在中间同样是字面量')
  assert.equal(isExcluded({ title: 'ab' }, { titlePatterns: ['a?b'] }), false, '`?` 不得退化成"可有可无"')
  for (const ch of ['.', '+', '^', '$', '{', '}', '(', ')', '[', ']', '|', '\\']) {
    const list = { titlePatterns: [`a${ch}b`] }
    assert.doesNotThrow(() => isExcluded({ title: `a${ch}b` }, list), `元字符 ${JSON.stringify(ch)} 不得抛异常`)
    assert.equal(isExcluded({ title: `a${ch}b` }, list), true, `元字符 ${JSON.stringify(ch)} 必须按字面量匹配`)
  }
})

test('空 item / 空清单：不排除（但不抛异常）', () => {
  assert.equal(isExcluded({}, DEFAULT_EXCLUSIONS), false)
  assert.equal(isExcluded(null, DEFAULT_EXCLUSIONS), false)
  assert.equal(isExcluded({ process: 'keepass' }, null), false)
  assert.equal(isExcluded({ process: 'keepass' }, {}), false)
})

test('★ 不导出 filterExcluded（P2a 的过滤在脚本侧，Node 侧无调用者 —— 不造孤儿）', () => {
  // 本仓 HEAD 是「清理零调用者的孤儿」，同类问题不再制造。
  // 过滤职责：main.cjs 读 shared 数据 → env 传给 screen.ps1 → 脚本侧 Test-Excluded 执行。
  // 本模块的 isExcluded 只作**对账参照**（Task 12 的两侧语义对账测试消费它）。
  assert.equal(mod.filterExcluded, undefined, 'filterExcluded 在 P2a 无消费者，不得导出')
})

test('★ 导出面就是约定的两项（防将来悄悄加回孤儿）', () => {
  assert.deepEqual(Object.keys(mod).sort(), ['DEFAULT_EXCLUSIONS', 'isExcluded'])
})
