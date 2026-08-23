# 豆包 AI 图片生成 — P0 校准指南（Task 9 Step 2）

> 目的：用真实登录态下的豆包页面请求与生成图，校准两处基线实现——
> 1. `electron/doubao-page-script.js` 的 generate 请求 body 结构（`bot_id`/`messages`/`option`/`ext`）
> 2. `server/watermark_remove.py` 顶部去水印参数（`SCAN_W_RATIO`/`SCAN_H_RATIO`/`THRESH`）
>
> 本指南供用户在场手测时使用；校准结果按 Step 4 落地回源码并重新同步 release。

---

## 0. 前置：以调试版启动应用（带 CDP 9223）

必须用桌面「Ponos 调试版」快捷方式启动（等价命令）：

```bash
# 在 release 目录下
"release\Ponos_ms92cd6u\electron\electron.exe" --remote-debugging-port=9223 --enable-logging "release\Ponos_ms92cd6u\electron\main.cjs"
```

- 快捷方式实际参数（已核对桌面 .lnk）：`--remote-debugging-port=9223 --enable-logging <main.cjs>`，工作目录为 `release\Ponos_ms92cd6u`
- CDP 端口 9223 只在此调试方式下存在；普通启动没有，路径 B 不可用
- 确保 `release\Ponos_ms92cd6u` 副本已完成 Task 9 Step 1 同步（`server/doubao.mjs`、`server/watermark_remove.py`、`server/bridge.mjs`、`electron/main.cjs`、`electron/preload.cjs`、`electron/doubao-page-script.js` 均为新版本）

---

## 1. 校准流程总览

| 步骤 | 操作 | 结果 |
| --- | --- | --- |
| 1 | 重启调试版应用 | 应用正常启动 |
| 2 | 点 AI 绘图（Sparkles）按钮 → 面板显示「登录豆包」→ 点登录 | 登录窗口打开 |
| 3 | 扫码登录豆包 | 窗口约 0.8 秒后自动隐藏；面板显示「已登录豆包」 |
| 4 | 确保捕获钩子已挂载（见 §2） | `window.__DOUBAO_CAPTURE_HOOKED__ === true` |
| 5 | 显示豆包隐藏窗口，在豆包页面手动生成一张图（见 §3） | 页面出现真实生成结果 |
| 6 | 读取 capture（路径 A 或路径 B，见 §4/§5） | 拿到真实 `/api/image/generate` 请求的 url/请求体/响应体 |
| 7 | 按 §6/§7/§8 校准两处源码并记录错误 | 校准结论清单 |

> 注意：本任务**不重启应用进程之外的任何操作**，整个手测过程用户在场执行；本指南只说明怎么做。

---

## 2. 确保捕获钩子已挂载（关键前置）

捕获钩子 `CAPTURE_HOOK` 由主进程在 `doubao:generate` handler 内注入（`electron/main.cjs` 第 800 行）。它包装页面当前的 `window.fetch`，把**最近一次** `/api/` 请求记入 `window.__DOUBAO_CAPTURED__`。因为豆包页面 JS 已劫持 fetch（签名注入器），我们的钩子包在其外层，所以**页面手动生成发起的请求同样会被记录**。

钩子尚未挂载时的两种挂载方式（任选其一）：

- 方式一（最简单）：在应用面板点一次「生成图片」（即使失败/未填提示词），hook 即注入；
- 方式二（CDP）：连豆包窗口 target 直接执行钩子脚本（见 §5 的 `ensureHook` 分支）。

验证是否已挂载：路径 B 脚本执行 `Runtime.evaluate` 读 `window.__DOUBAO_CAPTURE_HOOKED__`，为 `true` 即已挂载。

## 3. 在豆包页面手动生成一张图

隐藏窗口默认不可见。调出方式：在应用面板再点一次「登录豆包」（主进程 `openDoubaoLogin` 对已存在的窗口执行 `show()+focus()`，`electron/main.cjs` 第 711 行），窗口即重新显示。

在豆包页面中**用页面自身 UI 手动生成一张图**（输入提示词 → 点生成 → 等图片出现）。这一步会触发页面真实请求链，钩子记录最后一个 `/api/` 请求（即 `/api/image/generate`）。

> 注意：钩子只保留**最后一个** `/api/` 请求。手动生成后若页面还有其他 `/api/` 请求发生，会覆盖记录。读 capture 前不要再触发其他请求；若被覆盖，重新手动生成一次再读。

## 4. 路径 A：应用内控制台执行 `doubao:capture`

`window.doubao.capture` 已由 `electron/preload.cjs` 第 77 行暴露（`ipcRenderer.invoke('doubao:capture')`），主进程 handler 在 `electron/main.cjs` 第 826-830 行，执行 `buildCaptureScript()` 读 `window.__DOUBAO_CAPTURED__`。

操作：在主应用窗口按 F12 打开 DevTools → Console 执行：

```js
await window.doubao.capture()
```

返回 JSON：

- `{ code: 0, captured: { url, options, body } }` — 成功，见 §6 记录清单
- `{ code: 404, message: 'no capture yet' }` — 钩子未挂或尚未捕获到请求 → 回 §2 挂载钩子后重新在页面生成
- `{ code: 401, message: 'not logged in' }` — 登录态判定失败（`doubaoLoggedIn` 为 false）→ 重新登录

## 5. 路径 B：CDP 9223 读 `window.__DOUBAO_CAPTURED__`

适用场景：路径 A 不可用（如登录态守卫失败、想在豆包窗口 target 直接操作）。连接配方：

1. 列 targets：`GET http://127.0.0.1:9223/json`，在列表中找到豆包窗口：`type === 'page' && url.includes('doubao.com')`（主窗口 URL 不含 doubao.com，不会误选）
2. 连 WebSocket：`ws://127.0.0.1:9223/devtools/page/<id>`（`<id>` 即上一步 target 的 `webSocketDebuggerUrl` 内嵌 id）
3. `Runtime.evaluate` 读 `window.__DOUBAO_CAPTURED__`，`returnByValue: true`
4. **脚本文件必须 `.cjs` 后缀**（本环境 Node 将 `.js` 按 ESM 解析；`.cjs` 强制 CommonJS 才能用 `require`）。参考 `C:\Users\T203-15\claude-code-gui\.salvage-work\state-snapshot.cjs` 的既有配方。

完整脚本（保存为 `doubao-capture.cjs` 运行：`node doubao-capture.cjs`）：

```js
// doubao-capture.cjs — 从 CDP 9223 读豆包页面 window.__DOUBAO_CAPTURED__
const http = require('http')
function getJson(path) { return new Promise((res, rej) => {
  http.get(`http://127.0.0.1:9223${path}`, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{try{res(JSON.parse(d))}catch(e){rej(new Error('bad json'))}}) }).on('error', rej)
}) }
async function main() {
  const targets = await getJson('/json')
  // 选中豆包隐藏窗口（url 含 doubao.com 的 page target）
  const page = targets.find(t => t.type === 'page' && t.url.includes('doubao.com'))
  if (!page) throw new Error('doubao window target not found: ' + JSON.stringify(targets.map(t => ({type:t.type,url:t.url}))))
  console.log('target:', page.url)
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let id = 0; const pending = new Map()
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result) } }
  const send = (method, params={}) => { const i = ++id; return new Promise((res, rej) => { const tm = setTimeout(()=>{pending.delete(i); rej(new Error('timeout'))}, 20000); pending.set(i, {res: v=>{clearTimeout(tm);res(v)}, rej: e=>{clearTimeout(tm);rej(e)}}); ws.send(JSON.stringify({id:i,method,params})) }) }
  await send('Runtime.enable')
  // 若钩子未挂，先注入 CAPTURE_HOOK（与 electron/doubao-page-script.js 顶部一致）
  const hook = await send('Runtime.evaluate', { expression: `(() => {
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
  })()`, returnByValue: true })
  console.log('hook:', hook.result?.value)
  // 读捕获结果（若为 undefined 说明尚无 /api/ 请求被记录）
  const r = await send('Runtime.evaluate', { expression: `JSON.stringify(window.__DOUBAO_CAPTURED__ || null)`, returnByValue: true })
  console.log('captured:', r.result?.value)
  ws.close(); process.exit(0)
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
```

输出 `captured:` 后的 JSON 即待记录数据（§6 清单）。

## 6. 要记录的数据（记录到本任务报告）

从 `captured` 对象提取并记录以下内容：

| 字段 | 含义 | 用于 |
| --- | --- | --- |
| `captured.url` | 请求路径（应为 `/api/image/generate`） | 确认端点正确 |
| `captured.options.method` | 请求方法（应为 POST） | 确认方法 |
| `captured.options.headers` | 请求头（含劫持器注入的 `a_bogus`/`msToken` 签名） | 理解签名机制 |
| `captured.options.body` | **请求体 JSON 字符串**（fetch 参数 `args[1].body`） | **校准 `electron/doubao-page-script.js` 的 `bot_id`/`messages`/`option`/`ext` 结构（最关键）** |
| `captured.body` | **响应体文本前 3000 字符**（`r.clone().text()`，SSE 流） | 验证图片提取逻辑（`block_type: 2074`）与拿生成图下载 URL |
| 下载 URL | SSE 响应中 `block_type === 2074` 的 `content.image_url`/`content.url`/`content.image`；或手动生成后右键复制图片地址 | 校准 `server/watermark_remove.py` 用的真实水印图 |

> 注意区分：`captured.body` 是**响应体**（钩子实现如此）；**请求体**在 `captured.options.body`。校准 payload 看 `options.body`。

## 7. 校准 `electron/doubao-page-script.js` 的 body 结构

对比基线（`buildGenerateScript` 内 `const body = {...}`，当前为公开逆向基线）：

```js
const body = {
  bot_id: '7338286299411103781',   // ← 用真实请求体校准
  messages: [{ role: 'user', content: [...] }],  // ← 用真实请求体校准（image_file_ids/text 字段名）
  client_meta: { from: 'doubao_web' },  // ← 用真实请求体校准
  option: { need_create_conversation: true, local_conversation_id: 'conv_' + Date.now() },  // ← 校准
  ext: {},  // ← 校准
}
// count > 1 时顶层写 body.count（字段位置待实测校准）
```

校准动作：

1. 用 §6 记录的真实请求体（`captured.options.body`）与上述基线逐字段 diff
2. 记录差异：`bot_id` 实际值、`messages[0].content` 数组结构（text/image_file_ids 的字段名与顺序）、`option`/`ext`/`client_meta` 实际字段、是否有 `count` 字段及其位置（多图是顶层字段还是其他机制）
3. 若 SSE 响应结构与基线解析不一致（`content_block`/`block_type`/`SSE_REPLY_END`），记录实际事件结构
4. 把结论写回本任务报告，Step 4 统一落地到源码

## 8. 校准 `server/watermark_remove.py` 顶部参数

先用 §6 拿到的真实生成图（原图，未处理），单独跑脚本验证：

```bash
python server/watermark_remove.py <真实生成图路径> --mode auto --output <输出路径>
```

观察 stdout JSON：

- `mode: 'inpaint'` → 检测正常，检查 `region`（水印实际位置/尺寸）是否覆盖真实水印
- `mode: 'crop'` 且 `mask.sum() == 0` → 检测失败降级裁剪 → 需调低 `THRESH`（当前 25）或调大扫描框
- `ok: false` + `error` → 记录错误

顶部参数（`server/watermark_remove.py` 第 10-15 行）：

| 参数 | 当前值 | 含义 | 调参方向 |
| --- | --- | --- | --- |
| `SCAN_W_RATIO` | 0.35 | 扫描框占图宽比例（右下角） | 水印超框 → 调大；水印远小于框（误检背景）→ 调小 |
| `SCAN_H_RATIO` | 0.35 | 扫描框占图高比例 | 同上 |
| `THRESH` | 25 | 与背景亮度差阈值 | 检测不到（降级 crop）→ 调低；误检大量背景 → 调高 |
| `DILATE_RATIO` | 0.008 | inpaint 膨胀半径（按尺寸缩放） | 水印区域未完全覆盖 → 调大 |

验证标准：`auto` 模式下 `region` 精确包住水印、输出图水印消除且尺寸不变（inpaint）或仅裁掉水印列（crop）。

## 9. 生成链路错误记录

若 generate 链路返回非 0（应用面板报错或 `await window.doubao.generate({prompt})` 返回），记录并归档：

- `{ code: 401, message: 'not logged in' }` → 登录态判定失败（doubaoLoggedIn / 会话文件），检查登录流程
- `{ code: -1, message: 'http <status> <body前200字符>' }` → 端点/参数错误，配合 §6 真实请求校准
- `{ code: -1, message: 'no image in response' }` → SSE 解析与真实结构不符，校准 §7 的解析逻辑
- `{ code: -1, message: 'generate timeout' }` → 90 秒超时，记录用时
- 其他错误 → 原文记录

错误消息均用于 Step 4 修复，务必连同时间戳与触发 prompt 一并写入报告。

## 10. 完成标准

- [ ] `captured` 已取到，真实请求体完整记录（url/method/headers/`options.body`/`body`）
- [ ] 生成图下载 URL 已拿到，跑过 `watermark_remove.py --mode auto` 并记录 mode/region
- [ ] `doubao-page-script.js` 需改字段清单已列出（若与基线一致则注明「无需改动」）
- [ ] `watermark_remove.py` 参数校准结论已列出（若无需调则注明「参数可用」）
- [ ] 所有非 0 错误消息已记录
- [ ] 全部结论写入 Task 9 报告，进入 Step 4 落地
