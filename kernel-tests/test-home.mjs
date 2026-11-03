// kernel-tests/test-home.mjs —— 给"要读 config.json 判出网闸"的用例一个**确定性的 home**
// （2026-11-01）
//
// 为什么需要它（实测的真实假绿）：
//   `electron/app-egress.cjs#checkEgress` 的判据是 **home 里 config.json 的 network.capabilities**，
//   而 `fetchPageMaterial` / `harvestSite` / websearch 这批用例**不传 home** ⇒ 走
//   `resolvePonosHome()` = 开发机真实的 `~/.ponos`。
//   开发机上那份 config.json 有 `network` 段（没有 capabilities 键 ⇒ 存量兜底
//   provider/web/browser/shell）⇒ 用例一直绿；CI runner 的 home 里**没有 config.json**
//   ⇒ `file-missing` ⇒ **新装最严**（只放 provider）⇒ 23 条用例整片红，而红的原因不是被测行为。
//   ⇒ 用例必须自己声明"一份正常安装的配置"，不能靠本机残留。
//
// 用法：在测试文件顶部 `import { installTestHome } from './test-home.mjs'` 并调用一次；
//   它把 `PONOS_HOME` 指向临时目录、写入一份**存量兜底等价**的 network 段，退出时清理。
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 「存量安装」的放行清单：与 `capabilitiesOf(undefined)` 的兜底同集合（不是新造口径） */
export const LEGACY_CAPABILITIES = Object.freeze(['provider', 'web', 'browser', 'shell'])

/**
 * 安装一个临时 home 并指向 `PONOS_HOME`。
 * @param {{ capabilities?: string[] }} [o]
 * @returns {string} 临时 home 路径
 */
export function installTestHome({ capabilities = LEGACY_CAPABILITIES } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ponos-test-home-'))
  writeFileSync(join(home, 'config.json'), JSON.stringify({ network: { capabilities } }), 'utf-8')
  process.env.PONOS_HOME = home
  process.on('exit', () => { try { rmSync(home, { recursive: true, force: true }) } catch { /* 退出期尽力 */ } })
  return home
}
