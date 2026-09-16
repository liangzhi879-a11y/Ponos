// src/lib/hooksDeps.test.ts
// React 依赖数组的守门测试（2026-09-16）。
//
// 背景：i18n 的 `useTranslation()` 返回的 `t` 是**每次渲染新建的函数**（未做 useCallback）。
// 一旦把它写进 useCallback/useEffect 的依赖数组，被包装的函数每帧都是新引用，
// 依赖它的 useEffect 就每帧重跑。MCP 服务器面板正是这样翻车的：load() 首行
// setLoading(true)、末尾 setLoading(false)，于是形成
// "重跑 → 置真 → 异步置假 → 重渲染 → 再重跑"的无限循环：
// 界面永远停在「读取中」，新增的服务器卡片也因走 loading 分支而看不见
// —— 用户视角就是"一直重新读取配置、还读不出来，点新增没反应"。
//
// 这类 bug 有三个特点，决定了必须靠扫描而不是靠人 review 来拦：
//   ① 语法完全合法、typecheck 全绿；
//   ② 单测不覆盖渲染，只有人肉点界面才看得见（本仓库 node --test 无 DOM 环境）；
//   ③ 复发代价极高（白屏级故障），而修法只有一处：改用稳定的 `lang` 作依赖。
//
// 为什么能用 `lang` 顶替 `t`：`t` 的行为只由当前语言决定，而 `lang` 是稳定字符串。
// 以 `lang` 作依赖 ⇒ 函数仅在语言切换时重建，重建时捕获的 `t` 恰好对应新语言，
// 语义不变（保留了"换语言要换文案"），引用却稳定了。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')

/**
 * 找出"依赖数组里含不稳定 `t`"的位置。
 * 用**精确等于 t** 判定，而不是包含匹配——否则 count / setT / themes 这类
 * 正常依赖会被误报，守卫一旦误报就会被当成噪音而失去意义。
 */
export function findUnstableTDeps(src: string): Array<{ line: number, deps: string }> {
  const hits: Array<{ line: number, deps: string }> = []
  const re = /\}\s*,\s*\[([^\]]*)\]/g   // 匹配 `}, [ ... ]`（含跨行，[^\]] 可吃换行）
  let m
  while ((m = re.exec(src)) !== null) {
    const deps = m[1]
    if (deps.split(',').some((d) => d.trim() === 't')) {
      hits.push({
        line: src.slice(0, m.index).split('\n').length,
        deps: deps.replace(/\s+/g, ' ').trim(),
      })
    }
  }
  return hits
}

test('判定规则自检：坏样本必命中，好样本不得误报', () => {
  // 先证明规则本身是对的 —— 否则"扫描结果为空"可能只是正则失效造成的假绿
  assert.equal(findUnstableTDeps('  }, [t])\n').length, 1, '单独依赖 t 应命中')
  assert.equal(findUnstableTDeps('  }, [a, t])\n').length, 1, '混在多个依赖里也应命中')
  assert.equal(findUnstableTDeps('  }, [a, lang])\n').length, 0, 'lang 是正确写法，不得命中')
  assert.equal(findUnstableTDeps('  }, [])\n').length, 0, '空依赖不得命中')
  assert.equal(
    findUnstableTDeps('  }, [count, setT, themes, items.map]\n').length, 0,
    'count/setT/themes 含字母 t 但不是标识符 t，不得误报',
  )
  assert.equal(findUnstableTDeps('  }, [\n    a,\n    t,\n  ])\n').length, 1, '跨行依赖数组也要能扫到')
})

/** 递归收集 src 下的 .ts/.tsx（排除测试文件） */
function collectSources(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) { collectSources(p, acc); continue }
    if (!/\.tsx?$/.test(name)) continue
    if (/\.test\.tsx?$/.test(name)) continue   // 测试文件里可以出现反例
    acc.push(p)
  }
  return acc
}

test('守卫有效性：必须扫到足量依赖数组，否则规则失效等于没守', () => {
  const files = collectSources(join(REPO, 'src'))
  assert.ok(files.length > 20, `扫描范围异常（只找到 ${files.length} 个源码文件），守卫形同虚设`)
  let arrays = 0
  for (const f of files) arrays += (readFileSync(f, 'utf8').match(/\}\s*,\s*\[/g) || []).length
  assert.ok(arrays > 30, `只扫到 ${arrays} 个依赖数组，说明匹配规则或扫描范围出了问题`)
})

test('架构守卫：src 下不得把不稳定的 t 放进依赖数组（会无限重渲染）', () => {
  const offenders = []
  for (const f of collectSources(join(REPO, 'src'))) {
    for (const hit of findUnstableTDeps(readFileSync(f, 'utf8'))) {
      offenders.push(`${relative(REPO, f).replace(/\\/g, '/')}:${hit.line} → [${hit.deps}]`)
    }
  }
  assert.deepEqual(
    offenders,
    [],
    '依赖数组里出现了 t。t 每次渲染都是新函数，会让 useCallback/useEffect 每帧重建、' +
    '造成无限重渲染（MCP 面板曾因此永远停在「读取中」）。请改用稳定字符串 lang：\n  ' +
    offenders.join('\n  '),
  )
})
