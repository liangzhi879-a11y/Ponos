# -*- coding: utf-8 -*-
"""
YFWorking 宣传页 → A4 PDF 生成脚本
与产品使用说明书同尺寸（A4 竖版），品牌视觉沿用：
  - 远方橙 #FF4200 / 远方红 #FF2400
  - 玻璃质感卡片（半透明白 + 品牌渐变描边）
  - 标题 微软雅黑 900，正文 微软雅黑，数据 Consolas
流程：内联 HTML → Playwright Chromium 打印 A4 PDF（含页脚页码）。
借鉴 space-markdown-poster 的 Markdown→HTML→浏览器渲染管线，
但输出尺寸与品牌样式按说明书规格定制。
"""
import base64
import os

from playwright.sync_api import sync_playwright

# S6 清洗：BASE 由 repo 根解析（原硬编码旧库路径 claude-code-gui，随 S3 迁移失效）
BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # = <repo 根>（scripts/ 上一级）
IMG_DIR = os.path.join(BASE, "docs", "manual", "images")
LOGO_PNG = os.path.join(IMG_DIR, "logo_新远方数据LOGO横版.png")
OUT_PDF = os.path.join(BASE, "docs", "manual", "YFWorking宣传页.pdf")

ORANGE = "#FF4200"
RED = "#FF2400"
INK = "#221B15"
MUTED = "#7A7269"
TINT = "#FFF5EF"
LINE = "#F3DCD0"
GLASS = "rgba(255,255,255,0.78)"

# ---------------- Logo → base64 ----------------
logo_b64 = "data:image/png;base64," + base64.b64encode(open(LOGO_PNG, "rb").read()).decode()

CSS = """
@page { size: A4; }
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { font-family: 'Microsoft YaHei', 'PingFang SC', sans-serif; color: {ink}; }
.page { width: 210mm; height: 297mm; padding: 20mm 18mm 22mm 18mm; position: relative; overflow: hidden; page-break-after: always; }
.page:last-child { page-break-after: auto; }

/* ===== 页眉（每页） ===== */
.pagehead { display: flex; align-items: center; justify-content: space-between; border-bottom: 2px solid {line}; padding-bottom: 6mm; margin-bottom: 10mm; }
.pagehead .brand { display: flex; align-items: center; gap: 8px; }
.pagehead .logo { height: 8mm; object-fit: contain; }
.pagehead .wordmark { font-weight: 900; font-size: 15pt; letter-spacing: 1px; color: {ink}; }
.pagehead .wordmark em { font-style: normal; color: {orange}; }
.pagehead .eyebrow { font-family: Consolas, monospace; font-size: 8pt; letter-spacing: 3px; color: {muted}; }

/* ===== 章节标题 ===== */
.kicker { font-family: Consolas, monospace; font-size: 8.5pt; letter-spacing: 4px; color: {orange}; font-weight: 700; margin-bottom: 3mm; }
.h-title { font-size: 26pt; font-weight: 900; letter-spacing: 1px; line-height: 1.2; margin-bottom: 5mm; }
.h-sub { font-size: 11pt; color: {muted}; line-height: 1.7; margin-bottom: 8mm; }

/* ===== 玻璃卡片 ===== */
.glass {
  background: {glass};
  border: 1px solid rgba(255,66,0,0.28);
  border-radius: 5mm;
  box-shadow: 0 2mm 6mm rgba(255,66,0,0.06), inset 0 0 0 0.3mm rgba(255,66,0,0.06);
  padding: 7mm 8mm;
}

/* ===== 封面 ===== */
.cover { text-align: center; }
.cover .bg-glow { position: absolute; width: 120mm; height: 120mm; right: -38mm; top: -30mm; border-radius: 50%;
  background: radial-gradient(circle, rgba(255,66,0,0.16) 0%, rgba(255,66,0,0) 70%); z-index: 0; }
.cover .bg-grid { position: absolute; left: -20mm; bottom: 20mm; width: 90mm; height: 90mm; opacity: 0.5; z-index: 0;
  background-image: linear-gradient(rgba(255,66,0,0.10) 1px, transparent 1px), linear-gradient(90deg, rgba(255,66,0,0.10) 1px, transparent 1px);
  background-size: 10mm 10mm; }
.cover > * { position: relative; z-index: 1; }
.cover .logo-top { height: 14mm; object-fit: contain; margin-top: 16mm; }
.cover .c-eyebrow { font-family: Consolas, monospace; font-size: 9.5pt; letter-spacing: 6px; color: {orange}; margin-top: 14mm; font-weight: 700; }
.cover .c-title { font-size: 34pt; font-weight: 900; line-height: 1.35; letter-spacing: 2px; margin-top: 10mm; }
.cover .c-title .grad { background: linear-gradient(92deg, {orange} 20%, {red} 90%); -webkit-background-clip: text; background-clip: text; color: transparent; }
.cover .c-sub { font-size: 13pt; color: {muted}; margin-top: 9mm; line-height: 1.8; letter-spacing: 1px; }
.cover .c-badges { display: flex; justify-content: center; gap: 7mm; margin-top: 16mm; }
.cover .badge { min-width: 44mm; padding: 6mm 5mm; border-radius: 4mm; text-align: center; }
.cover .badge .b-en { font-family: Consolas, monospace; font-size: 7pt; letter-spacing: 2px; color: {orange}; font-weight: 700; }
.cover .badge .b-cn { font-size: 11.5pt; font-weight: 700; margin-top: 2mm; }
.cover .c-foot { position: absolute; bottom: 18mm; left: 0; right: 0; font-family: Consolas, monospace; font-size: 8.5pt; letter-spacing: 3px; color: {muted}; }

/* ===== 数据条 ===== */
.databar { display: flex; justify-content: space-around; margin-top: 10mm; padding: 6mm 4mm; border-radius: 4mm;
  background: linear-gradient(90deg, rgba(255,66,0,0.08), rgba(255,36,0,0.05)); border: 1px solid {line}; }
.databar .d { text-align: center; }
.databar .d-num { font-family: Consolas, monospace; font-size: 20pt; font-weight: 700; color: {red}; }
.databar .d-lab { font-size: 8.5pt; color: {muted}; margin-top: 1mm; letter-spacing: 1px; }

/* ===== 四支柱 ===== */
.pillars { display: grid; grid-template-columns: 1fr 1fr; gap: 6mm; }
.pillar .p-icon { width: 12mm; height: 12mm; border-radius: 3mm; background: linear-gradient(135deg, {orange}, {red});
  display: flex; align-items: center; justify-content: center; margin-bottom: 4mm; }
.pillar .p-icon svg { width: 7mm; height: 7mm; stroke: #fff; stroke-width: 2.2; fill: none; stroke-linecap: round; stroke-linejoin: round; }
.pillar .p-name { font-size: 13.5pt; font-weight: 800; margin-bottom: 3mm; }
.pillar .p-points { list-style: none; }
.pillar .p-points li { font-size: 9.5pt; color: #4a423a; line-height: 1.65; padding-left: 5mm; position: relative; }
.pillar .p-points li::before { content: ""; position: absolute; left: 0; top: 0.42em; width: 2.6mm; height: 2.6mm; border-radius: 50%;
  background: rgba(255,66,0,0.35); }

/* ===== 流程（场景页） ===== */
.flowstep { display: flex; gap: 5mm; align-items: flex-start; }
.flowstep .fs-no { flex-shrink: 0; width: 10mm; height: 10mm; border-radius: 50%; background: linear-gradient(135deg, {orange}, {red});
  color: #fff; font-size: 11pt; font-weight: 800; display: flex; align-items: center; justify-content: center; }
.flowstep .fs-body { flex: 1; padding-bottom: 5mm; border-bottom: 1px dashed {line}; }
.flowstep .fs-name { font-size: 11.5pt; font-weight: 800; margin-bottom: 1.5mm; }
.flowstep .fs-desc { font-size: 9pt; color: {muted}; line-height: 1.6; }

/* ===== 场景卡 ===== */
.scene { display: grid; grid-template-columns: 1fr 1fr; gap: 6mm; margin-top: 6mm; }
.scene-card .sc-tag { display: inline-block; font-family: Consolas, monospace; font-size: 7pt; letter-spacing: 2px; color: {orange};
  border: 1px solid rgba(255,66,0,0.4); border-radius: 2mm; padding: 1mm 3mm; font-weight: 700; margin-bottom: 3mm; }
.scene-card .sc-name { font-size: 12.5pt; font-weight: 800; margin-bottom: 2.5mm; }
.scene-card .sc-desc { font-size: 9pt; color: #4a423a; line-height: 1.7; }

/* ===== 血条示意 ===== */
.bar-demo { display: flex; gap: 4mm; margin-top: 3mm; }
.bar-demo .bd { flex: 1; text-align: center; }
.bar-demo .bd .track { height: 4mm; border-radius: 2mm; background: #f3ece6; position: relative; overflow: hidden; }
.bar-demo .bd .fill { position: absolute; inset: 0; border-radius: 2mm; }
.bar-demo .bd .lab { font-size: 7.5pt; color: {muted}; margin-top: 1.5mm; }
.g-fill { background: linear-gradient(90deg, #4caf50, #8bc34a); }
.y-fill { background: linear-gradient(90deg, #ffb300, #ffca28); }
.r-fill { background: linear-gradient(90deg, #f44336, #ff7043); }

/* ===== 结束语 ===== */
.closing { text-align: center; margin-top: 12mm; }
.closing .cl-mark { font-size: 20pt; font-weight: 900; letter-spacing: 2px; }
.closing .cl-mark .grad { background: linear-gradient(92deg, {orange} 20%, {red} 90%); -webkit-background-clip: text; background-clip: text; color: transparent; }
.closing .cl-sub { font-size: 10pt; color: {muted}; margin-top: 3mm; letter-spacing: 1px; }
.closing .cl-install { display: inline-block; margin-top: 6mm; padding: 4mm 10mm; border-radius: 3mm;
  background: linear-gradient(92deg, {orange}, {red}); color: #fff; font-size: 11pt; font-weight: 700; letter-spacing: 2px; }
""".replace("{orange}", ORANGE).replace("{red}", RED).replace("{ink}", INK).replace("{muted}", MUTED).replace("{line}", LINE).replace("{glass}", GLASS)

FOOTER = (
    '<div style="width:100%;font-size:0;padding:0 18mm;">'
    '<div style="display:flex;justify-content:space-between;align-items:baseline;'
    'font-size:7.5pt;font-family:Consolas,monospace;letter-spacing:1px;color:#9a9188;">'
    '<span>YFWorking V2.8.0 · 深圳市远方数据技术有限公司</span>'
    '<span>PAGE <span class="pageNumber"></span> / <span class="totalPages"></span></span>'
    '</div></div>'
)

# ================= 页面内容 =================
P1 = """
<div class="page cover">
  <div class="bg-glow"></div><div class="bg-grid"></div>
  <img class="logo-top" src="__LOGO__" alt="深圳市远方数据技术有限公司 Logo"/>
  <div class="c-eyebrow">YFWORKING · ENTERPRISE AI WORKBENCH</div>
  <div class="c-title">企业咨询项目与开发的<br/><span class="grad">AI 工作台</span></div>
  <div class="c-sub">对话、技能与智能体 —— 一站式完成企业申报、文档处理与软件开发<br/>让复杂项目从第一天起就进入正轨</div>
  <div class="c-badges">
    <div class="badge glass"><div class="b-en">LOCAL-FIRST</div><div class="b-cn">数据本地优先</div></div>
    <div class="badge glass"><div class="b-en">MULTI-MODEL</div><div class="b-cn">多模型自由接入</div></div>
    <div class="badge glass"><div class="b-en">SKILLS &amp; AGENTS</div><div class="b-cn">技能 · 智能体生态</div></div>
  </div>
  <div class="c-foot">YFWORKING 2.8.0 · NEW YUANFANG DATA · 2026-08</div>
</div>
"""

P2 = """
<div class="page">
  <div class="pagehead">
    <div class="brand"><img class="logo" src="__LOGO__" alt=""/><span class="wordmark">YF<em>Working</em></span></div>
    <div class="eyebrow">CORE CAPABILITIES</div>
  </div>
  <div class="kicker">CORE · 核心能力</div>
  <div class="h-title">一个工作台，四种力量</div>
  <div class="h-sub">围绕「对话 + 技能 + 智能体」构建，覆盖从想法到交付的完整链条。</div>
  <div class="pillars">
    <div class="pillar glass">
      <div class="p-icon"><svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h10M4 18h7"/><circle cx="20" cy="18" r="3"/></svg></div>
      <div class="p-name">AI 对话工作台</div>
      <ul class="p-points">
        <li>工作目录绑定，附件 / 图片 / 语音输入</li>
        <li>流式输出、斜杠命令、技能一键调用</li>
        <li>消息撤销重做、生成中插话与紧急打断</li>
      </ul>
    </div>
    <div class="pillar glass">
      <div class="p-icon"><svg viewBox="0 0 24 24"><path d="M12 3l2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z"/></svg></div>
      <div class="p-name">多模型供应商</div>
      <ul class="p-points">
        <li>DeepSeek / MiniMax 预设模板，即配即用</li>
        <li>任意 Anthropic 兼容 API 自定义接入</li>
        <li>独立视觉模型配置与连通性测试</li>
      </ul>
    </div>
    <div class="pillar glass">
      <div class="p-icon"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="13" width="8" height="8" rx="2"/><path d="M13 7h5v5M11 17H7v-5"/></svg></div>
      <div class="p-name">技能体系</div>
      <ul class="p-points">
        <li>高企认定 gxtz-* · 文档 yfwdoc-* 套件</li>
        <li>网页 yfwweb-* · 资质 yfwx-* 套件</li>
        <li>安装 / 卸载 / 更新，收藏与分类管理</li>
      </ul>
    </div>
    <div class="pillar glass">
      <div class="p-icon"><svg viewBox="0 0 24 24"><path d="M8 6l-5 6 5 6M16 6l5 6-5 6M13 4l-2 16"/></svg></div>
      <div class="p-name">文件与开发</div>
      <ul class="p-points">
        <li>Word / Excel / 代码应用内编辑</li>
        <li>Git 工作树、代码审查与提交</li>
        <li>文件浏览器 + 内嵌查看器</li>
      </ul>
    </div>
  </div>
  <div class="databar">
    <div class="d"><div class="d-num">16</div><div class="d-lab">专业智能体（11 专业 + 5 内置）</div></div>
    <div class="d"><div class="d-num">25+</div><div class="d-lab">系统自诊断检测项</div></div>
    <div class="d"><div class="d-num">6</div><div class="d-lab">主题（含玻璃质感 / 极速形态）</div></div>
  </div>
</div>
"""

P3 = """
<div class="page">
  <div class="pagehead">
    <div class="brand"><img class="logo" src="__LOGO__" alt=""/><span class="wordmark">YF<em>Working</em></span></div>
    <div class="eyebrow">ENTERPRISE SCENARIOS</div>
  </div>
  <div class="kicker">SCENARIO · 企业场景</div>
  <div class="h-title">企业咨询与申报，一条链路走完</div>
  <div class="h-sub">为高企认定、政策申报与日常办公打造的真实工作流，数据可溯源、材料可打包。</div>
  <div class="glass" style="padding:6mm 8mm;">
    <div class="sc-tag" style="font-family:Consolas,monospace;font-size:7pt;letter-spacing:2px;color:{orange};border:1px solid rgba(255,66,0,.4);border-radius:2mm;padding:1mm 3mm;font-weight:700;margin-bottom:4mm;">高新技术企业认定 · 全流程</div>
    <div class="flowstep"><div class="fs-no">1</div><div class="fs-body"><div class="fs-name">收资清单与企业信息调查</div><div class="fs-desc">一键生成资料清单，结构化收集企业基础数据</div></div></div>
    <div class="flowstep"><div class="fs-no">2</div><div class="fs-body"><div class="fs-name">RD / PS / IP / TOAI 四表联动生成</div><div class="fs-desc">研发项目、高新产品、知识产权与汇总表交叉校验，口径一致</div></div></div>
    <div class="flowstep"><div class="fs-no">3</div><div class="fs-body"><div class="fs-name">证明材料整理与审计核对</div><div class="fs-desc">专利证书、立项报告、专审报告核对、发票与产品匹配</div></div></div>
    <div class="flowstep"><div class="fs-no">4</div><div class="fs-body"><div class="fs-name">打包提交</div><div class="fs-desc">按申报系统要求压缩、命名校验，生成最终上传包</div></div></div>
  </div>
  <div class="scene">
    <div class="scene-card glass">
      <div class="sc-tag">BROWSER AUTOMATION</div>
      <div class="sc-name">内置浏览器自动化</div>
      <div class="sc-desc">可见窗口自动化、人工接管、域名白名单；支撑政策抓取、在线填表、企业信息核验。</div>
    </div>
    <div class="scene-card glass">
      <div class="sc-tag">LOOP &amp; SCHEDULE</div>
      <div class="sc-name">循环与定时任务</div>
      <div class="sc-desc">/loop 循环执行、一次性定时提醒，界面化引导创建。</div>
    </div>
    <div class="scene-card glass">
      <div class="sc-tag">DOCUMENT SUITE</div>
      <div class="sc-name">办公文档套件</div>
      <div class="sc-desc">公文、PPT、PDF、Excel 四大套件：红头文件、汇报路演、扫描识别、数据分析。</div>
    </div>
  </div>
</div>
"""

P4 = """
<div class="page">
  <div class="pagehead">
    <div class="brand"><img class="logo" src="__LOGO__" alt=""/><span class="wordmark">YF<em>Working</em></span></div>
    <div class="eyebrow">EXPERIENCE &amp; ASSURANCE</div>
  </div>
  <div class="kicker">EXPERIENCE · 体验与保障</div>
  <div class="h-title">聪明地工作，也安心地工作</div>
  <div class="h-sub">上下文健康、系统自诊断、主题与性能调优 —— 把复杂留给系统，把简单留给你。</div>
  <div class="pillars">
    <div class="pillar glass">
      <div class="p-icon"><svg viewBox="0 0 24 24"><path d="M12 3l7 4v5c0 4.5-3 8.5-7 9-4-.5-7-4.5-7-9V7z"/></svg></div>
      <div class="p-name">上下文健康监控</div>
      <ul class="p-points">
        <li>输入框下方血条，实时显示上下文余量</li>
        <li>红档自动上浮「新建会话 / 携带摘要」建议</li>
      </ul>
      <div class="bar-demo">
        <div class="bd"><div class="track"><div class="fill g-fill" style="width:85%"></div></div><div class="lab">健康</div></div>
        <div class="bd"><div class="track"><div class="fill y-fill" style="width:55%"></div></div><div class="lab">注意</div></div>
        <div class="bd"><div class="track"><div class="fill r-fill" style="width:22%"></div></div><div class="lab">建议新建</div></div>
      </div>
    </div>
    <div class="pillar glass">
      <div class="p-icon"><svg viewBox="0 0 24 24"><path d="M12 8v4l3 3M12 3a9 9 0 100 18 9 9 0 000-18z"/></svg></div>
      <div class="p-name">系统自诊断</div>
      <ul class="p-points">
        <li>25+ 项环境检测（内核 / 桥接 / 浏览器 / Python）</li>
        <li>一键重测、日志落盘、诊断报告导出</li>
      </ul>
    </div>
    <div class="pillar glass">
      <div class="p-icon"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/></svg></div>
      <div class="p-name">主题与极速形态</div>
      <ul class="p-points">
        <li>六套主题：亮色 / 暗色 / 玻璃质感等自由切换</li>
        <li>低配设备（CPU ≤ 4 核或内存 ≤ 4GB）自动引导极速形态</li>
        <li>GPU 异常自动降级，核心功能不中断</li>
      </ul>
    </div>
    <div class="pillar glass">
      <div class="p-icon"><svg viewBox="0 0 24 24"><path d="M12 2a5 5 0 015 5v3a5 5 0 01-10 0V7a5 5 0 015-5zM4 12h16M12 17v4"/></svg></div>
      <div class="p-name">桌面宠物「嘉嘉」</div>
      <ul class="p-points">
        <li>陪伴式桌面小助手，随任务状态实时互动</li>
        <li>托盘后台运行，通知时机可选</li>
      </ul>
    </div>
  </div>
  <div class="closing">
    <div class="cl-mark">让每一个项目，都从 <span class="grad">AI 工作台</span> 开始</div>
    <div class="cl-sub">YFWorking —— 企业咨询项目与开发的 AI 工作台 · 数据本地优先 · 技能生态持续生长</div>
    <div class="cl-install">Windows 10 / 11（64 位）· 下载安装即可体验</div>
  </div>
</div>
"""

HTML = ("<!DOCTYPE html><html lang='zh-CN'><head><meta charset='utf-8'>"
        "<style>" + CSS + "</style></head><body>"
        + P1 + P2 + P3 + P4
        + "</body></html>").replace("__LOGO__", logo_b64)

# ================= 渲染 =================
with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    page.set_content(HTML, wait_until="load")
    page.wait_for_timeout(600)
    page.pdf(
        path=OUT_PDF, format="A4", print_background=True,
        margin={"top": "0mm", "bottom": "0mm", "left": "0mm", "right": "0mm"},
        display_header_footer=True,
        header_template="<span></span>",
        footer_template=FOOTER,
    )
    browser.close()

print("OK:", OUT_PDF)
