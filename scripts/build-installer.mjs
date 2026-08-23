// scripts/build-installer.mjs
// Builds the full YFWorking installer package
// 1. Builds embedded Python runtime (if not already built)
// 2. Packages ~/.yfworking/skills
// 3. Builds electron-builder NSIS installer
// 4. Builds portable .zip
import { execSync } from 'child_process'
import { existsSync, mkdirSync, rmSync, cpSync, copyFileSync, statSync, readdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const ROOT = join(import.meta.dirname, '..')
const RELEASE = join(ROOT, 'release')
const RUNTIME = join(ROOT, 'runtime', 'python')
const SKILLS_SRC = join(homedir(), '.yfworking', 'skills')
const SKILLS_DEST = join(ROOT, 'runtime', 'skills')

console.log('============================================')
console.log('  YFWorking Full Installer Builder')
console.log('============================================\n')

// ── Step 1: Ensure embedded Python runtime exists ─────────────────────
console.log('[1/4] Checking embedded Python runtime...')
if (!existsSync(join(RUNTIME, 'python.exe'))) {
  console.log('  Runtime not found, building...')
  execSync('node scripts/build-embedded-python.mjs', {
    stdio: 'inherit', timeout: 600000, cwd: ROOT,
  })
} else {
  const size = walkSize(RUNTIME)
  console.log(`  Runtime exists: ${(size / 1024 / 1024).toFixed(1)} MB`)
}

// ── Step 2: Package skills ──────────────────────────────────────────
console.log('\n[2/4] Packaging skills...')
if (existsSync(SKILLS_DEST)) rmSync(SKILLS_DEST, { recursive: true, force: true })
console.log(`  Copying from ${SKILLS_SRC}`)
cpSync(SKILLS_SRC, SKILLS_DEST, { recursive: true })
const skillsSize = walkSize(SKILLS_DEST)
const skillsCount = countFiles(SKILLS_DEST)
console.log(`  Skills: ${skillsCount} files, ${(skillsSize / 1024 / 1024).toFixed(1)} MB`)

// ── Step 3: Build frontend ──────────────────────────────────────────
console.log('\n[3/4] Building frontend...')
execSync('npm run build', { stdio: 'inherit', timeout: 120000, cwd: ROOT })

// ── Step 3.5: Bundle node.exe for bridge spawn ──────────────────────
// The bridge server is spawned via `node server/bridge.mjs`. On machines
// without Node.js in PATH this fails and the main process never creates a
// window (waitForBridge times out). Bundle the current node.exe.
const nodeExeTmp = join(ROOT, 'node.exe')
const nodeExeSrc = process.execPath
const nodeExeNeeded = !existsSync(nodeExeTmp)
if (nodeExeNeeded) {
  copyFileSync(nodeExeSrc, nodeExeTmp)
  console.log(`  Bundled node.exe: ${(statSync(nodeExeTmp).size / 1024 / 1024).toFixed(1)} MB`)
} else {
  console.log(`  node.exe already present: ${(statSync(nodeExeTmp).size / 1024 / 1024).toFixed(1)} MB`)
}

// ── Step 4: Build NSIS installer via electron-builder ────────────────
console.log('\n[4/4] Building NSIS installer...')
try {
  execSync('npx electron-builder --win nsis', {
    stdio: 'inherit', timeout: 600000, cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'production' },
  })
} finally {
  // Clean up temp node.exe (only needed during packaging)
  if (nodeExeNeeded && existsSync(nodeExeTmp)) {
    rmSync(nodeExeTmp)
    console.log('  Removed temp node.exe')
  }
}

// Show build artifacts
console.log('\n============================================')
console.log('  Build Complete')
console.log('============================================')
const releaseFiles = readdirSync(join(ROOT, 'release'), { withFileTypes: true })
for (const f of releaseFiles) {
  const p = join(ROOT, 'release', f.name)
  if (f.isFile()) {
    const size = (statSync(p).size / 1024 / 1024).toFixed(1)
    console.log(`  ${f.name} (${size} MB)`)
  }
}

function walkSize(dir) {
  let s = 0
  function w(d) {
    try {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) w(join(d, e.name))
        else s += statSync(join(d, e.name)).size
      }
    } catch {}
  }
  w(dir)
  return s
}

function countFiles(dir) {
  let n = 0
  function w(d) {
    try {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) w(join(d, e.name))
        else n++
      }
    } catch {}
  }
  w(dir)
  return n
}
