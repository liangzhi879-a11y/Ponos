// kit/lib/python-manifest.test.mjs —— 内嵌 Python 包清单的**单一真源**（B2）+ 双清单对账（B3）
//
// 为什么需要这个门禁：包列表原先硬编码在 scripts/build-embedded-python.mjs 里，
// 于是"构建脚本装哪些包"与"台账记了哪些包"是**两份数据** —— 改一处漏一处，
// 而漏的后果是**发出去的应用缺一个包、运行时才炸**（内嵌运行时不可在线补包）。
//
// 断言刻意分四层，缺任何一层都留有假绿路径（本计划 Task 1–10 的返工教训，全是"断言不可能独立失败"）：
//   ① 行为层：换 root 下的 deps.json ⇒ 返回值**跟着变**（钉死"真读文件"，而不是换个地方硬编码）；
//   ② 失败开放层：读不到真源必须**抛错**，不得静默返回 []（否则构建脚本"零包安装成功"）；
//   ③ 调用点层：构建脚本必须**调用**共享实现（`= readEmbeddedPackages({ root: … })`），
//      且不得本地重写 / 不得再出现引号包裹的包名字面量、不得再有裸数组 ——
//      只断言"import 了它"是**无效的**（import 还在、列表照旧硬编码，照样过）；
//   ④ 同源层：构建脚本 import 的说明符必须解析到本测试 import 的**同一个文件**，
//      否则"两处各写一份"会以"两处都叫 readEmbeddedPackages"的形式复活。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readEmbeddedPackages } from './python-manifest.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const BUILD_SCRIPT = join(ROOT, 'scripts', 'build-embedded-python.mjs')
const DEPS_LEDGER = join(ROOT, 'kit', 'manifest', 'deps.json')

/** PyPI 名归一：大小写无关、`_` 与 `-` 等价（与 dep-rules.mjs 的 normalizePy 同口径） */
const norm = (n) => String(n).toLowerCase().replace(/_/g, '-')

/**
 * 迁移前的硬编码 13 条（`scripts/build-embedded-python.mjs` 的 `packages` 数组）。
 * 它在这里的作用是**下界**：真源搬家不得改行为，删包必须是**有意**的（删了就必须改这个列表并附证据）。
 * 内嵌运行时不可在线补包 ⇒ "少装一个"在开发机上永远看不出来，只在发出去的机器上炸。
 */
const BASELINE = [
  'openpyxl', 'python-docx', 'xlrd', 'Pillow', 'beautifulsoup4', 'rapidocr-onnxruntime',
  'PyPDF2', 'pypdf', 'pypdfium2', 'requests', 'Jinja2', 'openai', 'pydantic',
]

/** 夹具根：<临时目录>/kit/manifest/deps.json。绝不复用真仓路径（真仓被改坏时测试要能独立报警） */
function fixtureRoot(embedded, { raw } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'yfw-pymanifest-'))
  mkdirSync(join(root, 'kit', 'manifest'), { recursive: true })
  writeFileSync(join(root, 'kit', 'manifest', 'deps.json'),
    raw !== undefined ? raw : JSON.stringify({ python: { embedded } }))
  return root
}

// ── ① 行为层：真源是 <root>/kit/manifest/deps.json#python.embedded ─────────────

test('readEmbeddedPackages 读的是 root 下 deps.json 的 python.embedded（逐字返回）', () => {
  const root = fixtureRoot(['openpyxl', 'PyPDF2'])
  assert.deepEqual(readEmbeddedPackages({ root }), ['openpyxl', 'PyPDF2'])
})

test('readEmbeddedPackages 的返回值跟着 deps.json 变（钉死"不是硬编码、不做跨调用缓存"）', () => {
  const root = fixtureRoot(['openpyxl'])
  assert.deepEqual(readEmbeddedPackages({ root }), ['openpyxl'])
  // 同一个 root、同一个进程内改台账：第二次调用必须看到新值。
  // 若实现里写死了列表 / 缓存了首次结果，这里会红 —— 这正是 B2 要消灭的失败模式。
  writeFileSync(join(root, 'kit', 'manifest', 'deps.json'),
    JSON.stringify({ python: { embedded: ['openpyxl', 'pdfium-a0', 'pkg-b'] } }))
  assert.deepEqual(readEmbeddedPackages({ root }), ['openpyxl', 'pdfium-a0', 'pkg-b'])
})

// ── ② 失败开放层：读不到真源必须抛错 ──────────────────────────────────────────

test('真源缺失/为空/形状不对时抛错，绝不返回空清单', () => {
  // 空数组：真源没写包时若返回 []，构建脚本会"装 0 个包"却报 [6/7] 成功 —— 必须炸。
  assert.throws(() => readEmbeddedPackages({ root: fixtureRoot([]) }), /python\.embedded/)
  // 键名被改名（如 python.embedded2）
  assert.throws(() => readEmbeddedPackages({ root: fixtureRoot(undefined, { raw: '{"python":{"embeddedList":["a"]}}' }) }),
    /python\.embedded/)
  // 条目不是字符串（手改成 [{name}] 形状 → pip install [object Object] 会静默装错东西）
  assert.throws(() => readEmbeddedPackages({ root: fixtureRoot(undefined, { raw: '{"python":{"embedded":[{"name":"a"}]}}' }) }),
    /python\.embedded/)
  // deps.json 根本不存在
  const empty = mkdtempSync(join(tmpdir(), 'yfw-pymanifest-none-'))
  assert.throws(() => readEmbeddedPackages({ root: empty }), /python\.embedded/)
  // 未传 root（禁止用默认值猜仓库位置：猜错就装错包，且没有任何报错）
  assert.throws(() => readEmbeddedPackages(), /root/)
})

// ── 真仓台账：真源标记 + 域内镜像 + 不得缩水 ────────────────────────────────────

test('真仓：清单真源标记在台账，且 python-embedded 域与 python.embedded 逐项一致', () => {
  const deps = JSON.parse(readFileSync(DEPS_LEDGER, 'utf8'))
  assert.equal(deps.domains['python-embedded'].source, 'kit/manifest/deps.json#python.embedded')
  // sync 生成域条目、人工维护 python.embedded：两边漏跟（改了嵌入集没重跑 sync）必须能被发现
  assert.deepEqual(deps.domains['python-embedded'].packages.map((p) => p.name), deps.python.embedded)
})

test('真仓：readEmbeddedPackages 与台账逐字相等，且不少于迁移前的 13 条（不得缩水）', () => {
  const deps = JSON.parse(readFileSync(DEPS_LEDGER, 'utf8'))
  assert.deepEqual(readEmbeddedPackages({ root: ROOT }), deps.python.embedded)
  const emb = deps.python.embedded.map(norm)
  const missing = BASELINE.filter((n) => !emb.includes(norm(n)))
  assert.deepEqual(missing, [], `内嵌运行时不可在线补包：删包 = 发出去的应用运行时才炸（缺 ${missing.join(', ')}）——` +
    '若确要删，请在 kit/lib/python-manifest.test.mjs 的 BASELINE 里同步删掉并附证据')
})

// ── ③ 调用点层：构建脚本真的调用共享实现，且不含任何包名字面量 ────────────────────

test('构建脚本调用 readEmbeddedPackages({ root }) 取包清单，且不再有本地实现/硬编码数组', () => {
  const src = readFileSync(BUILD_SCRIPT, 'utf8')
  // 只 import 不调用 = 假绿；这里要求"赋值自调用（带括号 + root 入参）"
  assert.match(src, /(?:const|let|var)\s+\w+\s*=\s*readEmbeddedPackages\s*\(\s*\{[^}]*\broot\b[^}]*\}/,
    '构建脚本必须把 readEmbeddedPackages({ root: … }) 的结果当作待安装包清单')
  assert.equal(/function\s+readEmbeddedPackages\b|(?:const|let|var)\s+readEmbeddedPackages\s*=/.test(src), false,
    '不得在构建脚本里另写一份 readEmbeddedPackages 实现（那等于真源又变成两份）')
  assert.equal(/const\s+(?:PACKAGES|packages)\s*=\s*\[/.test(src), false,
    '不得再保留硬编码包数组（原先的 const packages = [ ... ]）')
  const quoted = new RegExp('[\'"](?:' + BASELINE.join('|') + ')[\'"]', 'i')
  assert.equal(quoted.test(src), false,
    '构建脚本里不得再出现引号包裹的包名字面量（包名只能来自台账）')
})

test('构建脚本 import 的是与本测试同一个实现文件（同源），且它返回的就是台账清单', () => {
  const src = readFileSync(BUILD_SCRIPT, 'utf8')
  const m = src.match(/import\s*\{[^}]*\breadEmbeddedPackages\b[^}]*\}\s*from\s*['"]([^'"]+)['"]/)
  assert.ok(m, '构建脚本必须从共享模块 import readEmbeddedPackages（{ readEmbeddedPackages } from …）')
  const resolved = resolve(dirname(BUILD_SCRIPT), m[1]).replace(/\\/g, '/')
  assert.equal(resolved, join(HERE, 'python-manifest.mjs').replace(/\\/g, '/'),
    '构建脚本 import 的必须就是本测试 import 的那个文件（同源），不得另起一个模块')
  // 行为收口：构建脚本实际拿到的那个模块，读夹具根也得到夹具里的清单
  return import(pathToFileURL(resolved).href).then((mod) => {
    const root = fixtureRoot(['only-in-fixture'])
    assert.deepEqual(mod.readEmbeddedPackages({ root }), ['only-in-fixture'])
  })
})

// ── ④ B3：两套 Python 清单的差集逐项可解释 ─────────────────────────────────────

test('差集（仅内嵌 / 仅技能）逐项在 deps.notes 里写明理由，且理由指向调用点或显式标注未核实', () => {
  const deps = JSON.parse(readFileSync(DEPS_LEDGER, 'utf8'))
  const emb = deps.python.embedded.map(norm)
  const sk = deps.domains['python-skills'].packages.map((p) => norm(p.name))
  const onlyEmbedded = emb.filter((n) => !sk.includes(n))
  const onlySkills = sk.filter((n) => !emb.includes(n))
  // 差集归零是**合法**的将来态（补齐后）——但那时必须显式改这条断言，不能靠"没有差集"静默通过
  assert.ok(onlyEmbedded.length > 0 && onlySkills.length > 0,
    '本仓两套清单确有差集；若已补齐，请把本用例改成断言"无差集"并附证据')

  const reasonsOf = (key) => new Map((deps.notes?.[key] || []).map((x) => [norm(x.name), String(x.reason || '')]))
  const check = (names, key) => {
    const reasons = reasonsOf(key)
    for (const n of names) {
      assert.ok(reasons.has(n), `差集里的 ${n} 未在 deps.notes.${key} 里说明理由（黄灯不允许静默）`)
      const reason = reasons.get(n).trim()
      assert.ok(reason.length >= 10, `deps.notes.${key} 里 ${n} 的 reason 形同未填：「${reason}」`)
      // 理由要么指向真实调用点（带文件名），要么**显式**承认未核实 —— 不允许"应该不需要"这类空话
      assert.match(reason, /\.(py|mjs|cjs|ts|json|txt|yml|yaml)\b|未核实/,
        `deps.notes.${key} 里 ${n} 的 reason 既没指向调用点文件、也没标注"未核实"：「${reason}」`)
    }
  }
  check(onlyEmbedded, 'pythonOnlyEmbedded')
  check(onlySkills, 'pythonOnlySkills')
})
