/**
 * Builds a portable YFWorking desktop app and creates a desktop shortcut.
 * Usage: node scripts/package-portable.cjs
 *
 * Output: release/YFWorking/ — double-click YFWorking.vbs to launch (no terminal).
 */
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const SCRIPTS = path.resolve(__dirname)
let RELEASE = path.join(ROOT, 'release', 'YFWorking')
// S6 Batch B：真实桌面解析（OneDrive 重定向安全），PowerShell 查询一次
let DESKTOP
try {
  DESKTOP = execSync(
    "powershell -NoProfile -Command \"[Environment]::GetFolderPath('Desktop')\"",
    { encoding: 'utf8', timeout: 10000 },
  ).trim()
} catch (err) {
  console.warn('  WARNING: PowerShell Desktop resolution failed, falling back to homedir/Desktop:', err.message)
  DESKTOP = path.join(require('os').homedir(), 'Desktop')
}

// ── Helpers ─────────────────────────────────────────────────────────────
function cpDir(src, dest, ignoreList = ['node_modules']) {
  if (!fs.existsSync(src)) return
  fs.mkdirSync(dest, { recursive: true })
  const items = fs.readdirSync(src, { withFileTypes: true })
  for (const item of items) {
    if (ignoreList.includes(item.name)) continue
    const s = path.join(src, item.name)
    const d = path.join(dest, item.name)
    if (item.isDirectory()) cpDir(s, d, ignoreList)
    else fs.copyFileSync(s, d)
  }
}

function cpNodeModules(srcRoot, destRoot, modules) {
  for (const mod of modules) {
    const src = path.join(srcRoot, mod)
    const dest = path.join(destRoot, mod)
    if (!fs.existsSync(src)) continue
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    cpDir(src, dest, []) // include all, including nested node_modules
  }
}

function countFiles(dir) {
  let n = 0
  function w(d) {
    try {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) w(path.join(d, e.name))
        else n++
      }
    } catch {}
  }
  w(dir)
  return n
}

// ── Clean ───────────────────────────────────────────────────────────────
console.log('[1/5] Cleaning...')
// If the canonical dir was previously locked, reuse the latest YFWorking_* sibling
const releaseRoot = path.join(ROOT, 'release')
if (!fs.existsSync(RELEASE) && fs.existsSync(releaseRoot)) {
  const siblings = fs.readdirSync(releaseRoot, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name.startsWith('YFWorking_'))
    .map(d => d.name).sort()
  if (siblings.length) {
    RELEASE = path.join(releaseRoot, siblings[siblings.length - 1])
    console.log('  Reusing previous dir: ' + RELEASE)
  }
}
if (fs.existsSync(RELEASE)) {
  try {
    fs.rmSync(RELEASE, { recursive: true, force: true })
  } catch (err) {
    // Directory locked (e.g. lingering electron process) — reuse the latest
    // sibling dir if any, else fall back to a fresh one.
    const siblings = fs.readdirSync(releaseRoot, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name.startsWith('YFWorking_'))
      .map(d => d.name).sort()
    if (siblings.length) {
      RELEASE = path.join(releaseRoot, siblings[siblings.length - 1])
      try { fs.rmSync(RELEASE, { recursive: true, force: true }) } catch {}
    } else {
      RELEASE = RELEASE + '_' + Date.now().toString(36)
    }
    console.warn('  Existing dir locked, packaging to: ' + RELEASE)
  }
}
fs.mkdirSync(RELEASE, { recursive: true })

// ── Copy app files ──────────────────────────────────────────────────────
console.log('[2/5] Copying app files...')
cpDir(path.join(ROOT, 'dist'), path.join(RELEASE, 'dist'))
cpDir(path.join(ROOT, 'electron'), path.join(RELEASE, 'electron'))
cpDir(path.join(ROOT, 'server'), path.join(RELEASE, 'server'))
cpDir(path.join(ROOT, 'public'), path.join(RELEASE, 'public'))
// shared/：内核与桥共用的模块（knowledge-pack/knowledge-core/pack-zip）。
// 2026-09-14 实况：这份复制清单漏了它，而 server/knowledge-routes.mjs 静态 import
// '../shared/knowledge-pack.mjs' ⇒ 打包产物里 bridge 在模块求值阶段就 ERR_MODULE_NOT_FOUND，
// 端口从未打开，应用只报「桥接服务器无法在端口 51517 上启动」（把根因指向 WinNAT，误导）。
cpDir(path.join(ROOT, 'shared'), path.join(RELEASE, 'shared'))

// ── Copy built-in agent/memory/tools templates ──────────────────────────
// 对齐 electron-builder extraResources `to: runtime/agents|memory|tools`
//（T1 改接源：build/templates/{agents,memory,tools}）语义；main.cjs dev 形态
// 候选解析 app 根 runtime/（main.cjs:46 先例）→ 便携包落 <app>/runtime/ 同址。
const templatesSrc = path.join(ROOT, 'build', 'templates')
if (!fs.existsSync(templatesSrc)) {
  console.error('  ERROR: build/templates not found — portable package would be incomplete, aborting')
  process.exit(1)
}
for (const group of ['agents', 'memory', 'tools']) {
  cpDir(path.join(templatesSrc, group), path.join(RELEASE, 'runtime', group), ['__pycache__'])
  console.log('  runtime/' + group + ' templates packaged')
}

// ── Copy desktop pet (independent Python pet: runtime script + assets) ──
const petSrc = path.join(ROOT, 'pet')
const petDst = path.join(RELEASE, 'pet')
if (fs.existsSync(petSrc)) {
  fs.mkdirSync(petDst, { recursive: true })
  const petScript = path.join(petSrc, 'jiajia-pet.py')
  if (fs.existsSync(petScript)) fs.copyFileSync(petScript, path.join(petDst, 'jiajia-pet.py'))
  const petLib = path.join(petSrc, 'accessories_lib.py')
  if (fs.existsSync(petLib)) fs.copyFileSync(petLib, path.join(petDst, 'accessories_lib.py'))
  const petAssets = path.join(petSrc, 'assets')
  if (fs.existsSync(petAssets)) cpDir(petAssets, path.join(petDst, 'assets'), [])
  console.log('  pet/ copied (jiajia-pet.py + accessories_lib.py + assets)')
}

// ── Copy embedded Python runtime ──────────────────────────────────────
const runtimeSrc = path.join(ROOT, 'runtime', 'python')
const runtimeDst = path.join(RELEASE, 'runtime', 'python')
if (fs.existsSync(runtimeSrc)) {
  cpDir(runtimeSrc, runtimeDst, ['__pycache__'])
  console.log('  runtime/python embedded (all Python dependencies bundled)')
} else {
  console.warn('  WARNING: runtime/python not found — Python features may not work')
}

// ── Copy skills ────────────────────────────────────────────────────────
const skillsSrc = path.join(ROOT, 'runtime', 'skills')
const skillsDst = path.join(RELEASE, 'runtime', 'skills')
if (fs.existsSync(skillsSrc)) {
  cpDir(skillsSrc, skillsDst, ['__pycache__'])
  console.log('  runtime/skills packaged (' + countFiles(skillsSrc) + ' files)')
}

// ── Copy YFW kernel (净室内核 bundle，node 直跑 D1) ───────────────────────
// 内核 = scripts/build-kernel.mjs 的产物 kernel-dist/cli.mjs（gitignored，
// bun build --target=node 单文件 ESM，零外部依赖 → 无 vendor/；运行时 = node，
// 由包内 node.exe 或系统 node 拉起，bun 不随包）。
const kernelSrc = path.join(ROOT, 'kernel-dist', 'cli.mjs')
const kernelDst = path.join(RELEASE, 'kernel')
if (fs.existsSync(kernelSrc)) {
  fs.mkdirSync(kernelDst, { recursive: true })
  fs.copyFileSync(kernelSrc, path.join(kernelDst, 'cli.mjs'))
  console.log('  kernel/cli.mjs embedded (YFWorking ponos kernel bundle)')
} else {
  console.warn('  WARNING: kernel-dist/cli.mjs not found — run `node scripts/build-kernel.mjs` first')
}

// ── Copy production node_modules ────────────────────────────────────────
console.log('[3/5] Copying production dependencies...')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'))
const prodDeps = Object.keys(pkg.dependencies || {})
// Only copy deps that bridge/main actually need
const neededDeps = prodDeps.filter(d => {
  // Bridge uses: ws, xlsx, mammoth, nanoid (via server/bridge.mjs)
  // Skip react/frontend deps — not needed at runtime (bundled in dist)
  const browserOnly = ['react', 'react-dom', 'framer-motion', 'tailwind-merge', 'class-variance-authority',
    'lucide-react', 'zustand', 'react-markdown', 'remark-gfm', 'diff']
  const browserRadix = prodDeps.filter(d => d.startsWith('@radix-ui/'))
  return !browserOnly.includes(d) && !browserRadix.includes(d)
})

cpNodeModules(path.join(ROOT, 'node_modules'), path.join(RELEASE, 'node_modules'), neededDeps)
// Also copy electron runtime
cpDir(path.join(ROOT, 'node_modules', 'electron'), path.join(RELEASE, 'node_modules', 'electron'), [])

// ── Launcher scripts ─────────────────────────────────────────────────────
console.log('[4/5] Creating launchers...')

// Bundle node.exe so bridge spawn works even if PATH has no node
try {
  const nodeSource = process.execPath
  fs.copyFileSync(nodeSource, path.join(RELEASE, 'node.exe'))
  console.log('  node.exe bundled:', path.basename(nodeSource))
} catch (err) {
  console.warn('  WARNING: could not bundle node.exe:', err.message)
}

// VBS wrapper: launches electron without terminal window
const vbsReliable = `Set WshShell = CreateObject("WScript.Shell")
Set FSO = CreateObject("Scripting.FileSystemObject")
Dim appPath
appPath = FSO.GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = appPath
WshShell.Run """" & appPath & "\\electron\\electron.exe"" """ & appPath & "\\electron\\main.cjs""", 0, False
`

fs.writeFileSync(path.join(RELEASE, 'YFWorking.vbs'), vbsReliable, 'utf-8')

// .bat for debugging
fs.writeFileSync(path.join(RELEASE, 'YFWorking-debug.bat'), [
  '@echo off',
  'cd /d "%~dp0"',
  'echo Starting YFWorking Desktop...',
  'start "" /wait "electron\\electron.exe" "electron\\main.cjs"',
  'echo YFWorking closed.',
].join('\r\n'), 'utf-8')

// ── Package node_modules/electron for portability ───────────────────────
// Electron needs dist/electron.exe to be findable
const electronDir = path.join(RELEASE, 'electron');
// Copy electron.exe binary to the electron dir for simplicity
const electronModule = path.join(RELEASE, 'node_modules', 'electron');
if (fs.existsSync(electronModule)) {
  // electron-builder-like approach: symlink or copy into electron/
  const electronExe = path.join(electronModule, 'dist', 'electron.exe')
  const targetExe = path.join(electronDir, 'electron.exe')
  if (fs.existsSync(electronExe) && !fs.existsSync(targetExe)) {
    // ① Copy electron.exe to a temp location
    const tmpExe = path.join(RELEASE, 'electron_branded.exe')
    fs.writeFileSync(tmpExe, fs.readFileSync(electronExe))
    // ② Patch temp copy with brand icon
    const icoPath = path.join(RELEASE, 'public', 'icon.ico')
    const patchScript = path.join(SCRIPTS, 'patch-icon.mjs')
    if (fs.existsSync(icoPath) && fs.existsSync(patchScript)) {
      try {
        console.log('[icon] Injecting brand icon into electron.exe...')
        execSync(`node "${patchScript}" "${tmpExe}" "${icoPath}"`, { stdio: 'pipe', timeout: 15000 })
        // ③ Move patched exe to target
        fs.renameSync(tmpExe, targetExe)
        console.log('  Brand icon injected successfully')
      } catch (e) {
        console.warn('  WARNING: could not patch icon:', e.stderr ? e.stderr.toString().trim() : e.message)
        // Fallback: use unpatched copy
        if (!fs.existsSync(targetExe)) {
          fs.writeFileSync(targetExe, fs.readFileSync(electronExe))
        }
        if (fs.existsSync(tmpExe)) fs.unlinkSync(tmpExe)
      }
    } else {
      fs.renameSync(tmpExe, targetExe)
      if (!fs.existsSync(icoPath)) console.warn('  No icon.ico — electron.exe will keep default icon')
    }
    // Also copy supporting DLLs
    const distDir = path.join(electronModule, 'dist')
    const items = fs.readdirSync(distDir, { withFileTypes: true })
    for (const item of items) {
      if (item.name === 'electron.exe') continue
      const src = path.join(distDir, item.name)
      const dest = path.join(electronDir, item.name)
      if (item.isDirectory()) {
        cpDir(src, dest, [])
      } else {
        fs.copyFileSync(src, dest)
      }
    }
  }
} else {
  console.error('WARNING: electron runtime not found in node_modules/electron')
}

// ── Desktop shortcut ─────────────────────────────────────────────────────
console.log('[5/5] Creating desktop shortcut...')
// Shortcut points DIRECTLY at electron.exe (no wscript/VBS hop).
// VBS only escapes quotes; backslashes are fine as-is.
const lnkPath = path.join(DESKTOP, 'YFWorking.lnk')
const shortcutVbs = path.join(DESKTOP, 'YFWorking-shortcut.vbs')
// VBS escaping: a literal " inside a string is written as "".
// So Arguments needs """ + path + """ (3 quotes each side).
const vq = '"""'
const electronExe = path.join(RELEASE, 'electron', 'electron.exe')
const mainCjs = path.join(RELEASE, 'electron', 'main.cjs')
const iconIco = path.join(RELEASE, 'public', 'icon.ico')
fs.writeFileSync(shortcutVbs, [
  `Set WshShell = CreateObject("WScript.Shell")`,
  `Set shortcut = WshShell.CreateShortcut("${lnkPath}")`,
  `shortcut.TargetPath = "${electronExe}"`,
  `shortcut.Arguments = ${vq}${mainCjs}${vq}`,
  `shortcut.WorkingDirectory = "${RELEASE}"`,
  `shortcut.IconLocation = "${iconIco}"`,
  `shortcut.Description = "YFWorking Desktop"`,
  `shortcut.Save`,
].join('\r\n'))
execSync(`cscript //Nologo "${shortcutVbs}"`, { cwd: RELEASE, timeout: 10000 })
fs.unlinkSync(shortcutVbs)
console.log('  Shortcut → electron.exe directly')

// ── Done ────────────────────────────────────────────────────────────────
console.log()
console.log('========================================')
console.log('  YFWorking Desktop packaged!')
console.log(`  Location: ${RELEASE}`)
console.log(`  Desktop shortcut: ${DESKTOP}\\YFWorking.lnk`)
console.log('========================================')
console.log()
console.log('To launch: double-click YFWorking.lnk on Desktop')
console.log('To debug:  right-click → run YFWorking-debug.bat')
