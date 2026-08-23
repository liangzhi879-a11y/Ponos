// scripts/build-embedded-python.mjs
// Builds portable embedded Python runtime for Ponos installer
import { execSync } from 'child_process'
import { existsSync, mkdirSync, rmSync, statSync, readdirSync, createWriteStream, unlinkSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { get } from 'https'

const ROOT = join(import.meta.dirname, '..')
const RUNTIME = join(ROOT, 'runtime', 'python')
const PY_VER = '3.12.0'
const EMBED_URL = `https://www.python.org/ftp/python/${PY_VER}/python-${PY_VER}-embed-amd64.zip`
const GET_PIP_URL = 'https://bootstrap.pypa.io/get-pip.py'

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest)
    get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400) {
        file.close()
        download(res.headers.location, dest).then(resolve).catch(reject)
        return
      }
      res.pipe(file)
      file.on('finish', () => { file.close(); resolve() })
    }).on('error', reject)
  })
}

function walkSize(dir) {
  let s = 0
  function w(d) {
    try {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name)
        if (e.isDirectory()) w(p)
        else s += statSync(p).size
      }
    } catch {}
  }
  w(dir)
  return s
}

try {
  console.log('[1/7] Cleaning runtime...')
  if (existsSync(RUNTIME)) rmSync(RUNTIME, { recursive: true, force: true })
  mkdirSync(RUNTIME, { recursive: true })

  console.log('[2/7] Downloading Python embeddable...')
  const zipPath = join(ROOT, 'runtime', 'python-embed.zip')
  await download(EMBED_URL, zipPath)
  console.log('  Downloaded')

  console.log('[3/7] Extracting Python embeddable...')
  execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${RUNTIME}' -Force"`, {
    stdio: 'pipe', timeout: 30000,
  })
  unlinkSync(zipPath)

  console.log('[4/7] Configuring site-packages path...')
  const pthFile = join(RUNTIME, 'python312._pth')
  let pthContent = readFileSync(pthFile, 'utf-8')
  pthContent = pthContent.replace('#import site', 'import site')
  pthContent += '\nLib\\site-packages\n'
  writeFileSync(pthFile, pthContent)
  mkdirSync(join(RUNTIME, 'Lib', 'site-packages'), { recursive: true })
  console.log('  Configured')

  console.log('[5/7] Downloading get-pip.py...')
  const getPipPath = join(ROOT, 'runtime', 'get-pip.py')
  await download(GET_PIP_URL, getPipPath)
  console.log('  Downloaded')

  console.log('[6/7] Installing pip + packages...')
  const pythonExe = join(RUNTIME, 'python.exe')
  execSync(`"${pythonExe}" "${getPipPath}" --no-warn-script-location`, {
    stdio: 'pipe', timeout: 60000, cwd: RUNTIME,
  })
  unlinkSync(getPipPath)
  console.log('  pip installed')

  const packages = [
    'openpyxl', 'python-docx', 'xlrd', 'Pillow',
    'beautifulsoup4', 'rapidocr-onnxruntime', 'PyPDF2', 'pypdf', 'pypdfium2',
    'requests', 'Jinja2', 'openai', 'pydantic',
  ]
  console.log('  Installing packages...')
  for (const pkg of packages) {
    try {
      console.log(`    ${pkg}`)
      execSync(`"${pythonExe}" -m pip install ${pkg} --quiet --no-warn-script-location`, {
        stdio: 'pipe', timeout: 180000, cwd: RUNTIME,
      })
    } catch (e) {
      console.warn(`    WARNING: ${pkg} installation had issues`)
    }
  }

  console.log('[7/7] Verifying runtime...')
  const testScript = join(RUNTIME, '_test.py')
  writeFileSync(testScript, [
    'import openpyxl, docx, xlrd, PIL, bs4, requests, jinja2, pydantic',
    'import rapidocr_onnxruntime',
    'from PyPDF2 import PdfReader',
    'from openai import OpenAI',
    'print("OK: all packages verified")',
  ].join('\n'))
  try {
    const result = execSync(`"${pythonExe}" "${testScript}"`, {
      encoding: 'utf-8', timeout: 60000, cwd: RUNTIME,
    })
    console.log('  ', result.trim())
  } catch (e) {
    console.warn('  WARNING: verification failed:', e.stderr?.toString().slice(0, 500) || e.message)
  }
  unlinkSync(testScript)

  const size = (walkSize(RUNTIME) / 1024 / 1024).toFixed(1)
  console.log(`\n  OK Runtime ready: ${size} MB`)
  console.log(`  Location: ${RUNTIME}`)

} catch (e) {
  console.error('FATAL:', e.message)
  process.exit(1)
}
