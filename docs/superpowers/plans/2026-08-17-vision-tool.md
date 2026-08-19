# VisionTool 视觉识别工具实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在内核集成 VisionTool（模态转换桥），非多模态模型运行时把图片/PDF 转成文字描述，并自动桥接对话中的图片。

**Architecture:** 方案 A——VisionTool 内核工具（TS 壳）+ `vision_prepare.py` 预处理（fitz/PIL）+ `visionClient.ts` Node 侧 API 客户端（复用 provider 的 baseUrl/authToken/visionModel）+ 桥接钩子（`attachments.ts` 组装处，image block 转文本描述块）。

**Tech Stack:** TypeScript（内核 vitest）、Python 3（stdlib unittest + PyMuPDF/PIL）、server/bridge.mjs（node --test）、React（SettingsView）。

## Global Constraints

- 密钥零新增：视觉调用复用 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`，仅新增 `YFW_VISION_MODEL` 环境变量
- `vision_prepare.py` 禁止包含任何密钥/网络逻辑（仅图像预处理）
- VisionTool 声明 `isReadOnly: true`，权限模型对齐 OcrTool
- 视觉 API 请求为 Anthropic 消息格式（`POST {baseUrl}/v1/messages`，image block + text），60s 超时，`max_tokens: 1024`
- 缓存目录 `.trae/vision_cache/{project}/{key}.json`，key = md5(fileMd5 + instruction + model)
- PDF 渲染默认上限 10 页，超出截断并置 `truncated: true`；图片等比缩放到最长边 ≤ 2048px
- 桥接失败不得吞用户内容：替换为 `[图片描述失败: 原因]` 文本块
- 前端无单测框架，用 `npm run typecheck`（tsc --noEmit）兜底

---

### Task 1: vision_prepare.py 预处理脚本

**Files:**
- Create: `runtime/skills/_common/vision_prepare.py`
- Create: `runtime/skills/_common/test_vision_prepare.py`

**Interfaces:**
- Produces: CLI `python vision_prepare.py prepare --file <path> --output <json> [--max-pages 10]`，输出 JSON `{"md5": str, "pages": [{"page": int, "png": str, "width": int, "height": int}], "truncated": bool}`；PNG 写入临时目录（python 退出后由调用方清理）

- [ ] **Step 1: 写失败测试**（`test_vision_prepare.py`，stdlib unittest，仿照 `.agents/skills/ui-ux-pro-max/scripts/tests/test_core.py` 的"stdlib-only"惯例）

```python
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Stdlib-only regression tests for vision_prepare.py (unittest).

Run with:
    python runtime/skills/_common/test_vision_prepare.py
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import vision_prepare as vp


def _make_image(path, mode='RGB', size=(400, 300), color=(200, 60, 60)):
    from PIL import Image
    Image.new(mode, size, color).save(path)
    return path


class PrepareImageTest(unittest.TestCase):
    def test_jpg_normalized_to_png(self):
        with tempfile.TemporaryDirectory() as td:
            src = _make_image(str(Path(td) / 'a.jpg'))
            out_dir = Path(td) / 'out'
            out_dir.mkdir()
            pages = vp.prepare_image(src, out_dir)
            self.assertEqual(len(pages), 1)
            self.assertEqual(pages[0]['page'], 1)
            self.assertTrue(pages[0]['png'].endswith('.png'))
            self.assertEqual(pages[0]['width'], 400)
            self.assertEqual(pages[0]['height'], 300)

    def test_rgba_converted_to_rgb(self):
        with tempfile.TemporaryDirectory() as td:
            src = _make_image(str(Path(td) / 'a.png'), mode='RGBA')
            out_dir = Path(td) / 'out'
            out_dir.mkdir()
            pages = vp.prepare_image(src, out_dir)
            from PIL import Image
            with Image.open(pages[0]['png']) as im:
                self.assertEqual(im.mode, 'RGB')

    def test_oversized_downscaled_to_2048(self):
        with tempfile.TemporaryDirectory() as td:
            src = _make_image(str(Path(td) / 'big.jpg'), size=(4096, 2048))
            out_dir = Path(td) / 'out'
            out_dir.mkdir()
            pages = vp.prepare_image(src, out_dir)
            self.assertEqual(pages[0]['width'], 2048)
            self.assertEqual(pages[0]['height'], 1024)


class PreparePdfTest(unittest.TestCase):
    def _make_pdf(self, path, pages=3):
        import fitz
        doc = fitz.open()
        for _ in range(pages):
            doc.new_page(width=400, height=300)
        doc.save(path)
        doc.close()
        return path

    def test_multipage_rendered(self):
        with tempfile.TemporaryDirectory() as td:
            pdf = self._make_pdf(str(Path(td) / 'p.pdf'))
            out_dir = Path(td) / 'out'
            out_dir.mkdir()
            pages, truncated = vp.prepare_pdf(pdf, out_dir, max_pages=10)
            self.assertEqual(len(pages), 3)
            self.assertFalse(truncated)
            self.assertEqual([p['page'] for p in pages], [1, 2, 3])

    def test_max_pages_truncated(self):
        with tempfile.TemporaryDirectory() as td:
            pdf = self._make_pdf(str(Path(td) / 'p.pdf'), pages=12)
            out_dir = Path(td) / 'out'
            out_dir.mkdir()
            pages, truncated = vp.prepare_pdf(pdf, out_dir, max_pages=10)
            self.assertEqual(len(pages), 10)
            self.assertTrue(truncated)

    def test_corrupt_pdf_raises(self):
        with tempfile.TemporaryDirectory() as td:
            bad = Path(td) / 'bad.pdf'
            bad.write_bytes(b'not a pdf')
            with self.assertRaises(Exception):
                vp.prepare_pdf(str(bad), Path(td), max_pages=10)


class CliTest(unittest.TestCase):
    def test_cli_output_json(self):
        with tempfile.TemporaryDirectory() as td:
            src = _make_image(str(Path(td) / 'a.png'))
            out = Path(td) / 'out.json'
            rc = vp.main(['prepare', '--file', src, '--output', str(out)])
            self.assertEqual(rc, 0)
            data = json.loads(out.read_text('utf-8'))
            self.assertIn('md5', data)
            self.assertEqual(len(data['pages']), 1)
            self.assertIn('truncated', data)
            self.assertEqual(len(data['md5']), 32)


if __name__ == '__main__':
    unittest.main()
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python runtime/skills/_common/test_vision_prepare.py`
Expected: FAIL with `ModuleNotFoundError: No module named 'vision_prepare'`

- [ ] **Step 3: 实现 `vision_prepare.py`**

```python
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
vision_prepare.py - 视觉识别预处理引擎

将图片/PDF 归一化为 PNG 页面序列（视觉模型 API 只收 jpg/png/webp）：
  - PDF：用 PyMuPDF(fitz) 逐页渲染 PNG（默认上限 10 页，超出截断并标记）
  - 图片：PIL 转 RGB、等比缩放至最长边 <= 2048px、输出 PNG
本脚本不含任何密钥/网络逻辑，仅供 VisionTool 内核工具调用。

用法：
  python vision_prepare.py prepare --file "scan.pdf" --output out.json [--max-pages 10]
输出 JSON：
  {"md5": "<file md5>", "pages": [{"page": 1, "png": "...", "width": w, "height": h}], "truncated": false}
"""

import argparse
import hashlib
import json
import sys
from pathlib import Path

SUPPORTED_EXTENSIONS = {'png', 'jpg', 'jpeg', 'bmp', 'tif', 'tiff', 'gif', 'webp', 'pdf'}
MAX_EDGE = 2048
DEFAULT_MAX_PAGES = 10


def get_file_md5(path):
    h = hashlib.md5()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(8192), b''):
            h.update(chunk)
    return h.hexdigest()


def prepare_image(path, out_dir):
    """图片归一化：转 RGB、等比缩放到最长边 <= MAX_EDGE、存 PNG。返回 [page_dict]."""
    from PIL import Image

    out_dir = Path(out_dir)
    img = Image.open(path)
    if img.mode != 'RGB':
        img = img.convert('RGB')
    w, h = img.size
    longest = max(w, h)
    if longest > MAX_EDGE:
        ratio = MAX_EDGE / longest
        img = img.resize(
            (max(1, int(w * ratio)), max(1, int(h * ratio))), Image.LANCZOS
        )
    png = out_dir / 'page_1.png'
    img.save(png, 'PNG')
    return [{'page': 1, 'png': str(png), 'width': img.width, 'height': img.height}]


def prepare_pdf(path, out_dir, max_pages=DEFAULT_MAX_PAGES):
    """PDF 逐页渲染 PNG，超出 max_pages 截断。返回 (pages, truncated)."""
    import fitz

    out_dir = Path(out_dir)
    doc = fitz.open(path)
    pages = []
    for i, page in enumerate(doc, start=1):
        if i > max_pages:
            break
        r = page.rect
        scale = min(1.0, MAX_EDGE / max(r.width, r.height))
        pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
        png = out_dir / f'page_{i}.png'
        pix.save(str(png))
        pages.append(
            {'page': i, 'png': str(png), 'width': pix.width, 'height': pix.height}
        )
    truncated = len(doc) > max_pages
    doc.close()
    return pages, truncated


def prepare(file_path, out_dir, max_pages=DEFAULT_MAX_PAGES):
    ext = Path(file_path).suffix.lower().lstrip('.')
    if ext not in SUPPORTED_EXTENSIONS:
        raise ValueError(
            f'Unsupported file type for vision: "{ext}". '
            f'Supported: {", ".join(sorted(SUPPORTED_EXTENSIONS))}.'
        )
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    if ext == 'pdf':
        pages, truncated = prepare_pdf(file_path, out_dir, max_pages)
    else:
        pages = prepare_image(file_path, out_dir)
        truncated = False
    return {
        'md5': get_file_md5(file_path),
        'pages': pages,
        'truncated': truncated,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description='vision_prepare 预处理')
    sub = parser.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('prepare')
    p.add_argument('--file', required=True, help='图片或 PDF 路径')
    p.add_argument('--output', required=True, help='输出 JSON 路径')
    p.add_argument('--max-pages', type=int, default=DEFAULT_MAX_PAGES)
    p.add_argument('--out-dir', help='PNG 临时目录（默认自动创建在 --output 旁）')
    args = parser.parse_args(argv)

    if args.cmd == 'prepare':
        out_dir = Path(args.out_dir) if args.out_dir else (
            Path(args.output).parent / 'png'
        )
        try:
            data = prepare(args.file, out_dir, args.max_pages)
        except Exception as e:  # noqa: BLE001 - CLI 边界
            print(json.dumps({'error': str(e)}, ensure_ascii=False))
            return 1
        Path(args.output).write_text(
            json.dumps(data, ensure_ascii=False), 'utf-8'
        )
        return 0
    return 1


if __name__ == '__main__':
    sys.exit(main())
```

- [ ] **Step 4: 跑测试确认通过**

Run: `python runtime/skills/_common/test_vision_prepare.py`
Expected: `OK`（全部通过；本机系统 Python 需有 fitz/PIL，或改用 `runtime/python/python.exe`）

- [ ] **Step 5: 提交**

```bash
git add runtime/skills/_common/vision_prepare.py runtime/skills/_common/test_vision_prepare.py
git commit -m "feat(vision): vision_prepare.py 图片/PDF 预处理引擎（PNG 归一化+PDF 渲染）"
```

---

### Task 2: visionClient.ts Node 侧 API 客户端

**Files:**
- Create: `yfw-kernel/claude-code/src/utils/visionClient.ts`
- Create: `yfw-kernel/claude-code/src/utils/visionClient.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `prepare` 输出 JSON（`md5`/`pages[].png`/`truncated`）
- Produces:
  - `interface VisionClientConfig { baseUrl: string; authToken: string; model: string }`
  - `interface VisionPageInput { page: number; data: string }`（data 为 base64 PNG）
  - `interface DescribeResult { description: string; pages: { page: number; description: string }[]; model: string; durationMs: number }`
  - `export const VISION_DEFAULT_INSTRUCTION: string`
  - `export function getVisionConfigFromEnv(): VisionClientConfig | null`
  - `export async function describeImages(pages: VisionPageInput[], instruction: string, config: VisionClientConfig): Promise<DescribeResult>`（每页一次 API 调用，逐页拼接）
  - `export function buildVisionCacheKey(fileMd5: string, instruction: string, model: string): string`
  - `export function visionCachePath(project: string, key: string): string`（`path.resolve('.trae', 'vision_cache', project, key + '.json')`）
  - `export function readVisionCache(project: string, key: string): DescribeResult | null`
  - `export function writeVisionCache(project: string, key: string, result: DescribeResult): void`

- [ ] **Step 1: 写失败测试**（vitest，mock 全局 fetch）

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  VISION_DEFAULT_INSTRUCTION,
  buildVisionCacheKey,
  describeImages,
  getVisionConfigFromEnv,
  readVisionCache,
  visionCachePath,
  writeVisionCache,
} from './visionClient.js'

const mockFetch = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch)
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ content: [{ type: 'text', text: '图片里有一只猫' }] }),
  } as Response)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  vi.unstubAllEnvs()
})

describe('getVisionConfigFromEnv', () => {
  it('returns null when any key missing', () => {
    delete process.env.ANTHROPIC_BASE_URL
    delete process.env.ANTHROPIC_AUTH_TOKEN
    delete process.env.YFW_VISION_MODEL
    expect(getVisionConfigFromEnv()).toBeNull()
  })

  it('reads config from env and trims trailing slash', () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://api.example.com/anthropic/')
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'sk-test')
    vi.stubEnv('YFW_VISION_MODEL', 'vision-model')
    const cfg = getVisionConfigFromEnv()
    expect(cfg).toEqual({
      baseUrl: 'https://api.example.com/anthropic',
      authToken: 'sk-test',
      model: 'vision-model',
    })
  })
})

describe('describeImages', () => {
  it('posts anthropic message format and returns description', async () => {
    const cfg = { baseUrl: 'https://api.example.com/anthropic', authToken: 'sk-1', model: 'vm' }
    const res = await describeImages([{ page: 1, data: 'AAA' }], '这是什么？', cfg)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.example.com/anthropic/v1/messages')
    const body = JSON.parse(String(init.body))
    expect(body.model).toBe('vm')
    expect(body.max_tokens).toBe(1024)
    expect(body.messages[0].content[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AAA' },
    })
    expect(body.messages[0].content[1]).toEqual({ type: 'text', text: '这是什么？' })
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('sk-1')
    expect(res.description).toContain('一只猫')
    expect(res.pages).toEqual([{ page: 1, description: '图片里有一只猫' }])
    expect(res.model).toBe('vm')
  })

  it('calls once per page and merges with page markers', async () => {
    const cfg = { baseUrl: 'https://api.example.com/anthropic', authToken: 'sk-1', model: 'vm' }
    const res = await describeImages(
      [
        { page: 1, data: 'AAA' },
        { page: 2, data: 'BBB' },
      ],
      '描述',
      cfg,
    )
    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(res.pages).toHaveLength(2)
    expect(res.description).toContain('第1页')
    expect(res.description).toContain('第2页')
  })

  it('throws with status on non-2xx', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'unauthorized',
    } as Response)
    const cfg = { baseUrl: 'https://api.example.com/anthropic', authToken: 'bad', model: 'vm' }
    await expect(describeImages([{ page: 1, data: 'AAA' }], '描述', cfg)).rejects.toThrow(
      /401/,
    )
  })

  it('uses default instruction when omitted', async () => {
    const cfg = { baseUrl: 'https://api.example.com/anthropic', authToken: 'sk-1', model: 'vm' }
    await describeImages([{ page: 1, data: 'AAA' }], VISION_DEFAULT_INSTRUCTION, cfg)
    const [_, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(String(init.body))
    expect(body.messages[0].content[1].text).toBe(VISION_DEFAULT_INSTRUCTION)
  })
})

describe('cache helpers', () => {
  it('builds stable key from md5+instruction+model', () => {
    const k1 = buildVisionCacheKey('abc', 'desc', 'vm')
    const k2 = buildVisionCacheKey('abc', 'desc', 'vm')
    const k3 = buildVisionCacheKey('abc', 'desc2', 'vm')
    expect(k1).toBe(k2)
    expect(k1).not.toBe(k3)
    expect(k1).toMatch(/^[0-9a-f]{32}$/)
  })

  it('round-trips cache write/read under project dir', () => {
    const project = 'unit-test-vision'
    const key = buildVisionCacheKey('abc', 'desc', 'vm')
    const result = {
      description: 'd',
      pages: [{ page: 1, description: 'd' }],
      model: 'vm',
      durationMs: 10,
    }
    writeVisionCache(project, key, result)
    expect(readVisionCache(project, key)).toEqual(result)
    expect(readVisionCache(project, buildVisionCacheKey('x', 'y', 'z'))).toBeNull()
    const p = visionCachePath(project, key)
    expect(p.includes('vision_cache')).toBe(true)
    expect(p.includes(project)).toBe(true)
    expect(p.endsWith(`${key}.json`)).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd yfw-kernel/claude-code && npx vitest run src/utils/visionClient.test.ts`
Expected: FAIL（模块不存在 / 函数未定义）

- [ ] **Step 3: 实现 `visionClient.ts`**

```ts
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import * as path from 'path'

export interface VisionClientConfig {
  baseUrl: string
  authToken: string
  model: string
}

export interface VisionPageInput {
  page: number
  /** base64 编码的 PNG 数据 */
  data: string
}

export interface DescribeResult {
  description: string
  pages: { page: number; description: string }[]
  model: string
  durationMs: number
}

export const VISION_DEFAULT_INSTRUCTION =
  '详细描述这张图片的内容，包括所有可见文字、物体、场景布局、图表数据与表格数值。'

const VISION_TIMEOUT_MS = 60_000
const VISION_MAX_TOKENS = 1024

/**
 * 从环境变量读取视觉模型配置（由 bridge 注入）：
 * ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN 复用主 provider，YFW_VISION_MODEL 指定视觉模型。
 */
export function getVisionConfigFromEnv(): VisionClientConfig | null {
  const baseUrl = process.env.ANTHROPIC_BASE_URL
  const authToken = process.env.ANTHROPIC_AUTH_TOKEN
  const model = process.env.YFW_VISION_MODEL
  if (!baseUrl || !authToken || !model) return null
  return { baseUrl: baseUrl.replace(/\/+$/, ''), authToken, model }
}

async function describeOnePage(
  page: VisionPageInput,
  instruction: string,
  config: VisionClientConfig,
): Promise<string> {
  const res = await fetch(`${config.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.authToken,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: VISION_MAX_TOKENS,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: page.data },
            },
            { type: 'text', text: instruction },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Vision API error ${res.status}: ${detail.slice(0, 500)}`)
  }
  const json = (await res.json()) as {
    content?: { type?: string; text?: string }[]
  }
  const text = (json.content ?? [])
    .filter(b => b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text as string)
    .join('')
  if (!text) {
    throw new Error('Vision API returned no text content.')
  }
  return text
}

/**
 * 逐页调用视觉模型，合并为带页码标记的描述文本。
 */
export async function describeImages(
  pages: VisionPageInput[],
  instruction: string,
  config: VisionClientConfig,
): Promise<DescribeResult> {
  const start = Date.now()
  const pageResults: { page: number; description: string }[] = []
  for (const p of pages) {
    const description = await describeOnePage(p, instruction, config)
    pageResults.push({ page: p.page, description })
  }
  const description =
    pageResults.length === 1
      ? pageResults[0].description
      : pageResults.map(r => `【第${r.page}页】${r.description}`).join('\n\n')
  return {
    description,
    pages: pageResults,
    model: config.model,
    durationMs: Date.now() - start,
  }
}

export function buildVisionCacheKey(
  fileMd5: string,
  instruction: string,
  model: string,
): string {
  return createHash('md5')
    .update(`${fileMd5}|${instruction}|${model}`)
    .digest('hex')
}

export function visionCachePath(project: string, key: string): string {
  return path.resolve('.trae', 'vision_cache', project, `${key}.json`)
}

export function readVisionCache(
  project: string,
  key: string,
): DescribeResult | null {
  const p = visionCachePath(project, key)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as DescribeResult
  } catch {
    return null
  }
}

export function writeVisionCache(
  project: string,
  key: string,
  result: DescribeResult,
): void {
  const p = visionCachePath(project, key)
  mkdirSync(path.dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(result), 'utf-8')
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd yfw-kernel/claude-code && npx vitest run src/utils/visionClient.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add yfw-kernel/claude-code/src/utils/visionClient.ts yfw-kernel/claude-code/src/utils/visionClient.test.ts
git commit -m "feat(vision): visionClient Node 侧视觉 API 客户端（Anthropic 格式+缓存）"
```

---

### Task 3: VisionTool 内核工具

**Files:**
- Create: `yfw-kernel/claude-code/src/tools/VisionTool/VisionTool.ts`
- Create: `yfw-kernel/claude-code/src/tools/VisionTool/prompt.ts`
- Create: `yfw-kernel/claude-code/src/tools/VisionTool/UI.tsx`
- Create: `yfw-kernel/claude-code/src/tools/VisionTool/VisionTool.test.ts`
- Modify: `yfw-kernel/claude-code/src/tools.ts`（注册，紧随 `OcrTool` 之后，约 207-210 行）

**Interfaces:**
- Consumes: Task 1 的 `vision_prepare.py`（spawn），Task 2 的 `getVisionConfigFromEnv` / `describeImages` / `buildVisionCacheKey` / `readVisionCache` / `writeVisionCache` / `VISION_DEFAULT_INSTRUCTION`
- Produces: 工具名 `Vision`，schema `{ file_path: string; instruction?: string; project?: string; force?: boolean }`；在 `src/tools.ts` 注册，agent 可通过工具名调用

- [ ] **Step 1: 写失败测试**（validateInput 边界 + 未配置视觉模型报错 + happy path 走 mock fetch）

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'os'
import * as path from 'path'
import * as fs from 'fs'
import { VisionTool } from './VisionTool.js'

const mockFetch = vi.fn()

function makeCtx() {
  return {
    getAppState: () => ({
      toolPermissionContext: { canUseTool: () => true },
    }),
    abortController: { signal: new AbortController().signal },
  } as never
}

function makeTmpPng(): string {
  const p = path.join(tmpdir(), `vision-test-${Date.now()}-${Math.random()}.png`)
  fs.writeFileSync(p, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
  return p
}

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch)
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ content: [{ type: 'text', text: '描述结果' }] }),
  } as Response)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('VisionTool.validateInput', () => {
  it('rejects unsupported extension', async () => {
    const res = await VisionTool.validateInput({ file_path: 'a.xyz' }, makeCtx())
    expect(res.result).toBe(false)
  })

  it('accepts image and pdf extensions', async () => {
    for (const ext of ['png', 'jpg', 'pdf', 'webp']) {
      const res = await VisionTool.validateInput({ file_path: `a.${ext}` }, makeCtx())
      expect(res.result).toBe(true)
    }
  })
})

describe('VisionTool.call', () => {
  it('fails clearly when vision model not configured', async () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', '')
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', '')
    vi.stubEnv('YFW_VISION_MODEL', '')
    const file = makeTmpPng()
    await expect(
      VisionTool.call({ file_path: file }, makeCtx()),
    ).rejects.toThrow(/未配置视觉模型/)
  })

  it('throws when file does not exist', async () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://api.example.com/anthropic')
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'sk-1')
    vi.stubEnv('YFW_VISION_MODEL', 'vm')
    await expect(
      VisionTool.call({ file_path: '/no/such/file.png' }, makeCtx()),
    ).rejects.toThrow(/does not exist/)
  })

  it('happy path: prepares, calls vision API, returns description', async () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://api.example.com/anthropic')
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'sk-1')
    vi.stubEnv('YFW_VISION_MODEL', 'vm')
    // 指向真实 runtime（dev 布局：内核仓库同级 runtime/）
    vi.stubEnv('YFWORKING_PYTHON', process.cwd().replace(/\\/g, '/').split('/yfw-kernel')[0] + '/runtime/python/python.exe')
    vi.stubEnv('YFWORKING_VISION_PREPARE', process.cwd().replace(/\\/g, '/').split('/yfw-kernel')[0] + '/runtime/skills/_common/vision_prepare.py')
    const file = makeTmpPng()
    const out = await VisionTool.call({ file_path: file }, makeCtx())
    const data = out.data as { description: string; model: string; cacheHit: boolean }
    expect(data.description).toContain('描述结果')
    expect(data.model).toBe('vm')
    expect(data.cacheHit).toBe(false)
    expect(mockFetch).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd yfw-kernel/claude-code && npx vitest run src/tools/VisionTool/VisionTool.test.ts`
Expected: FAIL（`Cannot find module './VisionTool.js'`）

- [ ] **Step 3: 实现 `prompt.ts`**

```ts
export const VISION_TOOL_NAME = 'Vision'

export const DESCRIPTION = `Understand the semantics of image files and PDFs using a configured vision-capable model API.

Use this tool when:
- You need semantic understanding of an image: what is depicted, scene layout, objects, chart trends, or design
- You need to answer a question about a picture that is NOT about extracting exact text or numbers
- A PDF contains visual content (charts, photos, screenshots) that you need described

Do NOT use this tool for exact text extraction (invoices, ID cards, table numbers) — use OCR instead, which reads text locally with high fidelity.

Behavior:
- Sends the image (PDF pages are rendered locally first) to the vision model configured in Settings → Models (visionModel).
- Requires the active provider to have a visionModel configured; otherwise the tool fails with a clear message.
- Results are cached per file + instruction + model under .trae/vision_cache.
- Pass instruction to ask a specific question; the default is a detailed general description.`
```

- [ ] **Step 4: 实现 `UI.tsx`**（对齐 OcrTool 的 UI 模式，仅改名与字段）

```tsx
import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs';
import React from 'react';
import { getDisplayPath } from '../../utils/file.js';

export function userFacingName(): string {
  return 'Vision';
}

export function renderToolUseMessage(
  {
    file_path,
  }: Partial<{
    file_path: string;
  }>,
  {
    verbose,
  }: {
    verbose: boolean;
  },
): React.ReactNode {
  if (!file_path) {
    return null;
  }
  return `file: "${verbose ? file_path : getDisplayPath(file_path)}"`;
}

export function renderToolUseErrorMessage(
  result: ToolResultBlockParam['content'],
  { verbose }: { verbose: boolean },
): React.ReactNode {
  const detail =
    typeof result === 'string'
      ? result
      : Array.isArray(result)
        ? result.map(b => (b.type === 'text' ? b.text : '')).join('\n')
        : '';
  const lines = detail.split('\n').filter(Boolean);
  return lines.length > 1 && verbose
    ? lines.slice(0, -1).map((line, i) => <span key={i}>{line}<br /></span>)
    : (lines[lines.length - 1] ?? detail);
}

export function getToolUseSummary(input: { file_path?: string }): string {
  return input.file_path ? getDisplayPath(input.file_path) : '';
}

export function renderToolResultMessage(
  result: ToolResultBlockParam['content'],
  { verbose }: { verbose: boolean },
): React.ReactNode {
  const detail =
    typeof result === 'string'
      ? result
      : Array.isArray(result)
        ? result.map(b => (b.type === 'text' ? b.text : '')).join('\n')
        : '';
  const lines = detail.split('\n');
  if (lines.length > 4 && !verbose) {
    return (
      <>
        {lines.slice(0, 3).map((line, i) => (
          <span key={i}>{line}<br /></span>
        ))}
        <span className="text-dim">... ({lines.length - 3} more lines)</span>
      </>
    );
  }
  return detail;
}
```

- [ ] **Step 5: 实现 `VisionTool.ts`**（对齐 OcrTool 结构：buildTool + spawn python + describeImages + 缓存）

```ts
import { spawn } from 'child_process'
import { existsSync, readFileSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import * as path from 'path'
import { z } from 'zod/v4'
import type { ValidationResult } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { FILE_NOT_FOUND_CWD_NOTE } from '../../utils/file.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { expandPath } from '../../utils/path.js'
import {
  checkReadPermissionForTool,
  matchingRuleForInput,
} from '../../utils/permissions/filesystem.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import { matchWildcardPattern } from '../../utils/permissions/shellRuleMatching.js'
import {
  VISION_DEFAULT_INSTRUCTION,
  buildVisionCacheKey,
  describeImages,
  getVisionConfigFromEnv,
  readVisionCache,
  writeVisionCache,
  type DescribeResult,
} from '../../utils/visionClient.js'
import { DESCRIPTION, VISION_TOOL_NAME } from './prompt.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  userFacingName,
} from './UI.js'

const VISION_TIMEOUT_MS = 10 * 60 * 1000

const SUPPORTED_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'bmp',
  'tif',
  'tiff',
  'gif',
  'webp',
  'pdf',
])

const PYTHON_REL_PARTS = ['runtime', 'python', 'python.exe']
const PREPARE_REL_PARTS = ['runtime', 'skills', '_common', 'vision_prepare.py']

function getKernelDir(): string | null {
  const arg = process.argv[1]
  if (arg) return path.dirname(path.resolve(arg))
  try {
    const metaPath = (import.meta as { path?: string }).path
    if (metaPath) return path.dirname(metaPath)
  } catch {}
  return null
}

/** 与 OcrTool 相同的 runtime 解析：env 覆盖 > 内核目录逐级向上找 */
function resolveSiblingRuntime(relParts: string[], envKey: string): string | null {
  const envValue = process.env[envKey]
  if (envValue) {
    const expanded = expandPath(envValue)
    if (existsSync(expanded)) return expanded
  }
  const kernelDir = getKernelDir()
  if (!kernelDir) return null
  let dir = kernelDir
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, ...relParts)
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

const inputSchema = lazySchema(() =>
  z.strictObject({
    file_path: z.string().describe(
      'The absolute path to the image or PDF file to understand visually. Supported formats: PNG, JPG, JPEG, BMP, TIFF, GIF, WEBP, PDF.',
    ),
    instruction: z
      .string()
      .optional()
      .describe(
        'Optional question or instruction about the image, e.g. "描述图表趋势" / "图中有什么产品". Defaults to a detailed general description.',
      ),
    project: z
      .string()
      .optional()
      .describe(
        'Optional cache namespace (e.g. the client or project name). Results are cached per file, instruction and model. Omit to use the default namespace.',
      ),
    force: z
      .boolean()
      .optional()
      .describe(
        'Bypass the cache and re-run vision understanding. Defaults to false.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    filePath: z.string().describe('The absolute path of the file understood'),
    description: z.string().describe('The vision description (pages merged with page markers)'),
    pages: z
      .array(
        z.object({
          page: z.number().describe('1-based page number'),
          description: z.string().describe('Description of this page'),
        }),
      )
      .describe('Per-page descriptions'),
    model: z.string().describe('The vision model used'),
    truncated: z
      .boolean()
      .optional()
      .describe('Whether a PDF was truncated at the max page count'),
    cacheHit: z.boolean().describe('Whether the result was served from cache'),
    durationMs: z.number().describe('Time taken in milliseconds'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

async function runPrepare(
  python: string,
  engine: string,
  filePath: string,
  maxPages: number,
  signal: AbortSignal,
): Promise<{ md5: string; pages: { page: number; png: string }[]; truncated: boolean }> {
  const tmpJson = path.join(
    tmpdir(),
    `yfw-vision-${process.pid}-${Date.now()}-${Math.round(Math.random() * 1e9)}.json`,
  )
  const tmpPngDir = path.join(
    tmpdir(),
    `yfw-vision-png-${process.pid}-${Date.now()}-${Math.round(Math.random() * 1e9)}`,
  )
  const args = [
    engine,
    'prepare',
    '--file',
    filePath,
    '--output',
    tmpJson,
    '--max-pages',
    String(maxPages),
    '--out-dir',
    tmpPngDir,
  ]

  let stderr = ''
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(python, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (e) {
      reject(e)
      return
    }
    const timer = setTimeout(() => {
      child.kill()
      resolve(null)
    }, VISION_TIMEOUT_MS)
    child.stdout?.on('data', () => {})
    child.stderr?.on('data', d => {
      stderr += d.toString()
    })
    child.on('error', e => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve(code)
    })
    signal.addEventListener('abort', () => {
      child.kill()
      resolve(null)
    }, { once: true })
  })

  let raw: Record<string, unknown> | null = null
  try {
    raw = JSON.parse(readFileSync(tmpJson, 'utf-8')) as Record<string, unknown>
  } catch {
    raw = null
  } finally {
    try {
      rmSync(tmpJson, { force: true })
    } catch {}
  }

  if (raw === null || typeof raw.error === 'string' && raw.error) {
    const detail = (stderr || '').trim()
    throw new Error(
      exitCode === null
        ? `Vision preparation cancelled or timed out after ${VISION_TIMEOUT_MS / 60000} minutes.`
        : `Vision preparation failed (exit code ${exitCode}).${detail ? `\n${detail.slice(0, 2000)}` : ''}`,
    )
  }

  const rawPages = Array.isArray(raw.pages) ? (raw.pages as Record<string, unknown>[]) : []
  const pages = rawPages.map(p => ({
    page: (p.page as number) ?? 1,
    png: p.png as string,
  }))
  return {
    md5: (raw.md5 as string) ?? '',
    pages,
    truncated: Boolean(raw.truncated),
  }
}

export const VisionTool = buildTool({
  name: VISION_TOOL_NAME,
  searchHint: 'semantic understanding of images and PDFs via vision model',
  strict: true,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return DESCRIPTION
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName,
  getToolUseSummary,
  getActivityDescription(input) {
    const summary = getToolUseSummary(input)
    return summary ? `Understanding ${summary} visually` : 'Understanding image visually'
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  toAutoClassifierInput(input) {
    return input.file_path
  },
  isSearchOrReadCommand() {
    return { isSearch: false, isRead: true }
  },
  getPath({ file_path }): string {
    return expandPath(file_path)
  },
  backfillObservableInput(input) {
    if (typeof input.file_path === 'string') {
      input.file_path = expandPath(input.file_path)
    }
  },
  async preparePermissionMatcher({ file_path }) {
    return pattern => matchWildcardPattern(pattern, expandPath(file_path))
  },
  async checkPermissions(input, context): Promise<PermissionDecision> {
    const appState = context.getAppState()
    return checkReadPermissionForTool(VisionTool, input, appState.toolPermissionContext)
  },
  renderToolUseMessage,
  renderToolUseErrorMessage,
  renderToolResultMessage,
  extractSearchText() {
    return ''
  },
  async validateInput({ file_path }, toolUseContext): Promise<ValidationResult> {
    const fullFilePath = expandPath(file_path)
    const ext = path.extname(fullFilePath).toLowerCase().slice(1)
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      return {
        result: false,
        message: `Unsupported file type for Vision: "${ext}". Supported formats: PNG, JPG, JPEG, BMP, TIFF, GIF, WEBP, PDF.`,
        errorCode: 1,
      }
    }
    const appState = toolUseContext.getAppState()
    const denyRule = matchingRuleForInput(
      fullFilePath,
      appState.toolPermissionContext,
      'read',
      'deny',
    )
    if (denyRule !== null) {
      return {
        result: false,
        message: 'File is in a directory that is denied by your permission settings.',
        errorCode: 2,
      }
    }
    return { result: true }
  },
  async call(
    { file_path, instruction, project = 'default', force = false },
    context,
  ) {
    const start = Date.now()
    const fullFilePath = expandPath(file_path)
    const instructionText = instruction || VISION_DEFAULT_INSTRUCTION

    const config = getVisionConfigFromEnv()
    if (!config) {
      throw new Error(
        '未配置视觉模型，请在 设置→模型 中为该 provider 选择视觉模型（visionModel）。',
      )
    }
    if (!existsSync(fullFilePath)) {
      throw new Error(`File does not exist: ${fullFilePath}. ${FILE_NOT_FOUND_CWD_NOTE}`)
    }
    try {
      if (!statSync(fullFilePath).isFile()) {
        throw new Error(`Not a file: ${fullFilePath}`)
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('Not a file')) throw e
      throw e
    }

    const python = resolveSiblingRuntime(PYTHON_REL_PARTS, 'YFWORKING_PYTHON')
    if (!python) {
      throw new Error(
        'Vision runtime not found: expected runtime/python/python.exe next to the kernel, or set YFWORKING_PYTHON.',
      )
    }
    const engine = resolveSiblingRuntime(PREPARE_REL_PARTS, 'YFWORKING_VISION_PREPARE')
    if (!engine) {
      throw new Error(
        'Vision prepare engine not found: expected runtime/skills/_common/vision_prepare.py next to the kernel, or set YFWORKING_VISION_PREPARE.',
      )
    }

    const prepared = await runPrepare(python, engine, fullFilePath, 10, context.abortController.signal)

    // 缓存检查（force 跳过）
    const cacheKey = buildVisionCacheKey(prepared.md5, instructionText, config.model)
    if (!force) {
      const cached = readVisionCache(project, cacheKey)
      if (cached) {
        return {
          data: {
            filePath: fullFilePath,
            description: cached.description,
            pages: cached.pages,
            model: cached.model,
            ...(prepared.truncated ? { truncated: true } : {}),
            cacheHit: true,
            durationMs: Date.now() - start,
          } satisfies Output,
        }
      }
    }

    const pageInputs = prepared.pages.map(p => ({
      page: p.page,
      data: readFileSync(p.png, 'base64'),
    }))
    const result = await describeImages(pageInputs, instructionText, config)

    // 清理临时 PNG
    try {
      for (const p of prepared.pages) rmSync(p.png, { force: true })
    } catch {}

    const output: Output = {
      filePath: fullFilePath,
      description: result.description,
      pages: result.pages,
      model: result.model,
      ...(prepared.truncated ? { truncated: true } : {}),
      cacheHit: false,
      durationMs: Date.now() - start,
    }
    writeVisionCache(project, cacheKey, {
      description: result.description,
      pages: result.pages,
      model: result.model,
      durationMs: result.durationMs,
    } satisfies DescribeResult)
    return { data: output }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const meta =
      `${output.model} · ${output.pages.length} page(s)` +
      (output.truncated ? ' · truncated' : '') +
      (output.cacheHit ? ' · cache hit' : '')
    const body = output.description || '(Vision returned no description.)'
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `${meta}\n\n${body}`,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
```

- [ ] **Step 6: 注册到 `src/tools.ts`**

在 `import { OcrTool } from './tools/OcrTool/OcrTool.js'` 后加：

```ts
import { VisionTool } from './tools/VisionTool/VisionTool.js'
```

在 tools 数组的 `OcrTool,` 条目后加 `VisionTool,`。

- [ ] **Step 7: 跑全部测试确认通过**

Run: `cd yfw-kernel/claude-code && npx vitest run src/tools/VisionTool/VisionTool.test.ts`
Expected: PASS（validateInput 3 例 + call 2 例）
再跑 `npx vitest run` 确认内核全量不回归。

- [ ] **Step 8: 提交**

```bash
git add yfw-kernel/claude-code/src/tools/VisionTool/ yfw-kernel/claude-code/src/tools.ts
git commit -m "feat(vision): VisionTool 内核工具（spawn 预处理 + visionClient 调用 + 缓存）"
```

---

### Task 4: 对话图片自动桥接

**Files:**
- Create: `yfw-kernel/claude-code/src/utils/visionBridge.ts`
- Create: `yfw-kernel/claude-code/src/utils/visionBridge.test.ts`
- Modify: `yfw-kernel/claude-code/src/utils/attachments.ts:1062-1073`

**Interfaces:**
- Consumes: Task 2 的 `getVisionConfigFromEnv` / `describeImages` / `VISION_DEFAULT_INSTRUCTION`
- Produces: `export async function maybeBridgeImageBlocks(blocks: ImageBlockParam[]): Promise<ContentBlockParam[]>`（配了 visionModel 且主模型非视觉时把 image block 替换为文本描述；否则原样透传）
- 判断依据：`getVisionConfigFromEnv()` 非空 且 `process.env.ANTHROPIC_MODEL !== config.model`

- [ ] **Step 1: 写失败测试**

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { maybeBridgeImageBlocks } from './visionBridge.js'

const mockFetch = vi.fn()

function imageBlock(data = 'AAA') {
  return { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data } }
}

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch)
  vi.stubEnv('ANTHROPIC_BASE_URL', 'https://api.example.com/anthropic')
  vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'sk-1')
  vi.stubEnv('YFW_VISION_MODEL', 'vision-model')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('maybeBridgeImageBlocks', () => {
  it('passes through when vision model equals main model', async () => {
    vi.stubEnv('ANTHROPIC_MODEL', 'vision-model')
    const blocks = [imageBlock()]
    const out = await maybeBridgeImageBlocks(blocks)
    expect(out).toEqual(blocks)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('passes through when vision model not configured', async () => {
    vi.stubEnv('YFW_VISION_MODEL', '')
    const blocks = [imageBlock()]
    const out = await maybeBridgeImageBlocks(blocks)
    expect(out).toEqual(blocks)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('bridges image block to text description', async () => {
    vi.stubEnv('ANTHROPIC_MODEL', 'deepseek-v4-flash')
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ content: [{ type: 'text', text: '图中是一份报表' }] }),
    } as Response)
    const out = await maybeBridgeImageBlocks([imageBlock('AAA')])
    expect(out).toHaveLength(1)
    expect(out[0].type).toBe('text')
    const text = (out[0] as { text: string }).text
    expect(text).toContain('图片描述')
    expect(text).toContain('一份报表')
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('replaces with failure note but keeps conversation alive', async () => {
    vi.stubEnv('ANTHROPIC_MODEL', 'deepseek-v4-flash')
    mockFetch.mockResolvedValue({ ok: false, status: 401, text: async () => 'bad key' } as Response)
    const out = await maybeBridgeImageBlocks([imageBlock('AAA')])
    expect(out).toHaveLength(1)
    expect((out[0] as { text: string }).text).toContain('图片描述失败')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd yfw-kernel/claude-code && npx vitest run src/utils/visionBridge.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `visionBridge.ts`**

```ts
import type {
  ContentBlockParam,
  ImageBlockParam,
} from '@anthropic-ai/sdk/resources/messages.mjs'
import {
  VISION_DEFAULT_INSTRUCTION,
  describeImages,
  getVisionConfigFromEnv,
} from './visionClient.js'

/**
 * 桥接钩子：主模型不支持视觉时，把用户消息中的 image block 转换为文字描述。
 * 配置了 visionModel 且对话模型 != visionModel 时执行桥接，否则原样透传。
 * 桥接失败保留提示文本，不吞用户内容。
 */
export async function maybeBridgeImageBlocks(
  blocks: ImageBlockParam[],
): Promise<ContentBlockParam[]> {
  const config = getVisionConfigFromEnv()
  const mainModel = process.env.ANTHROPIC_MODEL
  if (!config || mainModel === config.model) {
    return blocks
  }
  const out: ContentBlockParam[] = []
  for (const block of blocks) {
    const data = block.source.type === 'base64' ? block.source.data : null
    if (!data) {
      out.push(block)
      continue
    }
    try {
      const result = await describeImages(
        [{ page: 1, data }],
        VISION_DEFAULT_INSTRUCTION,
        config,
      )
      out.push({ type: 'text', text: `📷 [图片描述] ${result.description}` })
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      out.push({ type: 'text', text: `📷 [图片描述失败: ${reason}]` })
    }
  }
  return out
}
```

- [ ] **Step 4: 接入 `attachments.ts:1062-1073`**

原代码：

```ts
      const imageBlocks = await buildImageContentBlocks(_.pastedContents)
      let prompt: string | Array<ContentBlockParam> = _.value
      if (imageBlocks.length > 0) {
        // Build content block array with text + images so the model sees them
        const textValue =
          typeof _.value === 'string'
            ? _.value
            : extractTextContent(_.value, '\n')
        prompt = [{ type: 'text' as const, text: textValue }, ...imageBlocks]
      }
```

改为：

```ts
      const imageBlocks = await buildImageContentBlocks(_.pastedContents)
      let prompt: string | Array<ContentBlockParam> = _.value
      if (imageBlocks.length > 0) {
        // Build content block array with text + images so the model sees them
        const textValue =
          typeof _.value === 'string'
            ? _.value
            : extractTextContent(_.value, '\n')
        const bridged = await maybeBridgeImageBlocks(imageBlocks)
        prompt = [{ type: 'text' as const, text: textValue }, ...bridged]
      }
```

文件头部新增 import（与既有 import 风格一致）：

```ts
import { maybeBridgeImageBlocks } from './visionBridge.js'
```

- [ ] **Step 5: 跑测试确认通过 + 全量不回归**

Run: `cd yfw-kernel/claude-code && npx vitest run src/utils/visionBridge.test.ts`
Expected: PASS
再跑 `npx vitest run` 全量。

- [ ] **Step 6: 提交**

```bash
git add yfw-kernel/claude-code/src/utils/visionBridge.ts yfw-kernel/claude-code/src/utils/visionBridge.test.ts yfw-kernel/claude-code/src/utils/attachments.ts
git commit -m "feat(vision): 对话图片自动桥接——主模型非视觉时 image block 转文字描述"
```

---

### Task 5: 配置链路（类型 / bridge env / 设置 UI / i18n）

**Files:**
- Modify: `src/types/index.ts:269-277`（`ModelProvider` 加 `visionModel?: string`）
- Modify: `server/bridge.mjs`（`syncKernelSettings` 中 `existing.env` 加 `YFW_VISION_MODEL`）
- Modify: `src/stores/settingsStore.ts`（providers 初始化值加 `visionModel: ''`）
- Modify: `src/components/settings/SettingsView.tsx`（"视觉模型"下拉 + "自动图片桥接"开关）
- Modify: `src/i18n/translations/zh-CN.ts`、`src/i18n/translations/en-US.ts`（新增文案键）
- Verify: `npm run typecheck`（tsc --noEmit）

**Interfaces:**
- Produces: `ModelProvider.visionModel?: string`（前端存储）；`YFW_VISION_MODEL` env（bridge 注入内核，VisionTool/桥接读取）

- [ ] **Step 1: 类型扩展**

`src/types/index.ts` 的 `ModelProvider` 接口加一行：

```ts
export interface ModelProvider {
  id: string
  name: string
  apiBaseUrl: string
  models: string[]
  primaryModel: string
  subagentModel: string
  effortLevel: string
  contextWindow: number
  authToken: string
  /** 该 provider 下支持视觉的模型名（留空=不启用 VisionTool 与自动桥接） */
  visionModel?: string
}
```

- [ ] **Step 2: bridge 注入 env**

`server/bridge.mjs` 的 `syncKernelSettings` 中 `existing.env` 对象（约 320-329 行）加一行（在 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 行后）：

```js
      YFW_VISION_MODEL: provider.visionModel || '',
```

- [ ] **Step 3: settingsStore 默认值**

`src/stores/settingsStore.ts` 的两个 provider 初始化对象（deepseek / minimax）各加 `visionModel: ''`。

- [ ] **Step 4: SettingsView 视觉模型下拉**

在 `src/components/settings/SettingsView.tsx` 的 Subagent Model 区块后（约 640-655 行，`{/* Subagent Model */}` 的 select 闭合后）新增：

```tsx
                {/* Vision Model */}
                <div>
                  <label className="text-xs font-medium text-secondary mb-1 block">{t('settings.providerVisionModel')}</label>
                  <select
                    value={activeProv.visionModel || ''}
                    onChange={e => handleUpdateActiveProvider('visionModel', e.target.value || undefined)}
                    className="w-full h-8 rounded-md border border bg-surface px-3 text-xs text-primary focus:outline-none focus:ring-1 focus:ring-accent font-mono"
                  >
                    <option value="">{t('settings.providerVisionModelNone')}</option>
                    {activeProv.models.map(m => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                  <p className="text-[10px] text-tertiary mt-1">{t('settings.providerVisionModelDesc')}</p>
                </div>
```

（`handleUpdateActiveProvider` 已存在，直接传 `'visionModel'` 键即可；`activeProv` 类型为 `ModelProvider`，扩展后自动支持该键。）

- [ ] **Step 5: i18n 文案**

`src/i18n/translations/zh-CN.ts` 的 settings 段新增：

```ts
    providerVisionModel: '视觉模型（识图）',
    providerVisionModelNone: '不使用（禁用 VisionTool）',
    providerVisionModelDesc: '非多模态模型运行时，VisionTool 与对话图片自动识别会调用此模型理解图片内容；留空即禁用。',
```

`src/i18n/translations/en-US.ts` 对应新增：

```ts
    providerVisionModel: 'Vision model',
    providerVisionModelNone: 'Disabled (VisionTool off)',
    providerVisionModelDesc: 'When the main model is not multimodal, VisionTool and automatic image bridging use this model to understand images; leave empty to disable.',
```

（以文件实际 settings 段的相邻键与缩进为准放置。）

- [ ] **Step 6: 类型检查**

Run: `cd C:/Users/T203-15/claude-code-gui && npm run typecheck`
Expected: 无类型错误

- [ ] **Step 7: 提交**

```bash
git add src/types/index.ts server/bridge.mjs src/stores/settingsStore.ts src/components/settings/SettingsView.tsx src/i18n/translations/zh-CN.ts src/i18n/translations/en-US.ts
git commit -m "feat(vision): provider 视觉模型配置（visionModel 字段 + bridge env + 设置 UI + i18n）"
```

---

### Task 6: 端到端验证

**Files:**
- 无新增/修改（验证 + 必要时修复）

- [ ] **Step 1: 内核测试与构建**

Run: `cd yfw-kernel/claude-code && npx vitest run`（全量通过）→ `bun scripts/build-bundle.ts`（构建内核 bundle）

- [ ] **Step 2: 前端构建**

Run: `cd C:/Users/T203-15/claude-code-gui && npm run typecheck && npm run build`

- [ ] **Step 3: 运行环境验证**

按项目既有发布流程（参考记忆：源码改动需同步 release 目录并重启进程；重启 live 应用前必须先经用户同意）：
1. 同步内核 bundle 与前端产物到运行目录
2. 请用户重启应用（需用户同意后执行）
3. 设置页为该 provider 选择"视觉模型"（如 MiniMax 下某视觉模型，或已支持视觉的模型名）

- [ ] **Step 4: 手工验证清单**

1. 对话粘贴一张图片 → 应收到 `📷 [图片描述] ...` 文本块（桥接生效），主模型能继续对话
2. agent 调用 `Vision` 工具读一张本地图片 → 返回描述 + model + page 数
3. agent 调用 `Vision` 工具读一个 3 页 PDF → 返回逐页描述（带页码标记）
4. 再次调用同一文件同一指令 → `cache hit`（缓存生效）
5. 设置页"视觉模型"留空 → 工具报错提示配置、对话图片原样透传
6. 用 `OCR` 工具读发票确认与 `Vision` 的分工（OCR 精确文字 / Vision 语义描述）

- [ ] **Step 5: 提交（如有修复）**

```bash
git add -A
git commit -m "fix(vision): 端到端验证修复"
```

---

## Self-Review 记录

- **Spec 覆盖**：架构（Task 1/2/3/4）、双路径（Task 3 工具 / Task 4 桥接）、配置（Task 5）、测试（各 Task TDD + Task 6 手测）、错误处理（Task 3 call 未配置报错 / Task 4 失败保留）、范围外（未纳入任何任务，符合"明确不做"）
- **占位符扫描**：无 TBD/TODO；所有代码块完整可执行；Task 5 的 UI/i18n 给出精确键名与相邻结构，执行者按文件实际排版放置
- **类型一致性**：`getVisionConfigFromEnv`/`describeImages`/`buildVisionCacheKey`/`readVisionCache`/`writeVisionCache`/`VISION_DEFAULT_INSTRUCTION` 在 Task 2 定义、Task 3/4 消费，签名一致；`VisionTool` 导出的 `Output` 类型与 `mapToolResultToToolResultBlockParam` 字段一致
