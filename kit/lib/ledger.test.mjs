// kit/lib/ledger.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { trackedFiles, readTracked } from './scan.mjs'
import {
  parseByLocator, keyOfVersion, discoverVersionConsts, syncVersions, readVersions,
  collectEvidence, parseDeclaredImports, readRequirements, syncDeps, readDeps, writeDeps, computeGhost,
  buildEvidenceIndex, syncSkillsLock, listCommonPy, readJson, COMMON_DIR,
} from './ledger.mjs'

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'yfw-kit-'))
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, content)
  }
  return root
}

test('parseByLocator(const)：字符串与数字都能解析', () => {
  const root = fixture({
    'a.mjs': "export const APP_VERSION = 'dev 3.0.0'\nexport const INDEX_VERSION = 4\n",
  })
  assert.equal(parseByLocator({ root, file: 'a.mjs', locator: { kind: 'const', name: 'APP_VERSION' } }).value, 'dev 3.0.0')
  assert.equal(parseByLocator({ root, file: 'a.mjs', locator: { kind: 'const', name: 'INDEX_VERSION' } }).value, 4)
  assert.equal(parseByLocator({ root, file: 'a.mjs', locator: { kind: 'const', name: 'NOPE' } }), null)
})

test('parseByLocator(json)：读 package.json 的 version 字段', () => {
  const root = fixture({ 'p.json': '{ "name": "x", "version": "2.8.0" }' })
  assert.equal(parseByLocator({ root, file: 'p.json', locator: { kind: 'json', path: 'version' } }).value, '2.8.0')
})

test('parseByLocator：行尾注释与分号不干扰取值', () => {
  const root = fixture({ 'a.mjs': "const VAULT_VERSION = 1 // 密码库格式版本\nconst X_VERSION = 'a';\n" })
  assert.equal(parseByLocator({ root, file: 'a.mjs', locator: { kind: 'const', name: 'VAULT_VERSION' } }).value, 1)
  assert.equal(parseByLocator({ root, file: 'a.mjs', locator: { kind: 'const', name: 'X_VERSION' } }).value, 'a')
})

test('keyOfVersion = id@file（同一常量名出现在两个文件时必须可区分）', () => {
  assert.equal(keyOfVersion({ id: 'SCHEMA_VERSION', file: 'kernel/loop.mjs' }), 'SCHEMA_VERSION@kernel/loop.mjs')
  assert.notEqual(
    keyOfVersion({ id: 'SCHEMA_VERSION', file: 'kernel/loop.mjs' }),
    keyOfVersion({ id: 'SCHEMA_VERSION', file: 'server/workflow-store.mjs' }),
  )
})

test('discoverVersionConsts：只认以 VERSION 结尾的全大写常量，跳过测试文件', () => {
  const root = fixture({
    'k/a.mjs': "export const INDEX_VERSION = 4\nexport const OTHER = 1\n",
    'k/b.test.mjs': 'export const TEST_VERSION = 9\n',
  })
  const found = discoverVersionConsts({ root, files: ['k/a.mjs', 'k/b.test.mjs'] })
  assert.deepEqual(found.map((e) => e.id), ['INDEX_VERSION'])
})

test('syncVersions：首次 sync 建立台账；二次 sync 保留人工字段、只更新 value/line', () => {
  const root = fixture({
    'version.mjs': "export const APP_VERSION = 'dev 3.0.0'\nexport const KERNEL_VERSION = 'dev 0.2'\nexport const SCHEMA_VERSION = 1\n",
    'kernel/package.json': '{ "version": "0.2.0" }',
    'package.json': '{ "version": "2.8.0" }',
    'k/c.mjs': 'export const INDEX_VERSION = 4\n',
    'public/skills.json': '[]',
  })
  const files = ['version.mjs', 'kernel/package.json', 'package.json', 'k/c.mjs', 'public/skills.json']
  const first = syncVersions({ root, files })
  assert.equal(first.data.version, 1)
  assert.equal(first.data.lines.length, 4)
  assert.equal(first.data.contracts.length, 1)

  // 人工加字段后再 sync，必须保留
  const data = readVersions({ root })
  data.contracts[0].migrationNote = '人工写的迁移说明'
  data.contracts[0].consumers = ['src/mirror.ts']
  writeFileSync(join(root, 'kit/manifest/versions.json'), JSON.stringify(data, null, 2))

  // 改宿主文件的值 + 搬走一行，模拟真实漂移
  writeFileSync(join(root, 'k/c.mjs'), '\n\nexport const INDEX_VERSION = 5\n')
  const second = syncVersions({ root, files })
  const entry = second.data.contracts.find((e) => e.id === 'INDEX_VERSION')
  assert.equal(entry.value, 5)
  assert.equal(entry.line, 3)
  assert.equal(entry.migrationNote, '人工写的迁移说明')
  assert.deepEqual(entry.consumers, ['src/mirror.ts'])
})

test('syncVersions：lines 分区的人工字段（note/consumers/migrationNote）也必须被继承', () => {
  const root = fixture({
    'version.mjs': "export const APP_VERSION = 'dev 3.0.0'\nexport const KERNEL_VERSION = 'dev 0.2'\nexport const SCHEMA_VERSION = 1\n",
    'kernel/package.json': '{ "version": "0.2.0" }',
    'package.json': '{ "version": "2.8.0" }',
    'public/skills.json': '[]',
  })
  const files = ['version.mjs', 'kernel/package.json', 'package.json', 'public/skills.json']
  syncVersions({ root, files })

  // 人工在 lines 条目上写说明（契约允许：note / consumers / migrationNote）
  const data = readVersions({ root })
  const app = data.lines.find((e) => e.id === 'APP_VERSION')
  app.note = '人工写的说明'
  app.consumers = ['electron/main.cjs']
  data.lines.find((e) => e.id === 'KB_SCHEMA_VERSION').migrationNote = '人工写的迁移说明'
  writeFileSync(join(root, 'kit/manifest/versions.json'), JSON.stringify(data, null, 2))

  // 宿主文件同时漂移（版本值真的变了），迫使 sync 重建 lines
  writeFileSync(join(root, 'version.mjs'),
    "export const APP_VERSION = 'dev 4.0.0'\nexport const KERNEL_VERSION = 'dev 0.2'\nexport const SCHEMA_VERSION = 2\n")
  const second = syncVersions({ root, files })
  const app2 = second.data.lines.find((e) => e.id === 'APP_VERSION')
  assert.equal(app2.note, '人工写的说明')
  assert.deepEqual(app2.consumers, ['electron/main.cjs'])
  assert.equal(second.data.lines.find((e) => e.id === 'KB_SCHEMA_VERSION').migrationNote, '人工写的迁移说明')
  // 白名单继承的前提是"不把陈旧 value 带回来"：value 必须是本次从源文件解析出来的
  assert.equal(app2.value, 'dev 4.0.0')
  assert.equal(second.data.lines.find((e) => e.id === 'KB_SCHEMA_VERSION').value, 2)
})

test('syncVersions：lines 的 value 是源文件真源，人工改不动（会被纠正回来）', () => {
  const root = fixture({
    'version.mjs': "export const APP_VERSION = 'dev 3.0.0'\nexport const KERNEL_VERSION = 'dev 0.2'\nexport const SCHEMA_VERSION = 1\n",
    'kernel/package.json': '{ "version": "0.2.0" }',
    'package.json': '{ "version": "2.8.0" }',
    'public/skills.json': '[]',
  })
  const files = ['version.mjs', 'kernel/package.json', 'package.json', 'public/skills.json']
  syncVersions({ root, files })

  const data = readVersions({ root })
  data.lines.find((e) => e.id === 'APP_VERSION').value = '9.9.9-人工篡改'
  writeFileSync(join(root, 'kit/manifest/versions.json'), JSON.stringify(data, null, 2))

  const { data: corrected } = syncVersions({ root, files })
  const app = corrected.lines.find((e) => e.id === 'APP_VERSION')
  assert.equal(app.value, 'dev 3.0.0')            // 正向：等于源文件真实值
  assert.notEqual(app.value, '9.9.9-人工篡改')     // 反向：人工篡改不留存
})

test('syncVersions：exclude 的人工编辑（新增排除项 + note）同样被保留', () => {
  const root = fixture({
    'version.mjs': "export const APP_VERSION = 'dev 3.0.0'\nexport const KERNEL_VERSION = 'dev 0.2'\nexport const SCHEMA_VERSION = 1\n",
    'kernel/package.json': '{ "version": "0.2.0" }',
    'package.json': '{ "version": "2.8.0" }',
    'k/c.mjs': "export const UPSTREAM_VERSION = '2023-06-01'\nexport const INDEX_VERSION = 4\n",
    'public/skills.json': '[]',
  })
  const files = ['version.mjs', 'kernel/package.json', 'package.json', 'k/c.mjs', 'public/skills.json']
  const first = syncVersions({ root, files })
  assert.equal(first.data.contracts.some((e) => e.id === 'UPSTREAM_VERSION'), true)

  // 人工把它登记为排除项（附人工理由/说明）
  const data = readVersions({ root })
  data.exclude.push({ id: 'UPSTREAM_VERSION', file: 'k/c.mjs', reason: '上游协议版本', note: '人工加的说明' })
  writeFileSync(join(root, 'kit/manifest/versions.json'), JSON.stringify(data, null, 2))

  const second = syncVersions({ root, files })
  assert.equal(second.data.contracts.some((e) => e.id === 'UPSTREAM_VERSION'), false)
  assert.deepEqual(second.data.exclude.find((e) => e.id === 'UPSTREAM_VERSION'),
    { id: 'UPSTREAM_VERSION', file: 'k/c.mjs', reason: '上游协议版本', note: '人工加的说明' })
})

test('syncVersions：exclude 列表里的常量不进台账', () => {
  const root = fixture({
    'version.mjs': "export const APP_VERSION = 'dev 3.0.0'\nexport const KERNEL_VERSION = 'dev 0.2'\nexport const SCHEMA_VERSION = 1\n",
    'kernel/package.json': '{ "version": "0.2.0" }',
    'package.json': '{ "version": "2.8.0" }',
    'k/c.mjs': "export const ANTHROPIC_VERSION = '2023-06-01'\nexport const INDEX_VERSION = 4\n",
    'public/skills.json': '[]',
  })
  const files = ['version.mjs', 'kernel/package.json', 'package.json', 'k/c.mjs', 'public/skills.json']
  const { data } = syncVersions({ root, files })
  assert.equal(data.contracts.some((e) => e.id === 'ANTHROPIC_VERSION'), false)
  assert.equal(data.contracts.some((e) => e.id === 'INDEX_VERSION'), true)
})

// ── Task 5：依赖台账 ────────────────────────────────────────────────────────

test('collectEvidence：静态 import / require 命中', () => {
  const root = fixture({
    'src/a.ts': "import { x } from 'clsx'\n",
    'server/b.mjs': "const y = require('ws')\n",
  })
  const files = ['src/a.ts', 'server/b.mjs']
  assert.deepEqual(collectEvidence({ root, files, dep: 'clsx' }).classes, ['import'])
  assert.deepEqual(collectEvidence({ root, files, dep: 'ws' }).classes, ['import'])
  assert.deepEqual(collectEvidence({ root, files, dep: 'nope' }).classes, [])
})

// G3 回归夹具之一：动态 import
test('collectEvidence：动态 import() 命中 —— rcedit 就是这一类（scripts/patch-icon.mjs:10）', () => {
  const root = fixture({ 'scripts/p.mjs': "const { rcedit } = await import('rcedit')\n" })
  const ev = collectEvidence({ root, files: ['scripts/p.mjs'], dep: 'rcedit' })
  assert.deepEqual(ev.classes, ['dynamic-import'])
})

// G3 回归夹具之二：根级配置文件
test('collectEvidence：配置文件引用命中 —— @tailwindcss/typography 就是这一类', () => {
  const root = fixture({ 'tailwind.config.ts': "import typography from '@tailwindcss/typography'\n" })
  const ev = collectEvidence({ root, files: ['tailwind.config.ts'], dep: '@tailwindcss/typography' })
  assert.equal(ev.classes.includes('config-file'), true)
})

// G3 回归夹具之三：CLI 调用
test('collectEvidence：CLI 调用命中 —— electron-builder 就是这一类（npx electron-builder）', () => {
  const root = fixture({
    'scripts/build-installer.mjs': "execSync('npx electron-builder --win nsis', { stdio: 'inherit' })\n",
    'package.json': '{ "scripts": { "build:electron": "npm run build && electron-builder" } }',
  })
  const ev = collectEvidence({ root, files: ['scripts/build-installer.mjs', 'package.json'], dep: 'electron-builder' })
  assert.equal(ev.classes.includes('cli'), true)
})

// G3 回归夹具之四：类型包
test('collectEvidence：@types/* 归 types 类（由 tsconfig 自动包含，不参与未用判定）', () => {
  const root = fixture({ 'tsconfig.json': '{ "include": ["src"] }' })
  const ev = collectEvidence({ root, files: ['tsconfig.json'], dep: '@types/node' })
  assert.equal(ev.classes.includes('types'), true)
})

// ── R2（Task 5 复审 rider）：tsconfig 的 types 字段 ──────────────────────────
// 旧判据只看"tsconfig 里有没有 `types` 这个键"：一旦写上 `"types": ["node"]`，
// 全部 @types/* 立刻被判 unused → P1 报红 → B1 会去删**真在用**的类型包。
test('collectEvidence：tsconfig 写了 types 字段 —— 列出的包判 used，未列出的照旧参与未用判定', () => {
  const root = fixture({ 'tsconfig.json': '{ "compilerOptions": { "strict": true, "types": ["node"] } }' })
  assert.equal(collectEvidence({ root, files: ['tsconfig.json'], dep: '@types/node' }).classes.includes('types'), true,
    '列在 compilerOptions.types 里的是"全局类型包"，必须判 used')
  assert.equal(collectEvidence({ root, files: ['tsconfig.json'], dep: '@types/diff' }).classes.includes('types'), false,
    '判据不得放宽成"有 types 字段就全放行"：没列出的类型包要照旧走未用判定，否则真未用的 @types/* 永远删不掉')
})

test('collectEvidence：types 字段存在时，宿主真 import 的那个模块对应的 @types/* 仍判 used（模块级类型包不受 types 字段影响）', () => {
  const root = fixture({
    'tsconfig.json': '{ "compilerOptions": { "types": ["node"] } }',
    'src/a.tsx': "import { useState } from 'react'\n",
  })
  const files = ['tsconfig.json', 'src/a.tsx']
  assert.equal(collectEvidence({ root, files, dep: '@types/react' }).classes.includes('types'), true,
    'types 字段只管"全局自动包含"；@types/react 是靠 `import react` 的模块解析生效的，仍是必需依赖')
  assert.equal(collectEvidence({ root, files, dep: '@types/react-dom' }).classes.includes('types'), false,
    '宿主没 import react-dom → 它对应的类型包不得被"顺手救回"（反向约束，防止判据从宽）')
  assert.equal(collectEvidence({ root, files, dep: '@types/babel__core' }).classes.includes('types'), false,
    '作用域包 @types/babel__core 同理：没 import @babel/core 就不算在用')
})

test('collectEvidence：无 types 字段时回退现行为（@types/* 全部自动包含）', () => {
  const root = fixture({ 'tsconfig.json': '{ "compilerOptions": { "strict": true } }' })
  assert.equal(collectEvidence({ root, files: ['tsconfig.json'], dep: '@types/diff' }).classes.includes('types'), true)
  assert.equal(collectEvidence({ root, files: ['tsconfig.json'], dep: '@types/react-dom' }).classes.includes('types'), true)
})

test('syncDeps：types:["node"] 下三个类型包一条 unused 都不许出（R2 的落地：P1 不得对此报红）', () => {
  const root = fixture({
    'package.json': JSON.stringify({
      dependencies: {},
      devDependencies: { '@types/node': '^20', '@types/react': '^18', '@types/react-dom': '^18' },
      scripts: {},
    }),
    'tsconfig.json': '{ "compilerOptions": { "types": ["node"] } }',
    'src/a.tsx': "import { useState } from 'react'\nimport { createRoot } from 'react-dom/client'\n",
    'kernel/package.json': '{}',
  })
  const files = ['package.json', 'tsconfig.json', 'src/a.tsx', 'kernel/package.json']
  const { data, unused } = syncDeps({ root, files })
  assert.deepEqual(unused, [], 'tsconfig 一旦写上 types 字段，在用的类型包仍须判 used（否则 P1 红 → B1 误删）')
  assert.deepEqual(data.domains['npm-dev'].packages.map((p) => p.status), ['used', 'used', 'used'])
})

// ── R4（Task 5 复审 rider）：check 侧与 sync 侧必须共用同一份幽灵判据 ──────────
// 起因：Task 7 计划里的 `ghostOf()` 自己重写了一遍判定（只滤 `@/`、不看 optionalProbes），
// 在真仓实测会多报两条：`~`（public/sample-skills 上游示例的 `~/threads/...`）与
// `jszip`（shared/pack-zip.test.mjs:85 的 try/catch 可选探针）—— 这两类"不得报红"下面的夹具已钉住。
test('computeGhost：check 路径（传台账里的 declared/optionalProbes）与 sync 路径结论一致', () => {
  const root = fixture({
    'package.json': JSON.stringify({ dependencies: { react: '^18' }, devDependencies: {}, scripts: {} }),
    'src/a.ts': [
      "import { x } from 'react'",
      "import type { T } from '~/threads/thread-manager'",  // 上游技能示例的工程别名
      "import 'left-pad'",                                  // 真幽灵
    ].join('\n') + '\n',
    'shared/opt.test.mjs': "try {\n  await import('jszip')\n} catch { /* 可选探针 */ }\n",
    'kernel/package.json': '{}',
  })
  const files = ['package.json', 'src/a.ts', 'shared/opt.test.mjs', 'kernel/package.json']
  const sync = syncDeps({ root, files })
  assert.deepEqual(sync.ghost, ['left-pad'], 'sync 侧：~ 别名与可选探针都不算幽灵')

  // check 侧：不回写台账，只用台账里的 declared + optionalProbes 现场扫宿主
  const ledger = readDeps({ root })
  const declared = new Set(Object.values(ledger.domains).flatMap((d) => (d.packages || []).map((p) => p.name)))
  assert.deepEqual(computeGhost({ root, files, declared, probes: ledger.optionalProbes }), ['left-pad'],
    'check 侧不得多报 ~ / jszip（多报 = 门禁自己打自己脸，且会诱导人删掉不该删的 import）')
  assert.deepEqual(ledger.optionalProbes.map((o) => o.spec), ['jszip'])
})

test('collectEvidence：测试文件里的 import 不算生产证据（但会被记录到 files）', () => {
  const root = fixture({ 'src/a.test.ts': "import { d } from 'diff'\n" })
  const ev = collectEvidence({ root, files: ['src/a.test.ts'], dep: 'diff', includeTests: true })
  assert.equal(ev.productionFiles.length, 0)
})

test('parseDeclaredImports：抽出模块说明符，过滤 node: 与相对路径', () => {
  const root = fixture({
    'src/a.ts': "import x from 'react'\nimport y from './local'\nimport z from 'node:fs'\nimport '@radix-ui/react-slot'\n",
  })
  const names = parseDeclaredImports({ root, files: ['src/a.ts'] })
  assert.ok(names.includes('react'))
  assert.ok(names.includes('@radix-ui/react-slot'))
  assert.equal(names.includes('./local'), false)
  assert.equal(names.some((n) => n.startsWith('node:')), false)
})

test('readRequirements：解析 requirements.txt 的名称与版本约束，跳过注释', () => {
  const root = fixture({
    'public/sample-skills/_common/requirements.txt': '# 注释\nopenpyxl>=3.1.0  # 注释\npdfplumber>=0.9.0\n\n# pywin32>=305\n',
  })
  const reqs = readRequirements({ root, file: 'public/sample-skills/_common/requirements.txt' })
  assert.deepEqual(reqs.map((r) => r.name), ['openpyxl', 'pdfplumber'])
  assert.equal(reqs[0].spec, '>=3.1.0')
})

test('syncDeps：判出 unused 与 ghost，且守卫 types/config/cli 不被误判', () => {
  const root = fixture({
    'package.json': JSON.stringify({
      dependencies: { react: '^18', 'classic-level': '^3', '@tailwindcss/typography': '^0.5' },
      devDependencies: { '@types/node': '^20' },
      scripts: {},
    }),
    'src/a.ts': "import { x } from 'react'\n",
    'tailwind.config.ts': "import typography from '@tailwindcss/typography'\n",
    'tsconfig.json': '{ "include": ["src"] }',
    'kernel/package.json': '{ "version": "0.2.0" }',
  })
  const files = ['package.json', 'src/a.ts', 'tailwind.config.ts', 'tsconfig.json', 'kernel/package.json']
  const { data, unused } = syncDeps({ root, files })
  assert.deepEqual(unused, ['classic-level'])
  assert.equal(data.domains['npm-runtime'].packages.find((p) => p.name === 'react').status, 'used')
  assert.equal(data.domains['npm-runtime'].packages.find((p) => p.name === '@tailwindcss/typography').status, 'used',
    '配置文件证据必须救回 @tailwindcss/typography（G3）')
  assert.equal(data.domains['kernel'].assertZero, true)
})

test('syncDeps：ghost（源码 import 了但未声明）能被发现', () => {
  const root = fixture({
    'package.json': JSON.stringify({ dependencies: {}, devDependencies: {}, scripts: {} }),
    'src/a.ts': "import { x } from 'left-pad'\n",
    'kernel/package.json': '{}',
  })
  const { ghost } = syncDeps({ root, files: ['package.json', 'src/a.ts', 'kernel/package.json'] })
  assert.deepEqual(ghost, ['left-pad'])
})

// ── Task 5 追加：判据的边界（每条都对应一次实测假阳性） ─────────────────────

test('collectEvidence：CLI 判据只认命令调用 —— 裸包名 token 不算（实测 electron/main.cjs:1153 的扩展名清单里有 xlsx，且该文件有 execSync）', () => {
  const root = fixture({
    'electron/main.cjs': "execSync('git status', { cwd: ROOT })\nconst extensions = ['pdf', 'xlsx', 'xls']\n",
  })
  assert.deepEqual(collectEvidence({ root, files: ['electron/main.cjs'], dep: 'xlsx' }).classes, [],
    '把"文件里有 execSync + 出现包名"当 CLI 证据会让真未用的 xlsx/nanoid 逃掉未用判定（B1 就不会删它们）')
})

test('collectEvidence：工具配置文件按约定消费对应包（实测 postcss / autoprefixer / typescript 全仓源码零 import）', () => {
  const root = fixture({
    'postcss.config.js': 'export default {\n  plugins: {\n    tailwindcss: {},\n    autoprefixer: {},\n  },\n}\n',
    'tsconfig.json': '{ "include": ["src"] }',
  })
  const files = ['postcss.config.js', 'tsconfig.json']
  assert.equal(collectEvidence({ root, files, dep: 'postcss' }).classes.includes('config-file'), true)
  assert.equal(collectEvidence({ root, files, dep: 'autoprefixer' }).classes.includes('config-file'), true)
  assert.equal(collectEvidence({ root, files, dep: 'typescript' }).classes.includes('config-file'), true)
})

test('syncDeps：五类证据齐备后 dev 域零 unused（漏一类就会误红 P1 → 诱导删掉在用的工具链）', () => {
  const root = fixture({
    'package.json': JSON.stringify({
      dependencies: {},
      devDependencies: {
        '@types/node': '^20', 'electron': '^31', 'rcedit': '^4', 'electron-builder': '^24',
        'vite': '^5', '@vitejs/plugin-react': '^4', 'tailwindcss': '^3', '@tailwindcss/typography': '^0.5',
        'postcss': '^8', 'autoprefixer': '^10', 'typescript': '^5',
      },
      scripts: {},
    }),
    'vite.config.ts': "import { defineConfig } from 'vite'\nimport react from '@vitejs/plugin-react'\n",
    'tailwind.config.ts': "import { Config } from 'tailwindcss'\nimport typography from '@tailwindcss/typography'\n",
    'postcss.config.js': 'export default {\n  plugins: {\n    tailwindcss: {},\n    autoprefixer: {},\n  },\n}\n',
    'tsconfig.json': '{ "include": ["src"] }',
    'electron/main.cjs': "const { app } = require('electron')\n",
    'scripts/patch-icon.mjs': "const { rcedit } = await import('rcedit')\n",
    'scripts/build-installer.mjs': "execSync('npx electron-builder --win nsis', { stdio: 'inherit' })\n",
    'kernel/package.json': '{}',
  })
  const files = ['package.json', 'vite.config.ts', 'tailwind.config.ts', 'postcss.config.js', 'tsconfig.json',
    'electron/main.cjs', 'scripts/patch-icon.mjs', 'scripts/build-installer.mjs', 'kernel/package.json']
  const { data, unused } = syncDeps({ root, files })
  assert.deepEqual(unused, [])
  assert.ok(data.domains['npm-dev'].packages.every((p) => p.status === 'used'))
})

test('syncDeps：默认扫描域是 git ls-files —— 未跟踪文件（scratch/ 参考副本）不得翻转判定（I2）', () => {
  const root = fixture({
    'package.json': JSON.stringify({ dependencies: { react: '^18', 'classic-level': '^3' }, devDependencies: {}, scripts: {} }),
    'src/a.ts': "import { x } from 'react'\n",
    'kernel/package.json': '{}',
  })
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['add', '-A'], { cwd: root })
  // 未跟踪副本（scratch/ 里 claude-code 参考源码的真实形态）：import 大量真未用依赖
  mkdirSync(join(root, 'scratch-ref'), { recursive: true })
  writeFileSync(join(root, 'scratch-ref', 'evil.ts'), "import 'classic-level'\nimport 'diff'\n")
  const { unused } = syncDeps({ root }) // 不传 files：走 trackedFiles 默认路径
  assert.deepEqual(unused, ['classic-level'],
    '扫描域若退化为磁盘遍历，scratch-ref/ 的 import 会把它判成在用（实测 scratch/ 里 diff 与 @tanstack/react-virtual 有大量 import）')
})

test('syncDeps：try/catch 包裹的可选探针不算幽灵依赖，但必须记入台账 optionalProbes（实测 jszip@shared/pack-zip.test.mjs:85）', () => {
  const root = fixture({
    'package.json': JSON.stringify({ dependencies: {}, devDependencies: {}, scripts: {} }),
    'shared/pack-zip.test.mjs': "test('与 jszip 对拍', async (t) => {\n  let JSZip = null\n  try {\n    JSZip = (await import('jszip')).default\n  } catch { /* 未安装则跳过 */ }\n  if (!JSZip) return\n})\n",
    'src/a.ts': "import 'left-pad'\n",
    'kernel/package.json': '{}',
  })
  const files = ['package.json', 'shared/pack-zip.test.mjs', 'src/a.ts', 'kernel/package.json']
  const { ghost, data } = syncDeps({ root, files })
  assert.deepEqual(ghost, ['left-pad'], '硬依赖照旧报幽灵（不得因为"有可选探针规则"而整体放宽）')
  assert.deepEqual(data.optionalProbes, [{ spec: 'jszip', file: 'shared/pack-zip.test.mjs', line: 4 }])
})

test('syncDeps：注释 / 正则字面量 / 夹具字符串 / `~/` 别名都不产生幽灵依赖（实测 7 条假幽灵）', () => {
  const root = fixture({
    'package.json': JSON.stringify({ dependencies: {}, devDependencies: {}, scripts: {} }),
    'src/a.ts': [
      '// Distortion axis: a separate measurement from "pressure" — the meter',
      "const re = /import \\{ x \\} from '@\\/hooks\\/useKnowledge'/",
      "const fixture = \"import y from 'left-pad'\"",
      "import type { ThreadManager } from '~/threads/thread-manager'",
    ].join('\n') + '\n',
    'kernel/package.json': '{}',
  })
  const files = ['package.json', 'src/a.ts', 'kernel/package.json']
  const { ghost } = syncDeps({ root, files })
  assert.deepEqual(ghost, [], '7 条假幽灵（pressure@en-US.ts:220 / @\\/hooks\\@verify-knowledge-import-gui.mjs:167 / left-pad·diff·@\\/lib\\ 等夹具字符串 / ~@技能示例）必须一条都不报')
})

test('syncDeps：真幽灵照旧被抓 —— "把传递依赖当直接依赖"（实测 @codemirror/autocomplete@CodeEditor.tsx:6、js-yaml@verify-package-assets.mjs:7）', () => {
  const root = fixture({
    'package.json': JSON.stringify({ dependencies: {}, devDependencies: {}, scripts: {} }),
    'src/components/editor/CodeEditor.tsx': "import { closeBrackets } from '@codemirror/autocomplete'\n",
    'scripts/verify-package-assets.mjs': "import { load } from 'js-yaml'\n",
    'kernel/package.json': '{}',
  })
  const files = ['package.json', 'src/components/editor/CodeEditor.tsx', 'scripts/verify-package-assets.mjs', 'kernel/package.json']
  const { ghost } = syncDeps({ root, files })
  assert.deepEqual(ghost, ['@codemirror/autocomplete', 'js-yaml'], '收紧噪声判据不得顺手把真幽灵也放过')
})

test('collectEvidence：同一行两个 require 都能命中（引号奇偶判据不得误伤真实证据）', () => {
  const root = fixture({ 'src/a.ts': "const a = require('clsx'); const b = require('ws')\n" })
  assert.deepEqual(collectEvidence({ root, files: ['src/a.ts'], dep: 'ws' }).classes, ['import'])
})

test('syncDeps：notes / gates 是人工维护段，sync 必须原样保留（否则 Task 11/12 的实测内容会被静默冲掉）', () => {
  const root = fixture({
    'package.json': JSON.stringify({ dependencies: { react: '^18' }, devDependencies: {}, scripts: {} }),
    'src/a.ts': "import { x } from 'react'\n",
    'kernel/package.json': '{}',
  })
  const files = ['package.json', 'src/a.ts', 'kernel/package.json']
  syncDeps({ root, files })
  const d = readDeps({ root })
  d.notes = { pythonOnlyEmbedded: [{ name: 'pydantic', reason: '人工实测' }] }
  d.gates = { ci: ['verify-highrisk'], manual: [{ script: 'verify-gui-fidelity', reason: '需图形会话' }] }
  writeDeps({ root, data: d })

  const { data } = syncDeps({ root, files })
  assert.deepEqual(data.notes.pythonOnlyEmbedded, [{ name: 'pydantic', reason: '人工实测' }])
  assert.deepEqual(data.gates.ci, ['verify-highrisk'])
  assert.deepEqual(data.gates.manual, [{ script: 'verify-gui-fidelity', reason: '需图形会话' }])
})

test('syncDeps：packages[].status 是**事实字段**（人工不可篡改）——手改成 used/unused 都会被重算纠正回来', () => {
  // 与 notes / gates 相反：那两个是"人工段"（sync 必须原样保留），status 是"宿主事实"（sync 必须重算）。
  // 二者混淆的后果不对称：status 被人工留住 ⇒ 台账说"未用"而源码在用（或反之），
  // P1/P2 规则与后续 B1 的删除动作都建立在它上面 —— 会据一条假事实删掉在用的依赖。
  const root = fixture({
    'package.json': JSON.stringify({
      dependencies: { react: '^18', 'classic-level': '^3' },
      devDependencies: {},
      scripts: {},
    }),
    'src/a.ts': "import { x } from 'react'\n",
    'kernel/package.json': '{}',
  })
  const files = ['package.json', 'src/a.ts', 'kernel/package.json']
  syncDeps({ root, files })

  // 手工篡改两个方向：真未用的改成 used（连证据一起伪造，模拟"装得更像"），在用的改成 unused
  const d = readDeps({ root })
  const pkgs = d.domains['npm-runtime'].packages
  const cl = pkgs.find((p) => p.name === 'classic-level')
  cl.status = 'used'
  cl.evidence = { classes: ['import'], files: ['src/a.ts'] }
  pkgs.find((p) => p.name === 'react').status = 'unused'
  writeDeps({ root, data: d })

  const { data, unused } = syncDeps({ root, files })
  const after = data.domains['npm-runtime'].packages
  assert.equal(after.find((p) => p.name === 'classic-level').status, 'unused',
    '人工把 status 改成 used 必须被重算纠正回来（不得沿用旧值）')
  assert.equal(after.find((p) => p.name === 'react').status, 'used',
    '反方向同样：人工把在用的改成 unused 也必须纠正回来')
  assert.deepEqual(after.find((p) => p.name === 'classic-level').evidence.classes, [],
    '伪造的证据与 status 同属事实字段，一并重算')
  assert.deepEqual(unused, ['classic-level'], '未用判定只由本次重算的证据决定，与人工改过的 status 无关')
})

// ── Rider 4-①（Task 7）：types 分支只扫入参 files，结论不得随 cache 覆盖面变化 ──────────
// 实测的问题：旧实现扫的是内部 cache 的 `idx.values()`，于是
//   collectEvidence({files:['tsconfig.json'], dep:'@types/react'})              → []         （无 cache）
//   collectEvidence({..., cache: 含 src/a.tsx 的索引})                          → ['types']  （有 cache）
// 同一函数、同一 files 入参，两个结论 —— check 与 sync 各自建索引的覆盖面不同，门禁结论就不可复现。
test('Rider4-①：@types 的模块级解析只认入参 files，cache 只是性能优化（不得改语义）', () => {
  const root = fixture({
    'tsconfig.json': '{ "compilerOptions": { "types": ["node"] } }',
    'src/a.tsx': "import { useState } from 'react'" + String.fromCharCode(10),
  })
  assert.deepEqual(collectEvidence({ root, files: ['tsconfig.json'], dep: '@types/react' }).classes, [],
    'files 里没有 import react 的文件 → 证据必须是空（旧实现会靠 cache 里的 src/a.tsx 把结论救回来）')
  const cache = buildEvidenceIndex({ root, files: ['tsconfig.json', 'src/a.tsx'] })
  assert.deepEqual(collectEvidence({ root, files: ['tsconfig.json'], dep: '@types/react', cache }).classes, [],
    '带 cache 也必须同结论：cache 的覆盖面不得泄漏进判据')
  // 反向：把文件真的放进 files，就必须命中（否则"收紧"会退化成"永远判空"）
  assert.equal(collectEvidence({ root, files: ['tsconfig.json', 'src/a.tsx'], dep: '@types/react' })
    .classes.includes('types'), true)
})

// ── Task 9（A7）：skills-lock 重算（D5 —— lock 记"本地安装后"哈希）─────────────
//
// ★ 为什么是"重算 lock 文件"而不是"把哈希记进台账"：台账由 sync 重写，若 V7 拿台账里的
//   哈希去比对文件，那么"跑一次 sync"就必然让 V7 全绿 —— 门禁被自己的 sync 架空（自证陷阱）。
//   判据必须是**已提交的 lock 文件**（version-rules.mjs V7 直读它，不读台账；反向断言见
//   version-rules.test.mjs「V7 防自证：台账里塞入'正确'哈希也不影响判定」）。
const SKILL_MD = '---\nname: demo\nversion: "1.0.0"\n---\n\n正文\n'
const DEMO_SKILL = 'public/sample-skills/demo/SKILL.md'
const sha256 = (s) => createHash('sha256').update(s).digest('hex')

test('syncSkillsLock：重算 computedHash、保留 source/其他字段、不动 SKILL.md', () => {
  const root = fixture({
    [DEMO_SKILL]: SKILL_MD,
    'skills-lock.json': JSON.stringify({ version: 1, skills: { demo: { source: 'anthropics/skills', upstreamHash: 'KEEP', computedHash: 'STALE' } } }),
  })
  const r = syncSkillsLock({ root, files: [DEMO_SKILL, 'skills-lock.json'] })
  const after = JSON.parse(readFileSync(join(root, 'skills-lock.json'), 'utf8'))
  assert.equal(after.skills.demo.upstreamHash, 'KEEP', '非目标字段必须原样保留（只改该改的）')
  assert.equal(after.skills.demo.source, 'anthropics/skills')
  assert.equal(after.version, 1, 'lock 顶层其他分区同样不得丢')
  assert.deepEqual(r.updated, ['demo'])
  // ★ 判据独立复算（不信任实现给出的值）：必须是该 SKILL.md 字节的 sha256。
  //   少了这条，实现写个随机 64 位十六进制也能过（长度断言拦不住"值不对"）。
  assert.equal(after.skills.demo.computedHash, sha256(SKILL_MD), '写入的哈希必须等于该文件字节的 sha256')
  assert.equal(readFileSync(join(root, DEMO_SKILL), 'utf8'), SKILL_MD, 'syncSkillsLock 只改 lock，不得触碰 SKILL.md')
})

test('syncSkillsLock：lock 里登记但文件不存在 → 进 missing、不静默删除条目', () => {
  // ★ 夹具里必须**同时**有一条待更新（demo）与一条 missing（ghost）：
  //   missing 单条时 `updated.length === 0` → 根本不落盘，于是"实现把 missing 条目删掉"
  //   这个 bug 在文件上看不出来（变异测试实测：只有 missing 的夹具抓不到 M2）。
  const root = fixture({
    [DEMO_SKILL]: SKILL_MD,
    'skills-lock.json': JSON.stringify({ skills: { ghost: { computedHash: 'x' }, demo: { computedHash: 'STALE' } } }),
  })
  const r = syncSkillsLock({ root, files: [DEMO_SKILL, 'skills-lock.json'] })
  assert.deepEqual(r.missing, ['ghost'])
  assert.deepEqual(r.updated, ['demo'])
  const after = JSON.parse(readFileSync(join(root, 'skills-lock.json'), 'utf8'))
  assert.equal(after.skills.ghost.computedHash, 'x',
    'missing 的条目必须原样保留（删掉它就等于把 V7 的红灯擦掉：文件没了反而无人报）')
  assert.equal(after.skills.demo.computedHash, sha256(SKILL_MD))
})

test('syncSkillsLock：二次运行幂等（unchanged 全量、文件一字节不变）', () => {
  const root = fixture({ [DEMO_SKILL]: SKILL_MD, 'skills-lock.json': JSON.stringify({ skills: { demo: { computedHash: 'x' } } }) })
  const files = [DEMO_SKILL, 'skills-lock.json']
  syncSkillsLock({ root, files })
  const first = readFileSync(join(root, 'skills-lock.json'), 'utf8')
  const second = syncSkillsLock({ root, files })
  assert.deepEqual(second.updated, [])
  assert.deepEqual(second.unchanged, ['demo'])
  assert.equal(readFileSync(join(root, 'skills-lock.json'), 'utf8'), first, '幂等：内容必须一字节不变（否则每次 sync 都产生无意义 diff）')
})

test('syncSkillsLock：dryRun 只报告、不落盘（`kit sync --dry-run` 的承诺）', () => {
  const root = fixture({ [DEMO_SKILL]: SKILL_MD, 'skills-lock.json': JSON.stringify({ skills: { demo: { computedHash: 'STALE' } } }) })
  const before = readFileSync(join(root, 'skills-lock.json'), 'utf8')
  const r = syncSkillsLock({ root, files: [DEMO_SKILL, 'skills-lock.json'], dryRun: true })
  assert.deepEqual(r.updated, ['demo'], '预演必须报出"真跑会改哪几条"，否则预演没有信息量')
  assert.equal(readFileSync(join(root, 'skills-lock.json'), 'utf8'), before, '--dry-run 不得写盘')
})

// ★ "CLI 的 sync 真的调用 syncSkillsLock"是 spawn 真进程的端到端断言，放在
//   `kit/cli.test.mjs`（那里有 CLI 夹具与 run() 辅助）——本文件只测库函数行为。

// ── Task 9（A6）：commonTools 覆盖 98/98 + manifest `_note` 的可校验性 ─────────//
// 这条测试读**本仓真实文件**（git ls-files，干净克隆里同样成立）而不是夹具：A6 的交付物
// 就是"台账 vs 实有 .py vs manifest 三者对得上"，夹具里造一份就等于自己证明自己。
// 它补的是规则层的缺口：V8（登记的都存在）+ V8b（实有的都登记）**都不管版本值真伪**，
// 于是"台账给某个未标注脚本编一个版本号"当前无人报红 —— 本条按 manifest 复算堵住它。
test('A6：台账 commonTools 全量覆盖实有 .py，且非空版本可复算回 manifest（不得编造）', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const py = listCommonPy(trackedFiles({ root }))
  const v = readVersions({ root })
  const entries = (v && v.commonTools && v.commonTools.entries) || []
  assert.deepEqual(entries.map((e) => e.file).sort(), py.map((n) => `${COMMON_DIR}/${n}`),
    '台账必须与实有 .py 一一对应（spec §5.4：全量登记，版本可为空但不得漏登记）')

  const manifest = readJson({ root, rel: `${COMMON_DIR}/_common_manifest.json` }) || { tools: {} }
  const manifestTools = manifest.tools || {}
  let filled = 0
  for (const e of entries) {
    const name = e.file.replace(`${COMMON_DIR}/`, '')
    const truth = manifestTools[name]?.current_version ?? null
    if (e.version === null) {
      assert.equal(truth, null, `${name}: manifest 无版本，台账却填了 ${JSON.stringify(e.version)}（编造版本值）`)
      assert.equal(e.versionSource, 'unmarked', `${name}: 未标注者必须显式标 unmarked（可为空的字段不许留 undefined）`)
    } else {
      filled++
      assert.equal(e.version, truth, `${name}: 台账版本必须等于 manifest 的 current_version（唯一真源，可复算）`)
      assert.equal(e.versionSource, 'manifest')
    }
  }
  assert.ok(filled > 0, '至少要有一条 manifest 版本值被登记 —— 否则本条退化成空跑（filled=0 时下面全部断言都不执行）')

  // `_note` 的两条声明必须与实测一致：零个 .py 声明 __version__、版本不从脚本内容校验。
  // 有人给脚本加了 __version__ → 本条红 → 迫使同步 _note（否则 _note 变成过期谎言）。
  const declared = py.filter((n) => /^\s*__version__\s*=/m.test(readTracked({ root, file: `${COMMON_DIR}/${n}` }) || ''))
  assert.deepEqual(declared, [], `_note 声称存量脚本零个声明 __version__，实测已不符：${declared.join(', ')}`)
  assert.match(String(manifest._note || ''), /不从脚本内容校验/, '_note 必须写明 current_version 不可从脚本内容校验')
})
