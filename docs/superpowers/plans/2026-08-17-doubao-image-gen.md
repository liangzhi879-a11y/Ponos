# 豆包 AI 图片生成集成 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 claude-code-gui 中接入豆包 AI 图片生成（文生图/图生图/插入聊天/去水印），替代已废弃的 hidream 实现。

**Architecture:** Electron 主进程持有豆包隐藏窗口（persist:doubao 分区），生成请求通过 `webContents.executeJavaScript` 在页面上下文执行 `fetch`（字节 JS 劫持器自动注入 `a_bogus`/`msToken` 签名，规避风控）；图片下载经 bridge 调 Python（PIL+OpenCV）去水印后落盘本地。

**Tech Stack:** Electron（main.cjs/preload.cjs）、ESM bridge（server/bridge.mjs, 端口 51309）、React + zustand（src/）、Python 3 + PIL 12.2 + OpenCV 4.13（server/watermark_remove.py）、node:test。

## Global Constraints

- 测试命令：`npm test`（= `node --test "server/*.test.mjs"`）；类型检查：`npm run typecheck`；构建：`npm run build`
- 会话文件契约：`~/.ponos/doubao-session.json`（`{exportedAt, cookies:[{name,value,domain,path}]}`，写后 `chmodSync(0o600)`），cookie 判定键为 `sessionid`（与 hidream 的 `__session` 不同）
- 测试隔离：`process.env.PONOS_TEST_HOME` 覆盖数据目录；`PONOS_BRIDGE_NO_LISTEN=1` 跳过 bridge 顶层 listen
- 所有生成请求只能由主进程发出（页面上下文），bridge 禁止直连豆包 API
- 删除所有 hidream 残留引用（Task 8 用 grep 验证清零）
- 新增图片落盘目录：`~/.ponos/doubao-images/`
- i18n：zh-CN.ts / en-US.ts 同步新增 `doubao` 键组并删除 `hidream` 键组
- release 副本路径：`C:\Users\T203-15\claude-code-gui\release\Ponos_ms92cd6u\`（Task 9 同步）

---

### Task 1: server/doubao.mjs — 会话/历史/限速模块

**Files:**
- Create: `server/doubao.mjs`
- Test: `server/doubao.test.mjs`

**Interfaces:**
- Produces（供 Task 3/4 消费）：
  - `sessionFile()` → `join(HOME, '.ponos', 'doubao-session.json')`
  - `historyFile()` / `imagesDir()`（`.../doubao-history.json` / `.../doubao-images`）
  - `isLoggedIn()` → boolean（会话文件 cookies 中任一 `name === 'sessionid'` 且 value 非空）
  - `saveSession(cookies: Array<{name,value,domain,path}>)`（写 + chmodSync 0o600）
  - `clearSession()` / `readSessionMeta()` → `{exportedAt} | null`
  - `addHistory(entry)` / `listHistory()` / `removeHistory(id)`（历史上限 100 条，新条目 unshift）
  - `rateLimitHit()` → boolean（3 秒间隔）
  - 常量 `HOME = process.env.PONOS_TEST_HOME || homedir()`

- [ ] **Step 1: 写失败测试** `server/doubao.test.mjs`

```js
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as d from './doubao.mjs'   // homeDir() 延迟读取 env，模块求值时机无关紧要

let home
before(() => {
  home = mkdtempSync(join(tmpdir(), 'doubao-test-'))
  process.env.PONOS_TEST_HOME = home
})
after(() => { rmSync(home, { recursive: true, force: true }) })

test('isLoggedIn: 无会话文件返回 false', () => {
  assert.equal(d.isLoggedIn(), false)
})

test('saveSession + isLoggedIn: 写 sessionid cookie 后为 true', () => {
  d.saveSession([{ name: 'sessionid', value: 'abc123', domain: '.doubao.com', path: '/' }])
  assert.equal(d.isLoggedIn(), true)
  const raw = JSON.parse(readFileSync(d.sessionFile(), 'utf-8'))
  assert.ok(raw.exportedAt > 0)
  assert.equal(raw.cookies[0].value, 'abc123')
})

test('clearSession: 清除后为 false', () => {
  d.clearSession()
  assert.equal(d.isLoggedIn(), false)
})

test('readSessionMeta: 返回 exportedAt', () => {
  d.saveSession([{ name: 'sessionid', value: 'x', domain: '.doubao.com', path: '/' }])
  const m = d.readSessionMeta()
  assert.ok(m && m.exportedAt > 0)
})

test('history: add/list/remove 与上限', () => {
  for (let i = 0; i < 105; i++) d.addHistory({ id: `h${i}`, prompt: `p${i}`, imageUrl: `u${i}` })
  const list = d.listHistory()
  assert.equal(list.length, 100)
  assert.equal(list[0].prompt, 'p104')
  assert.ok(list.every(x => x.createdAt > 0))
  d.removeHistory('h104')
  assert.equal(d.listHistory().some(x => x.id === 'h104'), false)
})

test('rateLimitHit: 3 秒内第二次调用为 true', () => {
  assert.equal(d.rateLimitHit(), false)
  assert.equal(d.rateLimitHit(), true)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test server/doubao.test.mjs`
Expected: FAIL（`Cannot find module './doubao.mjs'` 或函数 undefined）

- [ ] **Step 3: 实现 `server/doubao.mjs`**

```js
import { homedir } from 'os'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, chmodSync } from 'fs'

// HOME 延迟读取（每次调用读 env）：测试通过 PONOS_TEST_HOME 隔离，
// 避免 ESM import 求值顺序问题（模块顶层求值时 env 可能尚未设置）
export const homeDir = () => process.env.PONOS_TEST_HOME || homedir()
export const sessionFile = () => join(homeDir(), '.ponos', 'doubao-session.json')
export const historyFile = () => join(homeDir(), '.ponos', 'doubao-history.json')
export const imagesDir = () => join(homeDir(), '.ponos', 'doubao-images')

let lastReqAt = 0

function readJson(p) {
  try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : null } catch { return null }
}
function writeJson(p, v) {
  mkdirSync(join(homeDir(), '.ponos'), { recursive: true })
  writeFileSync(p, JSON.stringify(v, null, 2), 'utf-8')
}

export function getSessionCookies() {
  const s = readJson(sessionFile())
  return s && Array.isArray(s.cookies) ? s.cookies : []
}
export function isLoggedIn() {
  return getSessionCookies().some(c => c.name === 'sessionid' && c.value)
}
export function saveSession(cookies) {
  writeJson(sessionFile(), { exportedAt: Date.now(), cookies: Array.isArray(cookies) ? cookies : [] })
  try { chmodSync(sessionFile(), 0o600) } catch {}
}
export function clearSession() {
  try { rmSync(sessionFile(), { force: true }) } catch {}
}
export function readSessionMeta() {
  try {
    const s = JSON.parse(readFileSync(sessionFile(), 'utf-8'))
    return s && typeof s.exportedAt === 'number' ? { exportedAt: s.exportedAt } : null
  } catch { return null }
}

export function addHistory(entry) {
  const list = listHistory()
  list.unshift({ ...entry, createdAt: Date.now() })
  writeJson(historyFile(), list.slice(0, 100))
  return true
}
export function listHistory() {
  return readJson(historyFile()) || []
}
export function removeHistory(id) {
  writeJson(historyFile(), listHistory().filter(x => x.id !== id))
  return true
}

export function rateLimitHit() {
  const now = Date.now()
  if (now - lastReqAt < 3000) return true
  lastReqAt = now
  return false
}
```

> 说明：`homeDir()` 每次调用读 `process.env.PONOS_TEST_HOME`，`before` 设置后生效；测试运行器 `--test` 每个文件独立进程，无模块缓存串扰。

- [ ] **Step 4: 运行确认通过**

Run: `node --test server/doubao.test.mjs`
Expected: PASS（6/6）

- [ ] **Step 5: 提交**

```bash
git add server/doubao.mjs server/doubao.test.mjs
git commit -m "feat(doubao): 会话/历史/限速模块（sessionid 判定 + 0600 权限 + 100 条历史）"
```

---

### Task 2: server/watermark_remove.py — 去水印脚本

**Files:**
- Create: `server/watermark_remove.py`
- Test: `server/watermark_remove.test.py`

**Interfaces:**
- Produces（供 Task 3 消费）：
  - CLI: `python watermark_remove.py <input> [--mode auto|crop] [--output <path>]`
  - stdout 单行 JSON：成功 `{"ok":true,"output":"<abs path>","mode":"inpaint"|"crop","region":[x,y,w,h]}`；失败 `{"ok":false,"error":"..."}`
  - 退出码：0 成功 / 1 失败
  - 默认 `--output`：同目录 `<basename>_clean.png`
  - `auto` = 右下角水印区域检测 + cv2.inpaint；检测置信不足降级 `crop`
  - 参数常量集中在文件顶部（水印区域扫描框等，供 P0 校准）

- [ ] **Step 1: 写失败测试** `server/watermark_remove.test.py`

```python
import json, os, subprocess, sys, tempfile, unittest
from PIL import Image, ImageDraw, ImageFont

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'watermark_remove.py')

def make_watermarked(path):
    """构造带右下角水印的测试图：纯色底 + 半透明白色圆角矩形 + 文字。"""
    img = Image.new('RGB', (400, 300), (120, 160, 200))
    d = ImageDraw.Draw(img, 'RGBA')
    d.rectangle([300, 230, 395, 290], fill=(255, 255, 255, 160))  # 半透明白块（模拟豆包水印）
    img.save(path, 'PNG')
    return img

class WatermarkTest(unittest.TestCase):
    def run_script(self, *args):
        r = subprocess.run([sys.executable, SCRIPT, *args], capture_output=True, text=True, timeout=30)
        return r

    def test_inpaint_mode_removes_region(self):
        with tempfile.TemporaryDirectory() as td:
            src = os.path.join(td, 'in.png')
            make_watermarked(src)
            r = self.run_script(src, '--mode', 'auto')
            self.assertEqual(r.returncode, 0, r.stderr)
            out = json.loads(r.stdout.strip().splitlines()[-1])
            self.assertTrue(out['ok'])
            self.assertEqual(out['mode'], 'inpaint')
            self.assertTrue(os.path.exists(out['output']))
            # 输出图右下角区域应与原图不同（水印被填充）且尺寸不变
            clean = Image.open(out['output'])
            self.assertEqual(clean.size, (400, 300))
            self.assertNotEqual(
                clean.convert('RGB').getpixel((350, 260)),
                (120, 160, 200)  # 若未处理则仍是半透明白与底色混合值，处理后接近底色
            )

    def test_crop_mode(self):
        with tempfile.TemporaryDirectory() as td:
            src = os.path.join(td, 'in.png')
            make_watermarked(src)
            r = self.run_script(src, '--mode', 'crop')
            out = json.loads(r.stdout.strip().splitlines()[-1])
            self.assertTrue(out['ok'])
            self.assertEqual(out['mode'], 'crop')
            clean = Image.open(out['output'])
            self.assertLess(clean.size[0], 400)  # 裁剪后更小

    def test_missing_input_fails(self):
        r = self.run_script('/nonexistent/xx.png')
        self.assertEqual(r.returncode, 1)
        out = json.loads(r.stdout.strip().splitlines()[-1])
        self.assertFalse(out['ok'])

if __name__ == '__main__':
    unittest.main()
```

- [ ] **Step 2: 运行确认失败**

Run: `python server/watermark_remove.test.py`
Expected: FAIL（`FileNotFoundError` / 找不到脚本）

- [ ] **Step 3: 实现 `server/watermark_remove.py`**

```python
# -*- coding: utf-8 -*-
"""豆包图片去水印后处理：右下角水印区域检测 + OpenCV inpaint，降级裁剪。
CLI: python watermark_remove.py <input> [--mode auto|crop] [--output <path>]
stdout 单行 JSON: {"ok":true,"output":"...","mode":"inpaint|crop","region":[x,y,w,h]}
"""
import json, os, sys

# ===== 可调参数（P0 用真实豆包图校准） =====
# 扫描框：右下角区域占图宽高的比例
SCAN_W_RATIO = 0.35
SCAN_H_RATIO = 0.35
# inpaint 膨胀半径（像素，按原图尺寸线性缩放）
DILATE_RATIO = 0.008
# 检测阈值：区域内与背景亮度差异超过该值视为水印像素
THRESH = 25
# =========================================

def parse_args(argv):
    mode = 'auto'
    out = None
    src = None
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == '--mode':
            mode = argv[i + 1]; i += 2
        elif a == '--output':
            out = argv[i + 1]; i += 2
        else:
            src = a; i += 1
    return src, mode, out

def main(argv):
    src, mode, out = parse_args(argv)
    if not src or not os.path.exists(src):
        print(json.dumps({'ok': False, 'error': 'input not found'}, ensure_ascii=False))
        return 1
    if out is None:
        base, ext = os.path.splitext(src)
        out = base + '_clean.png'
    try:
        import cv2
        import numpy as np
        img = cv2.imread(src)
        if img is None:
            raise RuntimeError('cannot decode image')
        h, w = img.shape[:2]
        if mode == 'crop':
            region = [int(w * (1 - SCAN_W_RATIO)), int(h * (1 - SCAN_H_RATIO)), int(w * SCAN_W_RATIO), int(h * SCAN_H_RATIO)]
            x, y, cw, ch = region
            cropped = img[y:, :x]
            cv2.imwrite(out, cropped)
            print(json.dumps({'ok': True, 'output': os.path.abspath(out), 'mode': 'crop', 'region': region}, ensure_ascii=False))
            return 0
        # auto：区域灰度差检测 → mask → inpaint
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        x0, y0 = int(w * (1 - SCAN_W_RATIO)), int(h * (1 - SCAN_H_RATIO))
        region_gray = gray[y0:, x0:]
        # 背景亮度用区域外右下角更外围（若存在）或区域均值近似
        bg = float(np.mean(gray[max(0, y0 - 1):y0, x0:]))
        mask = np.where(np.abs(region_gray.astype(int) - bg) > THRESH, 255, 0).astype('uint8')
        # 形态学闭合 + 膨胀，让 logo 区域连续
        k = max(3, int(min(w, h) * DILATE_RATIO) | 1)
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (k, k))
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
        mask = cv2.dilate(mask, kernel)
        if int(mask.sum()) == 0:
            # 检测不到水印像素 → 降级裁剪
            region = [x0, y0, w - x0, h - y0]
            cv2.imwrite(out, img[y0:, :x0])
            print(json.dumps({'ok': True, 'output': os.path.abspath(out), 'mode': 'crop', 'region': region}, ensure_ascii=False))
            return 0
        full_mask = np.zeros((h, w), dtype='uint8')
        full_mask[y0:, x0:] = mask
        result = cv2.inpaint(img, full_mask, 3, cv2.INPAINT_TELEA)
        cv2.imwrite(out, result)
        ys, xs = np.where(full_mask > 0)
        region = [int(xs.min()), int(ys.min()), int(xs.max() - xs.min()), int(ys.max() - ys.min())]
        print(json.dumps({'ok': True, 'output': os.path.abspath(out), 'mode': 'inpaint', 'region': region}, ensure_ascii=False))
        return 0
    except Exception as e:  # noqa: BLE001
        print(json.dumps({'ok': False, 'error': str(e)}, ensure_ascii=False))
        return 1

if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
```

> 说明：`crop` 模式下右下角裁剪 = 保留 `[0:h]` 行、`[0:x0]` 列（裁掉右下角水印块）。

- [ ] **Step 4: 运行确认通过**

Run: `python server/watermark_remove.test.py`
Expected: PASS（3/3）

- [ ] **Step 5: 提交**

```bash
git add server/watermark_remove.py server/watermark_remove.test.py
git commit -m "feat(doubao): 去水印脚本 PIL+OpenCV（区域检测 inpaint，降级 crop）"
```

---

### Task 3: bridge.mjs — /ponos/doubao/* 端点替换 /ponos/img/*

**Files:**
- Modify: `server/bridge.mjs`（顶部 import；1194-1244 行 `/ponos/img/*` 整块替换）
- Delete: `server/hidream.mjs`、`server/hidream.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `doubao.mjs` 全部导出；Task 2 的 `watermark_remove.py` CLI
- Produces（供前端 Task 6/7 消费）：
  - `GET /ponos/doubao/status` → `{loggedIn, exportedAt}`
  - `GET /ponos/doubao/history` → `{items: [...]}`
  - `POST /ponos/doubao/history` body `{id, prompt, imageUrl, createdAt}` → `{ok:true}`（缺 id/prompt → 400）
  - `DELETE /ponos/doubao/history/:id` → `{ok:true}`
  - `POST /ponos/doubao/download` body `{url, mode?}` → 下载 url → 去水印 → 落盘 `doubao-images/<id>.png` → `{ok:true, id, url:'/ponos/doubao/images/<id>'}`；限速 429；下载失败 502
  - `GET /ponos/doubao/images/<id>` → 图片二进制（mime 由扩展名判定）

- [ ] **Step 1: 改 bridge.mjs 顶部 import**

将 `import * as hid from './hidream.mjs'` 替换为：
```js
import * as doubao from './doubao.mjs'
```
并确认 `spawn` 已在 `child_process` import 中（第 1 行已有）。

- [ ] **Step 2: 替换端点块**

用以下内容整体替换 `if (url.pathname.startsWith('/ponos/img/')) { ... }`（1194-1244 行）：
```js
    // 豆包图片生成端点（会话/历史/限速见 doubao.mjs；下载去水印走 watermark_remove.py）
    if (url.pathname.startsWith('/ponos/doubao/')) {
      if (url.pathname === '/ponos/doubao/status') {
        const s = doubao.readSessionMeta()
        return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({ loggedIn: doubao.isLoggedIn(), exportedAt: s?.exportedAt || null }))
      }
      if (url.pathname === '/ponos/doubao/history' && req.method === 'GET') {
        return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({ items: doubao.listHistory() }))
      }
      if (url.pathname === '/ponos/doubao/history' && req.method === 'POST') {
        const b = await readJsonBody(req)
        if (!b.id || !b.prompt) return reply(400, { 'Content-Type': 'application/json' }, JSON.stringify({ code: 400, message: 'id and prompt required' }))
        doubao.addHistory({ id: b.id, prompt: b.prompt, imageUrl: b.imageUrl || '', createdAt: b.createdAt || Date.now() })
        return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: true }))
      }
      if (url.pathname.startsWith('/ponos/doubao/history/') && req.method === 'DELETE') {
        const id = decodeURIComponent(url.pathname.split('/').pop())
        doubao.removeHistory(id)
        return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: true }))
      }
      if (url.pathname === '/ponos/doubao/download' && req.method === 'POST') {
        if (doubao.rateLimitHit()) return reply(429, { 'Content-Type': 'application/json' }, JSON.stringify({ code: 429, message: 'rate limited' }))
        const b = await readJsonBody(req)
        if (!b.url) return reply(400, { 'Content-Type': 'application/json' }, JSON.stringify({ code: 400, message: 'url required' }))
        const { nanoid } = await import('nanoid')
        const id = nanoid(12)
        const dir = doubao.imagesDir()
        mkdirSync(dir, { recursive: true })
        const tmpRaw = join(dir, `${id}.raw`)
        try {
          const r = await fetch(b.url, { signal: AbortSignal.timeout(30000) })
          if (!r.ok) throw new Error(`upstream ${r.status}`)
          writeFileSync(tmpRaw, Buffer.from(await r.arrayBuffer()))
        } catch (e) {
          return reply(502, { 'Content-Type': 'application/json' }, JSON.stringify({ code: 502, message: 'download failed: ' + (e?.message || e) }))
        }
        const outPng = join(dir, `${id}.png`)
        const mode = b.mode === 'crop' ? 'crop' : 'auto'
        const proc = spawn(findPythonExe(), [join(__dirname, 'watermark_remove.py'), tmpRaw, '--mode', mode, '--output', outPng], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 })
        let so = '', se = ''
        proc.stdout.on('data', d => { so += d })
        proc.stderr.on('data', d => { se += d })
        const code = await new Promise(res => proc.on('close', res))
        try { rmSync(tmpRaw, { force: true }) } catch {}
        if (code !== 0) {
          return reply(500, { 'Content-Type': 'application/json' }, JSON.stringify({ code: 500, message: 'watermark remove failed: ' + se.slice(0, 200) }))
        }
        let meta
        try { meta = JSON.parse(so.trim().split(/\r?\n/).pop()) } catch { meta = null }
        if (!meta || !meta.ok) {
          return reply(500, { 'Content-Type': 'application/json' }, JSON.stringify({ code: 500, message: 'watermark remove bad output' }))
        }
        return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: true, id, mode: meta.mode, url: `/ponos/doubao/images/${id}` }))
      }
      if (url.pathname.startsWith('/ponos/doubao/images/') && req.method === 'GET') {
        const id = decodeURIComponent(url.pathname.split('/').pop())
        const fp = join(doubao.imagesDir(), `${id}.png`)
        if (!existsSync(fp)) return reply(404, { 'Content-Type': 'application/json' }, JSON.stringify({ error: 'not found' }))
        return reply(200, { 'Content-Type': 'image/png' }, readFileSync(fp))
      }
      return reply(404, { 'Content-Type': 'application/json' }, JSON.stringify({ error: 'unknown doubao endpoint' }))
    }
```
确认 `findPythonExe`（已在 bridge.mjs 194-199 行附近）、`mkdirSync`/`writeFileSync`/`readFileSync`/`existsSync`/`rmSync`/`join` 均已从 'fs'/'path' import。

- [ ] **Step 3: 删除 hidream 文件并验证无残留 import**

```bash
git rm server/hidream.mjs server/hidream.test.mjs
```
`grep -n "hidream" server/bridge.mjs` → 必须无输出（只剩注释清理干净）。若残留 `hid` 引用，全部改为 `doubao` 或删除。

- [ ] **Step 4: 运行全部 server 测试**

Run: `npm test`
Expected: 原有用例（askuser/experience/packager）+ doubao.test.mjs 全绿

- [ ] **Step 5: 提交**

```bash
git add server/bridge.mjs
git commit -m "feat(doubao): bridge 端点 /ponos/doubao/*（status/history/download+去水印/images）；移除 hidream 端点与模块"
```

---

### Task 4: main.cjs 登录窗口管理 + IPC + preload

**Files:**
- Modify: `electron/main.cjs`（删除 88-92 行 hidream 变量、555-570 行 writeHidreamSession/readHidreamStatus、705-764 行 hidream IPC；新增 doubao 窗口与 IPC）
- Modify: `electron/preload.cjs`（70-75 行 window.hidream → window.doubao）

**Interfaces:**
- Produces（供 Task 5 复用 doubaoWin/ses 状态；供 Task 6/7 前端调用）：
  - `window.doubao.openLogin()` → `{ok:true}`（登录窗口显示；已登录则直接显示隐藏窗口）
  - `window.doubao.getStatus()` → `{loggedIn, exportedAt}`
  - `window.doubao.logout()` → `{ok:true}`（清会话文件 + 分区 cookie + `doubaoLoggedIn=false`）
  - 内部状态：`doubaoWin`（隐藏常驻）、`doubaoLoggedIn`、`DOUBAO_SESSION_FILE`、`writeDoubaoSession(cookies)`、`readDoubaoStatus()`

- [ ] **Step 1: 删除 hidream 主进程代码**

删除：
- 88-92 行：`hidreamWin` / `hidreamLoggedIn` / `HIDREAM_SESSION_FILE` 变量
- 555-570 行：`writeHidreamSession` / `readHidreamStatus` 函数
- 705-764 行：`hidream:open-login` / `hidream:get-status` / `hidream:logout` 三个 handler
`grep -n "hidream" electron/main.cjs` → 无输出

- [ ] **Step 2: 新增 doubao 变量与工具函数**

在文件顶部（原 hidream 变量位置）添加：
```js
// 豆包图片生成：登录窗口隐藏常驻（persist:doubao 分区），生成请求在页面上下文执行
let doubaoWin = null            // 豆包隐藏常驻窗口（登录成功后 hide，补登录时 show）
let doubaoLoggedIn = false      // 登录判定防重入守卫
// 豆包会话文件：契约与 server/doubao.mjs 的 sessionFile() 一致
const DOUBAO_SESSION_FILE = path.join(os.homedir(), '.ponos', 'doubao-session.json')
const DOUBAO_URL = 'https://www.doubao.com/chat/create-image'
```

在原 `writeHidreamSession` 位置添加（删除原函数）：
```js
// 豆包登录会话：写/读 ~/.ponos/doubao-session.json（契约与 server/doubao.mjs 一致）
function writeDoubaoSession(cookies) {
  fs.mkdirSync(path.dirname(DOUBAO_SESSION_FILE), { recursive: true })
  fs.writeFileSync(DOUBAO_SESSION_FILE, JSON.stringify({ exportedAt: Date.now(), cookies }, null, 2), 'utf-8')
  try { fs.chmodSync(DOUBAO_SESSION_FILE, 0o600) } catch {}
}
function readDoubaoStatus() {
  try {
    const s = JSON.parse(fs.readFileSync(DOUBAO_SESSION_FILE, 'utf-8'))
    const loggedIn = Array.isArray(s?.cookies) && s.cookies.some(c => c.name === 'sessionid' && c.value)
    return { loggedIn, exportedAt: typeof s?.exportedAt === 'number' ? s.exportedAt : null }
  } catch { return { loggedIn: false, exportedAt: null } }
}
```

- [ ] **Step 3: 新增 doubao IPC handler**

在原 hidream IPC 位置添加（删除原 hidream handler 后）：
```js
  // ---------------------------------------------------------------------------
  // 豆包图片生成登录：独立登录窗口（persist:doubao 分区持久化 cookie）
  // 登录成功判定：轮询分区 cookie 含 sessionid + 导航事件即时触发 + 关窗兜底
  // 成功后 hide() 隐藏常驻（不销毁）：页面与字节 fetch 签名劫持器保持存活，
  // 生成请求靠 executeJavaScript 在页面上下文执行（Task 5）
  // ---------------------------------------------------------------------------
  const openDoubaoLogin = async () => {
    if (doubaoWin && !doubaoWin.isDestroyed()) { doubaoWin.show(); doubaoWin.focus(); return { ok: true } }
    const ses = session.fromPartition('persist:doubao')
    doubaoWin = new BrowserWindow({
      width: 1100,
      height: 780,
      title: '豆包登录',
      parent: mainWindow || undefined,
      modal: true,
      show: false,
      webPreferences: { partition: 'persist:doubao', contextIsolation: true, backgroundThrottling: false },
    })
    let poll = null
    let pollTimer = null
    const stopPoll = () => { if (poll) clearInterval(poll); if (pollTimer) clearTimeout(pollTimer); poll = null; pollTimer = null }
    const trySave = async () => {
      if (doubaoLoggedIn || !doubaoWin || doubaoWin.isDestroyed()) return   // 防重入
      try {
        // cookies.get 的 url 需与 cookie 域名匹配：豆包 sessionid 落在 www.doubao.com
        const cookies = await ses.cookies.get({ url: DOUBAO_URL })
        if (cookies.some(c => c.name === 'sessionid')) {
          writeDoubaoSession(cookies.map(c => ({ name: c.name, value: c.value, domain: c.domain, path: c.path })))
          doubaoLoggedIn = true
          stopPoll()
          const win = doubaoWin
          setTimeout(() => {
            // 隐藏而非关闭：保持页面与签名劫持器存活
            if (win && !win.isDestroyed() && doubaoWin === win) win.hide()
          }, 800)
        }
      } catch (err) {
        console.warn('[main] doubao session check failed:', err?.message || err)
      }
    }
    doubaoWin.on('close', () => { trySave() })   // 关窗时最终确认一次
    doubaoWin.on('closed', () => { doubaoWin = null; doubaoLoggedIn = false; stopPoll() })
    doubaoWin.webContents.on('did-navigate', () => { trySave() })
    doubaoWin.webContents.on('did-navigate-in-page', () => { trySave() })
    poll = setInterval(trySave, 2000)
    pollTimer = setTimeout(stopPoll, 300000)   // 5 分钟轮询窗口
    doubaoWin.once('ready-to-show', () => { if (doubaoWin && !doubaoWin.isDestroyed()) doubaoWin.show() })
    await doubaoWin.loadURL(DOUBAO_URL).catch(err => {
      console.warn('[main] doubao loadURL failed:', err?.message || err)
      throw err
    })
    return { ok: true }   // 不等关闭：登录成功后窗口隐藏常驻，函数立即返回
  }
  ipcMain.handle('doubao:open-login', () => openDoubaoLogin())

  ipcMain.handle('doubao:get-status', () => readDoubaoStatus())

  ipcMain.handle('doubao:logout', async () => {
    doubaoLoggedIn = false   // 重置守卫：登出后重新登录需能再次触发成功判定
    try { fs.rmSync(DOUBAO_SESSION_FILE, { force: true }) } catch {}
    try { await session.fromPartition('persist:doubao').clearStorageData({ storages: ['cookies'] }) } catch {}
    return { ok: true }
  })
```

- [ ] **Step 4: preload.cjs 替换**

将 70-75 行替换为：
```js
// 豆包图片生成（main 侧 doubao:* ipcMain.handle 配对；生成请求需经主进程页面上下文）
contextBridge.exposeInMainWorld('doubao', {
  openLogin: () => ipcRenderer.invoke('doubao:open-login'),
  getStatus: () => ipcRenderer.invoke('doubao:get-status'),
  logout: () => ipcRenderer.invoke('doubao:logout'),
  generate: (payload) => ipcRenderer.invoke('doubao:generate', payload),
  instant: (payload) => ipcRenderer.invoke('doubao:instant', payload),
})
```
> 注意：`generate`/`instant` 的 handler 在 Task 5 才注册——若 Task 5 未完成时调用会 reject，前端需 try/catch（Task 7 实现时处理）。

- [ ] **Step 5: 语法检查**

Run: `node --check electron/main.cjs && node --check electron/preload.cjs`
Expected: 无输出（通过）

- [ ] **Step 6: 提交**

```bash
git add electron/main.cjs electron/preload.cjs
git commit -m "feat(doubao): 登录窗口隐藏常驻 + doubao:* IPC（open-login/get-status/logout）+ preload 暴露"
```

---

### Task 5: main.cjs 生成执行器 + 页面脚本

**Files:**
- Create: `electron/doubao-page-script.js`（导出 `buildGenerateScript(payload)`，返回 executeJavaScript 注入的完整脚本字符串）
- Modify: `electron/main.cjs`（新增 `doubao:generate` / `doubao:instant` handler）

**Interfaces:**
- Consumes: Task 4 的 `doubaoWin` / `doubaoLoggedIn` 状态
- Produces（供 Task 6/7 前端调用）：
  - `window.doubao.generate({prompt, ratio?, count?})` → `{code:0, data:{images: string[]}}` 或 `{code:401, message}`（未登录/会话失效）或 `{code:-1, message}`
  - `window.doubao.instant({prompt, imageBase64})` → 同 generate
  - `window.doubao.capture()`（调试用，P0 校准）→ `{code:0, captured:{url, options, body}}` 或 `{code:404, message:'no capture yet'}`

**关键背景**（doubao2api 洞见）：豆包前端 JS 劫持 `window.fetch` 自动注入 `a_bogus`/`msToken` 签名。前提是**页面在登录态下加载**（Task 4 登录流程保证：分区 cookie 先写入再导航，隐藏窗口保持页面存活）。payload 精确结构以 P0 实测（Task 9）校准，本任务提供基线实现 + 捕获模式。

- [ ] **Step 1: 实现 `electron/doubao-page-script.js`**

```js
// 豆包页面上下文执行脚本构造器（webContents.executeJavaScript 注入）。
// 页面内 window.fetch 已被豆包 JS 劫持 → 自动注入 a_bogus/msToken 签名。
// 基线 payload 基于 doubao-free-api/doubao2api 公开逆向信息；P0 用 capture 校准。

// 注入脚本：挂捕获钩子到 window（首次调用时包装 fetch，记录下一个 /api/ 请求）
const CAPTURE_HOOK = `(() => {
  if (window.__DOUBAO_CAPTURE_HOOKED__) return 'already'
  const orig = window.fetch
  window.fetch = async (...args) => {
    const r = await orig(...args)
    try {
      if (String(args[0]).includes('/api/')) {
        const body = await r.clone().text()
        window.__DOUBAO_CAPTURED__ = { url: String(args[0]), options: args[1], body: body.slice(0, 3000) }
      }
    } catch {}
    return r
  }
  window.__DOUBAO_CAPTURE_HOOKED__ = true
  return 'hooked'
})()`

// 生成脚本：主动 POST /api/image/generate 并收集 SSE
export function buildGenerateScript(payload) {
  return `(async () => {
    const payload = ${JSON.stringify(payload)}
    const body = {
      bot_id: '7338286299411103781',   // 默认 bot（P0 校准）
      messages: [{
        role: 'user',
        content: [
          ...(payload.imageFileId ? [{ image_file_ids: [payload.imageFileId] }] : []),
          { text: payload.prompt },
        ],
      }],
      client_meta: { from: 'doubao_web' },
      option: { need_create_conversation: true, local_conversation_id: 'conv_' + Date.now() },
      ext: {},
    }
    const res = await fetch('/api/image/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      return { code: res.status === 401 ? 401 : -1, message: 'http ' + res.status + ' ' + t.slice(0, 200) }
    }
    // SSE 收集：解析 data 行 JSON，收集 block_type=2074 图片 url，遇 SSE_REPLY_END 结束
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    const images = []
    let replyEnd = false
    while (!replyEnd) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let idx
      while ((idx = buf.indexOf('\\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line.startsWith('data:')) continue
        let ev
        try { ev = JSON.parse(line.slice(5).trim()) } catch { continue }
        const evType = ev.type || ev.event || ''
        if (evType === 'SSE_REPLY_END') { replyEnd = true; break }
        const blocks = ev.content_block || (ev.data && ev.data.content_block) || (ev.data && Array.isArray(ev.data) ? ev.data : null)
        if (blocks) {
          const arr = Array.isArray(blocks) ? blocks : [blocks]
          for (const b of arr) {
            if (b && b.block_type === 2074) {
              const u = b.content && (b.content.image_url || b.content.url || b.content.image)
              if (u && !images.includes(u)) images.push(u)
            }
          }
        }
      }
    }
    if (images.length === 0) return { code: -1, message: 'no image in response' }
    return { code: 0, data: { images } }
  })()`
}

// 捕获脚本：返回最近一次被记录的 /api/ 请求
export function buildCaptureScript() {
  return `(() => {
    if (!window.__DOUBAO_CAPTURED__) return { code: 404, message: 'no capture yet' }
    return { code: 0, captured: window.__DOUBAO_CAPTURED__ }
  })()`
}

export { CAPTURE_HOOK }
```

- [ ] **Step 2: main.cjs 新增生成 handler**

在 `doubao:logout` handler 之后添加：
```js
  const { buildGenerateScript, buildCaptureScript, CAPTURE_HOOK } = await import('./doubao-page-script.js')

  const assertDoubaoWindow = () => {
    if (!doubaoWin || doubaoWin.isDestroyed() || !doubaoLoggedIn) {
      return { code: 401, message: 'not logged in' }
    }
    return null
  }
  const runPageScript = async (script, timeoutMs = 90000) => {
    const win = doubaoWin
    const timer = setTimeout(() => { try { win.webContents.executeJavaScript('null').catch(() => {}) } catch {} }, timeoutMs)
    try {
      // executeJavaScript 支持返回 Promise；超时无法取消注入，用竞速兜底
      return await Promise.race([
        win.webContents.executeJavaScript(script),
        new Promise(res => setTimeout(() => res({ code: -1, message: 'generate timeout' }), timeoutMs)),
      ])
    } finally { clearTimeout(timer) }
  }

  ipcMain.handle('doubao:generate', async (_e, payload) => {
    const bad = assertDoubaoWindow()
    if (bad) return bad
    try {
      // 确保捕获钩子已挂（挂载后页面内所有 /api/ 请求均会被记录，供 P0 校准）
      await doubaoWin.webContents.executeJavaScript(CAPTURE_HOOK).catch(() => null)
      const result = await runPageScript(buildGenerateScript({ prompt: String(payload?.prompt || ''), ratio: payload?.ratio, imageFileId: payload?.imageFileId }))
      if (result && result.code === 401) doubaoLoggedIn = false
      return result
    } catch (err) {
      return { code: -1, message: err?.message || String(err) }
    }
  })

  ipcMain.handle('doubao:instant', async (_e, payload) => {
    const bad = assertDoubaoWindow()
    if (bad) return bad
    try {
      // 图生图：imageBase64 → 页面上下文原生 FormData/File 上传（fetch 劫持器同样注入签名）
      const b64 = String(payload?.imageBase64 || '')
      if (!b64) return { code: -1, message: 'imageBase64 required' }
      // 设计决定（范围控制）：上传链路（prepare_upload → TOS multipart → file_id）
      // 的真实字段依赖 P0 实测捕获（CAPTURE_HOOK 会记录页面内真实 upload 请求）。
      // 首版 instant 返回明确错误而非伪造结果，Task 9 校准后补全完整实现；
      // generate（文生图）已是完整链路。
      return { code: -1, message: '图生图上传链路待 P0 校准（CAPTURE_HOOK 捕获真实 upload 请求后补全）' }
    } catch (err) {
      return { code: -1, message: err?.message || String(err) }
    }
  })

  ipcMain.handle('doubao:capture', async () => {
    const bad = assertDoubaoWindow()
    if (bad) return bad
    return doubaoWin.webContents.executeJavaScript(buildCaptureScript()).catch(() => ({ code: -1, message: 'capture failed' }))
  })
```
> 上述 instant 首版为占位（P0 校准后补全），**generate 是完整链路**。确保删除上述脚本中 `buildGenerateScript.__proto__` 占位行（该行仅为说明，实际代码不包含）。

- [ ] **Step 3: 语法检查**

Run: `node --check electron/main.cjs && node --check electron/doubao-page-script.js`
Expected: 通过

- [ ] **Step 4: 提交**

```bash
git add electron/main.cjs electron/doubao-page-script.js
git commit -m "feat(doubao): 页面上下文生成执行器（fetch 签名注入 + SSE 解析 + 捕获钩子）"
```

---

### Task 6: 前端类型 + doubaoStore

**Files:**
- Modify: `src/types/index.ts`（448-476 行 hidream 类型与 Window.hidream → doubao 类型与 Window.doubao）
- Create: `src/stores/doubaoStore.ts`
- Delete: `src/stores/hidreamStore.ts`

**Interfaces:**
- Consumes: Task 4/5 的 `window.doubao` IPC（openLogin/getStatus/logout/generate/instant）；bridge `/ponos/doubao/*` HTTP
- Produces（供 Task 7 面板消费）：
  - `useDoubaoStore` state: `{ status, generating, results, history, busy, error }`
  - actions: `refreshStatus()`, `generate(p: {prompt, imageBase64?, ratio?, count?})`, `loadHistory()`, `removeHistory(id)`, `insertImage(att)`
  - 生成成功后：对每张图调 bridge `POST /ponos/doubao/download` 去水印 → 得本地 id/url → 写入 results（`imageUrl = bridgeUrl + '/ponos/doubao/images/' + id`）并 POST history

- [ ] **Step 1: 改 `src/types/index.ts`**

将 448-476 行附近（Window 接口 hidream 字段 + HidreamStatus/HidreamResult/HidreamHistoryItem）替换为：
```ts
export interface DoubaoStatus {
  loggedIn: boolean
  exportedAt: number | null
}
export interface DoubaoResult {
  id: string
  prompt: string
  imageUrl: string      // 本地去水印图（bridge /ponos/doubao/images/<id>）
  createdAt: number
}
export interface DoubaoHistoryItem extends DoubaoResult {}
```
Window 接口中 `hidream?: {...}` 替换为：
```ts
    doubao?: {
      openLogin: () => Promise<{ ok: boolean }>
      getStatus: () => Promise<DoubaoStatus>
      logout: () => Promise<{ ok: boolean }>
      generate: (payload: { prompt: string; ratio?: string; count?: number }) => Promise<{ code: number; data?: { images: string[] }; message?: string }>
      instant: (payload: { prompt: string; imageBase64: string }) => Promise<{ code: number; data?: { images: string[] }; message?: string }>
      capture?: () => Promise<{ code: number; captured?: unknown; message?: string }>
    }
```

- [ ] **Step 2: 实现 `src/stores/doubaoStore.ts`**

```ts
import { create } from 'zustand'
import { nanoid } from 'nanoid'
import { getBridgeUrl } from '@/lib/config'
import type { DoubaoStatus, DoubaoResult } from '@/types'

interface State {
  status: DoubaoStatus | null
  generating: boolean
  results: DoubaoResult[]
  history: DoubaoResult[]
  busy: boolean
  error: string | null
  refreshStatus: () => Promise<void>
  generate: (p: { prompt: string; imageBase64?: string; ratio?: string; count?: number }) => Promise<void>
  loadHistory: () => Promise<void>
  removeHistory: (id: string) => Promise<void>
  insertImage: (att: { name: string; path: string; preview?: string }) => void
}

const bridge = () => getBridgeUrl()

export const useDoubaoStore = create<State>((set, get) => ({
  status: null, generating: false, results: [], history: [], busy: false, error: null,

  refreshStatus: async () => {
    try {
      const s = await window.doubao?.getStatus?.()
      set({ status: s || { loggedIn: false, exportedAt: null } })
    } catch { set({ status: { loggedIn: false, exportedAt: null } }) }
  },

  generate: async (p) => {
    set({ generating: true, busy: true })
    try {
      const payload = { prompt: p.prompt, ratio: p.ratio, count: p.count || 1 }
      let resp
      if (p.imageBase64) {
        resp = await window.doubao?.instant?.({ prompt: p.prompt, imageBase64: p.imageBase64 })
      } else {
        resp = await window.doubao?.generate?.(payload)
      }
      if (!resp) { set({ error: 'IPC 不可用' }); return }
      if (resp.code === 401) { set({ status: { loggedIn: false, exportedAt: null }, error: null }); return }
      if (resp.code !== 0) { set({ error: resp.message || '生成失败' }); return }
      const urls: string[] = resp.data?.images || []
      const items: DoubaoResult[] = []
      for (const u of urls) {
        // 去水印下载：经 bridge 处理并落盘，返回本地 id
        let id: string | null = null
        try {
          const r = await fetch(`${bridge()}/ponos/doubao/download`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: u }),
          })
          const d = await r.json()
          if (d.ok) id = d.id
        } catch { id = null }
        if (id) {
          items.push({ id, prompt: p.prompt, imageUrl: `${bridge()}/ponos/doubao/images/${id}`, createdAt: Date.now() })
        }
      }
      set({ error: null, results: items })
      for (const it of items) {
        await fetch(`${bridge()}/ponos/doubao/history`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(it),
        }).catch(() => {})
      }
    } finally { set({ generating: false, busy: false }) }
  },

  loadHistory: async () => {
    try { const r = await fetch(`${bridge()}/ponos/doubao/history`); const d = await r.json(); set({ history: d.items || [] }) } catch {}
  },

  removeHistory: async (id) => {
    await fetch(`${bridge()}/ponos/doubao/history/${encodeURIComponent(id)}`, { method: 'DELETE' })
    set({ history: get().history.filter(h => h.id !== id) })
  },

  insertImage: (att) => { /* 由 ChatInput 注入回调：见 Task 7 */ },
}))
```

- [ ] **Step 3: 删除 hidreamStore**

```bash
git rm src/stores/hidreamStore.ts
```

- [ ] **Step 4: 类型检查**

Run: `npm run typecheck`
Expected: 若 ChatInput 仍引用 HiDreamPanel/hidreamStore 会报错——属预期（Task 7 修复）；**本任务仅确认 doubaoStore 自身无类型错误**（可临时注释 ChatInput 引用或接受预期错误列表）。

- [ ] **Step 5: 提交**

```bash
git add src/types/index.ts src/stores/doubaoStore.ts
git commit -m "feat(doubao): 前端 store 与类型（IPC 生成 + bridge 去水印下载 + 历史）"
```

---

### Task 7: 前端面板 + ChatInput + i18n

**Files:**
- Create: `src/components/doubao/DoubaoPanel.tsx`
- Delete: `src/components/hidream/HiDreamPanel.tsx`（及空目录）
- Modify: `src/components/chat/ChatInput.tsx`（HiDreamPanel import → DoubaoPanel）
- Modify: `src/i18n/translations/zh-CN.ts`、`src/i18n/translations/en-US.ts`（hidream 键组 → doubao 键组）

**Interfaces:**
- Consumes: Task 6 的 `useDoubaoStore`；`window.doubao.openLogin`
- Produces: `DoubaoPanel({ onInsertImage })` 组件；ChatInput 的 Sparkles 按钮内嵌该面板

- [ ] **Step 1: i18n 键组替换**

zh-CN.ts：删除 `hidream: {...}` 键组，新增：
```ts
  doubao: {
    login: '登录豆包',
    notice: '登录一次后窗口自动隐藏，无需重复登录',
    loggedIn: '已登录豆包',
    logout: '退出登录',
    prompt: '描述你想生成的图片…',
    ratio: '比例',
    img2img: '参考图',
    uploadRef: '移除参考图',
    generating: '生成中…',
    generate: '生成图片',
    insert: '插入对话',
    download: '下载',
    history: '历史记录',
    loginRequired: '请先登录豆包',
  },
```
en-US.ts：对应英文：
```ts
  doubao: {
    login: 'Login Doubao',
    notice: 'Window auto-hides after login; no repeated login needed',
    loggedIn: 'Logged in',
    logout: 'Log out',
    prompt: 'Describe the image you want…',
    ratio: 'Ratio',
    img2img: 'Ref image',
    uploadRef: 'Remove ref',
    generating: 'Generating…',
    generate: 'Generate',
    insert: 'Insert',
    download: 'Download',
    history: 'History',
    loginRequired: 'Please log in first',
  },
```
用 `grep -n "hidream" src/i18n/translations/*.ts` 确认清零。

- [ ] **Step 2: 实现 `src/components/doubao/DoubaoPanel.tsx`**

```tsx
import { useEffect, useRef, useState } from 'react'
import { Wand2, LogIn, LogOut, Download, ImagePlus, Sparkles, X } from 'lucide-react'
import { useDoubaoStore } from '@/stores/doubaoStore'
import { useTranslation } from '@/i18n/useTranslation'
import { Button } from '@/components/ui/button'

export function DoubaoPanel({ onInsertImage }: { onInsertImage?: (att: { name: string; path: string; preview?: string }) => void }) {
  const { t } = useTranslation()
  const { status, generating, results, history, error, refreshStatus, generate, loadHistory, removeHistory } = useDoubaoStore()
  const [prompt, setPrompt] = useState('')
  const [ratio, setRatio] = useState('1:1')
  const [count, setCount] = useState(1)
  const [refImage, setRefImage] = useState<string | undefined>()
  const [refBase64, setRefBase64] = useState<string | undefined>()
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { refreshStatus(); loadHistory() }, [])
  useEffect(() => {
    return () => { if (refImage && refImage.startsWith('blob:')) URL.revokeObjectURL(refImage) }
  }, [refImage])

  const doGenerate = async () => {
    if (!prompt.trim()) return
    await generate({ prompt, ratio, count, imageBase64: refBase64 })
  }

  // 参考图：本地文件 → objectURL 预览 + base64 上传（FileReader）
  const handleRefPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    setRefImage(URL.createObjectURL(f))
    const fr = new FileReader()
    fr.onload = () => { setRefBase64(String(fr.result).split(',')[1]) }
    fr.readAsDataURL(f)
    e.target.value = ''
  }

  return (
    <div className="w-[360px] p-3 space-y-3">
      {!status?.loggedIn ? (
        <div className="space-y-2">
          <p className="text-sm text-secondary">{t('doubao.loginRequired')}</p>
          <Button variant="primary" size="sm" onClick={async () => { await window.doubao?.openLogin(); refreshStatus() }}>
            <LogIn className="w-3.5 h-3.5 mr-1" /> {t('doubao.login')}
          </Button>
          <p className="text-xs text-tertiary">{t('doubao.notice')}</p>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between text-xs">
            <span className="text-secondary">{t('doubao.loggedIn')}</span>
            <Button variant="ghost" size="xs" onClick={() => window.doubao?.logout().then(refreshStatus)}>
              <LogOut className="w-3 h-3 mr-1" /> {t('doubao.logout')}
            </Button>
          </div>
          <textarea
            className="w-full h-20 bg-input rounded-lg p-2 text-sm resize-none outline-none"
            placeholder={t('doubao.prompt')} value={prompt} onChange={e => setPrompt(e.target.value)}
          />
          <div className="flex gap-2 text-xs">
            <select value={ratio} onChange={e => setRatio(e.target.value)} className="bg-input rounded px-1">
              <option value="1:1">1:1</option><option value="16:9">16:9</option><option value="9:16">9:16</option><option value="4:3">4:3</option><option value="3:4">3:4</option>
            </select>
            <select value={count} onChange={e => setCount(Number(e.target.value))} className="bg-input rounded px-1">
              {[1, 2, 4].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
          <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleRefPick} />
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="xs" onClick={() => fileInputRef.current?.click()}>
              <ImagePlus className="w-3.5 h-3.5 mr-1" /> {t('doubao.img2img')}
            </Button>
            {refImage && (
              <div className="relative">
                <img src={refImage} alt="ref" className="w-10 h-10 rounded object-cover border border-border" />
                <button
                  className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-black/60 text-white flex items-center justify-center"
                  onClick={() => { setRefImage(undefined); setRefBase64(undefined) }} title={t('doubao.uploadRef')}
                >
                  <X className="w-2.5 h-2.5" />
                </button>
              </div>
            )}
          </div>
          <Button variant="primary" size="sm" className="w-full" disabled={generating || !prompt.trim()} onClick={doGenerate}>
            <Sparkles className="w-3.5 h-3.5 mr-1" /> {generating ? t('doubao.generating') : t('doubao.generate')}
          </Button>
          {error && <p className="text-xs text-error">{error}</p>}
          {results.length > 0 && (
            <div className="grid grid-cols-2 gap-2">
              {results.map(r => (
                <div key={r.id} className="relative group rounded-lg overflow-hidden border border-border">
                  <img src={r.imageUrl} alt={r.prompt} className="w-full h-24 object-cover" />
                  <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center gap-1">
                    <button onClick={() => onInsertImage?.({ name: r.prompt.slice(0, 20) + '.png', path: r.imageUrl, preview: r.imageUrl })} title={t('doubao.insert')}>
                      <Wand2 className="w-4 h-4 text-white" />
                    </button>
                    <a href={r.imageUrl} download title={t('doubao.download')}>
                      <Download className="w-4 h-4 text-white" />
                    </a>
                  </div>
                </div>
              ))}
            </div>
          )}
          {history.length > 0 && (
            <details className="text-xs">
              <summary className="text-secondary cursor-pointer">{t('doubao.history')}</summary>
              <ul className="mt-1 space-y-1 text-tertiary">
                {history.slice(0, 10).map(h => (
                  <li key={h.id} className="flex justify-between">
                    <span className="truncate">{h.prompt}</span>
                    <button onClick={() => removeHistory(h.id)}>×</button>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  )
}
```

- [ ] **Step 3: ChatInput.tsx 接入**

找到引用 `HiDreamPanel` 与 `useHidreamStore` / `hidreamStore` 的位置，替换为 `DoubaoPanel` / `useDoubaoStore`；Popover 内嵌组件与 `onInsertImage` 回调签名保持不变（`{name, path, preview}`）。
`grep -n "hidream\|HiDream" src/` 确认前端其余引用清零（Task 8 再全仓复核）。

- [ ] **Step 4: 删除 HiDreamPanel**

```bash
git rm src/components/hidream/HiDreamPanel.tsx
```

- [ ] **Step 5: 类型检查 + 构建**

Run: `npm run typecheck && npm run build`
Expected: 全绿（无 hidream 残留引用错误）

- [ ] **Step 6: 提交**

```bash
git add src/components/doubao/DoubaoPanel.tsx src/components/chat/ChatInput.tsx src/i18n/translations/zh-CN.ts src/i18n/translations/en-US.ts
git commit -m "feat(doubao): 面板组件 + ChatInput 接入 + i18n（移除 hidream 前端）"
```

---

### Task 8: 全仓回归与清理验证

**Files:** 全仓（可能触及遗漏引用）

- [ ] **Step 1: hidream 残留扫描**

Run: `grep -rni "hidream" src/ electron/ server/ docs/superpowers/specs/2026-08-17-doubao-image-gen-design.md 2>/dev/null`
Expected: 仅 spec 背景描述提及 hidream（属正常历史说明），代码中零残留。若 `src/types/index.ts`、`src/i18n`、`server/bridge.mjs`、`electron/main.cjs`、`electron/preload.cjs` 有残留，逐一删除。

- [ ] **Step 2: 全量测试 + 类型 + 构建**

Run: `npm test && npm run typecheck && npm run build`
Expected: 全部通过；`npm test` 输出不含 hidream 测试文件。

- [ ] **Step 3: 检查未跟踪/残留文件**

Run: `git status`
Expected: 无 `server/hidream*`、`src/components/hidream/`、`src/stores/hidreamStore.ts` 等残留。

- [ ] **Step 4: 提交（如有清理）**

```bash
git add -u && git commit -m "chore(doubao): 全仓 hidream 残留清零与回归"
```
若无变更则跳过。

---

### Task 9: release 同步 + P0 手测与校准

**Files:**
- 同步到 `C:\Users\T203-15\claude-code-gui\release\Ponos_ms92cd6u\`：`server/doubao.mjs`、`server/watermark_remove.py`、`server/bridge.mjs`、`electron/main.cjs`、`electron/preload.cjs`、`electron/doubao-page-script.js`、`dist/`（build 产物）
- 删除副本中 `server/hidream.mjs` / `server/hidream.test.mjs`

**说明：本任务需要用户配合（重启应用 + 真实登录），且包含两项 P0 校准（payload 捕获 + 水印参数）。执行方式以用户在场手测为主，implementer 子代理负责同步与脚本准备。**

- [ ] **Step 1: 同步 release 副本**

```bash
cd release/Ponos_ms92cd6u
cp ../../server/doubao.mjs ../../server/watermark_remove.py ../../server/bridge.mjs server/
cp ../../electron/main.cjs ../../electron/preload.cjs ../../electron/doubao-page-script.js electron/
rm -f server/hidream.mjs server/hidream.test.mjs
cp -r ../../dist/* dist/ 2>/dev/null || true
diff ../../server/bridge.mjs server/bridge.mjs && echo BRIDGE_OK
diff ../../electron/main.cjs electron/main.cjs && echo MAIN_OK
```

- [ ] **Step 2: 准备校准脚本**（供 P0 手测时在登录后的豆包页面操作）

创建 `docs/superpowers/plans/2026-08-17-doubao-capture-guide.md`，内容要点：
- 用户重启应用 → 点 AI 绘图按钮 → 登录豆包（扫码）→ 窗口自动隐藏
- 在豆包页面手动生成一张图（暴露页面上下文真实请求）
- 主进程控制台执行 `doubao:capture`（或 CDP 9223 调 `window.__DOUBAO_CAPTURED__`）拿真实 payload → 校准 `electron/doubao-page-script.js` 的 body 结构（bot_id/messages/option/ext）
- 用真实生成图校准 `server/watermark_remove.py` 顶部参数（SCAN_W_RATIO/SCAN_H_RATIO/THRESH）
- 若 generate 链路返回非 0，记录错误消息用于修复

- [ ] **Step 3: 手测清单执行**（用户在场）

- [ ] 重启后 Sparkles 按钮 → 面板显示"登录豆包"
- [ ] 登录窗口打开 → 扫码 → 自动隐藏 → 面板显示已登录
- [ ] 文生图成功 → 图片去水印显示 → 可插入聊天
- [ ] 图生图（参考图）走通或记录错误（待校准）
- [ ] 下载按钮可用
- [ ] 重启应用 → 免登录
- [ ] 退出登录 → 需重新登录
- [ ] 生成失败/超时错误提示合理

- [ ] **Step 4: 校准落地**

根据 Step 2/3 结果修改 `electron/doubao-page-script.js`（payload 结构）与 `server/watermark_remove.py`（水印参数），回归 `npm test && npm run typecheck && npm run build`，重新同步 release 并提交。

```bash
git add electron/doubao-page-script.js server/watermark_remove.py docs/superpowers/plans/2026-08-17-doubao-capture-guide.md
git commit -m "fix(doubao): P0 实测校准（真实 payload 与去水印参数）"
```
