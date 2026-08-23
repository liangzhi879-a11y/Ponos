# 豆包 AI 图片生成集成设计

日期：2026-08-17
状态：已确认（用户批准方案 A + 去水印后处理）

## 1. 背景与目标

原计划接入 hidream.org 图片生成（反向代理 + 会话持久化），实测发现 **hidream.org 使用 Google reCAPTCHA，Electron 窗口内页面加载 ERR_FAILED（Google 被墙导致验证码脚本超时）**，该方案在国内网络环境不可行，已废弃。

**目标**：接入豆包（doubao.com）AI 图片生成，免费账号登录一次后免重复登录，支持文生图、图生图、图片插入聊天输入栏，并集成去水印后处理。

**决策记录**：
- 方案：页面上下文执行（隐藏常驻窗口 + `executeJavaScript` 页面内 fetch，字节 JS 劫持器自动注入 `a_bogus`/`msToken` 签名）
- 用户接受水印存在，但要求集成**去水印后处理**（下载后本地处理）
- 登录窗口隐藏常驻（`win.hide()` 不销毁）

## 2. 架构总览

```
┌─ 前端 React ──────────┐   ┌─ bridge.mjs (51309) ─┐   ┌─ Electron 主进程 ───────────┐
│ DoubaoPanel           │   │ /ponos/doubao/*        │   │ 隐藏窗口 (persist:doubao)    │
│ doubaoStore           │◄──►│ download + 去水印    │◄─►│ executeJavaScript 页面内 fetch│
│ 插入聊天输入栏         │   │                      │   │ 登录窗口（可见，仅登录时）    │
└───────────────────────┘   └──────────────────────┘   └─────────────────────────────┘
                                     │
                              watermark_remove.py
                              (PIL + OpenCV inpaint)
```

- 主进程持有豆包隐藏窗口，是唯一能发签名请求的地方（页面上下文）
- bridge 是前端与主进程的 HTTP 中介，同时承担图片下载 + 去水印后处理
- 前端复用 hidream 面板骨架（登录卡 / 文生图 / 图生图 / 画廊 / 插入）

## 3. 登录与会话（隐藏常驻）

**登录窗口**（main.cjs）：
- `session.fromPartition('persist:doubao')`，`webPreferences: { partition: 'persist:doubao', contextIsolation: true, backgroundThrottling: false }`
- 加载 `https://www.doubao.com/chat/create-image`，用户扫码/手机号登录
- 登录成功判定：轮询分区 cookie 含 `sessionid`（2s 间隔，5 分钟超时）+ `did-navigate`/`did-navigate-in-page` 事件即时触发 + 关窗时最终确认一次
- 成功后 **`win.hide()` 隐藏常驻**（不销毁，保活页面与签名劫持器）
- 会话持久化：`persist:doubao` 分区天然落盘（userData/Partitions/doubao/），重启后重新加载页面自动恢复登录态

**会话失效**：
- 生成请求返回登录态失效特征（响应含登录跳转 / 401 / 特定错误码）→ bridge 标记 loggedIn=false → 前端提示重新登录
- 重新登录 = 显示已隐藏的窗口（`win.show()`），用户补登录后再次隐藏

**复用现有模式**：参考 hidream 的轮询+导航双通道判定（已修复的 9c85835 方案），直接迁移逻辑。

## 4. 生成请求（页面上下文执行）

核心：**签名由豆包前端 JS 自动注入**。字节前端劫持 `window.fetch`，页面内 `fetch()` 自动附加 `a_bogus`/`msToken` 到 query。

**文生图**（main.cjs 通过 `webContents.executeJavaScript`）：

```js
// 页面上下文执行的脚本（收集 SSE 后 resolve）
const script = `
(async () => {
  const res = await fetch('/api/image/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload }),
  })
  // 逐 chunk 读 SSE，收集到完整响应
  const reader = res.body.getReader()
  let buf = ''
  // ... 解析 SSE 事件（7 种类型），收集 block_type=2074 的图片内容
  return collectedResult
})()
`
const result = await hidreamWin.webContents.executeJavaScript(script)
```

- `bot_id` 标识模型（非 model 字段）；prompt 必须是纯字符串
- `option` 含 `need_create_conversation`、`local_conversation_id` 等标志位
- SSE 事件：`SSE_HEARTBEAT` / `SSE_ACK` / `FULL_MSG_NOTIFY` / `STREAM_MSG_NOTIFY` / `CHUNK_DELTA` / `STREAM_CHUNK` / `SSE_REPLY_END`
- 图片内容：`content_block` 嵌套，`block_type=2074` 为图片，文本 `block_type=10000`
- 返回：图片 URL 列表（CDN，带水印）+ 可选额度信息（尽力而为）

**executeJavaScript 限制与防护**：
- 单次调用 payload 较大（prompt 长文本）：注意 cmd 长度限制？——executeJavaScript 无此限制（直接注入 V8），但脚本字符串拼接需转义
- 超时：文生图可能 10-60s，executeJavaScript 需设置超时兜底（Promise.race）
- 失败重试：签名失效（风控码）时重试一次，仍失败返回错误

## 5. 图生图（上传管道）

1. 前端把参考图（objectURL/本地路径）经 bridge 上传或直接传 base64 给主进程
2. 主进程在页面上下文执行上传：豆包走 ImageX TOS 管道，multipart 需手动拼 raw body（`--{boundary}` → Content-Disposition → Content-Type → 二进制），`filename` 必须带扩展名且与内容类型一致
3. 上传成功返回 `file_id`
4. `file_id` 原样塞入生成请求的 `image_file_ids` 数组

**简化方案**（优先）：若豆包页面上下文可用原生 `FormData` + `File` 构造上传（fetch 劫持器同样注入签名），则用原生方式，避免手拼 multipart。实测后决定（P0）。

## 6. 去水印后处理

**新模块**：`server/watermark_remove.py`（Python，PIL + OpenCV，零新增依赖——环境已确认 PIL 12.2.0 / cv2 4.13.0）

**流程**：图片 URL 经 bridge 下载 → 存临时文件 → spawn Python 脚本 → 去水印 → 返回处理后的图片数据/路径给前端

**算法（两级降级）**：
1. **inpaint 模式（默认）**：右下角区域检测水印（半透明 logo/文字区域，用亮度/饱和度/对比度聚类 + 形态学膨胀生成 mask）→ `cv2.inpaint`（TELEA）填充，保留原尺寸
2. **crop 模式（降级）**：水印检测失败或区域过大时，直接裁剪右下角水印区域（牺牲部分构图）

**校准**：水印精确位置/尺寸/样式需真实生成一张图实测（P0 任务），检测参数在 `watermark_remove.py` 顶部常量区集中维护。

**接口**：CLI 调用 `python watermark_remove.py <input> [--mode auto|crop] [--output <path>]`，stdout 输出单行 JSON `{ok, output, mode, region}`，退出码非 0 视为失败（走原图降级）。

**调用方**：bridge.mjs `/ponos/doubao/download` 端点（复用现有 `findPythonExe()` + spawn 模式）。

## 7. bridge 端点（/ponos/doubao/*）

| 端点 | 方法 | 说明 |
|---|---|---|
| `/ponos/doubao/status` | GET | 登录态 + 额度（尽力而为） |
| `/ponos/doubao/generate` | POST | 文生图 `{prompt, model, ratio, count}` |
| `/ponos/doubao/instant` | POST | 图生图 `{prompt, imageBase64, ...}` |
| `/ponos/doubao/download` | GET | 下载图片 URL → 去水印 → 返回图片 |
| `/ponos/doubao/logout` | POST | 清除会话（分区 cookie + 隐藏窗口重置） |

主进程侧通过 IPC 与新 `server/doubao.mjs`（或直接在主进程实现页面执行逻辑）交互。

## 8. 前端

- `HiDreamPanel.tsx` → `DoubaoPanel.tsx`（复用结构：登录卡 / 文生图表单 / 图生图 / 画廊 / 历史）
- `hidreamStore.ts` → `doubaoStore.ts`（zustand，action：refreshStatus / generate / instant / insertImage / download）
- 聊天输入栏 Sparkles 按钮与 Popover 结构不变（仅内部面板换）
- i18n：zh-CN / en-US 新增 `doubao` 键组（替换 hidream 键组）
- 类型：`src/types/index.ts` 新增 Doubao 相关类型，替换 Hidream 类型
- preload.cjs：`window.doubao = { openLogin, getStatus, logout }`（替换 hidream）

**生成成功后的图片默认走去水印管道**（前端拿到的是处理后图片），原图保留可切换（设置项，默认去水印开启）。

## 9. 清理 hidream 死代码

- `server/hidream.mjs` + `server/hidream.test.mjs`：删除
- bridge.mjs `/ponos/img/*` 端点：删除
- main.cjs hidream IPC（open-login / get-status / logout）+ `writeHidreamSession` / `readHidreamStatus` / `HIDREAM_SESSION_FILE`：删除
- `src/components/hidream/`、`src/stores/hidreamStore.ts`、types/i18n 中 hidream：删除
- `~/.ponos/hidream-session.json`：不影响（残留文件，不主动删，清理脚本可选）

## 10. 测试

- **单元/集成（node:test + PONOS_TEST_HOME 隔离）**：
  - `doubao.mjs`：登录判定 / 会话读写（stub cookie）
  - `watermark_remove.py`：构造带右下角水印的测试图 → 验证 inpaint / crop 输出
  - bridge `/ponos/doubao/*` 端点：本地 stub 服务器模拟豆包 API
- **真实手测清单**（P0）：
  1. 登录窗口打开 → 扫码登录 → 窗口自动隐藏
  2. 文生图成功 → 图片去水印 → 画廊展示
  3. 图生图（参考图）成功
  4. 图片插入聊天输入栏
  5. 下载保存
  6. 重启应用 → 免登录（分区持久化）
  7. 会话失效 → 重新登录提示与流程
- **水印校准实测**：真实生成一张图，确定水印位置/尺寸，校准 `watermark_remove.py` 参数

## 11. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 豆包前端 JS 更新破坏逆向（端点/SSE/签名变化） | 关注 doubao2api 社区；SSE 解析容错；模块化隔离便于修复 |
| 账号风控/封禁 | 用户个人免费账号低频使用；不做并发/批量滥用 |
| executeJavaScript 超时/隐藏窗口异常 | Promise.race 超时兜底；`backgroundThrottling: false`；异常时上报错误并提示 |
| 去水印效果不完美 | 两级降级（inpaint→crop）；效果以实测为准，参数可调 |
| 隐藏窗口内存占用 | 单窗口常驻可接受；必要时提供"退出登录即销毁" |

## 12. 非目标

- 不做批量生成/多账号负载均衡
- 不做豆包官方 API（火山引擎）付费接入
- 不承诺去水印 100% 无痕（CDN 水印无法从源头去除）
- 不做移动端/非 Electron 场景适配
