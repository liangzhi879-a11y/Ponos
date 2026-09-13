// sanitizeText：控制字符剥离（R4 改为正则后的语义锁）
// 运行：node --test src/lib/utils.test.ts
//
// 这个函数在**每个流式文本增量**上都会跑（useYFWCLI.ts:627），也在整份会话落盘前的
// 深清洗里跑，故 R4 把逐字符拼接换成正则（同文件 stripControlChars 的注释记过
// 40M 字符 7s vs 70ms 的实测）。这里的断言是"换实现不许换语义"的锁：
// 逐字符参考实现 + 差分性质测试，任何边界（\t\n\r 保留、C0 其余剥除、DEL 剥除、
// C1 与空格不受影响）都必须与原实现逐字节一致。
//
// 取样方式的约定：控制字符一律用 `ch(n)` **在运行时构造**，源码里不写字面控制字节、
// 也不用 \uXXXX 转义——不可见字节在编辑器/工具链任一环节都可能被吃掉或改写（本次
// 改动开始时 `utils.ts` 就踩过这个坑：Edit 把正则写成了字面控制字符）。这样文件的
// 字节内容与"做了什么"一一对应，`cat -v` 复核时不会出现任何 ^X 噪声。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeText } from './utils.ts'

const ch = (n: number) => String.fromCharCode(n)
const NUL = ch(0), SOH = ch(1), BEL = ch(7), BS = ch(8), VT = ch(0x0b), US = ch(0x1f)
const DEL = ch(0x7f), C1A = ch(0x80), C1B = ch(0x9f), TILDE = ch(0x7e), C1C = ch(0x81)

// 参考实现：逐字符判定。语义即"剥 C0（保留 \t\n\r）与 DEL"。
function reference(s: string): string {
  let out = ''
  for (const c of s) {
    const code = c.codePointAt(0)!
    const keep = code === 9 || code === 10 || code === 13
    if (code < 32 ? keep : code !== 127) out += c
  }
  return out
}

test('保留 \\t \\n \\r，剥除其余 C0 与 DEL', () => {
  assert.equal(sanitizeText('a\tb\nc\rd'), 'a\tb\nc\rd')
  assert.equal(sanitizeText('a' + NUL + 'b' + SOH + 'c' + US + 'd'), 'abcd')
  assert.equal(sanitizeText('响' + BEL + '铃' + VT), '响铃', 'VT(0x0B) 在剥除集内，BEL(0x07) 同')
})

test('边界逐字符定档：U+001F 剥 / U+0020 留 / U+007F 剥 / U+0080 留', () => {
  assert.equal(sanitizeText(US), '')
  assert.equal(sanitizeText(' '), ' ')
  assert.equal(sanitizeText(DEL), '')
  // C1 控制区（U+0080–U+009F）不在此函数职责内——严格版 stripControlChars 才管
  assert.equal(sanitizeText(C1A + C1B), C1A + C1B)
})

test('DEL 是唯一被剥的非 C0 字符：U+007E–U+0081 里只有 7F 消失', () => {
  assert.equal(sanitizeText(TILDE + DEL + C1A + C1C), TILDE + C1A + C1C)
})

test('已是干净文本 ⇒ 必须原样返回（含 CRLF 与制表）', () => {
  assert.equal(sanitizeText(''), '')
  const text = '```js\n\tconst a = 1\r\n```\n\n尾'
  assert.equal(sanitizeText(text), text)
})

test('差分：与逐字符参考实现在随机串上逐字节一致', () => {
  // 确定性 PRNG（xorshift32）：CI 上可复现，失败可重放
  let seed = 0x9e3779b9
  const rnd = () => {
    seed ^= seed << 13; seed >>>= 0
    seed ^= seed >>> 17
    seed ^= seed << 5; seed >>>= 0
    return seed / 0x1_0000_0000
  }
  // 字符池特意混入：C0 全域、DEL、C1、CJK、代理对，以及 \t\n\r 本身
  const pool: string[] = []
  for (let c = 0; c < 0xa0; c++) pool.push(ch(c))
  pool.push('中', '文', '🎉', 'é', ' ', '`', '\n', '\t', '\r')
  for (let trial = 0; trial < 200; trial++) {
    const len = Math.floor(rnd() * 60)
    let s = ''
    for (let i = 0; i < len; i++) s += pool[Math.floor(rnd() * pool.length)]
    assert.equal(sanitizeText(s), reference(s), `trial=${trial} 输入=${JSON.stringify(s)}`)
  }
})

test('长文本：正则实现必须比逐字符拼接快一个数量级（>1M 字符，相对断言）', () => {
  // R4 的收益就是这一条，所以断言必须真的能分辨两种实现——纯绝对红线做不到：
  // 实测同一份 1.08M 字符样本上逐字符拼接只要 68ms，"< 200ms" 的红线**照样放它过关**。
  // 故这里用相对断言（best-of-3、各自先热身一次），既钉住"正则至少快 5 倍"这个结论，
  // 又不受机器快慢影响。实测本机约 34×（正则 2.0ms vs 拼接 68.4ms）。
  const dirty = ('张三说' + BEL + '这是一段正文，含控制字符。\n').repeat(60_000)
  assert.ok(dirty.length > 1_000_000, `样本长度 ${dirty.length}`)
  const best = (f: (s: string) => string) => {
    f(dirty) // 热身：不热身时首个实现要替 JIT 买单，会得出反向结论
    let b = Infinity
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now()
      f(dirty)
      b = Math.min(b, performance.now() - t0)
    }
    return b
  }
  assert.equal(sanitizeText(dirty), reference(dirty), '先确认正确性，再谈快慢')
  const msRegex = best(sanitizeText)
  const msCharwise = best(reference)
  assert.ok(msRegex * 5 < msCharwise, `正则 ${msRegex.toFixed(1)}ms 未比逐字符 ${msCharwise.toFixed(1)}ms 快 5 倍——实现可能被改回拼接法`)
  assert.ok(msRegex < 300, `1M 字符耗时 ${msRegex.toFixed(1)}ms 超绝对红线`)
})
