# S6 Batch B（便携版交付 + 验收收口）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成 S6 Batch B——以**便携版**形态交付可运行 YFWorking（不构建 NSIS 安装包），应用图标统一为 `YF/icon-logo.ai`、UI 品牌 logo/favicon 统一为 `YF/boost-logo.ai`，并收口四层零残留审计、GUI 冒烟、双版并存验证、文档清洗与完结交接。

**Architecture:** 图标资产由 icon-logo.ai / boost-logo.ai 经 pymupdf 矢量渲染成 `public/` 图标族（全引用点自动跟随）；便携版沿用 `scripts/package-portable.cjs`（组装 `release/YFWorking/` + VBS 启动器 + 桌面快捷方式 + exe 图标注入），补齐模板资源与桌面路径健壮化后执行出包；随后按 roadmap S6 Batch B 清单逐项收口（审计/冒烟/双版/文档/完结）。破坏性 ops（退役旧内核/旧库等）不自动执行，完结时逐项征询。

**Tech Stack:** python 3.12 + pymupdf（矢量渲染）、node 24（electron-builder/rcedit/png-to-ico 既有链）、electron + vite（产品本体）、node --test（测试基线）。

## Global Constraints

1. **零触碰**：`kernel/`、`kernel-tests/`、`version.mjs`、`YF/`（untracked 用户素材）一律不改。`git add` 不得误收 `YF/`、`dist/`、`runtime/`、`kernel-dist/`、`node.exe`、`release/`。
2. **本轮不构建 NSIS 安装包**（用户定案 2026-09-08）：不执行 electron-builder nsis / build-installer.mjs。便携版 = `scripts/package-portable.cjs` 组装 `release/YFWorking/`（用户已批准沿用此形态）。electron-builder 配置（win/nsis/icon）仅保证指向新图标就位，不实跑。
3. **图标源**（只读源，均在 `YF/`，用户素材保留不入库；复现需源在位，脚本缺失时明确报错）：
   - `YF/icon-logo.ai`（551×551 透明底方形徽标）→ 应用图标族 `public/icon-{16,32,48,64,128,256}.png`、`public/icon.png`、`public/icon.ico`
   - `YF/boost-logo.ai`（544×378 透明底横版标识）→ UI 品牌位 `public/logo.png` 与 `public/favicon.ico`（favicon 为横版按 contain 居中于方形的渲染）
4. **图标统一语义**：全引用点只读 `public/` 图标族——electron-builder.yml `win.icon`/nsis 图标（`public/icon.ico`）、electron-builder files 中 `public/**/*`、main.cjs `ICON_PATH=public/icon.png`（BrowserWindow/tray/Notification :173/:483/:828/:882）、browser-executor.cjs:593、index.html favicon、package-portable.cjs 注入与快捷方式 `IconLocation`。**T1 只替换资产，不改任何代码引用**（引用自动跟随）。
5. **渲染环境**：系统 python 3.12 + pymupdf（`python` 在 PATH，已实测 `import fitz` 可用）。渲染脚本入 git，禁止依赖 Illustrator/inkscape/gs。
6. **便携布局对齐 electron-builder extraResources 语义**：`build/templates/{agents,memory,tools}` → 便携 `runtime/{agents,memory,tools}`（T1 Batch A 入库源；main.cjs dev 形态候选解析 app 根 `runtime/`，main.cjs:46 先例）；`pet/*` → 便携 `pet/`；`kernel-dist/cli.mjs` → 便携 `kernel/cli.mjs`；`runtime/python`、`runtime/skills` 同 T2 构建后拷贝。
7. **删除清单**（用户批准本计划即授权执行；commit 前复查一次路径）：
   - `scripts/gen-icons.ps1`（程序化占位图标生成器——橙块+YF 字样，被 icon-logo.ai 渲染链取代；git 历史可恢复）
8. **回归基线**：`npm test` 145/145（默认 home）、`node --test kernel-tests/*.test.mjs` 50/50、`npm run typecheck` 0 error、`npm run build` 成功——每 Task 收尾复核。
9. **commit 前缀**：`feat(s6)` / `fix(s6)` / `test(s6)` / `docs(s6)` / `chore(s6)`。
10. **审计白名单**（残留扫描不计入）：`docs/bridge-contract.md` §10 51309→51517 历史映射行；`docs/superpowers/plans|specs/` 下历史执行记录文档（S4/S5/S6-A 记录、旧 plan 允许历史字面）；`kernel/` 与 `kernel-tests/` 归内核本体（零触碰前提下不在产品面扫描范围）。
11. **deferred minor 收口**（随 T4 处置）：t1-minor2（`scripts/verify-package-assets.mjs` 未用 readdirSync import）、t2-minor1（package-lock.json root version 2.7.5→2.8.0）、t4-minor3（BUILD.md:57「高于常见动态端口范围」表述→改为「避开 WinNAT 预留段 3095-3194 与常见动态端口冲突面」）、t5-minor1（browser-executor.test.mjs:20 process.on('exit') 注释改称实际位置「文件头」）、终审 carry-forward（`scripts/build_manual_pdf.py:21/:285` BASE 相对化 + 版本字面清洗；`scripts/gen-icons.ps1:47` 旧库路径随删除清单一并消除）。

## 决策（用户定案 2026-09-08，本轮依据）

| # | 决策 | 内容 |
|---|---|---|
| D6-B2 | 打包形态 | Batch B 出包 = **便携版**（package-portable.cjs → `release/YFWorking/`），本轮不建 NSIS 安装包；installer 配置就位、留后续出包批 |
| D6-F | 应用图标 | 应用图标族统一 **`YF/icon-logo.ai`** 渲染（方形徽标） |
| D6-G | UI 品牌 logo/favicon | UI 内 logo.png（AgentAvatar/MessageBubble/Header 引用）与 favicon.ico 统一 **`YF/boost-logo.ai`** 渲染（横版标识） |
| D6-H | 资产落库 | 渲染 PNG/ICO 资产 + 渲染脚本入 git；.ai 源留 `YF/` 不入库 |
| D6-I | 桌面快捷方式 | 便携版经 package-portable.cjs 建桌面 `YFWorking.lnk`（真实桌面路径解析，兼容 OneDrive 重定向） |

---

## Task 1: 图标资产生成与统一（icon-logo.ai + boost-logo.ai → public 图标族）

**Files:**
- Create: `scripts/render-ai-assets.py`
- Modify: `scripts/png-to-ico.cjs`（支持 basename/输出参数，向后兼容）
- Replace（git tracked 更新）: `public/icon-16.png`、`public/icon-32.png`、`public/icon-48.png`、`public/icon-64.png`、`public/icon-128.png`、`public/icon-256.png`、`public/icon.png`、`public/icon.ico`、`public/favicon.ico`、`public/logo.png`

**Interfaces:**
- Consumes: `YF/icon-logo.ai`、`YF/boost-logo.ai`（只读源）、系统 python3.12+pymupdf、`scripts/png-to-ico.cjs`（既有）
- Produces: `public/icon-*.png` 各 6 尺寸（每尺寸由矢量直接栅格化）+ `public/icon.png`（icon-256 拷贝）+ `public/icon.ico`（多尺寸打包）+ `public/favicon.ico`（boost 方形化 16/32/48/64 打包）+ `public/logo.png`（boost 横版宽 512 透明渲染）

- [ ] **Step 1: 创建渲染脚本 `scripts/render-ai-assets.py`**（verbatim 全文落盘）

```python
# -*- coding: utf-8 -*-
"""S6 Batch B 图标资产生成：.ai(矢量/PDF) → public/ 图标族。

源（用户素材，YF/ 只读，不入 git）：
  YF/icon-logo.ai   551x551 方形徽标  -> icon-{16,32,48,64,128,256}.png + icon.png + icon.ico
  YF/boost-logo.ai  544x378 横版标识  -> logo.png（宽 512 透明渲染）
                                      -> favicon 方形化（contain 居中）16/32/48/64 -> favicon.ico
渲染 = pymupdf 每尺寸直接从矢量栅格化（避免缩放混叠）。ico 打包复用 png-to-ico.cjs。
依赖：python 3.12 + pymupdf（pip install pymupdf）。源缺失时报错退出（exit 1）。
"""
import os
import subprocess
import sys

import fitz  # pymupdf

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # repo 根
PUBLIC = os.path.join(ROOT, "public")
ICON_SRC = os.path.join(ROOT, "YF", "icon-logo.ai")
BOOST_SRC = os.path.join(ROOT, "YF", "boost-logo.ai")

ICON_SIZES = [16, 32, 48, 64, 128, 256]
FAVICON_SIZES = [16, 32, 48, 64]


def check_src(path):
    if not os.path.exists(path):
        print(f"ERROR: 源缺失（用户素材 YF/ 须在位）：{path}", file=sys.stderr)
        sys.exit(1)


def render_rect(doc, page_index, target_w, target_h, out_path, pad=False):
    """按画板渲染；pad=True 时内容 contain 居中于方形透明画布（favicon 用，Pillow 合成）。"""
    from PIL import Image  # render 前置依赖：pymupdf + pillow（均已在系统 python 3.12 验证）
    import io
    page = doc[page_index]
    r = page.rect
    scale = (min(target_w / r.width, target_h / r.height) if pad
             else target_w / r.width)
    pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=True)
    if not pad:
        pix.save(out_path)
        print(f"  created {out_path} ({pix.width}x{pix.height})")
        return
    img = Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGBA")
    canvas_img = Image.new("RGBA", (target_w, target_h), (0, 0, 0, 0))
    x = (target_w - img.width) // 2
    y = (target_h - img.height) // 2
    canvas_img.paste(img, (x, y), img)
    canvas_img.save(out_path)
    print(f"  created {out_path} ({canvas_img.width}x{canvas_img.height}, contain)")


def main():
    check_src(ICON_SRC)
    check_src(BOOST_SRC)
    os.makedirs(PUBLIC, exist_ok=True)

    # 1) 应用图标族（icon-logo.ai，方形，每尺寸矢量直接栅格化）
    icon_doc = fitz.open(ICON_SRC)
    if icon_doc.page_count < 1 or icon_doc[0].rect.width != icon_doc[0].rect.height:
        print(f"WARNING: icon-logo.ai 画板非方形（{icon_doc[0].rect}），按宽度渲染")
    for size in ICON_SIZES:
        render_rect(icon_doc, 0, size, size, os.path.join(PUBLIC, f"icon-{size}.png"))
    icon_doc.close()
    # icon.png = 256 拷贝（main.cjs ICON_PATH / 快捷方式等引用）
    import shutil
    shutil.copyfile(os.path.join(PUBLIC, "icon-256.png"), os.path.join(PUBLIC, "icon.png"))

    # 2) UI 品牌 logo（boost-logo.ai 横版 → logo.png 宽 512 透明）
    boost_doc = fitz.open(BOOST_SRC)
    bpage = boost_doc[0]
    logo_w = 512
    scale = logo_w / bpage.rect.width
    lpix = bpage.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=True)
    lpix.save(os.path.join(PUBLIC, "logo.png"))
    print(f"  created {os.path.join(PUBLIC, 'logo.png')} ({lpix.width}x{lpix.height})")

    # 3) favicon（boost 方形化 contain 居中 → favicon-*.png）
    for size in FAVICON_SIZES:
        render_rect(boost_doc, 0, size, size,
                    os.path.join(PUBLIC, f"favicon-{size}.png"), pad=True)
    boost_doc.close()

    # 4) ico 打包（png-to-ico.cjs 参数化：basename 前缀 + 输出路径）
    for base, out in (("icon", "icon.ico"), ("favicon", "favicon.ico")):
        subprocess.run(
            ["node", os.path.join(ROOT, "scripts", "png-to-ico.cjs"),
             base, os.path.join(PUBLIC, out)],
            check=True, cwd=ROOT,
        )
    print("Done. 图标族已生成于 public/")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: png-to-ico.cjs 参数化**（读文件后修改）——头部常量改为取 argv：`const base = process.argv[2] || 'icon'`、`const outPath = process.argv[3] || path.join(PUBLIC, 'icon.ico')`、SIZES 读对应 `icon-${size}.png`→`${base}-${size}.png`；末尾写 `outPath` 且 favicon 场景允许尺寸子集（favicon 用 16/32/48/64 已在 render 生成 favicon-64.png，SIZES 数组对 favicon 仍需含 64——favicon SIZES=[16,32,48,64] 由调用方以第 4 参传入或默认全 6；简化：SIZES 固定 [16,32,48,64,128,256]，render 只生成需要的尺寸即可，favicon 只需 16/32/48/64，为避免缺 128/256 报错，SIZES 改为过滤存在文件：`const SIZES = [16,32,48,64,128,256].filter(s => fs.existsSync(path.join(PUBLIC, `${base}-${s}.png`)))`。**以读到的现文语义为准落笔，保证默认无参调用行为与旧版一致**。
- [ ] **Step 3: 生成前快照对比（基线）**：`git status --short public/` 确认 10 个目标文件均为 tracked 且当前内容（旧图标），记录 hash 供 diff。
- [ ] **Step 4: 执行渲染**
```bash
python scripts/render-ai-assets.py
```
预期：public/ 下 6 个 icon-*.png（16/32/48/64/128/256）+ icon.png + icon.ico + logo.png（512 宽）+ favicon-16/32/48/64.png + favicon.ico 均生成，无 ERROR。
- [ ] **Step 5: 清理中间产物 + 验证**
```bash
rm -f public/favicon-16.png public/favicon-32.png public/favicon-48.png public/favicon-64.png   # 仅打包中间产物，favicon.ico 已生成；重跑 render 会重新生成
python -c "
import struct,glob,os
for f in sorted(glob.glob('public/icon-*.png')+['public/logo.png']):
    with open(f,'rb') as fh: assert fh.read(8)==b'\x89PNG\r\n\x1a\n', f+' not png'
    print(f, os.path.getsize(f))
for f in ['public/icon.ico','public/favicon.ico']:
    with open(f,'rb') as fh:
        h=fh.read(6); n=struct.unpack('<H',h[4:6])[0]
        assert h[:4]==b'\x00\x00\x01\x00'
        print(f, 'entries:', n)
"
git diff --stat public/icon.png public/icon.ico public/icon-256.png   # 均为修改非新增
git status --short | grep -v '^ M public/' | head        # 除 public 图标族外无其他改动
```
- [ ] **Step 6: 渲染质量自检**
```bash
python -c "
from PIL import Image
im = Image.open('public/icon-256.png').convert('RGBA')
w,h = im.size; px = im.getpixel((w//2,h//2))
assert px[3] == 255, 'icon-256 中心应为不透明'
print('icon-256 center rgba:', px)
assert not (px[0]>245 and px[1]>245 and px[2]>245), '中心非纯白（纯白=渲染失败占位）'
im16 = Image.open('public/icon-16.png').convert('RGBA')
colors = im16.getcolors(maxcolors=100000)
opaque = sum(n for n,c in colors if c[3]>200) / (16*16)
assert opaque > 0.05, 'icon-16 内容过少'
print('icon-16 不透明占比: %.0f%%' % (opaque*100))
logo = Image.open('public/logo.png').convert('RGBA')
print('logo size:', logo.size)
"
```
- [ ] **Step 7: Commit**
```bash
git add scripts/render-ai-assets.py scripts/png-to-ico.cjs public/icon-16.png public/icon-32.png public/icon-48.png public/icon-64.png public/icon-128.png public/icon-256.png public/icon.png public/icon.ico public/favicon.ico public/logo.png
git commit -m "feat(s6): 图标统一 icon-logo.ai 渲染图标族 + boost-logo.ai 渲染 UI logo/favicon（D6-F/G/H）"
```
（favicon-{16,32,48,64}.png 为中间产物——若 render 脚本未清理，在 .gitignore 检查或 commit 前确认不入库：这些文件可删，favicon.ico 已打包；Step 4 后 `rm public/favicon-*.png` 作为可选清理，若删除则在 commit 前的 add 列表不含它们即可——但下次重跑需重新生成。**决策：favicon-*.png 不删不入库，render 脚本每次重生成**——验证 add 列表只含上方列出的文件。）

---

## Task 2: 便携出包前置产物（dist/kernel-dist/runtime/python/runtime/skills）

**Files:**
- 无 git 改动（全部为 gitignored 构建产物，除 skills 组装）

**Interfaces:**
- Consumes: 仓库源（dist=public 最新含 T1 新图标）、kernel/（build-kernel.mjs 输入）、~/.yfworking/skills（homedir 动态）
- Produces: `dist/`（npm run build 最新）、`kernel-dist/cli.mjs`（build-kernel 产物）、`runtime/python/python.exe`、`runtime/skills/`——Task 3 出包输入

- [ ] **Step 1: 重建前端 dist**（public 新图标随 vite 复制进 dist）
```bash
npm run build
```
预期：typecheck 0 error、vite build 成功；`ls dist/favicon.ico dist/icon.png` 与 public 同源。
- [ ] **Step 2: 重建内核 bundle**
```bash
node scripts/build-kernel.mjs
```
预期：`kernel-dist/cli.mjs` 重新生成（du 约 200KB）。
- [ ] **Step 3: 构建嵌入式 python runtime**（耗时 5-10 分钟，耐心等完）
```bash
node scripts/build-embedded-python.mjs
```
预期：`runtime/python/python.exe` 存在；du -sh runtime/python 记录体积。
- [ ] **Step 4: 组装 runtime/skills**（源 = homedir 技能，动态解析）
```bash
node -e "const fs=require('fs'),os=require('os'),p=require('path');const src=p.join(os.homedir(),'.yfworking','skills');const dst=p.join('runtime','skills');if(!fs.existsSync(src)){console.error('skills 源缺失:',src);process.exit(1)}fs.rmSync(dst,{recursive:true,force:true});fs.cpSync(src,dst,{recursive:true});console.log('skills 组装完成 ->',dst)"
du -sh runtime/skills
```
- [ ] **Step 5: 校验**
```bash
test -f dist/index.html && test -f kernel-dist/cli.mjs && test -f runtime/python/python.exe && echo "前置就绪"
ls runtime/skills | head -5
```
- [ ] **Step 6: 无 commit**（全部 gitignored；`git status --short` 预期空或仅 untracked YF//文档）。记录产物体积到 report 供 T4 审计对照（python/skills 体积基线）。

---

## Task 3: package-portable.cjs 修订 + 便携出包 + 布局核对 + 桌面快捷方式

**Files:**
- Modify: `scripts/package-portable.cjs`
- Create: `scripts/verify-portable-layout.mjs`

**Interfaces:**
- Consumes: Task 1 图标族（public/）、Task 2 前置产物（dist/kernel-dist/runtime）、`build/templates/`（T1 Batch A）
- Produces: `release/YFWorking/`（便携版完整目录 + VBS 启动器 + debug bat）、桌面 `YFWorking.lnk`、`scripts/verify-portable-layout.mjs`

- [ ] **Step 1: 修订 package-portable.cjs——补模板资源拷贝**（`[2/5] Copying app files...` 段后新增）：将 `build/templates/{agents,memory,tools}` 拷至 `release/YFWorking/runtime/{agents,memory,tools}`，注释注明「对齐 electron-builder extraResources `to: runtime/agents|memory|tools`（T1 改接源）语义；main.cjs dev 形态候选解析 app 根 runtime/（main.cjs:46 先例）。**若 build/templates 缺失则 console.error 并 process.exit(1)**（便携不完整宁可失败）。参考既有 cpDir 用法写；并在「Copy embedded Python runtime」与「Copy skills」日志风格一致。
- [ ] **Step 2: 修订 package-portable.cjs——桌面路径健壮化**：`const DESKTOP = path.join(require('os').homedir(), 'Desktop')` 替换为 PowerShell 真实桌面解析（兼容 OneDrive 重定向）：
```js
// S6 Batch B：真实桌面解析（OneDrive 重定向安全），PowerShell 查询一次
const DESKTOP = execSync(
  "powershell -NoProfile -Command \"[Environment]::GetFolderPath('Desktop')\"",
  { encoding: 'utf8', timeout: 10000 },
).trim()
```
（execSync 已 require；如解析失败回退原 homedir 逻辑并 console.warn——加 try/catch。）
- [ ] **Step 3: 核对既有逻辑与 Global Constraints 一致性**：确认 pet 拷贝与 electron-builder extraResources pet 3 项一致（现有实现已含）；确认 kernel 落位 `kernel/cli.mjs`、node.exe bundle、VBS/快捷方式引用新 public/icon.ico（自动）。**不引入新的功能行为差异**。
- [ ] **Step 4: 执行出包**
```bash
node scripts/package-portable.cjs
```
预期：[1/5]..[5/5] 全过；release/YFWorking/ 生成；桌面 YFWorking.lnk 生成；console 输出 Location/Desktop shortcut。
- [ ] **Step 5: 布局核对脚本 `scripts/verify-portable-layout.mjs`（Create，verbatim）**

```js
// S6 Batch B 便携布局核对：断言 release/YFWorking/ 结构完整（对齐 electron-builder extraResources 语义）
import { existsSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const R = join(ROOT, 'release', 'YFWorking')

const requiredDir = ['dist', 'electron', 'server', 'public', 'pet', 'pet/assets',
  'runtime/python', 'runtime/skills', 'runtime/agents', 'runtime/memory', 'runtime/tools',
  'kernel', 'node_modules/electron']
const requiredFile = ['node.exe', 'YFWorking.vbs', 'YFWorking-debug.bat',
  'electron/electron.exe', 'electron/main.cjs', 'kernel/cli.mjs',
  'runtime/python/python.exe', 'public/icon.ico', 'public/icon.png', 'public/logo.png']
let fail = 0
for (const d of requiredDir) if (!existsSync(join(R, d))) { console.error('MISSING DIR:', d); fail++ }
for (const f of requiredFile) if (!existsSync(join(R, f))) { console.error('MISSING FILE:', f); fail++ }
// 模板三组非空
for (const g of ['agents', 'memory', 'tools']) {
  const dir = join(R, 'runtime', g)
  if (!existsSync(dir) || readdirSync(dir).length === 0) { console.error('EMPTY templates:', g); fail++ }
}
// 快捷方式已建
const desktop = process.env.S6_TEST_DESKTOP || join(process.env.USERPROFILE || '', 'Desktop')
const lnk = join(desktop, 'YFWorking.lnk')
if (!existsSync(lnk)) { console.warn('WARN: 桌面快捷方式未找到（若在测试环境/重定向桌面可忽略）：', lnk) }
else console.log('OK 桌面快捷方式:', lnk)
// exe 图标非默认（体积启发：注入品牌图标后 exe > 原始 electron.exe 少量）
const exe = join(R, 'electron', 'electron.exe')
if (existsSync(exe)) console.log('electron.exe', (statSync(exe).size / 1024 / 1024).toFixed(1), 'MB')
if (fail) { console.error(`便携布局核对失败：${fail} 项缺失`); process.exit(1) }
console.log('便携布局核对通过')
```

- [ ] **Step 6: 运行核对**
```bash
node scripts/verify-portable-layout.mjs
```
预期：全部 OK（除 WARN 快捷方式需人工确认桌面重定向场景）。
- [ ] **Step 7: 校验 + 提交**
```bash
npm run typecheck   # 无 GUI 改动，0 error
node --test electron/browser-executor.test.mjs   # 不受影响
git status --short | grep -v 'release/' | grep -v '^??' | head
git add scripts/package-portable.cjs scripts/verify-portable-layout.mjs
git commit -m "feat(s6): package-portable 补模板资源 + 真实桌面路径 + 便携布局核对脚本（D6-B2/I）"
```

---

## Task 4: 文档清洗与 deferred minor 收口批

**Files:**
- Modify: `scripts/build_manual_pdf.py`（:21/:285 BASE 相对化 + V2.7.2/2026-08-20 → 2.8.0/2026-09-08）
- Modify: `docs/manual/YFWorking产品使用说明书.md`（如 PDF 重建发现残留）
- Modify: `scripts/verify-package-assets.mjs`（t1-minor2 删未用 readdirSync import）
- Modify: `package-lock.json`（root version 2.7.5 → 2.8.0）
- Modify: `BUILD.md`（:57 端口表述 t4-minor3；如便携文档需同步）
- Modify: `electron/browser-executor.test.mjs`（t5-minor1 :20 注释改「文件头」）
- Delete: `scripts/gen-icons.ps1`（Global Constraints 删除清单）
- Create（产物）: `docs/manual/YFWorking宣传页.pdf`、`docs/manual/YFWorking产品使用说明书.pdf`（重建）

**Interfaces:**
- Consumes: Task 3 便携（本批为文档面，无依赖便携）
- Produces: 净库文档字面全部同步净室现状；PDF 重建；gen-icons.ps1 退役

- [ ] **Step 1: build_manual_pdf.py BASE 相对化 + 版本清洗**：仿 T3 build_promo_pdf.py 处理（scripts/build_promo_pdf.py:17-21 为同族先例，读后对齐）：BASE = `os.path.dirname(os.path.dirname(os.path.abspath(__file__)))`；`V2.7.2`/`2026-08-20` 字面 → `2.8.0`/`2026-09-08`；输出路径 repo 内。改后 `python -c "import ast; ast.parse(...)"` 语法校验。
- [ ] **Step 2: 重建 PDF 产物**：`python scripts/build_manual_pdf.py` 与 `python scripts/build_promo_pdf.py`（若脚本需 pdf 依赖缺，记录 verbatim 到 report 并标记 ⚠️ 交主 agent 裁决，**不要**擅自 pip install）。
- [ ] **Step 3: 扫 residual**：`grep -rn "claude-code-gui\|51309\|3099\|jiajia-pixel-pet\|V2\.7\.2\|2\.7\.5" scripts/ BUILD.md docs/manual/ --include=*.py --include=*.md --include=*.mjs`——预期 0（bridge-contract §10 例外）。gen-icons.ps1 已删。
- [ ] **Step 4: deferred minor 逐项收口**（t1-minor2 删 import 行；t2-minor1 改 package-lock.json root version 字段；t4-minor3 BUILD.md:57 表述替换；t5-minor1 注释位置改写）。每项 diff 最小化。
- [ ] **Step 5: 验证**
```bash
python -c "import ast; ast.parse(open('scripts/build_manual_pdf.py',encoding='utf-8').read())"   # 语法有效（不执行渲染）
npm run typecheck && node --test electron/browser-executor.test.mjs && node --test server/deploy-smoke.test.mjs
git diff --stat   # 仅目标文件
```
- [ ] **Step 6: Commit**（分两笔或一笔均可，前缀 docs(s6)/chore(s6)；删除 gen-icons.ps1 单独 `git rm` 前复查 `git log --oneline -- scripts/gen-icons.ps1` 记录无独有逻辑）
```bash
git add scripts/build_manual_pdf.py package-lock.json BUILD.md electron/browser-executor.test.mjs scripts/verify-package-assets.mjs docs/manual/*.pdf
git rm scripts/gen-icons.ps1
git commit -m "chore(s6): 文档清洗收口——build_manual_pdf 相对化+PDF 重建、deferred minors（t1-2/t2-1/t4-3/t5-1）、gen-icons.ps1 退役"
```

---

## Task 5: 四层零残留审计收口（便携产物面 + 代码面 + 依赖面 + CRLF）

**Files:**
- Create（scratch 报告）: `.superpowers/sdd/2026-09-08-s6-batchb-portable/task-5-audit-report.md`

**Interfaces:**
- Consumes: Task 3 便携产物 `release/YFWorking/`、Task 4 清洗后的库
- Produces: 四层审计结论 + CRLF 字节复核结论（backlog⑥ 关闭或转遗留）

- [ ] **Step 1: 代码面全库残留扫描**（白名单除外）：
```bash
grep -rn "51309\|5173\|3099\|yfw-kernel\|claude-code-gui\|jiajia-pixel-pet\|2\.7\.2\|2026-08-20" --include="*.mjs" --include="*.cjs" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.json" --include="*.py" . 2>/dev/null | grep -v node_modules | grep -v ".git/" | grep -v "bridge-contract.md" | head -30
```
白名单：`docs/bridge-contract.md`、`docs/superpowers/` 历史记录。transcriptAdapter.test.ts 的 51309 fixture——按「代码面审计」判定：是测试 fixture（模拟旧端口）则记录并保留（附白名单理由）或改为 51517 语义（如 fixture 模拟新环境）。**implementer 读上下文后裁决并披露**，不擅自删测试。
- [ ] **Step 2: 产物面标记探测**（便携 kernel/cli.mjs vs 旧内核对照）：
```bash
node -e "const fs=require('fs');for(const f of ['release/YFWorking/kernel/cli.mjs','C:/Users/T203-15/claude-code-gui/release/YFWorking/kernel/cli.mjs']){const s=fs.existsSync(f)?fs.readFileSync(f,'utf8'):'';if(!s){console.log('MISSING:',f);continue}console.log(f, (s.match(/ponos/gi)||[]).length, 'ponos', (s.match(/anthropic/gi)||[]).length, 'anthropic', (s.length/1024/1024).toFixed(2)+'MB')}"
```
预期：便携 ponos>0、anthropic=0（协议字段名/许可证文本白名单除外，参照 S6 §四层审计标准）；旧内核 anthropic 大量命中（对照基线，若旧便携产物缺失则注明）。
- [ ] **Step 3: 依赖面**：`node --test server/deploy-smoke.test.mjs` 全绿（内核零依赖断言）。补充对便携 `release/YFWorking/kernel/cli.mjs` 的 node 直跑冒烟：`node release/YFWorking/kernel/cli.mjs --help` exit 0。
- [ ] **Step 4: 测试面**：`npm test`（145/145）与 `node --test kernel-tests/*.test.mjs`（50/50）复跑。
- [ ] **Step 5: CRLF/.gitattributes 字节复核**（backlog⑥）：检查 `.gitattributes` 现状、git 报告的行尾警告文件清单、`git ls-files --eol` 抽样（对 public/ 图标二进制、scripts/*.py、BUILD.md 等）。结论：行尾一致性风险点清单 + 处理建议（如无需强制改造则标注 backlog⑥ 关闭于「字节复核完成、无功能风险」）。
- [ ] **Step 6: 审计报告**写入 scratch（四层各层结论 verbatim + 白名单命中逐项 + 遗留建议）。无 git 改动（除非 Step 1 裁决需改测试 fixture——若改，单独 commit `chore(s6): 审计代码面清理`）。

---

## Task 6: GUI 全栈功能冒烟（便携版，自动为主 + manual 授权清单）

**Files:**
- Create（scratch）: `.superpowers/sdd/2026-09-08-s6-batchb-portable/task-6-smoke-report.md`

**Interfaces:**
- Consumes: Task 3 便携 `release/YFWorking/`（YFWorking.vbs 启动）+ Task 1 图标
- Produces: 冒烟记录 + manual 行授权清单（待用户执行）

- [ ] **Step 1: 自动启动便携 + 健康检查**：
```bash
cd release/YFWorking && cscript //Nologo YFWorking.vbs   # 无终端启动
# 等待 5-8s 后：
curl -s http://127.0.0.1:51517/__health 或（无该端点则按 server/bridge.mjs 既有健康探针语义）——implementer 先读 server/bridge.mjs 找健康端点/探针，用既有方式断言 bridge 起、端口 51517 监听
netstat -ano | grep 51517 | head -3
```
启动与退出需用户在场确认 GUI 窗口出现？——**自动行**：进程出现 + 端口监听 + kernel bootstrap 缓存（home 下 runtime/ponos-kernel）生成。**manual 行**（授权用户在 GUI 上操作核对）：窗口图标/托盘图标为新 icon-logo、Header/气泡 logo 为 boost-logo、窗口标题 YFWorking 2.8.0。
- [ ] **Step 2: 模板首启安装验证**：确认 home（隔离或默认）下 `agents/`、`memory/personal/`、`tools/` 模板落位（计数与 build/templates 一致：agents 11 / memory 7 / tools 3 文件）。若 portable 用默认 home 会与开发态混用——**用隔离 home**：`YFWORKING_HOME=<tmp>` 启动便携实例（kernel bootstrap 落 `<tmp>/runtime/ponos-kernel`），避免污染真实 home。implementer 按 S4 T6 双版冒烟先例（roadmap S4 节 :69）组织隔离 home 启动。
- [ ] **Step 3: bridge 会话冒烟**（复用 S4 T6 语义：RESULT subtype=success）：读 server/bridge.mjs 的会话协议，发最小 echo/会话请求断言 subtype=success。
- [ ] **Step 4: 浏览器 executor 环境性**：默认 home 下跑 `node --test electron/browser-executor.test.mjs`（T5 Batch A 修复后应绿——回归基线）。
- [ ] **Step 5: manual 授权清单交付**：GUI 视觉与交互行（见 Step 1 manual）列表写入报告，标注「待用户授权执行」。自动行全绿即 Task 通过（manual 行随完结汇报呈用户）。
- [ ] **Step 6: 退出便携实例**（干净回收测试进程与隔离 home；**杀进程需用户已批准？**——本 Task 自启进程自动回收属本 Task 内部管理，结束前必须确认退出后无残留端口 51517；如杀进程涉及在售/其它会话进程，暂停征询）。无 git 改动。

---

## Task 7: 双版并存运行验证（新版便携 51517 vs 在售旧版 51309）

**Files:**
- Create（scratch）: `.superpowers/sdd/2026-09-08-s6-batchb-portable/task-7-dual-report.md`

**Interfaces:**
- Consumes: Task 3 便携（新版）+ 在售旧版便携（`C:\Users\T203-15\claude-code-gui\release\YFWorking`，51309）
- Produces: 双版并存验证记录

- [ ] **Step 1: 现状核对**：在售旧版目录存在性 + 端口占用（`netstat -ano | grep -E "51309|51517"`）+ 运行中 electron 进程归属（不杀任何既有进程；如需停旧版启动新版，**暂停征询用户**）。
- [ ] **Step 2: 并存验证**（复用 S4 T6 已验证模式，roadmap S4 节 :69 语义）：新版便携隔离 home 启动（51517 healthy），旧版在售（51309）不动/或按现状运行；断言：两端口同时监听、两版本 home 数据互不污染（新版 home=隔离临时目录，旧版=真实 home 或旧便携自带）、新版 bootstrap 落 `<隔离home>/runtime/ponos-kernel` 不影响旧版 `runtime/kernel` md5（对照 S4 记录基线 `86697d84…`）。
- [ ] **Step 3: 双快捷方式并存**：桌面现有 YFWorking.lnk（便携新版）与安装版/旧版快捷方式差异说明（BUILD.md:88 已知同名场景）——记录现状即可，不删改既有快捷方式。
- [ ] **Step 4: 记录 + 清理**：报告 verbatim；测试进程与隔离 home 回收。无 git 改动。

---

## Task 8: 完结——回归 + roadmap S6 完结标注 + ledger + 汇报 + 破坏性 ops 征询清单

**Files:**
- Modify: `docs/superpowers/plans/2026-09-07-s3-s6-cleanroom-roadmap.md`（S6 节 Batch B 完结标注 + 执行记录）
- Create（scratch）: `.superpowers/sdd/2026-09-08-s6-batchb-portable/{progress.md,task-N-report.md}`

**Interfaces:**
- Consumes: Task 1-7 全结果 + 各 scratch report
- Produces: roadmap S6 完结、Batch B ledger、全量回归证据、破坏性 ops 逐项征询清单

- [ ] **Step 1: roadmap S6 节更新**：S6 节追加「执行记录（2026-09-08，S6 Batch B 完结）」：commit 链、D6-A~I 决策全集补录（D6-B2/F/G/H/I）、Batch B 清单逐项处置状态（便携出包完成 + 产物结构核对/四层审计/冒烟/双版/文档清洗收口各结论；NSIS 安装包 = 明确留后续批（D6-B2））、deferred minors 处置表（含终审 carry-forward build_manual_pdf）、backlog⑥ CRLF 结论。Batch B 其余未完结项（如 NSIS 出包、旧图标资产清理）转开放项/后续批。
- [ ] **Step 2: ledger + 残余扫描**：Batch B ledger 全量记录（每 Task commit/验证/minors）+ 完成报告（仿 S5/S6-A 样式）写 scratch。
- [ ] **Step 3: 全量回归**：
```bash
npm run typecheck && npm test && node --test kernel-tests/*.test.mjs && npm run build
```
预期：0 error / 145/145 / 50/50 / build 成功。
- [ ] **Step 4: Commit**：`git add docs/superpowers/plans/2026-09-07-s3-s6-cleanroom-roadmap.md` → `docs(s6): roadmap S6 Batch B 完结标注 + 执行记录 + 后续批交接`
- [ ] **Step 5: 完结汇报（主 agent 输出）**：Batch B 汇报 + **破坏性 ops 逐项征询清单**（退役在售旧库 yfw-kernel/旧便携产物、清理 release/ 历史构建副本 YFWorking_ms92cd6u、旧图标程序化资产、NSIS 出包是否开工等——每项待用户逐条授权，不自动执行）。

## 门禁与纪律

- 每 Task implementer（subagent）+ 1 轮 reviewer（只读复核 spec 合规 + quality；Critical/Important/Minor 分级）；reviewer 关注：范围纪律（kernel/kernel-tests/version.mjs/YF 零触碰）、删除清单仅含批准项（gen-icons.ps1）、拷贝/源只读（YF/ .ai 不修改）、git add 不误收（dist/runtime/release/kernel-dist/node.exe/YF）、不实跑 NSIS 安装包（D6-B2）。
- 删除/拷贝动作以 Global Constraints 清单为唯一依据；清单外 rm/mv/cp 须暂停征询。
- commit 前缀 `(s6)`；回归基线每 Task 收尾绿。
- **破坏性 ops（在售旧库退役、进程管理、release 清理）不在自动执行范围**：任何涉及杀进程/删在售产物/删 release 历史副本的步骤须暂停征询用户。
- Task 6/7 涉及 GUI 窗口与在售进程——自动断言优先，越界即转 manual 授权。
