# HiDream 图片生成接入设计规格 — 聊天输入栏内嵌 AI 绘图（纯 A 反代）

| 字段 | 值 |
|---|---|
| 日期 | 2026-08-17 |
| 状态 | 设计定稿 / 待实施 |
| 涉及文件（参考） | `electron/main.cjs`、`server/bridge.mjs`、`src/components/chat/ChatInput.tsx`、`src/stores/hidreamStore.ts`、`src/types/index.ts`、`src/i18n/translations/zh-CN.ts`、`en-US.ts` |
| 决策记录 | 纯 A 反代（不做官方 API 双轨）；登录=独立小窗口 + Clerk"记住我"；入口=聊天输入栏左侧原"附加图片"按钮位置，替代为 AI 绘图面板；图生图+文生图+额度/历史 |

---

## 1. 设计目标

在 claude-code-gui（Electron 桌面应用）中接入 hidream.org 的免费 AI 图片生成能力：

- 用户**一次登录**（Clerk，勾选"记住我"），此后无需重复登录即可在本应用内生成图片
- 实现方式：**本地反代** hidream.org 内部接口（`/api/create-image`、`/api/image/instant`、`/api/user/get-user-credits` 等），复用网页端免费积分额度
- 入口：**聊天输入栏左侧"附加图片"按钮（ImageIcon）位置**，点击弹出 AI 绘图面板；生成结果可直接插入当前输入作为图片附件，或下载到本地
- 功能范围：文生图 + 图生图 + 额度显示 + 生成历史

## 2. 逆向调研结论（已实测确认）

- 站点形态：Next.js 应用，标题"免费在线文本生成图像 AI"，积分制（402=积分不足）
- 认证：Clerk（Google OAuth / 邮箱），会话为短效 JWT cookie（`__session`，非 httpOnly 可导出）
- 核心端点（已从 JS chunk 逆向定位）：
  - `POST /api/create-image` → body `{prompt, model_name:"dev", image_type, set_private, turnstile_token, count}`
  - `POST /api/image/instant` → body `{description}`（即时生成；401→需登录，403→风控/验证）
  - `POST /api/user/get-user-credits` → 查余额
  - `POST /api/storage/upload-image` → 图生图参考图上传
  - `POST /api/moderation/prompt`、`/api/config/get-configs` 等辅助端点
- 响应统一 `{code, message, data}` 格式
- 已知障碍：① Cloudflare Turnstile 人机验证（create-image 请求体带 `turnstile_token`，instant 接口不带，疑似风控触发式）；② Clerk JWT 短效，纯转发无自动续期

## 3. 总体架构与数据流

```
[React 前端] ──HTTP──► [bridge.mjs 代理端点] ──https(带Cookie/UA/Referer伪装)──► hidream.org/api/*
      ▲                        │
      │                        ▼
[main.cjs 登录窗口] ──导出──► ~/.ponos/hidream-session.json
```

1. **登录**：main.cjs 创建独立 BrowserWindow（`partition: 'persist:hidream'` 持久化分区），加载 `https://hidream.org/zh/ai-image-generator`。用户完成 Clerk 登录（勾选"记住我"）后，通过"登录完成"动作（URL 跳转到生成页 或 用户点击面板"完成登录"）触发：`session.cookies.get({ url: 'https://hidream.org' })` 导出 cookie → 写入 `~/.ponos/hidream-session.json` → 关窗。
2. **生成**：前端面板 → `POST /ponos/img/create`（bridge）→ 读 cookie 文件拼 `Cookie` 头，伪装同源 `Referer`/`Origin: https://hidream.org` 与浏览器 UA → 转发到 hidream.org 对应端点 → 透传 `{code, message, data}`。
3. **额度/历史**：`/ponos/img/credits` 转发 get-user-credits；生成历史存本地 `~/.ponos/hidream-history.json`（不依赖站点）。

## 4. 详细设计

### 4.1 登录窗口与会话（main.cjs）

- 新增 IPC handler：`hidream:open-login`（开窗）、`hidream:get-status`（读 cookie 文件返回登录态）、`hidream:logout`（清 cookie 文件 + 清持久化分区 cookie）
- 登录窗口：`new BrowserWindow({ width: 1100, height: 780, partition: 'persist:hidream', ... })`，`webContents.on('did-navigate')` 监听 URL：若命中生成页主路径（如 `https://hidream.org/zh/ai-image-generator` 且 cookie 中存在 `__session`）则视为登录成功
- cookie 导出落盘：`{ exportedAt, cookies: [{name, value, domain, path}...] }`，权限收紧（仅当前用户读写）
- **过期策略（P0）**：Clerk `__session` 为短效 JWT，纯转发无法自动续期。登录时提示用户勾选"记住我"（刷新会话可长达 30 天）；任一代理请求收到 401 → bridge 返回 `{code: 401, expired: true}` → 前端弹"HiDream 会话已过期"，一键 `hidream:open-login` 重登
- **增强项（backlog）**：后台隐藏窗口每 30 分钟静默加载站点一次，靠页面 JS 自动刷新 cookie

### 4.2 bridge 代理端点（server/bridge.mjs）

沿用现有 `if (url.pathname === ...)` 分派 + `readJsonBody` + `reply` 模式（bridge.mjs:964 起），全部受现有 `isAllowedOrigin` localhost 白名单保护：

| 端点 | 方法 | 说明 |
|---|---|---|
| `/ponos/img/status` | GET | 读 cookie 文件，返回 `{loggedIn, expiresAt?}` |
| `/ponos/img/credits` | GET | 转发 `/api/user/get-user-credits` |
| `/ponos/img/create` | POST | body `{prompt, model_name?, image_type?, count?, image_url?, aspect_ratio?}`；文生图走 create-image（`image_type: 'text2img'`），图生图先上传 image_url 再走 create-image（`image_type: 'img2img'`） |
| `/ponos/img/instant` | POST | 兜底通道：body `{description}` 转发 `/api/image/instant`（免 Turnstile 候选，P0 实测） |
| `/ponos/img/history` | GET | 读本地历史 |
| `/ponos/img/history/:id` | DELETE | 删本地历史条目 |
| `/ponos/img/download` | GET | 代理下载图片字节到本地（存 `~/.ponos/hidream-images/<id>.<ext>`），返回本地路径 |

转发实现：Node `https` 模块，`create-image` 超时 60s、状态类 10s；错误分类透传（401 会话过期 / 402 积分不足 / 403 风控 / 429 限速）；失败不落 cookie 日志。

### 4.3 前端 UI（入口替换 + 面板）

- **入口替换**：ChatInput.tsx:656 原"附加图片"按钮（ImageIcon）替换为 AI 绘图按钮（`Wand2`/`Sparkles` 图标），点击打开弹出面板（Popover，复用 Radix Popover 与玻璃风格）；原图片粘贴（剪贴板）能力保留不变
- **面板组件** `src/components/hidream/HiDreamPanel.tsx`：
  - 登录状态卡：未登录 → "登录 HiDream"（调 `hidream:open-login`）；已登录 → 额度显示（credits，轮询或进入时拉取）
  - 文生图：提示词 textarea、模型选择（默认 `dev`）、比例（1:1/16:9/9:16）、数量（1-4）
  - 图生图：参考图上传（本地文件→经 `/ponos/img/create` 的 image_url 或先传 `/api/storage/upload-image`），与提示词组合
  - 结果画廊：生成图预览、"插入到输入栏"（作为 `@image:<本地路径>` 附件进当前会话，复用现有 Attachment 结构）、"下载到本地"
  - 历史列表：最近 N 条，可查看/下载/删除
- **状态管理** `src/stores/hidreamStore.ts`（zustand）：`{loggedIn, credits, generating, results[], history[]}` + actions
- **i18n**：zh-CN / en-US 各增 `hidream.*` 键组
- **类型**：`src/types/index.ts` 增 `HidreamResult`、`HidreamHistoryItem` 等

### 4.4 错误处理与合规护栏

- 错误映射（前端统一提示）：401→过期重登 / 402→积分不足 / 403→风控（提示稍后重试，含 Turnstile 说明）/ 429→限速
- 护栏：单请求最小间隔 3s（bridge 内做轻量节流，防滥用触发风控）；仅本机 localhost 白名单；不公开部署；设置页/面板内展示风险提示文案（个人自用、ToS 封号风险知情、不绕过付费墙——本站为免费积分制）
- 敏感处理：`hidream-session.json` 不落日志、不进 git（若在仓库内则加入 .gitignore）

### 4.5 测试与 P0 实测项

**P0 实测（实施首步，决定端点策略）**：
1. 不带 `turnstile_token` 调 `create-image` 是否可成功（若必须则需在面板内嵌 Cloudflare Turnstile 组件取 token，列为后备）
2. Clerk cookie 在纯转发（无 JS）环境下有效时长实测（决定重登提示频率）
3. `/api/image/instant` 是否免 Turnstile、参数与返回结构，作兜底通道
4. 图生图 `image_type`/`image_url` 确切传参（必要时用 `/api/storage/upload-image` 前置上传）

**自动化单测**（server/*.test.mjs，node --test）：mock hidream 响应测试 `/ponos/img/*` 端点（cookie 注入、错误透传、history 存取、节流）。
**手测清单**：登录→文生图→图生图→额度显示→插入输入栏→下载→删除历史→会话过期重登→积分不足提示。

## 5. 范围外（YAGNI）

- 官方 hidreamai.com API 双轨（决策：纯 A，不做）
- 后台定时刷新 cookie（backlog 增强，第一版不做）
- 视频生成、矢量图等其它 HiDream 能力
- 多账号切换

## 6. 风险与缓解

| 风险 | 缓解 |
|---|---|
| ToS 违规/封号 | 个人自用、限速、风险提示知情；被封则用户可回网页端（第一版无官方 API 退路，已确认接受） |
| Turnstile 必填 | 面板内嵌 Turnstile 组件取 token；或改用 instant 通道（P0 实测定夺） |
| Clerk JWT 频繁过期 | 登录勾选"记住我" + 401 一键重登；backlog 做后台静默刷新 |
| 站点接口变更 | 端点集中在 bridge 一处转发，改一处即可；history 走本地不受影响 |
