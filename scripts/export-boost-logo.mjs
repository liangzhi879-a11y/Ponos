#!/usr/bin/env node
/**
 * scripts/export-boost-logo.mjs —— boost logo 透明导出管线
 * 用法: node scripts/export-boost-logo.mjs
 *
 * 源（用户素材，只读，不入 git）: YF/boost-logo.ai（PDF 1.6 头，544x378 横版）
 * 产出（GUI boot/login/cockpit 三屏共用资源）:
 *   public/logo/boost-logo-light.png   浅色界面（白/浅底）展示用
 *   public/logo/boost-logo-dark.png    深色界面（深底）展示用
 *
 * 策略（保留两条，运行时打印实际命中哪条，见 [strategy] 行）:
 *   策略 A 「整页透明」: 页面本底本就透明（artboard 未铺白/未铺渐变）时，
 *      直接 alpha 渲染出 RGBA 透明底 PNG；单一透明版则两版同文件。
 *   策略 B 「白底去背」: 页面整页不透明（白底/渐变铺满）时的退化路径——
 *      light 版 = 白底原样输出；dark 版 = 近白像素(阈 ~245)转透明后贴到品牌深色上。
 *
 * 渲染尺寸: 基准 4x（2176x1512），且保证短边 >=1024。输出两文件即成功(exit 0)，
 * 否则 exit 2 并打印原因。
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'YF', 'boost-logo.ai')
const OUT_DIR = join(ROOT, 'public', 'logo')
const LIGHT_PNG = join(OUT_DIR, 'boost-logo-light.png')
const DARK_PNG = join(OUT_DIR, 'boost-logo-dark.png')
const MIN_DIM = 1024
const PYTHON = process.env.PYTHON || 'python'

// 内联 python 脚本（经 stdin 交给本机 python 执行；仅依赖 pymupdf，退化策略 B 才用 Pillow+numpy）
const PY_CODE = `import os, sys
sys.stdout.reconfigure(encoding='utf-8')
def log(k, v):
    sys.stdout.write('[meta] %s=%s\\n' % (k, v))
SRC = ${JSON.stringify(SRC)}
OUT_DIR = ${JSON.stringify(OUT_DIR)}
BRAND_DARK = (23, 20, 18)   # 策略 B 退化兜底的“品牌深色”（近似深色主题 --bg-app），主路径不使用
MIN_DIM = 1024

import fitz
doc = fitz.open(SRC)
pg = doc[0]
pw, ph = pg.rect.width, pg.rect.height
if pw <= 0 or ph <= 0:
    sys.exit('ERROR: boost-logo.ai 首页尺寸异常')

scale = max(4.0, MIN_DIM / min(pw, ph))
scale = min(scale, 12.0)
pix = pg.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=True)
w, h = pix.width, pix.height
smp = pix.samples
if len(smp) != w * h * 4:
    sys.exit('ERROR: pixmap 字节数与尺寸不符')

def a_at(x, y):
    return smp[(y * w + x) * 4 + 3]

# ---- 本底探测: 四角 + 边界环 alpha ----
corner = [a_at(0, 0), a_at(w - 1, 0), a_at(0, h - 1), a_at(w - 1, h - 1)]
ring_min, ring_max = 255, 0
for x in range(0, w, 2):
    ring_min = min(ring_min, a_at(x, 0), a_at(x, h - 1))
    ring_max = max(ring_max, a_at(x, 0), a_at(x, h - 1))
for y in range(1, h, 2):
    ring_min = min(ring_min, a_at(0, y), a_at(w - 1, y))
    ring_max = max(ring_max, a_at(0, y), a_at(w - 1, y))

# ---- 内容区(alpha>16)与透明占比 ----
step = 3
tr = 0
tot = 0
minx, miny, maxx, maxy = w, h, -1, -1
y = 0
while y < h:
    x = 0
    while x < w:
        a = a_at(x, y)
        tot += 1
        if a < 8:
            tr += 1
        if a > 16:
            if x < minx: minx = x
            if x > maxx: maxx = x
            if y < miny: miny = y
            if y > maxy: maxy = y
        x += step
    y += step

tr_frac = tr / float(tot) if tot else 0.0
log('page', '%dx%d' % (w, h))
log('corner_alpha', corner)
log('ring_alpha_minmax', (ring_min, ring_max))
log('transparent_frac', round(tr_frac, 4))
if maxx >= 0:
    log('content_bbox', (minx, miny, maxx, maxy))
    log('margins_lrtb', (minx, w - 1 - maxx, miny, h - 1 - maxy))

os.makedirs(OUT_DIR, exist_ok=True)

def save_both(buf_bytes):
    with open(os.path.join(OUT_DIR, 'boost-logo-light.png'), 'wb') as f:
        f.write(buf_bytes)
    with open(os.path.join(OUT_DIR, 'boost-logo-dark.png'), 'wb') as f:
        f.write(buf_bytes)

transparent_canvas = (min(corner) < 8 or ring_min < 8) and tr_frac > 0.005

if transparent_canvas:
    # ---- 策略 A：整页透明 —— 单一透明版，两版同文件 ----
    sys.stdout.write('[strategy] A=transparent-canvas: 页面本底透明，直接 alpha 渲染；两版同文件\\n')
    save_both(pix.tobytes('png'))
    log('saved', 'boost-logo-light.png == boost-logo-dark.png (identical transparent render)')
else:
    # ---- 策略 B：白底去背退化（页面整页不透明，白底/渐变铺满） ----
    sys.stdout.write('[strategy] B=white-bg-knockout: 页面本底不透明(白底/渐变铺满)，走退化后处理\\n')
    try:
        from PIL import Image
        import numpy as np
    except Exception as e:
        sys.exit('ERROR: 策略 B 需要 Pillow + numpy（当前不可用: %s）' % e)
    arr = np.frombuffer(smp, dtype=np.uint8).reshape(h, w, 4).copy()
    alpha = arr[..., 3].astype(np.int32)[..., None]
    rgb = arr[..., :3].astype(np.int32)
    # light 版 = 白底原样（把残存半透明合成到白底，输出不透明 PNG）
    white = np.full((h, w, 3), 255, np.uint8)
    com = np.clip((rgb * alpha + white.astype(np.int32) * (255 - alpha)) // 255, 0, 255).astype(np.uint8)
    Image.fromarray(com, 'RGB').save(os.path.join(OUT_DIR, 'boost-logo-light.png'))
    log('saved', 'boost-logo-light.png (white-bg original)')
    # dark 版 = 近白(阈~245)转透明后贴到品牌深色上
    near_white = np.min(rgb, axis=2) > 245
    kept = ~near_white
    # 保留原 alpha 但把近白像素置透明；再以品牌深色为底合成（全幅不透明）
    out_a = np.where(near_white, 0, arr[..., 3]).astype(np.uint8)
    dst = np.tile(np.array(BRAND_DARK, dtype=np.int32)[None, None, :], (h, w, 1))
    a2 = out_a.astype(np.int32)[..., None]
    merged = np.clip((rgb * a2 + dst * (255 - a2)) // 255, 0, 255).astype(np.uint8)
    Image.fromarray(np.dstack([merged, np.full((h, w), 255, np.uint8)]), 'RGBA').save(
        os.path.join(OUT_DIR, 'boost-logo-dark.png'))
    log('saved', 'boost-logo-dark.png (near-white knocked out onto brand dark)')
doc.close()
sys.stdout.write('PY_DONE\\n')
`

function readPngSize(p) {
  const b = readFileSync(p)
  const w = b.readUInt32BE(16)
  const h = b.readUInt32BE(20)
  return { w, h }
}

function fail(msg) {
  console.error(`[export-boost-logo] ${msg}`)
  process.exit(2)
}

function main() {
  if (!existsSync(SRC)) fail(`源缺失（用户素材须在位）：${SRC}`)
  if (!existsSync(join(ROOT, 'public'))) fail('public/ 目录缺失，无法放置产物')
  mkdirSync(OUT_DIR, { recursive: true })

  const r = spawnSync(PYTHON, ['-u', '-'], {
    input: PY_CODE,
    encoding: 'utf-8',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    windowsHide: true,
  })
  if (r.error) fail(`python 不可用（${r.error.message}）；需 python + pymupdf（fitz）`)
  if (r.stdout) process.stdout.write(r.stdout)
  if (r.stderr) process.stderr.write(r.stderr)
  if (r.status !== 0) fail(`python 导出失败，exit=${r.status}`)

  for (const p of [LIGHT_PNG, DARK_PNG]) {
    if (!existsSync(p)) fail(`产物缺失：${p}`)
    const { w, h } = readPngSize(p)
    if (w < MIN_DIM || h < MIN_DIM) fail(`产物尺寸不足 ${MIN_DIM}px：${p} = ${w}x${h}`)
    console.log(`[verify] ${p} ${w}x${h} (>=${MIN_DIM}x${MIN_DIM})`)
  }
  console.log('[done] boost logo PNG 导出成功')
}

main()
