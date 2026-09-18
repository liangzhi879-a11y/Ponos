// 控制台「以 agent 为主」+ 覆盖率呈现的接线回归网（P1，2026-09-17）。
// ---------------------------------------------------------------------------
// 锁三件事：
//   ① **面板降级**（需求原话"执行命令保留但不做主要界面元素"）：主标签条只渲染 agent / diagnose，
//      `commands` 由页头次级入口打开；但 `APPS_TABS` **不许改**（它是持久化契约，
//      删掉会让老用户存在 localStorage/会话里的落点被静默改写）。
//   ② **覆盖率不可能是"渲染层自己算的"**：必须经 IPC 取自主进程的唯一实现（shared/ 的 CJS）。
//      同一条命令目录在渲染层再抄一份必然漂移，而漂移出来的覆盖率是**假指标**（显示 100% 却没能力）。
//   ③ **i18n 齐备**：目录里每一条命令都要在中英两份文案里能找到，否则界面会显示 key 原文
//      （覆盖率能显示但没有可读的命令名，等于又回到"看不懂的数字"）。
// 运行：node --test kernel-tests/app-console-tabs.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TARGET_CLASSES, commandsForClass, commandI18nKey, UNAVAILABLE_REASON } from '../shared/app-control-commands.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

test('面板降级：主标签条只渲染 agent/diagnose，commands 由页头入口进入', () => {
  const src = read('src/components/apps/AppConsole.tsx')
  // 主标签来自 PRIMARY_TABS（而不是直接遍历 APPS_TABS）
  assert.match(src, /\{PRIMARY_TABS\.map\(/, '主标签条必须遍历 PRIMARY_TABS')
  assert.match(src, /const PRIMARY_TABS = APPS_TABS\.filter\(\(v\) => v !== 'commands'\)/,
    'PRIMARY_TABS 必须由 APPS_TABS 派生（不许另抄一份列表 ⇒ 两处漂移）')
  assert.doesNotMatch(src, /<TabsList[\s\S]{0,400}?\{APPS_TABS\.map\(/,
    '主标签条不得再直接遍历 APPS_TABS（那样 commands 又回到主位）')
  // 页头次级入口：存在、且能在 commands 与 diagnose 之间切换
  assert.match(src, /data-testid="app-manual-commands"/, '页头必须有「手工执行命令」入口')
  assert.match(src, /onTabChange\(shownTab === 'commands' \? 'diagnose' : 'commands'\)/,
    '入口必须有去/回两态（只能进不能出的入口等于死胡同）')
  assert.match(src, /aria-pressed=\{shownTab === 'commands'\}/, '入口要反映激活态（否则用户不知自己在哪一屏）')
})

test('持久化契约不许动：APPS_TABS 仍是三项且含 commands', () => {
  const tab = read('src/lib/appsTab.ts')
  assert.match(tab, /APPS_TABS[^\n]*'agent'[^\n]*'diagnose'[^\n]*'commands'|APPS_TABS[^\n]*\['agent', 'diagnose', 'commands'\]/,
    'APPS_TABS 必须保留 commands（老落点不能失效）')
  for (const v of ['agent', 'diagnose', 'commands']) assert.ok(tab.includes(`'${v}'`), `appsTab 缺 ${v}`)
  // 默认落点仍是 agent（"以 agent 智能运行为主"的直接体现）。注意源码带类型标注：
  // `export const DEFAULT_APPS_TAB: AppsTab = 'agent'`，故正则要允许中间的 `: AppsTab`。
  assert.match(tab, /DEFAULT_APPS_TAB(?::\s*AppsTab)?\s*=\s*'agent'/, '默认落点必须是 agent')
})

test('覆盖率必须经 IPC 取自主进程唯一实现（不许渲染层自己算）', () => {
  const ipc = read('electron/app-ipc.cjs')
  assert.match(ipc, /require\('\.\.\/shared\/app-control-commands\.cjs'\)/,
    '主进程必须引用 shared 的唯一实现')
  assert.match(ipc, /ipcMain\.handle\('app:coverage'/, '必须注册 app:coverage')
  assert.match(ipc, /coverageReport\(\)[\s\S]{0,200}coverageForClass\(targetClass\)/,
    'app:coverage 必须同时给出两个类别的报告与该应用类别的覆盖率')
  const preload = read('electron/preload.cjs')
  assert.match(preload, /appCoverage: \(appId\) => ipcRenderer\.invoke\('app:coverage', appId\)/,
    'preload 必须把 app:coverage 暴露成 appCoverage（否则界面拿不到）')
  // 渲染层只消费、不复制目录
  const view = read('src/components/apps/AppCoverage.tsx')
  assert.match(view, /api\.appCoverage\(appId\)/, '覆盖率组件必须走 IPC')
  assert.doesNotMatch(view, /COVERAGE_THRESHOLD|commandsForClass/, '渲染层不得自己算覆盖率（会与后端漂移）')
  assert.match(view, /if \(failed \|\| !data \|\| !data\.coverage\) return null/,
    '拿不到数据时必须什么都不显示 —— 宁可缺席也不显示假数字')
})

test('i18n 齐备：目录里每条命令与每个不可用原因在中英文案里都存在', () => {
  const zh = read('src/i18n/translations/zh-CN.ts')
  const en = read('src/i18n/translations/en-US.ts')
  const missing = []
  for (const cls of TARGET_CLASSES) {
    for (const c of commandsForClass(cls)) {
      const key = commandI18nKey(cls, c.id)
      // 文案文件是**嵌套对象**（`apps: { cmd_web_goto: '…' }`），故按最后一段查，而不是整串 key
      const leaf = key.split('.').pop()
      for (const [name, src] of [['zh-CN', zh], ['en-US', en]]) {
        if (!new RegExp(`\\b${leaf}\\s*:`).test(src)) missing.push(`${name}:${key}`)
      }
      // 不可用命令必须带原因 key，且该 key 也要有文案（否则界面显示裸 key）
      if (!c.implemented) {
        assert.ok(c.reasonKey, `${cls}.${c.id} 不可用却没原因 key`)
        assert.ok(zh.includes(`${c.reasonKey.split('.').pop()}:`), `zh 缺原因文案 ${c.reasonKey}`)
        assert.ok(en.includes(`${c.reasonKey.split('.').pop()}:`), `en 缺原因文案 ${c.reasonKey}`)
      }
    }
  }
  assert.deepEqual(missing, [], `缺文案：${missing.join(', ')}`)
  // 覆盖率自身的文案（含 70% 判定与缺失清单）
  for (const k of ['coverageTitle', 'coverageValue', 'coverageMet', 'coverageUnmet', 'coverageMissing', 'coverageUsed']) {
    assert.ok(zh.includes(k), `zh 缺 apps.${k}`)
    assert.ok(en.includes(k), `en 缺 apps.${k}`)
  }
  // 未达标文案必须点明 70%（只写"未达标"用户不知道门槛在哪）
  assert.match(zh, /coverageUnmet: '[^']*70%/, 'zh 未达标语应含 70%')
  assert.match(en, /coverageUnmet: '[^']*70%/, 'en 未达标语应含 70%')
})

test('不可用原因与实际后端状态一致（uia 未接入这条文案不许变成假话）', () => {
  assert.equal(UNAVAILABLE_REASON.uiaUnavailable, 'apps.cmdUnavailableUia')
  const runner = read('electron/app-runner-desktop.cjs')
  assert.match(runner, /尚未接入|未接入/, 'uia 后端仍是桩 —— 若哪天真接上了，这条文案与覆盖率都要同步')
})
