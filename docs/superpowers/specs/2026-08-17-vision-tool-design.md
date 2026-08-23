# VisionTool 视觉识别工具设计（模态转换桥）

- 日期：2026-08-17
- 状态：设计已批准（方案 A）
- 范围：内核新增 VisionTool + 对话图片自动桥接 + provider 视觉模型配置

## 背景与目标

当前主对话模型（deepseek-v4-flash / deepseek-v4-pro）为纯文本模型，对话中出现的图片（image content block）无法被理解。目标：在非多模态模型运行时，提供**模态转换**能力——把图片转成文字描述喂给主模型，与 OcrTool（本地 rapidocr 精确读字）形成能力分工：

| 场景 | 工具 |
|---|---|
| 精确读取文字/数字（发票、证件、表格数字） | OcrTool（本地、免费、保真） |
| 语义理解（场景、图表趋势、物体、布局、图内非文字信息） | VisionTool（视觉模型 API） |

## 决策记录

| 问题 | 决策 |
|---|---|
| 视觉模型 API 来源 | 复用现有 provider 配置（同一 apiBaseUrl + authToken，零新增密钥） |
| 视觉模型指定方式 | provider 配置新增 `visionModel` 字段，用户从该 provider 模型列表手选 |
| 触发方式 | 工具调用 + 自动桥接双路径 |
| 输入范围 | 图片（png/jpg/jpeg/bmp/tif/tiff/gif/webp）+ PDF（PyMuPDF 渲染，支持多页） |
| 架构 | 方案 A：TS 壳 + Python 预处理 + Node 调 API + 内核桥接钩子 |

## 架构

```
① 工具路径（agent 主动调用）
   VisionTool(file_path, instruction?) → 只读权限校验/扩展名校验
        │ spawn
        ▼
   vision_prepare.py   PDF→PNG(fitz) / 格式归一化(PIL) / 2048px 内缩放
        │ 返回每页 PNG 路径
        ▼
   visionClient.ts(Node)  fetch provider API（Anthropic 消息格式 + image block）
        │                  + 缓存 .trae/vision_cache/{project}/{md5+指令hash}.json
        ▼
   返回 { description, pages, model, cacheHit, durationMs }

② 桥接路径（用户对话粘贴图片）
   image content block → 内核桥接钩子（消息发往主模型前）
        │ provider 配了 visionModel 且主模型非视觉
        ▼
   visionClient.ts 描述图片 → image block 替换为文本描述块 → 主模型
```

## 组件明细

| 组件 | 位置 | 职责 |
|---|---|---|
| VisionTool.ts | `ponos-kernel/claude-code/src/tools/VisionTool/VisionTool.ts` | buildTool 定义，对齐 OcrTool 范式。SUPPORTED_EXTENSIONS 与 OcrTool 相同；schema：`file_path` + `instruction?` + `project?` + `force?`；`isReadOnly: true`；权限校验复用 `checkReadPermissionForTool` |
| prompt.ts / UI.tsx | `ponos-kernel/claude-code/src/tools/VisionTool/` | 工具描述明确与 OcrTool 分工（语义理解 vs 精确读字）；渲染与摘要对齐 OcrTool 的 UI 模式 |
| vision_prepare.py | `runtime/skills/_common/vision_prepare.py` | 预处理：fitz 渲染 PDF（每页 PNG，默认上限 10 页，`--max-pages` 可调，超出截断并提示）；PIL 归一化 bmp/tif/gif/webp→PNG、转 RGB、2048px 内等比缩放（超限警告）。无密钥逻辑 |
| visionClient.ts | `ponos-kernel/claude-code/src/utils/visionClient.ts` | Node 侧唯一 API 出口：`describeImage(pages, instruction, config)` → POST `{apiBaseUrl}/v1/messages`（Anthropic 格式 image block + instruction）→ 文本；缓存读写 `.trae/vision_cache/{project}/`；60s 超时。供工具与桥接共用 |
| 桥接钩子 | 内核消息组装层（image block 发往主模型前） | 检测 image block + visionModel 已配 + 主模型非视觉 → 调 visionClient → 替换为文本块 |
| 配置 | `src/types/index.ts` + `server/bridge.mjs` + SettingsView | `ModelProvider.visionModel?: string`；bridge 启动内核注入 `PONOS_VISION_MODEL` env（baseUrl/token 复用现有 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`，同一 provider 同一端点）；前端 provider 编辑区加"视觉模型"下拉（从该 provider models 选，留空=禁用）+ "自动图片桥接"开关（默认开，配了 visionModel 才生效） |

## 数据流

### 工具路径

1. agent 调 `VisionTool(file_path, instruction?)` → 扩展名校验 + 只读权限校验（对齐 OcrTool）
2. 计算缓存键：文件 MD5 + instruction 哈希 + 模型名 → 查 `.trae/vision_cache/{project}/`，命中直接返回（`cacheHit: true`）
3. 未命中 → spawn `vision_prepare.py`：PDF 逐页渲染 PNG（上限 10 页，截断提示）；图片归一化（转 PNG/RGB、2048px 内缩放）
4. Node 读每页 PNG → base64 → `POST {apiBaseUrl}/v1/messages`：
   `{ model: visionModel, max_tokens: 1024, messages: [{ role: 'user', content: [ { type: 'image', source: { type: 'base64', media_type: 'image/png', data } }, { type: 'text', text: instruction || 默认描述指令 } ] }] }`，携带 `ANTHROPIC_AUTH_TOKEN`，60s 超时
5. 解析响应文本（逐页合并，标注页码）→ 写缓存 → 返回 `{ filePath, instruction, description, pages: [{page, description}], model, cacheHit, durationMs }`
6. `mapToolResultToToolResultBlockParam` 渲染：`model · N page(s) · cache hit?` + 描述正文

### 桥接路径

1. 用户消息含 image block → 组装 API 请求前触发桥接钩子
2. 判断：当前 provider 配了 `visionModel` **且** 对话模型 ≠ visionModel → 需要桥接；否则**透传**原 image block（主模型多模态时天然可用）
3. 对每个 image block：base64 原样送 visionClient（默认指令："详细描述这张图片的内容，包括所有可见文字、物体、场景布局、图表数据与表格数值"），不落盘
4. 成功后 image block 替换为 `{ type: 'text', text: '📷 [图片描述] ...' }`；失败替换为 `[图片描述失败: 原因]` 并保留提示，不吞内容
5. 桥接结果不做磁盘缓存（对话内图片一次性），复用会话内内存缓存避免重复调用

## 配置改动

- `src/types/index.ts`：`ModelProvider` 增加 `visionModel?: string`
- `server/bridge.mjs`：启动内核时注入 `PONOS_VISION_MODEL`（取 activeProvider 的 visionModel，空则不注入）；内核 VisionTool 从 `process.env` 读取 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `PONOS_VISION_MODEL`
- `src/stores/settingsStore.ts`：providers 初始化值（可选补 `visionModel` 占位）
- `src/components/settings/SettingsView.tsx`：provider 编辑区新增"视觉模型"下拉（options 来自该 provider 的 models 数组，含"不使用"空选项）+ "自动图片桥接"开关（默认开启，仅配了 visionModel 时有效）

## 错误处理

| 场景 | 工具路径 | 桥接路径 |
|---|---|---|
| 未配置 visionModel | 报错："未配置视觉模型，请在 设置→模型 中为该 provider 选择视觉模型" | 透传原 image block，不中断会话 |
| 401 / 429 / API 超时 | 明确错误 + 错误码 | 替换为 `[图片描述失败: ...]`，会话继续 |
| PDF 损坏 / 页数超限 | 报错 / 截断并提示已处理页数 | 不涉及（桥接只处理图片） |
| 预处理失败（不支持的格式等） | 校验层报错（对齐 OcrTool 的 validateInput） | 不涉及 |
| visionModel == 对话模型 | 工具正常可用 | 直接透传，不浪费调用 |

## 测试计划

- `vision_prepare.py`：PDF 多页渲染、格式归一化（bmp/tif/gif/webp→PNG）、分辨率缩放、页数超限截断、损坏文件报错
- `visionClient.ts`（mock fetch）：请求体断言（URL 路径/model 名/image block 格式/max_tokens/鉴权头）、缓存命中与写入、60s 超时、非 2xx 错误映射
- VisionTool 集成：spawn 失败、API 失败、成功路径、权限校验、`force` 绕过缓存
- 桥接钩子：image block 替换、开关关闭时不替换、visionModel==主模型时透传、失败保留提示
- 前端：`ModelProvider.visionModel` 序列化、SettingsView 下拉渲染与留空禁用、桥接开关联动（tsc 类型检查兜底）

## 范围外（明确不做）

- docx/xlsx/音频/视频输入（DeepSeek V4 声称支持，但本期仅图片 + PDF，后续迭代）
- 本地视觉模型（体积/算力不现实）
- DeepSeek 官方识图灰度（公共 API 状态未定论，visionModel 由用户自行选择可用模型即可覆盖）
- 逆向网页版识图模式（历史否决：合规风险，不纳入）
