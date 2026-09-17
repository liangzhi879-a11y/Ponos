// shell 命令行引号/校验的回归（P1 · shell 拼接加固）
// ---------------------------------------------------------------------------
// 目的：钉住"路径含引号不得闭合引号并注入命令"，同时保证**正常路径与 flag 的行为不变**
// （不过度加引号，否则可能改变被探测 CLI 收到的参数）。
//
// 运行：node --test electron/shell-args.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import shellArgs from './shell-args.cjs'

const { quoteShellArg, buildCommandLine, isShellSafe } = shellArgs

test('注入载荷被拒：路径内含双引号（可闭合引号后追加命令）', () => {
  const payloads = [
    'C:\\tmp\\a"& calc &".bat',
    'C:\\x\\py"thon.exe',
    '"/bin/sh -c id"',
    'a"b',
  ]
  for (const p of payloads) {
    assert.throws(() => quoteShellArg(p, 'exePath'), /quote\/CR\/LF/, `应拒绝: ${p}`)
    assert.equal(isShellSafe(p), false)
  }
})

test('注入载荷被拒：CR / LF（cmd 视为命令边界）', () => {
  for (const p of ['a\r\nb', 'a\nb', 'a\rb']) {
    assert.throws(() => quoteShellArg(p), /quote\/CR\/LF/)
    assert.equal(isShellSafe(p), false)
  }
})

test('空值被拒（避免拼出 `"" --help` 这类畸形命令行）', () => {
  for (const v of ['', null, undefined]) {
    assert.throws(() => quoteShellArg(v), /is empty/)
    assert.equal(isShellSafe(v), false)
  }
})

test('含空白/元字符的路径被加引号（cmd 下引号内元字符作字面量）', () => {
  const cases = [
    ['C:\\Program Files\\nodejs\\node.exe', '"C:\\Program Files\\nodejs\\node.exe"'],
    ['C:\\Program Files (x86)\\Python\\python.exe', '"C:\\Program Files (x86)\\Python\\python.exe"'],
    ['C:\\a&b\\x.exe', '"C:\\a&b\\x.exe"'],
    ['C:\\a|b\\x.exe', '"C:\\a|b\\x.exe"'],
    ['C:\\a>b\\x.exe', '"C:\\a>b\\x.exe"'],
    ['C:\\p%TEMP%\\x.exe', '"C:\\p%TEMP%\\x.exe"'],
  ]
  for (const [input, expected] of cases) {
    assert.equal(quoteShellArg(input), expected)
  }
})

test('行为不变：普通路径与 flag 不加引号（避免改变被探测 CLI 收到的参数）', () => {
  assert.equal(quoteShellArg('C:\\Python311\\python.exe'), 'C:\\Python311\\python.exe')
  assert.equal(quoteShellArg('--help'), '--help')
  assert.equal(quoteShellArg('--version'), '--version')
  assert.equal(quoteShellArg('/usr/bin/node'), '/usr/bin/node')
})

test('buildCommandLine：可执行文件在前，参数按序；必要时才加引号', () => {
  assert.equal(
    buildCommandLine('C:\\Python311\\python.exe', ['--version']),
    'C:\\Python311\\python.exe --version',
  )
  assert.equal(
    buildCommandLine('C:\\Program Files\\Py\\python.exe', ['C:\\my scripts\\k.py', '--help']),
    '"C:\\Program Files\\Py\\python.exe" "C:\\my scripts\\k.py" --help',
  )
  assert.equal(buildCommandLine('C:\\x\\runtime.exe'), 'C:\\x\\runtime.exe', '无参数时应只有可执行文件')
})

test('buildCommandLine：任一参数含引号即整体拒绝（不静默降级）', () => {
  assert.throws(
    () => buildCommandLine('C:\\ok\\runtime.exe', ['C:\\bad"arg.py', '--help']),
    /arg\[0\] contains quote\/CR\/LF/,
  )
})

test('错误信息带定位标签（便于日志定位是哪个参数）', () => {
  assert.throws(() => buildCommandLine('C:\\x\\a.exe', ['ok', 'bad"x']), /arg\[1\]/)
  assert.throws(() => buildCommandLine('bad"x', []), /exePath/)
})
