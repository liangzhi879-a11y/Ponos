# 内置浏览器自动化（可见模式）设计

- 日期：2026-08-18
- 状态：已获用户逐节批准，待实施计划

## 1. 背景与目标

Ponos 现有网页操作能力为 Python Playwright 沙箱（yfwweb-* 技能），完全隔离、用户不可见。
目标是新增**应用内置浏览器**的可见自动化模式：一个独立的 Electron 浏览器窗口由内核 agent 驱动，
操作方式与真人一致（看一眼 → 操作 → 再看一眼），用户可围观、可直接上手操作（验证码/人工确认）、
可随时暂停接管。

**定位**：与 Playwright 沙箱互补。Playwright 保留做批量静默抓取；内置浏览器专攻需要登录态、
验证码、人工确认、用户围观的复杂操作（申报系统填表、企业信息核验等）。

**核心约束**：决策环必须**纯文字模型可跑**（deepseek-v4-flash 无视觉），截图不作为模型决策输入。

## 2. 决策记录（用户确认）

| 决策点 | 结论 |
|---|---|
| 与 Playwright 关系 | 补充可见模式，不替代 |
| 窗口形态 | 独立 BrowserWindow（可缩放、用户可直接操作） |
| 交互保真度 | CDP 可信输入事件（webContents.debugger Input 域） |
| 人工协作 | 暂停等待 + 自动继续（页面变化检测触发恢复） |
| 会话管理 | 按会话分区隔离（partition = persist:automation-{conversationId}） |
| 首场景 | 通用能力 + 企业信息核验（gsxt）垂直切片 |
| 实现路线 | 方案 A：bridge 路由 + 主进程执行器 |
| 监视控制台 | 精简状态条 + 聊天集成（不做独立面板） |
| 反爬兜底 | 行为拟真作 opt-in 兜底（默认关、人工闸门、审计标注）；破解类始终禁止 |

## 3. 架构总览与进程拓扑

```
┌─ GUI renderer (React) ──────── 精简状态条：状态/暂停继续/打开窗口；聊天集成结果与截图
│        ▲ IPC（控制按钮，不经内核）
├─ Electron 主进程 ───────────── 浏览器执行器 browser-executor.cjs
│    ├─ spawn/监管 bridge（既有）
│    └─ 自动化窗口（按会话分区 lazily 创建）+ webContents.debugger（CDP）
│        ▲ WS 客户端（新增，注册 browser-executor 通道，复用 bridge 健康重连）
├─ bridge (node 51311) ───────── 新增路由：browser:exec 请求/响应中继 + browser:event 广播
│        ▲ WS（会话）
└─ kernel (bun, 每会话一个) ──── 新增 `browser` 工具：LLM 决策环（纯文本快照驱动）
```

- 内核 `browser` 工具是唯一决策入口：发出操作指令并等待快照返回，LLM 据索引化交互树决定下一步。
- 主进程执行器是唯一能碰窗口/分区/下载/对话框的组件。
- renderer 只做监视与控制，不做命令中继。

数据流（一次操作）：内核工具 → `browser:exec` WS → bridge → 主进程执行器 → 窗口执行 →
结果+快照原路返回内核 `tool_result`；期间 bridge 向 renderer 广播 `browser:event` 状态
（当前操作/暂停中/拟真模式）。

## 4. 组件设计

### 4.1 内核 `browser` 工具（协议）

工具签名：`browser_operate(action, params) → { ok, snapshot?, error? }`

动作集（v1）：

| 动作 | 参数 | 说明 |
|---|---|---|
| `goto` | url | 导航（含域名白名单校验） |
| `back` / `forward` / `refresh` | — | 导航 |
| `snapshot` | — | 取当前页索引化交互树快照 |
| `click` | ref | 按快照索引点击（命中盒坐标由执行器计算） |
| `type` | ref, text, clear? | 聚焦 + CDP 可信键盘输入 |
| `select` | ref, value | `<select>` 选项 |
| `scroll` | ref \| delta | 滚动到元素或按像素滚动 |
| `hover` | ref | 悬停 |
| `wait` | ms \| ref | 等待固定时间或元素出现 |
| `pause_for_human` | hint? | 暂停等人工介入（验证码/确认），内核挂起不超时 |
| `resume` | — | 人工完成后恢复（通常由执行器自动触发） |
| `close` | — | 关闭本次浏览器会话（可选保留窗口） |

超时：单动作 30s 默认（wait 类可更长）；`pause_for_human` 不超时；工具整体 60s 上限
（超时返回错误 + 最新快照）。每次动作结果都附最新快照，模型无需额外 snapshot 调用。

### 4.2 快照协议（纯文本模型优先）

快照为索引化交互树，尺寸有界（约 3-6K tokens）：

```
page:       { url, title, readyState, loading, 出现验证码 }
alerts:     [ "已找到 3 条结果", "验证码错误" ]      ← 可见提示文本
changes:    "+2 按钮 · URL 变化 · 出现验证码"          ← 与上版快照差异摘要
interactives: ← 只含可交互元素，层级缩进，最多 ~300 条
  { ref: 12, tag: button, label: "查询", path_hint: "表单区" }
  { ref: 13, tag: input,  label: "企业名称", value: "锐取电子", type: text }
  { ref: 14, tag: link,   label: "下一页", href: "/list?p=2" }
info:       ← 只读信息行（取证文本；表格折叠为前 N 行 + 行数）
truncated: 45   ← 裁剪掉的节点数
```

关键设计：
1. **ref 索引替代选择器**：快照生成时执行器为每个节点预计算稳定选择器
   （优先 id/name/placeholder/aria-label/data-testid → 角色+序号 → nth-child 路径）；
   模型只说 `click(12)`，从不写 CSS 选择器。
2. **自动等加载**：快照捕获前自动等网络空闲（~800ms 静默）；loading/转圈状态显式上抛。
3. **差异摘要**：每次动作后附带与上版快照的 diff（新增/消失元素、URL 变化、提示文本）。
4. **验证码识别**：图片节点/已知验证码容器特征暴露"出现验证码"信号 → 模型调 `pause_for_human`。
5. **截图降级为证据**：默认不喂模型；若配置 visionModel 可显式请求"视觉确认"；否则截图进
   状态条缩略图（人眼）+ 取证落盘 + 回填聊天——"模型用文字、人用眼睛"。
6. **裁剪策略**：折叠隐藏/装饰/重复导航；超长文本截断（60 字符 + 省略标记）；表格只读前 N 行。

### 4.3 bridge 路由（新增）

- 新消息类型：`browser:exec`（请求/响应）、`browser:event`（状态广播到 renderer）。
- 主进程 WS 客户端注册为 browser-executor 通道（单例，应用本身）；连接断开沿用 bridge
  健康重连机制。
- 路由规则：按会话 sid（conversationId）关联分区；请求带 requestId，响应按 requestId 配对，
  支持超时（30s）与错误回传。

### 4.4 主进程浏览器执行器（electron/browser-executor.cjs，新模块）

- **窗口生命周期**：首次 browser:exec 按分区 lazily 创建 BrowserWindow（可见、可缩放、
  用户可直接操作）；标题带会话标识；会话 close/应用退出销毁；空闲保留窗口（隐藏不销毁，
  保留登录态与页面，复用豆包思路）。
- **分区管理**：`persist:automation-{conversationId}`；GUI"清空会话"按钮调
  `ses.clearStorageData()`。
- **CDP 会话**：`webContents.debugger.attach('1.3')`；`Input.dispatchMouseEvent/dispatchKeyEvent`
  发可信事件（位置由 executeJavaScript 按 ref 命中盒计算）；`Accessibility.getFullAXTree`
  生成 a11y 树（在渲染前精简转换，避免大 payload）；`Page.captureScreenshot` 截图
  （JPEG、按视口降采样，≤200KB）。
- **ref → selector 解析**：快照时预计算并缓存（window 上下文内 Map），动作时解析。
- **人工接管检测**：pause_for_human 后轻量轮询（500ms）比对页面内容指纹
  （MutationObserver 计数 + title/hash 变化）；超过阈值 → 判定人工完成 → 自动发 resume 回内核。
- **下载处理**：`session.on('will-download')` → 落盘 `{项目目录}/downloads/` → 路径回传。
- **错误处理**：动作超时返回错误+最新快照；CDP attach 失败销毁重建重试 1 次；
  窗口被用户手动关闭 → 下次动作自动重建（分区不变）；通道断开走健康重连。
- **拟真兜底模式（opt-in）**：三档输入模式——
  1. 默认：CDP 可信输入；
  2. 兜底（显式开启）：行为拟真——自然打字节奏（随机间隔+错误修正）、鼠标贝塞尔路径移动+
     随机停驻、滚动节奏化；目的=让已授权操作不被行为检测误杀，不做轨迹录播克隆；
  3. 始终禁止：验证码 OCR/滑块自动破解、指纹伪装、UA/Canvas 伪造、绕过站点授权、
     高频并发压测。
  开启方式：agent 被拦时提议"开启拟真模式"，GUI 弹确认（人工闸门）；开启后该会话操作日志
  标注拟真模式。

### 4.5 GUI 精简状态条 + 聊天集成

- 主界面顶部/输入框上方一条状态条：当前操作文本（"正在点击「查询」…"）、暂停/继续按钮、
  "打开浏览器窗口"按钮、徽标（`人工接管中` / `拟真模式`）。
- 状态由 bridge 广播的 `browser:event` 驱动（无轮询）。
- **暂停/继续**：控制的是内核 agent 决策环（agent 在内核进程运行）——GUI → bridge
  控制通道发新 subtype `browser_pause` / `browser_resume` → 内核挂起/恢复当前 browser 工具
  （语义等价 pause_for_human；人工完成后执行器自动检测触发 resume，状态条"继续"按钮是
  手动恢复的另一入口）。
- **打开浏览器窗口 / 清空会话**：走 IPC 直连主进程（不经内核）。
- 操作日志以聊天消息形式呈现（每个动作一条轻量消息或汇总）；取证截图/结构化结果回填当前会话
  （复用"图片入消息"能力）；暂停时聊天区出现"人工接管中"提示条。

## 5. 安全与合规

- 域名白名单：goto/重定向复检（复用 yfwweb 规则：默认政府门户 *.gov.cn 等；白名单外需用户授权）。
- 敏感信息脱敏：快照生成时对身份证/手机号/账号打码。
- 人工闸门：提交/发送/付款类动作前必须确认（沿用既有权限体系）。
- 红线：破解类规避（OCR/打码/指纹伪装/绕过授权/高频压测）始终禁止；行为拟真仅限内置浏览器
  兜底模式、默认关闭、人工确认后开启、审计标注。相应修订 yfwweb 技能红线表述。

## 6. 核验场景垂直切片（gsxt 国家企业信用信息公示系统）

- 流程：goto（白名单内）→ 输入企业名 → 遇验证码 pause_for_human（用户手动滑）→ 指纹变化
  自动恢复 → a11y 树读结果 → 截图取证（落盘 downloads/）→ 结构化输出进聊天
  （名称/统一社会信用代码/法定代表人/状态/成立日期）。
- 验收标准：完整跑通一次真实查询（含验证码人工介入），取证截图落盘，结构化结果回填聊天。

## 7. 测试策略

- bridge 单测：`server/*.test.mjs` 追加 browser:exec 中继（路由、超时、错误回传）。
- 执行器集成测试：本地 fixture 页面（node 起 http 服务）→ goto/click/type/scroll/
  人工接管模拟 → 断言动作结果与快照内容。
- 快照测试：a11y 精简、敏感字段脱敏用例。
- 端到端人工验收：真实 gsxt 查询（用户在场）。
- 回归：不动豆包/编辑器窗口既有逻辑。

## 8. 落地顺序

1. 主进程执行器 + 自动化窗口（分区/CDP 会话/快照/可信输入/ref 解析）
2. bridge 路由 + 主进程 WS 客户端通道
3. 内核 `browser` 工具（快照 → 决策环）
4. 精简状态条 + 聊天集成
5. 核验场景端到端验收
6. 拟真兜底模式（最后做，opt-in + 人工闸门）

## 9. 明确不做（YAGNI）

- v1 不做多标签页管理（单页 + 导航即可）；不做多窗口并行自动化。
- 不做录屏/回放。
- 不做浏览器扩展加载。
- 视觉模型非必需（纯文字可跑全链路；有 visionModel 时仅作可选视觉确认）。
