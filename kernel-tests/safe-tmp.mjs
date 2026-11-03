// kernel-tests/safe-tmp.mjs —— 测试夹具用的"安全临时目录"（2026-11-01）
//
// 为什么需要它（实测的真实假红）：
//   CI 的 runner 以**服务/SYSTEM** 身份跑 ⇒ `os.tmpdir()` = `C:\Windows\Temp`，**落在系统目录内**。
//   而产品有多处**刻意的 fail-closed 保护**会拒绝系统目录下的东西，例如
//   `electron/app-profiler-desktop.cjs#defaultProcessProbe`：`拒绝探测系统目录下的可执行文件`。
//   ⇒ 夹具把假 CLI（.bat / .exe）造在 tmpdir 里，就会被这条保护正确拒绝 ⇒ 用例红，
//   但红的原因是**保护按设计生效**、而夹具放错了地方（本机 tmpdir 在用户目录下所以一直是绿的）。
//
// 口径：优先 `USERPROFILE`（真实用户目录，非系统目录），退到仓库内 `.tmp-tests/`，
//   最后才回落到 `os.tmpdir()`。调用方拿到的仍是 `mkdtempSync` 建的独占目录。
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

function norm(p) {
  return String(p).toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '')
}

/** 系统目录（产品会拒绝在这些目录下探测可执行文件/写文件） */
function systemRoots() {
  return [process.env.SystemRoot, process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.PROGRAMDATA]
    .filter(Boolean).map(norm)
}

const insideSystem = (p) => {
  const q = norm(p)
  return systemRoots().some((r) => q === r || q.startsWith(r + '/'))
}

/**
 * 建一个**不在系统目录内**的临时夹具目录。
 * @param {string} prefix 目录名前缀（沿用各自用例的命名，便于排障时辨认）
 * @returns {string}
 */
export function safeTempDir(prefix) {
  const candidates = [process.env.USERPROFILE, join(ROOT, '.tmp-tests')]
  for (const base of candidates) {
    if (!base || insideSystem(base)) continue
    try {
      mkdirSync(base, { recursive: true })
      return mkdtempSync(join(base, prefix))
    } catch { /* 换下一个候选 */ }
  }
  return mkdtempSync(join(tmpdir(), prefix))
}
