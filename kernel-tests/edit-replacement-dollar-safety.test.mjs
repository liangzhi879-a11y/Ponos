// kernel-tests/edit-replacement-dollar-safety.test.mjs —— Edit 的替换值必须按**纯文本**落盘
// ---------------------------------------------------------------------------
// 真 bug（2026-11-01）：单次替换分支曾用 `content.replace(old, newString)`，
// 而 String#replace 的**字符串型替换值**会做"美元符号替换序列"解析：
//   · 双美元符号 → 一个美元符号
//   · 美元+&     → 匹配到的原文
//   · 美元+反引号 → 匹配点之前的全部文本
//   · 美元+单引号 → 匹配点之后的全部文本
// 后果：工具回执报"已编辑"，磁盘内容却已被改写（且不会报错）——静默写坏文件。
// 真实触发面：Makefile 配方、sed/awk/PowerShell 脚本、正则替换示例、LaTeX 公式块。
// 修法：替换值改函数形态 `() => normNew`（不做模式解析）；replace_all 分支本就是 split/join。
// 隔离纪律：mkdtempSync 自建夹具，不碰真实用户目录，离线可重复。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createToolRegistry } from '../kernel/tools.mjs'

const D = String.fromCharCode(36) // 美元符号（本文件刻意经字符码构造，避免自身被替换语义干扰）

function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'edit-dollar-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('Edit 单次替换：new_string 里的美元序列必须原样落盘', () => {
  const env = makeEnv()
  try {
    const tools = createToolRegistry({ cwd: env.dir, addDirs: [], skipPermissions: true })
    const p = join(env.dir, 'dollar.mk')
    const cases = [
      { name: 'dollar-amp', newStr: `a${D}&b` },
      { name: 'dollar-dollar', newStr: `a${D}${D}b` },
      { name: 'dollar-backtick', newStr: `a${D}\`b` },
      { name: 'dollar-quote', newStr: `a${D}'b` },
    ]
    for (const c of cases) {
      writeFileSync(p, 'target:\n\tran XX done\n', 'utf-8')
      const r = tools.registry.Edit.run({ file_path: p, old_string: 'XX', new_string: c.newStr })
      assert.equal(r.isError, undefined, `${c.name}: ${r.content}`)
      assert.equal(readFileSync(p, 'utf-8'), `target:\n\tran ${c.newStr} done\n`, `${c.name} 落盘被替换语义改写`)
    }
  } finally { env.cleanup() }
})

test('Edit replace_all：同一序列也必须原样落盘（防将来改成带模式语义的实现）', () => {
  const env = makeEnv()
  try {
    const tools = createToolRegistry({ cwd: env.dir, addDirs: [], skipPermissions: true })
    const p = join(env.dir, 'many.txt')
    writeFileSync(p, 'A XX B XX C\n', 'utf-8')
    const newStr = `${D}&`
    const r = tools.registry.Edit.run({ file_path: p, old_string: 'XX', new_string: newStr, replace_all: true })
    assert.equal(r.isError, undefined, r.content)
    assert.equal(readFileSync(p, 'utf-8'), `A ${newStr} B ${newStr} C\n`)
  } finally { env.cleanup() }
})
