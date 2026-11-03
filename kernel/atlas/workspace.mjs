// kernel/atlas/workspace.mjs —— workspace / monorepo 包发现与裸包名解析
//
// 只做确定性的静态推断：
//   - 从根 package.json#workspaces 展开包目录（支持 * / **）；没有 workspaces 时探测常见目录。
//   - 读包内 name / exports / main / module / types / source，把 `@scope/pkg/sub` 映射到包内源文件。
//   - 构建产物路径（dist/build/lib/out）回落到 src / 包根的同名源码。
// 不执行包管理器，不读 node_modules，不联网。
import fs from 'node:fs'
import path from 'node:path'
import { tryExt } from './extract.mjs'

const MAX_PACKAGES = 500
const MAX_WALK_DIRS = 5000
const MAX_WALK_DEPTH = 5
const COMMON_ROOTS = ['packages', 'apps', 'services', 'libs', 'modules', 'plugins', 'workspaces', 'crates']
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.worktrees', '.superpowers', '.ponos', '.pi', '.claude',
  '.cache', '.turbo', '.next', '.nuxt', '.svelte-kit', 'coverage', 'dist', 'build',
])

function toRel(value) {
  return String(value).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function globToRegExp(glob) {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        out += '.*'
        i++
      } else {
        out += '[^/]*'
      }
    } else if (ch === '?') {
      out += '[^/]'
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${out}$`)
}

function workspacePatterns(rootPkg) {
  const ws = rootPkg?.workspaces
  const list = Array.isArray(ws) ? ws : (Array.isArray(ws?.packages) ? ws.packages : [])
  return list.filter((p) => typeof p === 'string' && p.trim()).map(toRel)
}

function collectPackageDirs(root, base, depth, out) {
  if (out.length >= MAX_WALK_DIRS) return
  let items
  try { items = fs.readdirSync(path.join(root, base), { withFileTypes: true }) } catch { return }
  for (const item of items) {
    if (!item.isDirectory() || item.isSymbolicLink()) continue
    if (SKIP_DIRS.has(item.name)) continue
    const rel = base ? `${base}/${item.name}` : item.name
    if (fs.existsSync(path.join(root, rel, 'package.json')) && !out.includes(rel)) {
      out.push(rel)
      if (out.length >= MAX_PACKAGES) return
    }
    if (depth > 0) collectPackageDirs(root, rel, depth - 1, out)
  }
}

function splitSpec(spec) {
  const parts = String(spec).split('/')
  if (!parts[0]) return null
  if (parts[0].startsWith('@')) {
    if (parts.length < 2 || !parts[1]) return null
    return { name: `${parts[0]}/${parts[1]}`, subpath: parts.slice(2).join('/') }
  }
  return { name: parts[0], subpath: parts.slice(1).join('/') }
}

function collectExportTargets(exportsField, subpath) {
  const out = []
  const key = subpath ? `./${subpath}` : '.'
  const add = (node, star = '') => {
    if (typeof node === 'string') {
      out.push(star ? node.replace(/\*/g, star) : node)
      return
    }
    if (Array.isArray(node)) {
      for (const item of node) add(item, star)
      return
    }
    if (node && typeof node === 'object') {
      for (const item of Object.values(node)) add(item, star)
    }
  }

  if (typeof exportsField === 'string' || Array.isArray(exportsField)) {
    if (!subpath) add(exportsField)
    return out
  }
  if (!exportsField || typeof exportsField !== 'object') return out

  const keys = Object.keys(exportsField)
  const hasSubpathKeys = keys.some((k) => k === '.' || k.startsWith('./'))
  if (!hasSubpathKeys) {
    if (!subpath) add(exportsField)
    return out
  }

  if (Object.prototype.hasOwnProperty.call(exportsField, key)) add(exportsField[key])
  for (const pattern of keys) {
    if (!pattern.includes('*')) continue
    const starAt = pattern.indexOf('*')
    const prefix = pattern.slice(0, starAt)
    const suffix = pattern.slice(starAt + 1)
    if (!key.startsWith(prefix) || !key.endsWith(suffix)) continue
    const star = key.slice(prefix.length, key.length - suffix.length)
    add(exportsField[pattern], star)
  }
  return out
}

function targetVariants(target) {
  const base = toRel(target).replace(/^\.\//, '')
  if (!base) return []
  const out = [base]
  for (const prefix of ['dist/', 'build/', 'lib/', 'out/']) {
    if (!base.startsWith(prefix)) continue
    const stem = base.slice(prefix.length)
    out.push(`src/${stem}`, stem)
  }
  const expanded = []
  for (const item of out) {
    expanded.push(item)
    if (item.endsWith('.d.ts')) expanded.push(item.slice(0, -5) + '.ts')
    else if (item.endsWith('.d.mts')) expanded.push(item.slice(0, -6) + '.mts')
    else if (item.endsWith('.d.cts')) expanded.push(item.slice(0, -6) + '.cts')
    if (/\.(?:js|mjs|cjs|jsx)$/.test(item)) {
      const stem = item.replace(/\.(?:js|mjs|cjs|jsx)$/, '')
      expanded.push(stem + '.ts', stem + '.tsx', stem + '.mts', stem + '.cts', stem + '.mjs', stem + '.cjs', stem + '.jsx')
    }
  }
  return [...new Set(expanded)]
}

function resolvePackageTarget(pkg, subpath, fileSet) {
  const targets = collectExportTargets(pkg.exports, subpath)
  if (!subpath) {
    for (const item of [pkg.source, pkg.module, pkg.main, pkg.types]) {
      if (typeof item === 'string' && item) targets.push(item)
    }
  }
  for (const target of targets) {
    for (const base of targetVariants(target)) {
      const rel = pkg.dir ? path.posix.join(pkg.dir, base) : base
      const hit = tryExt(rel, fileSet)
      if (hit) return hit
    }
  }
  // exports 缺失或指向构建产物时，按常见源码布局兜底。
  const direct = subpath ? [`src/${subpath}`, subpath] : ['src/index', 'index']
  for (const base of direct) {
    const rel = pkg.dir ? path.posix.join(pkg.dir, base) : base
    const hit = tryExt(rel, fileSet)
    if (hit) return hit
  }
  return null
}

/**
 * @typedef {{ name:string, dir:string, exports:any, main:string|null, module:string|null, types:string|null, source:string|null, manifest:object }} WorkspacePackage
 * @typedef {{
 *   root:string, packages:WorkspacePackage[], byName:Map<string,WorkspacePackage>, byDir:Map<string,WorkspacePackage>,
 *   packageOfPath:(rel:string)=>WorkspacePackage|null,
 *   packageNameOf:(rel:string)=>string|null,
 *   matches:(spec:string)=>boolean,
 *   resolve:(spec:string, fileSet:Set<string>)=>string|null,
 * }} WorkspaceIndex
 */

/**
 * 发现 workspace 包。
 * @param {string} root 绝对路径
 * @returns {WorkspaceIndex}
 */
export function discoverWorkspaces(root) {
  const absRoot = path.resolve(root)
  const rootManifest = readJson(path.join(absRoot, 'package.json'))
  const patterns = workspacePatterns(rootManifest)
  let dirs = []

  if (patterns.length) {
    const bases = new Set()
    for (const pattern of patterns) {
      const first = pattern.split('/')[0]
      if (first && !first.includes('*')) bases.add(first)
    }
    if (!bases.size) bases.add('')
    for (const base of bases) collectPackageDirs(absRoot, base, MAX_WALK_DEPTH, dirs)
    const matchers = patterns.map(globToRegExp)
    dirs = dirs.filter((dir) => matchers.some((re) => re.test(dir)))
    for (const pattern of patterns) {
      if (pattern.includes('*')) continue
      if (fs.existsSync(path.join(absRoot, pattern, 'package.json'))) {
        if (!dirs.includes(pattern)) dirs.push(pattern)
      }
    }
  }

  // workspaces 未声明、声明了但一个都没找到时，探测常见 monorepo 目录。
  if (!dirs.length) {
    for (const base of COMMON_ROOTS) collectPackageDirs(absRoot, base, 2, dirs)
  }

  const packages = []
  const byName = new Map()
  const byDir = new Map()
  const seen = new Set()
  for (const dir of dirs.sort()) {
    if (seen.has(dir)) continue
    seen.add(dir)
    const manifest = readJson(path.join(absRoot, dir, 'package.json'))
    if (!manifest || typeof manifest.name !== 'string' || !manifest.name) continue
    const pkg = {
      name: manifest.name,
      dir,
      exports: manifest.exports ?? null,
      main: manifest.main ?? null,
      module: manifest.module ?? null,
      types: manifest.types ?? null,
      source: manifest.source ?? null,
      manifest,
    }
    packages.push(pkg)
    byName.set(pkg.name, pkg)
    byDir.set(dir, pkg)
  }

  // 根 package 也参与裸包名解析（单包项目自引用），但不作为文件域。
  if (rootManifest && typeof rootManifest.name === 'string' && rootManifest.name && !byName.has(rootManifest.name)) {
    const rootPkg = {
      name: rootManifest.name,
      dir: '',
      exports: rootManifest.exports ?? null,
      main: rootManifest.main ?? null,
      module: rootManifest.module ?? null,
      types: rootManifest.types ?? null,
      source: rootManifest.source ?? null,
      manifest: rootManifest,
    }
    packages.push(rootPkg)
    byName.set(rootPkg.name, rootPkg)
  }

  const dirOrder = packages
    .filter((pkg) => pkg.dir)
    .map((pkg) => pkg.dir)
    .sort((a, b) => b.length - a.length)

  const workspace = {
    root: absRoot,
    packages,
    byName,
    byDir,
    packageOfPath(rel) {
      const value = String(rel || '')
      for (const dir of dirOrder) {
        if (value === dir || value.startsWith(dir + '/')) return byDir.get(dir) || null
      }
      return null
    },
    packageNameOf(rel) {
      return workspace.packageOfPath(rel)?.name || null
    },
    matches(spec) {
      const parsed = splitSpec(spec)
      return Boolean(parsed && byName.has(parsed.name))
    },
    resolve(spec, fileSet) {
      if (!fileSet) return null
      const parsed = splitSpec(spec)
      if (!parsed) return null
      const pkg = byName.get(parsed.name)
      if (!pkg) return null
      return resolvePackageTarget(pkg, parsed.subpath, fileSet)
    },
  }
  return workspace
}
