// scripts/verify-package-assets.mjs
// S6 打包资源面预检（Batch B 出包前跑）。校验 electron-builder.yml extraResources
// 声明的源在本仓库的存在性；构建期组装源（runtime/python、runtime/skills）标注为
// build-installer.mjs 前置产物，缺失时提示先跑 build-installer.mjs。
import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { load } from 'js-yaml'
// ★ DevKit 边界（CT12）：真源 + 唯一匹配实现（不在这里另抄一份路径清单）
import { loadDevkit, includeHitsDevkit, devkitLeaks } from '../kit/lib/devkit-rules.mjs'

const ROOT = join(import.meta.dirname, '..')
const yml = load(readFileSync(join(ROOT, 'electron-builder.yml'), 'utf8'))
const BUILD_TIME = new Set(['runtime/python', 'runtime/skills'])
let failed = false
for (const er of yml.extraResources ?? []) {
  const from = join(ROOT, er.from)
  if (BUILD_TIME.has(er.from)) {
    if (!existsSync(from)) {
      console.log(`[skip] ${er.from} —— 构建期组装源，先跑 scripts/build-installer.mjs 生成`)
    } else {
      console.log(`[ok  ] ${er.from} (构建期组装源已存在)`)
    }
    continue
  }
  const ok = existsSync(from)
  console.log(`[${ok ? 'ok' : 'FAIL'}] ${er.from} -> ${er.to}`)
  if (!ok) failed = true
}
// kernel-dist/cli.mjs 是 files 的打包前提（electron-builder.yml 有注释声明，另做存在性断言）
if (!existsSync(join(ROOT, 'kernel-dist', 'cli.mjs'))) {
  console.log('[FAIL] kernel-dist/cli.mjs 缺失——先跑 scripts/build-kernel.mjs')
  failed = true
}
// ── ★ DevKit 边界（CT12）：发行物不得含开发门禁 ──────────────────────────────
// 用户口径（2026-09-20）：『确保正式打包不会带 devkit，也就是发行给用户的版本不带 kit 及相关配置』。
// ★ 两道都用**同一真源与同一匹配实现**（`kit/manifest/devkit.json` + `kit/lib/devkit-rules.mjs`）：
//   ① **结构级**：`files` / `extraResources` 里不得出现 devkit —— 含 `**/*` 这种"全包含"，
//      那正是最常见的"顺手"改法（白名单今天干净 ≠ 明天干净）；
//   ② **产物级**：若已有 NSIS 解包产物，**直接扫它** —— 安装包是发行物，**零例外**
//      （不像调试渠道能按 `devChannelAllow` 放行 `AGENTS.md`）。
const devkit = loadDevkit()
if (!devkit.ok) {
  console.log('[FAIL] DevKit 真源读不到（kit/manifest/devkit.json）：' + devkit.error)
  failed = true
} else {
  const entries = [
    ...(yml.files ?? []),
    ...(yml.extraResources ?? []).flatMap((e) => [e?.from, e?.to]),
  ].filter((v) => typeof v === 'string')
  const hits = entries.filter((v) => includeHitsDevkit(v, devkit.devkit))
  console.log(`[${hits.length ? 'FAIL' : 'ok'  }] 安装包白名单不含 devkit（检查 ${entries.length} 条：files + extraResources）`)
  if (hits.length) {
    for (const h of hits) console.log(`       ⚠ 命中：${h}`)
    failed = true
  }

  const appDir = join(ROOT, 'release', 'installer', 'win-unpacked', 'resources', 'app')
  if (!existsSync(appDir)) {
    console.log('[skip] 尚无 NSIS 解包产物（release/installer/win-unpacked）—— 出包后再跑本脚本会自动扫')
  } else {
    const rels = []
    const scan = (rel, depth) => {
      if (depth > 3) return
      for (const e of readdirSync(rel ? join(appDir, rel) : appDir, { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name
        rels.push(r)
        if (e.isDirectory()) scan(r, depth + 1)
      }
    }
    scan('', 0)
    const leaks = devkitLeaks(rels, devkit.devkit) // ★ 发行物：零例外
    console.log(`[${leaks.length ? 'FAIL' : 'ok'  }] 安装包产物不含 devkit（扫描 ${rels.length} 项）`)
    for (const l of leaks.slice(0, 10)) console.log(`       ⚠ ${l.rel}（命中 ${l.path}）`)
    if (leaks.length) failed = true
  }
}

if (failed) { console.error('\n资源面校验失败，请补齐后重试'); process.exit(1) }
console.log('\n打包资源面校验通过')
