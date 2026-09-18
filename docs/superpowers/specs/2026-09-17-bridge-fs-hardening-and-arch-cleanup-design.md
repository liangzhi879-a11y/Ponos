# 桥文件面加固与架构瘦身 · P0–P2 设计（hardening + cleanup）

> 状态：**P0 全部完成 + P1-2 完成**（P0-1/2/3/4 与 P1-2 代码就位，测试 72 条全绿，回归全绿）；**P1 其余/P2 待推进**
> 日期：2026-09-17
> 基线：`978447c` + 工作树未提交改动（461 源码模块 / 116,212 行 / 1,275 依赖边）
> 实施记录见 **§10**（P0）与 **§11**（P1-2）；运维开关见 `docs/2026-09-17-桥文件面加固-运维开关与切换步骤.md`
> 前序：`docs/superpowers/specs/2026-09-17-loop-redesign-phase1-reliability-design.md`（环路可靠性）；本文与其正交，无重叠改动面
> 依据：`docs/architecture.md` §1–§12、`docs/architecture-graph.html`（实测依赖图谱）、本文 §1 的逐条源码核实
> 读法：§1 是**缺陷事实**（可复核），§2 是**架构决策**（需你拍板），§3–§5 是**施工项**，§6 是**先做的实验**

---

## 0. 总纲

### 0.1 范围

| 级别 | 主题 | 项数 |
|---|---|---|
| **P0** | 桥文件面安全加固（路径闸门 / 体积上限 / 不受信内容隔离 / CSP） | 4 |
| **P1** | 事件循环阻塞与安全规则双份实现 | 4 |
| **P2** | 巨石拆分、域归并、死代码清点、文档口径纳入校验 | 4 |

### 0.2 一句话定性

**不是"架构臃肿"**——实测平均出度 4.09、文件级循环最大 3 文件、三层反向依赖为 0、测试:源码 = 366:461，这些指标都健康。真正的问题是两类：

1. **桥的文件端点把"任意路径读写"暴露给了持令牌方**（`server/bridge.mjs:2436-2484`，4 个端点全无包含校验）；
2. **`/raw-file` 会把用户文件当 `text/html` 直接吐回，而预览 iframe 保留了 `allow-same-origin`** ⇒ 不受信 HTML 拿到"与桥同源的可执行上下文"，令牌闸门对此**无防护作用**（它管"谁能调桥"，不管"桥把谁放到自己源上执行"）。

### 0.3 明确不做（本 spec 边界）

- 不重写桥为多进程、不引入消息队列或数据库、不改 NDJSON 协议与 WS 消息格式。
- 不重构前端状态层（`chatStore` / `useYFWCLI` 只登记清单，P2 不动刀）。
- 不改动 DevLens 图谱与应用智控的功能面（仅 §P2-4 涉及文档口径）。
- 不引入新的运行时依赖（`fs-guard` 只用 `node:fs` / `node:path`）。
- **不重做令牌闸门**：S4 已证内核无法绕过（§6），闸门的缺陷在"来源判定粒度"（§1.2），不在"是否要令牌"。

### 0.4 六个 spike 的结论（**全部已跑完**，直接决定 §2/§3/§4 的方案）

| spike | 结论 | 影响 |
|---|---|---|
| **S4** 内核能否绕过审批直调 `/write-file` | **不能**（三重屏障：`kernel/` 零引用、`bridge_request` 只收路由名、Bash 子进程 env 白名单不含令牌） | §1.3 的链**不由提示注入触发**，必须用户打开不受信 HTML；同时发现内核 env 里**残留**桥令牌 ⇒ 顺手加固（P0-1） |
| **S2** 预览是否真调桥 | **6 个技能模板 0 处调桥**；`brainstorming` 互动展示走**自己的本地服务器**；唯一同源依赖（`localStorage`）**已被 try/catch 包裹** | 去 `allow-same-origin` **功能安全**，无需补受限 RPC；但发现 `viewer.html` **引 cdnjs 的 p5.js** ⇒ CSP 必须分上下文（P0-4） |
| **S1** 文件端点调用面 | **`/write-file` 全仓仅 1 处**（`FileEditor.tsx:54` 保存）；`/read-file` 4 处；`/raw-file` 3 处；`/list-dir` 2 处；`/convert-office` 2 处 | ⚠️ **`DirectoryPicker` 以用户主目录为起手目录**（`DirectoryPicker.tsx:112`）⇒ **读模式绝不能强拦**，否则"选目录"功能直接坏；写模式误伤面极小 ⇒ **支持"读告警、写强拦"的灰度设计**（D1） |
| **S3** CSP 可行性 | `script-src 'self'` **可行**（dist 产物无 inline script；`eval`/`new Function`/`document.write` 命中 **0**）；但 **`style-src` 必须保留 `'unsafe-inline'`** | CodeMirror 的 `style-mod` 在 `document` 上 mount 时走 `createElement('style')` + `textContent` 分支（受 `style-src` 管控；它支持 nonce 但 CM6 不传）⇒ 见 P0-4 定稿策略 |
| **S5** 凭据是否经桥端点访问 | **不经**。`YFW_SETTINGS_PATH`（`bridge.mjs:650`）只在 `loadConfig()`(:610) / `syncKernelSettings()`(:652) 由**桥进程自身用 fs 直读写**；`diag-monitor.cjs:240` 同理 | D1-a 的"写排除数据根"**零副作用**（应用不依赖）；且**读模式的 roots 必须含数据根**（知识库/工作流经 `/read-file` 读 `~/.yfworking` 下的文档） |
| **S6** DevLens `batchSize` 生效层 | ⚠️ **`batchSize` 根本不是并发数**：实际并发 = `FILE_BATCH_SIZE = 10`（`summarizer/types.js:17` 硬编码常量）；`batchSize` 在 config/ 之外**零消费**（纯遗留字段）；`jobs.ts:68` 的 `batchSize:50` 只是"跳过摘要"的 dummy config；`retry.js` **已对 429 做指数退避**（4 次尝试，1s→15s） | **P1-4 需重写并降级**（见 §4 P1-4）；**并更正我此前给出的"把 `batchSize` 降到 ≤20"建议——该字段不被消费，建议无效** |
| **S7** ✅（实施期新增） | D2-2 能否用 `initiator` 区分主窗口与沙箱 iframe？ | Electron 43 探针：file:// 主窗 / 桥源文档 / 无 same-origin 沙箱 iframe 各发一次请求，打印 details | ⚠️ **`details.initiator` 字段不存在（undefined）** ⇒ spec 原设想的机制不可用；但 **`details.frame.origin` 可用且干净区分**（`file://` / 桥源 / `null`）⇒ D2-2 改用 frame.origin（见 §10） |
| **S8** ✅（实施期新增） | `onHeadersReceived` 能拦截 `file://` 外壳文档吗？ | Electron 探针：注册 onHeadersReceived + `loadFile` | 能拦截 ⇒ CSP 可用主进程注入（支持 report-only），不必走无法灰度的 `<meta>` |
| **S9** ✅（实施期新增） | 注入的 CSP **真的生效**且不打断加载吗？ | 干净进程：注入后加载含内联脚本的 file:// 页，收集 `securitypolicyviolation` | 加载正常 + 捕获 `script-src-elem :: inline` / `script-src :: eval` ⇒ 策略生效；**外部 `file:` 脚本仍放行** ⇒ 不打断外壳模块脚本。⚠️ 同会话二次导航的 `ERR_FAILED` 是探针伪影 |

**由四个 spike 收敛出的三条决策级结论**

1. **写模式的闸门可以立即收紧，读模式必须灰度**（S1 + S5）：`/write-file` 只有 1 个调用点，强拦几乎无副作用；而 `/list-dir` 要服务"任意目录选择"、`/read-file` 要读数据根下的知识库文档 ⇒ 读模式先告警。
2. **CSP 的可行形态已确定**（S3）：`script-src 'self'` 能上（这是收益最大的一条），`style-src` 需 `'unsafe-inline'`（CodeMirror 硬约束），预览载荷不套严格策略（S2 的 p5.js）。
3. **P1-4 从"高价值修复"降为"观察项"**（S6）：并发只有 10 且有 429 退避重试 ⇒ 原判断"必触发 429"**无依据**，真实失败原因更可能是账号余额（402）。

---

## 1. 现状与缺陷（实测核实）

> 全部结论来自源码直读与图谱实测，逐条给出定位，可独立复核。**§1.4 同时更正了三处此前文档中的失真**。

### 1.1 桥的文件类端点：**10 个**，起先全无路径包含校验

> ⚠️ **本节首个版本低估了范围**（当时记为"4 个"）。实施时用 `grep -nE "[^a-zA-Z]resolve\(("`
> 才发现另有 5 个同类端点（sheet/docx 读写 + install-skill），它们同样只做 `resolve()`。
> **教训：按"端点清单"而非"记得的端点"扫，且扫法要用"裸 resolve 调用"这个模式**——
> 只 grep 已知端点名会漏。

`server/bridge.mjs`：

| 端点 | 行 | 现状 | 缺口 |
|---|---|---|---|
| `/list-dir` | 2436-2458 | `resolve(path)` → `readdir`，有 `MAX_LIST_ENTRIES = 2000`，**已是异步** | 无包含校验 ⇒ **任意目录列举**（信息泄露） |
| `/read-file` | 2460-2465 | `statSync` → 上限 524,288 B（512KB）→ `readFileSync` 全文 | 无包含校验 ⇒ **任意文件读** |
| `/raw-file` | 2466-2471 | `statSync` → **无任何上限** → `readFileSync`（**同步、整文件进内存**）→ 按扩展名给 `Content-Type` | 无包含校验 + **无体积上限** + mime 表含 `html`/`htm`/`svg` |
| `/write-file` | 2472-2479 | `readJsonBody` → `resolve(body.path)` → 上限 2,097,152 B（2MB）→ `writeFileSync` | 无包含校验 ⇒ **任意文件写** |
| `/convert-office` | 2480+ | 上限 10MB，python 脚本走**白名单** `scriptMap` ✅ | 无包含校验 |
| `/read-sheet` | 2636 | `resolve(body.path)`，无上限 | 无包含校验 |
| `/write-sheet` | 2651 | 同 `/write-file`，2MB | 无包含校验 |
| `/read-docx` | 2696 | `resolve(body.path)` | 无包含校验 |
| `/write-docx` | 2713 | 同 `/write-file` | 无包含校验 |
| `/install-skill` | 3413 | `resolve(body.path)` 作为**安装源**；会把源目录里的 SKILL.md **就地转换**，并安装到数据根 `skills/` | 无包含校验（且它本身要写数据根 ⇒ 见 §10 的 denyRoots 取舍） |

调用面（S1 实测，决定灰度）：`/write-file` **仅 1 处**（`FileEditor.tsx:54` 保存）；`/read-file` 4 处（含 `knowledgeApi.readRawDoc` 读数据根下的知识库文档）；`/list-dir` 2 处（含 `DirectoryPicker`，**起手目录是用户主目录**）。

现状代码形态（`/read-file`，2461-2462）：

```js
const fp = resolve((url.searchParams.get('path') || '').replace(/\//g, sep))
const st = statSync(fp)
if (st.isDirectory() || st.size > 524288) throw new Error('Invalid or too large')
```

**关键点：`resolve()` 只做"相对转绝对"，没有任何"是否在允许根内"的判断。** 写能力 = 持久化 RCE 的入口（覆盖 `preload.cjs` / 启动项 / shell 配置即可）。

### 1.2 令牌闸门：设计健全，但挡不住 §1.3 的链

`server/bridge.mjs:1989-1997`（`isAllowedOrigin`）、`:2023`（`authorizeBridgeRequest` 调用点）与 `server/bridge-token.cjs`：

- `isAllowedOrigin`：无 Origin ✅ / `file://` ✅ / `localhost|127.0.0.1|::1` 任意端口 ✅ / 其余 ❌。
- `authorizeBridgeRequest`：**无 Origin 或 opaque（`null`）必须持令牌**，fail-closed；仅 `/health`、`/api/auth/*` 豁免；**面向 `file://` 直开也 fail-closed**（团队已识别"file:// 直开可被沙箱查探"这条链，见 `bridge-token.cjs` 注释）。
- 回归网：`server/bridge-auth-token.test.mjs`——**5 个 test 块 / 68 处断言**，含 4 个真机用例（各带 90s timeout）：纯函数闸门语义、静态断言（fail-closed、令牌不进日志、已贯通 main/诊断/桌宠/spawn env）、无 Origin 无 token → 401 与带 token → 200、env 无令牌时自生成落盘（0600）、WS 无令牌被拒。
- 令牌注入：`electron/bridge-header-inject.cjs`，只注入**桥 host**，且**显式排除** `UNTRUSTED_SESSION_PARTITION_PREFIXES`（自动化/浏览器分区）——注释明确点出"若给自动化分区注入，任意网站即可直调桥"。**这一处做得对，是本次评估里最见功底的设计。**
- 浏览器执行器 `electron/browser-executor.cjs` 拦住 `file://` 导航（无 hostname 无法进白名单）。
- ⚠️ **但带"非不透明 Origin"的请求是免检的**——原码即 `if (origin && !isOpaqueOrigin(origin)) return { ok: true, via: 'origin' }`（`bridge-token.cjs`）。而 `isAllowedOrigin` 放行**任意端口的 `localhost` / `127.0.0.1` / `::1`**。⇒ 实际只有两道判定：① 非 loopback 来源被拒；② 无来源 / opaque 需令牌（**令牌由主进程注入器补给**）。**"令牌"对"已经在本应用 session 内运行的代码"不构成边界**（注入器会替它补上）——这既解释了 §1.3 为何成立，也说明修复必须针对**来源判定**，而不是再加令牌。
- 令牌头名：`x-yfw-bridge-token`（**不是** `x-bridge-token`）。`authorizeBridgeRequest` 的实际调用在 `server/bridge.mjs:2023` 附近，HTTP 与 WS 共用同一判定。
- 机制有效性已被真实利用印证：`bridge-token.cjs` 头部记录 2026-09-17 实机验证中 **`Origin: null` 曾让 `GET /config` 以 200 返回明文 authTokens**，随后才加固为"opaque 必须持令牌"。⇒ 这类 origin 判定会被真实利用，不是理论风险。

⇒ **结论：闸门无需重做。** §P0 要补的是"持令牌之后的授权粒度"（能干什么），不是"谁能进门"。

### 1.3 不受信 HTML 在桥源上执行（令牌闸门管不到的链）

| 位置 | 事实 |
|---|---|
| `src/components/editor/FileEditor.tsx:216-229` | `HtmlPreview`：`src = getBridgeUrl() + '/raw-file?path=' + encodeURIComponent(path)`，`sandbox="allow-scripts allow-same-origin"`，注释：**"放行 JS 支持互动展示（brainstorming 等）"** |
| `server/bridge.mjs:2469` | mime 表把 `html`/`htm` → `text/html; charset=utf-8`、`svg` → `image/svg+xml` |

**推理链**（每步都在代码里）：

1. `HtmlPreview` 的 iframe 从桥取内容 ⇒ 文档 **origin = 桥 origin**；`allow-same-origin` 使其**不是 opaque** ⇒ 依 §1.2，其请求带 `Origin: http://127.0.0.1:51517`（loopback，白名单内）⇒ **完全免检**，连令牌都不需要。
2. **若只去掉 `allow-same-origin`**（原 P0-3 方案）⇒ 文档变 opaque ⇒ 请求需令牌 ⇒ **但主进程注入器仍会为"桥 host 的请求"补令牌**（注入器只排除 `UNTRUSTED_SESSION_PARTITION_PREFIXES`，FileEditor 预览不在其中）⇒ **写操作依旧成功**。且状态改变类请求（`fetch(..., { mode: 'no-cors', method: 'POST', body })`）**不需要读取响应**，CORS 拦不住副作用（`/write-file` 只读 body 并 JSON 解析，不校验 `Content-Type`）。
3. ⇒ 配合 §1.1 的缺失 = **打开一个不受信 `.html` → 任意文件读写 → 持久化 RCE**。

**关键结论（修正原方案）**：**仅去掉 `allow-same-origin` 不足以堵住写入**——它只是把"origin 免检"换成"注入器补令牌"，两条路都通向授权。有效修复必须让预览**既拿不到令牌、又不在允许来源清单内**（见 §2 D2 修订案）。

**触发前置条件（§6 S4 的贡献，重要）**：这条链**不能**由提示注入单独触发——内核既无文件端点引用，也拿不到令牌（S4 结论见 §6）。**必须存在"渲染层可执行上下文"**，即用户实际打开 / 拖入一个不受信 `.html`。

**触发场景现实**：用户在文件面板打开/拖入一个下载来的 `.html`、AI 生成的 HTML 报告、或克隆仓库里的示例页。**不需要任何恶意网站或用户提权操作。**

> 注：Office 预览那条链**已核实不可利用** —— `server/convert_docx.py` / `convert_xls.py` 对 `& < >` 做了 `escape()`，且只插入文本节点、属性全硬编码；markdown 渲染刻意不用 `rehype-raw`。**唯一的真缺口就是 HTML 预览这条。**

### 1.4 纵深防御缺失

| 项 | 现状 |
|---|---|
| CSP | `index.html` **无任何 CSP meta**；且运行时外链 Google Fonts（`preconnect` + stylesheet） |
| 窗口 | `contextIsolation: true` ✅ / `nodeIntegration: false` ✅ / **`sandbox: false`**（preload 需 Node 权限）/ `backgroundThrottling: false` |
| `dangerouslySetInnerHTML` | 2 处：`FileEditor.tsx:287`（office HTML，转换器已转义）、`FilePreview.tsx:152`（`html: true` 的 markdown） |
| shell 拼接 | `diag-monitor.cjs:95` `spawn(cmdArgs.join(' '), { shell: true })`；`app-profiler.cjs:314` 仅 `.bat/.cmd` 分支 `exec(\`"${exePath}" ${args.join(' ')}\`)`（Windows 妥协，已注释）；`bridge.mjs:1364` `execSync(\`taskkill -F -T -PID ${pid}\`)`（pid 为数字，低危） |

⇒ 转换器的转义是**当前唯一防线**。任何人改动转换器、或新增一条未转义路径，即直达 §1.3 的后果。这是"纵深防御缺失"，不是"当前可触发漏洞"。

### 1.5 性能：单点阻塞

- `bridge.mjs` **单进程单事件循环**承载**全部会话**的 HTTP + WS 流式；而 `/read-file`、`/raw-file`、`/write-file` 用 `statSync/readFileSync/writeFileSync`。**一次大文件同步读（`/raw-file` 无上限）会阻塞所有会话的 token 流** ⇒ 用户看到"所有窗口一起卡住"。
- 对照：同文件的 `/list-dir` **已是异步**并带条目上限 ⇒ **改造范式现成**。
- `bridge.mjs` 4,318 行（占全仓 3.7%）；其后 `knowledge.mjs` 2,554、`engine.mjs` 2,390、`tools.mjs` 1,902、`main.cjs` 1,787。全仓 24 个文件 >1000 行，**前 10 大文件占 18% 代码**，中位数仅 133 行 ⇒ "少数巨石 + 大量短文件"。
- 平均出度 **4.09** / 平均入度 **3.17**（大项目典型 8–15）⇒ **耦合度低，不臃肿**。
- 24 个文件 >1000 行；68 个域中 **25 个（37%）只有 1–2 个模块**（`search`/`vault`/`usage`/`worktree`/`permissions` 等单文件域）⇒ **域分类过细**。

### 1.6 安全规则双份实现（漂移风险）

> ⚠️ **本节的风险描述在 P1-2 实施期被实测更正**，见 §11.1：`highrisk` 的桥侧判定
> **不参与门控**（只决定弹窗文案），故"桥放行、内核拦截错位"**不成立**；真实危害是
> **提示牌错**（漏标 + 告警疲劳）。`approval-mode` 的枚举/默认档一致性**已有测试把关**。

| 双份 | 影响 |
|---|---|
| `kernel/approval-mode.mjs` ↔ `server/approval-mode.mjs` | 一致性（**非安全错位**）：枚举/默认档已由 `server/approval-mode.test.mjs` 逐字比对 |
| `kernel/highrisk.mjs` ↔ `server/highrisk.mjs` | **安全提示牌**：两份词表实测 **52.7% 判定分叉**（无任何测试把关）→ 已由 P1-2 归一（§11） |
| `kernel/config.mjs` ↔ `src/lib/config.ts`、`kernel/agents.mjs` ↔ `src/lib/agents.ts` | 一致性（非安全） |
| `shared/knowledge-core.mjs` ↔ `src/lib/knowledgeBlocks.ts` | 同口径重复实现（前端刻意不复用） |

图谱实测：10 组同名文件。前端 `renderer→shared` 静态边为 **0** ⇒ 前端对 `shared/knowledge-core.mjs` 的引用**全在注释里**，`src/lib/knowledgeBlocks.ts` 是重复实现而非 import。

### 1.7 本次核实更正的三处文档失真

| 原表述 | 实测 | 处置 |
|---|---|---|
| "循环依赖：38 节点大环（App ↔ 设置窗 ↔ useYFWCLI ↔ WS 重连）" | **文件级不成立**：`App.tsx` 仅被 `main.tsx` 引用、无回边；`getOrCreateWS`/`scheduleReconnect` 均为 `useYFWCLI.ts` 内部符号。文件级实测仅 **5 组、最大 3 文件** | 已改为"符号图产物 + 文件级无环"，并说明两者差异 |
| "测试文件 365" | **366**（`docs/architecture.html` 的 364 还漏了 e2e 与 `test-*.mjs`） | md 已更正；**HTML 侧已随 §P2-4① 补全统一**（该文已纳入门禁 C） |
| 跨层边数字（`host→bridge` 13 等） | `host→bridge` **15**、`bridge→kernel` **10**、`host→kernel` **4**、另有 `bridge→host` 2 / `renderer→bridge` 1 | md 已刷新；并新增"tooling→运行层 33 条来自构建验证脚本"的口径说明 |

---

## 2. 架构决策（需拍板）

### D1 · 单一路径闸门：`shared/fs-guard.mjs`

**理由**：安全规则**必须单一真源**（§1.6 已证明双份必漂移）；放 `shared/` 因为 `server` 与 `kernel` 都要用，且图谱已证明 `kernel→shared` 有 25 条真实边（该方向可行）。

**导出契约**（`FSGuardError` 带 `code`）：

| 函数 | 语义 |
|---|---|
| `resolveReadable(input, opts)` | 返回 realpath 后的绝对路径；越界抛 `EOUTSIDE` |
| `resolveWritable(input, opts)` | 同上；额外拒绝写"根自身"与"凭据名单" |
| `assertSizeOk(stat, maxBytes)` | 统一 `ETOOLARGE` |

**校验顺序（缺一不可，按此顺序实现）**：

1. 入参必须是字符串且非空；**拒绝 NUL 与控制字符**（`\0`）。
2. `path.resolve` 归一化。
3. **realpath 必须作用于 `roots` 与目标两侧**（否则 roots 内含符号链接时判定失效）；写模式目标可能不存在 ⇒ 对**最近的已存在父目录**做 realpath，再拼回余下段。
4. **包含判定用 `path.relative(root, target)`**：结果不得以 `..` 开头、不得为绝对路径（**不要用字符串前缀比较**——`/a/b` 会误放 `/a/b-evil`）。
5. `roots` 的 realpath 结果按长度降序匹配（取最深命中，便于给错误信息）。
6. 扩展名策略按端点给定（`opts.exts`），不命中抛 `EBADEXT`。
7. 体积校验统一走 `assertSizeOk`。

**roots 构成（决策点 D1-a —— ✅ 已拍板）**：`roots = { 当前会话工作目录, 项目根, 用户显式授权的目录 }`；**写模式排除 YFW 数据根**（`~/.yfw` / `~/.yfworking`，因含 `settings.json` 的 `ANTHROPIC_AUTH_TOKEN`），**读模式允许**（按你的选择）。若 S5 最终确认应用自身不经桥读凭据，可再收紧为读也排除。
> 实施含义：`resolveWritable` 需独立的 `denyRoots`（默认 `[~/.yfw, ~/.yfworking]`），`resolveReadable` 不带该名单。

**兼容性护栏（重要）**：P0 落地时**只对写模式强拦，读模式先"记录并告警"不拦**（`console.warn` 带路径与调用来源），观察一周再收紧到拦。理由：`roots` 一旦配错，用户"打开 `D:\资料\a.docx`"这类合法操作会直接失败，体验伤害大于收益。告警期数据用于确定 roots 的真实分布。

### D2 · 预览必须"既无令牌、又不在允许来源内"（原「与桥异源」案不足以修复）

| 方案 | 做法 | 取舍 |
|---|---|---|
| **A（推荐，最小改动）** | ① 预览 iframe **去掉 `allow-same-origin`**（保留 `allow-scripts`，互动展示仍可跑 JS）；② `/raw-file` 对 `html`/`htm`/`svg` 响应加 **`Content-Security-Policy: sandbox allow-scripts`**（等效给该响应一个 opaque 源）+ **`X-Content-Type-Options: nosniff`**；③ `svg` 从 mime 表**移除**（改走 `application/octet-stream` + `<img>`） | 改动局部；**代价**：预览内的 JS 拿不到桥 API（跨源 + opaque ⇒ 请求带 `Origin: null` ⇒ 闸门要令牌 ⇒ 401）。若 `brainstorming` 预览确实调桥 API，需 §6 S2 的结论来决定是否追加受限 RPC |
| **B（更彻底，后续）** | HTML 预览走**独立端口的"预览源"**（如 `127.0.0.1:51518`），该源不在桥的 loopback 白名单内 ⇒ 天然跨源、且不共享桥的令牌注入 | 隔离最彻底；需新端口与生命周期管理，作为 A 之后的收敛 |

> ⚠️ **本节已被 §1.2 的新证据修订：原 A 案不足够（见下方"修订案"）。原 A/B 对照表保留，仅作决策留痕。**

**修订案（原 A 案不成立的原因）**：`allow-same-origin` 只改变 `Origin` 的形态——保留时走"loopback origin 免检"，去掉时走"opaque + 注入器补令牌"，**两条路都授权**（§1.2）。因此修复必须同时掐掉两条路：

| 编号 | 动作 | 掐掉的路径 |
|---|---|---|
| **D2-1** | `src/components/editor/FileEditor.tsx:216-229` 去掉 `allow-same-origin`（保留 `allow-scripts`，互动展示仍可跑 JS） | 掐掉「loopback origin 免检」 |
| **D2-2** | **令牌注入限定"可信发起者"**：`electron/bridge-header-inject.cjs` 仅在 `details.initiator` 属于受信文档（打包态 `file://`、dev 态 `localhost:5197`）时注入；预览 frame 的 initiator 是桥 origin ⇒ **不再被注入** | 掐掉「opaque + 补令牌」 |
| **D2-3**（纵深，可与上并行） | 收窄 `isAllowedOrigin`：把"任意端口 loopback"改为**显式清单**（桥自身 origin + dev GUI `5197`）。**注意：单独做 D2-3 无效**——预览仍由桥提供服务时，其 origin 就在清单内 | 掐掉「换个 loopback 端口即被信任」 |
| **D2-4** | `/raw-file` 的 `html`/`htm` 响应加 `Content-Security-Policy: sandbox allow-scripts` + `X-Content-Type-Options: nosniff`；`svg` 移出 mime 表 | 附加约束 |

**原 B 案（独立端口预览源）为何不足以单独用**：预览若落在另一个 loopback 端口，其 `Origin` 仍是 loopback ⇒ 依 §1.2 **照样免检**。B 案必须与 D2-3 合做才等价，收益不高于 D2-1 + D2-2。

**实施注意**：D2-2 需确认本项目的 Electron 版本在 `onBeforeSendHeaders` 中提供 `details.initiator`；不可用时退化为按 `webContentsId` / frame 白名单实现，须在实施时验证。**WS 握手同样依赖注入**，须一并回归（打包渲染层 WS 发起者同为 `file://`）。

**验收判据（修订）**：
- 预览内 `fetch('/write-file', { method: 'POST', mode: 'no-cors', body: … })` → **服务端 401**（不是"响应不可读"，而是**根本没被授权**）；
- 预览内 `GET /read-file` → 401；
- 预览内 `<script>` **仍能执行**（互动展示不回归）；
- 主窗口与 WS 全功能不回归（这是 D2-2 的主要风险面）。

### D3 · CSP 从"无"到"有"，但用主进程注入而非 meta

**理由**：meta CSP **不支持 `report-only`**，而主进程 `session.webRequest.onHeadersReceived` 注入可**分环境灰度**（dev 宽松 / 打包收紧），并可先 `Content-Security-Policy-Report-Only` 观察违规再切强制。

初始策略（打包态）：

```
default-src 'none'
script-src 'self'
style-src 'self' 'unsafe-inline'        ← 待 §6 S3 确认能否去掉
img-src 'self' data: blob:
font-src 'self'                          ← 配合 Google Fonts 本地化
connect-src http://127.0.0.1:51517 ws://127.0.0.1:51517 http://localhost:51517 ws://localhost:51517
frame-src http://127.0.0.1:51517
object-src 'none'; base-uri 'none'; frame-ancestors 'none'
```

**同时**：Google Fonts 本地化（自托管或 `@fontsource`），去掉 `preconnect` ⇒ 顺带解掉"离线仍外链"的矛盾（本应用卖点之一是离线自包含，运行时外链 CDN 本身就不一致）。

---

## 3. P0 施工项（建议当天完成）

### P0-1 · 文件端点接入路径闸门

**改动点**：`server/bridge.mjs` 的 `/list-dir`(2436)、`/read-file`(2460)、`/raw-file`(2466)、`/write-file`(2472)、`/convert-office`(2480)；新增 `shared/fs-guard.mjs`。

**形态**（示意，具体命名按 §2 D1）：

```js
import { resolveReadable, resolveWritable, assertSizeOk, FSGuardError } from '../shared/fs-guard.mjs'

if (url.pathname === '/read-file') {
  const fp = await resolveReadable(url.searchParams.get('path'), { roots: fileRoots() })
  const st = await stat(fp)
  assertSizeOk(st, 512 * 1024)
  return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({ path: fp, content: await readFile(fp, 'utf-8'), size: st.size }))
}
```

**统一错误响应**：越界 → `403 { error: 'outside allowed roots', code: 'EOUTSIDE', path }`（**不回显 realpath 的完整解析结果**，避免成为目录探测工具）；超限 → `413`；扩展名不符 → `415`。

**顺带加固（S4 发现，零风险）**：`server/bridge.mjs` 的 `buildChildEnv()` 以 `{ ...process.env, ... }` 构造内核子进程 env，**未剔除 `YFW_BRIDGE_TOKEN`**（该令牌由 `main.cjs` 注入桥进程）。内核由此继承桥令牌。当前不可利用（Bash 子进程 env 是严格白名单、`kernel/` 不调文件端点），但属**无谓暴露**：在 `buildChildEnv()` 中**显式 `delete` 令牌相关键**（`YFW_BRIDGE_TOKEN` 等），并在测试中断言"内核 env 不含桥令牌"。

**验收**：§6 攻击用例 1–6、10 全绿；`grep -n "resolve(" server/bridge.mjs` 在文件类端点内不再出现裸 `resolve`；内核子进程 env 中断言无 `YFW_BRIDGE_TOKEN`。

### P0-2 · `/raw-file` 补齐上限与类型收紧

- 加 `MAX_RAW_BYTES`（建议 32MB，与 Office 的 10MB、PDF 预览需求对齐；**用配置项**，不硬编码）。
- 用 `createReadStream` + `pipeline` 流式返回（**替换 `readFileSync`**）⇒ 既解决 OOM 又不阻塞事件循环；`Content-Length` 仍取自 `stat`。
- mime 表：**移除 `svg`**；`html`/`htm` 加上 D2 的 `CSP: sandbox` + `nosniff`。
- **验收**：请求 2GB 文件 → `413`（且**不**发生内存增长，用 `process.memoryUsage()` 前后对比断言）；请求 `.svg` → 非 `image/svg+xml`。

### P0-3 · 预览隔离（止住 §1.3 的链）——**按 §2 D2 修订案执行**

**执行项（两项必须同时做，缺一即失效）**

1. **D2-1** `src/components/editor/FileEditor.tsx:216-229`：`sandbox="allow-scripts allow-same-origin"` → **`sandbox="allow-scripts"`**。
2. **D2-2** `electron/bridge-header-inject.cjs`：令牌注入限定**可信发起者**（打包态 `file://` / dev 态 `localhost:5197`），预览 frame 不再获注入。
3. 纵深（可并行）：`isAllowedOrigin` 收窄为显式清单（桥自身 origin + `5197`）；`/raw-file` 的 html 响应加 `CSP: sandbox allow-scripts` + `nosniff`。

**S2 结论（已跑，见 §6）对方案的支撑**：
- **6 个技能 HTML 模板无一调用桥**（`fetch`/`XHR` 命中数全为 0）⇒ 去掉同源**不会**中断任何既有桥 API 用法，"补受限 RPC"**不需要**；
- `brainstorming` 的互动展示走**它自己的本地服务器**（`skills/brainstorming/scripts/server.cjs`：`127.0.0.1` + URL `?key=` 令牌 + 端口绑定 cookie + **WS Origin 校验**），**不经桥** ⇒ 与 D2-1 无耦合；
- 唯一同源依赖是 3 个模板的 `localStorage`（主题偏好），且**全部已被 `try{}catch(e){}` 包裹** ⇒ 变 opaque 后仅"偏好不持久化"，**功能不坏**；
- ⚠️ `space-generative-art/templates/viewer.html` 从 **cdnjs 加载 p5.js**（另引 Google Fonts）⇒ **P0-4 的 CSP 不能对预览载荷套用严格 `script-src 'self'`**，否则会打断它（详见 P0-4）。

**验收**：预览内 `fetch('/write-file', { method: 'POST', mode: 'no-cors', body })` → **401**；`GET /read-file` → 401；预览内 `<script>` 仍执行；主窗口与 WS 不回归。

### P0-4 · CSP + 外链收敛

**⚠️ 必须分上下文（S2 新发现，否则会打断既有功能）**：预览载荷是**用户/技能生成的 HTML，会合法加载外部 CDN** —— `skills/space-generative-art/templates/viewer.html` 从 **cdnjs 加载 p5.js**、并引 Google Fonts。若把 `script-src 'self'` 套到 `/raw-file` 的 HTML 响应上，该模板（及其它同类互动展示）**会直接坏掉**。

**策略已由 S3 定稿（见 §6 S3）**：

| 上下文 | CSP 策略 | 依据 |
|---|---|---|
| **应用外壳**（主窗口文档） | `default-src 'none'`<br>`script-src 'self'`<br>`style-src 'self' 'unsafe-inline'` ← **必须保留**<br>`img-src 'self' data: blob:`<br>`font-src 'self'`<br>`connect-src http://127.0.0.1:51517 ws://127.0.0.1:51517 http://localhost:51517 ws://localhost:51517`<br>`frame-src http://127.0.0.1:51517`<br>`object-src 'none'; base-uri 'none'; frame-ancestors 'none'` | `script-src 'self'` 可上：产物**无 inline script**、`eval` 类命中 **0**；`style-src` 去不掉：CodeMirror 的 `style-mod` 在 `document` 上 mount 走 `createElement('style')`+`textContent`（`style-mod.js:100/135`），CM6 不传 nonce |
| **预览载荷**（`/raw-file` 的 html/htm 响应） | **只做隔离、不锁资源**：`Content-Security-Policy: sandbox allow-scripts` + `X-Content-Type-Options: nosniff`。**不要**加 `script-src`/`default-src`（会打断 p5.js 等 CDN 依赖） | S2：viewer.html 依赖 cdnjs |

**已知残留（可接受，但需在 spec 留痕）**：`style-src 'unsafe-inline'` **无法去掉**。其风险显著低于 `script-src 'unsafe-inline'`（CSS 注入不能直接执行 JS）。若将来想彻底去掉，需给 CodeMirror 注入 nonce（要改 `style-mod` 的 mount 调用，属上游改动）。

**实施顺序**
1. 主进程 `session.webRequest.onHeadersReceived` **按路径区分**注入（**不要**用 meta：meta CSP 不支持 `Report-Only`，无法灰度）。
2. **先 Report-Only 跑一天**，只盯 `script-src` 违规（`style-src` 已有定论），无违规再切强制。
3. 可顺手把 `index.html:16-21` 那处 inline `<style>`（仅 2 条防闪白规则）外链化——**但注意它不改变结论**（CodeMirror 仍需要 `'unsafe-inline'`），属可选清理。
4. Google Fonts 本地化（自托管或 `@fontsource`），去掉 `preconnect` ⇒ 顺带解掉"离线产品却运行时外链 CDN"的矛盾，并使 `font-src 'self'` 成立。

**验收**
- 应用外壳的 CSP 违规报告为 **0**（尤其 `script-src`：CodeMirror / xyflow / office 预览是三个高危区）；
- **预览载荷不受影响**：打开 `space-generative-art/templates/viewer.html`，p5.js **仍能加载并渲染**（回归用例，防 CSP 误伤）；
- **CodeMirror 编辑器仍正常着色**（验证 `style-src 'unsafe-inline'` 保留有效）；
- `grep -rn "fonts.googleapis\|fonts.gstatic" index.html src/` 为空。

---

## 4. P1 施工项

### P1-1 · 拆桥 + 去同步 I/O

- 抽出 `server/routes/files.mjs`（5 个文件类端点）、`server/routes/office.mjs`（`/convert-office` + 转换器编排）；`bridge.mjs` 保留 router 表与网关中间件。
- **以 `/list-dir`(2436-2458) 为范式**：异步 + 条目上限 + 截断标记 `truncated`。
- 全桥 `*Sync` 清理：`grep -cE "\w+Sync\(" server/bridge.mjs` **目标归零**（配置类极小读写如需保留，逐处加注释说明理由）。
- **验收**：`bridge.mjs` ≤1,500 行；8 并发读 50MB 文件时，`perf_hooks.monitorEventLoopDelay` 的 **P95 < 200ms**（改前应有秒级尖峰，作为对照）；`server/bridge-auth-token.test.mjs` 全绿。

### P1-2 · 安全规则单一真源

- `approval-mode` / `highrisk` 抽到 `shared/`，`kernel/` 与 `server/` 双侧改为 import（保留原路径的 re-export 壳，避免一次性改调用方）。
- 新增**一致性回归测试**：两侧导出的档位表与高危词表 `deepEqual`；CI 必跑。
- **验收**：删掉任一侧的实现后另一侧仍能跑；一致性测试在任何单侧改动时会红。

### P1-3 · shell 拼接加固

- `electron/diag-monitor.cjs:95`：`spawn(cmdArgs.join(' '), { shell: true })` → 显式 argv 数组 + `{ shell: false }`；确需 shell 内置命令时用 `cmd /c` 并做引号转义。
- `electron/app-profiler.cjs:314`：`.bat/.cmd` 分支改 `spawn(exePath, args, { shell: true })` 形态或对每个 arg 加引号转义。
- **验收**：两处不再出现 `join(' ')` 直接进 shell；带空格/引号/`&` 的路径参数实测不被解释为命令分隔符。

### P1-4 · DevLens `summarize` 并发 —— **经 S6 证据后降级为观察项**

**⚠️ 本节此前的判断已被 S6 推翻，留痕如下（避免后来者重复误判）**

| 原判断 | S6 实测 | 处置 |
|---|---|---|
| "`Promise.all` 未限流且 `batchSize=50` ⇒ **必触发 429**" | 三处 `Promise.all`（`summarizer/index.js:196/233/260`）确实未限流，**但并发数由常量 `FILE_BATCH_SIZE = 10` 决定**（`summarizer/types.js:17`），与 `batchSize` 无关 | 判断**不成立** |
| "把 `~/.devlens/config.json` 的 `batchSize` 降到 ≤20 即可" | `batchSize` 在 `config/` 之外**零消费**（纯遗留字段），改它**完全无效** | **该建议无效，已撤回** |
| "`jobs.ts:68` 的 `batchSize:50` 是并发源" | 那只是**跳过摘要时的 dummy config**（源码注释：won't be called — skipSummarization will bypass this） | 判断**不成立** |
| —（未考虑） | `summarizer/retry.js` **已对 429 做指数退避**：`maxAttempts: 4`、`baseDelayMs: 1000`、`maxDelayMs: 15000`，并明确区分可重试（429/5xx/网络）与不可重试（400/401/403/404） | 429 有兜底 |

**结论：不列为施工项。** 10 并发的批次 + 429 退避重试，属合理设计。此前 `summarize` 失败的**真实原因更可能是 HTTP 402（账号余额耗尽）**，而非 429——即一个**外部依赖**问题，不是代码缺陷。

**降级后的动作（仅在实测再遇 429 时启用）**
- 给 `summarizer/index.js` 的三处 `Promise.all` 加并发上限池（信号量，默认 4）；**不要**改 `batchSize`（无效）。
- 或改用环境变量覆盖 `FILE_BATCH_SIZE`（需给该包打补丁或提 PR——它是编译进 `node_modules/devlensio/dist` 的常量）。
- **不在本 spec 范围内**，除非复现。

**顺带（本机配置卫生，非代码改动）**：`~/.devlens/config.json` 以**明文**保存 apiKey 且位于用户目录；建议确认文件权限为 `0600`，并注意 `~/.devlens/` 下还有图谱库（含仓库源码摘要）。

---

## 5. P2 施工项（结构治理，可按周推进）

### P2-1 · 巨石拆分（自上而下取前 5）

`bridge.mjs`(4,318，P1-1 已拆) → `knowledge.mjs`(2,554) → `engine.mjs`(2,390) → `tools.mjs`(1,902) → `main.cjs`(1,787)。
**约束**：纯搬移 + 显式导出，**零行为变更**；每拆一个跑该模块的既有测试（无测试的先用图谱登记"改前行为快照"）。

### P2-2 · 功能域归并 ✅ 已完成

把"1–2 模块域"并入邻近域（`search`→`chat` 侧栏能力、`vault`/`permissions`→`settings` 安全组、`usage`→`diagnostic` 观测组、`worktree`→`files`）。
**验收**：域数从 68 降到 ~50；**同步更新 `scripts/build-arch-graph.mjs` 的域表**并重跑图谱（覆盖核对仍须 ✅）。

**实施结果（2026-09-17）**
- **域数 70 → 52**（实测：生成器输出的"功能域 52"），达成"~50"。
- 做法：在生成器里新增 **`SRC_DOMAIN_MERGE`** 归并表（18 条）+ 把 `domainOf` 拆成 `domainOfRaw`（机械分配）与 `domainOf`（套用归并）两层，归并只作用于 renderer 侧。
- **判定标准**（写进了代码注释）：保留"代表独立概念 **且** 模块数 ≥3"的域；并入"只有 1–2 模块、语义上从属于某更大功能面"的目录。归并的 18 条：`search`/`history`→chat；`permissions`/`vault`/`shortcuts`/`auth`→settings；`rail`/`boot`/`command-palette`/`ErrorBoundary.tsx`/`src-root`→layout；`worktree`/`editor`→files；`usage`/`cockpit`→diagnostic；`browser`→apps；`hooks`/`types`→lib。
- **刻意不合并后端域**：`kernel/bridge/host/tooling` 的域是 `DOMAINS` 里**手工策展、带 name/desc** 的语义域（如 `b-mcp`=MCP 配置面）。合并它们等于销毁架构信息，不能为凑数字而动——这也是为什么合并后仍有 10 个 ≤2 模块的域（全是后端语义域）。
- **覆盖核对仍全 ✅**（8 个目录，251/36/68/62/21/1/29/2 全部 已收录=已跟踪）；域内文件合计 **476 = 节点数 476**（无文件在归并中丢失）；无名域 0。
- **新增测试** `kernel-tests/arch-graph-domains.test.mjs`（8 项）：守归并表的四类"错了但不报错"形态——归并目标必须是有名字的真实域、不得出现链式映射（只应用一层）、不得自映射、来源与目标集合不相交、后端域不被卷入。为此把生成器的 `main()` 用 `import.meta` 守卫（否则 import 即触发全仓扫描）并导出纯函数。
- **文档同步**：`docs/architecture.md` 的 §12 全部口径已对齐新图谱（域数 52、模块 476、行 118,482、边 1,274、按路径引用 49、覆盖 8 目录、孤立 27、测试排除 388、枢纽与跨层边数值），并**如实标注**了 §12.8 里那批布局度量（"64 个标签 / 填充率 80%"）取自 68 域时代、**需重测**。

### P2-3 · 死代码清点

26 个孤立模块逐个判定。**已确认无任何 import（仅注释提及）**：`src/components/boot/LogoMorph.tsx`、`src/components/settings/experienceFormat.ts` ⇒ 优先删。其余（`shared/office-merge.mjs`、`server/provider-profile.mjs`、`server/workflow-store.mjs`、`server/provider-probe.mjs`、`kernel/config-scan.mjs`）先判"动态加载 or 废弃"。
**验收**：每个孤立模块给出"删除 / 标注为动态入口（附加载点）/ 保留（附理由）"三态结论。

### P2-4 · 文档口径纳入校验 🚧 进行中

把 §1.7 的口径问题制度化：把已在用的 `consistency` 校验脚本化并入 CI（当前 26/26），**并新增两条**：① 文档中的模块/边/域数字必须能在 `docs/architecture-graph.html` 内嵌数据中找到；② 若文档声称"循环依赖"，必须给出**文件级** SCC 证据（防止再把符号图读数当文件级结论）。

**进展（2026-09-17）**
- **① 已完成（含补全）**：在 `scripts/check-doc-anchors.mjs` 里新增**门禁 C**——声明式地列出 **12 条**"文档数字 ↔ 图谱统计量"断言（模块数/域数/边数/行数/排除测试数/按路径引用数/孤立数），逐条与**已提交的** `docs/architecture-graph.html` 内嵌数据比对。覆盖 **两个文档**：`docs/architecture.md`（10 条，文本真源）与 `docs/architecture.html`（2 条，可视化/汇报版——**它此前完全不在门禁内**，是本工作包的补全项）。
  - **它为什么不会变成"每次重构都红"**：它比的是"文档 vs 图谱产物"两个**都在仓库里**的文件，而非"文档 vs 现场扫描"；平时一次改动会同时更新两者，只有**只更新了其中一边**（重生成图谱却忘改文档，或手改数字）时才报警——那正是要人介入的时刻。
  - **断言失效会响亮报错**：若某条的措辞在文档里匹配不到（有人改写了句子没同步断言表），门禁报"匹配不到声明语句"而非静默放过。
  - **已做正反两向验证（4 次）**：正常态 12/12 通过；`.md` 的"52 域"→"47 域"、`.html` 的"52 功能域"→"60 功能域"两处**均被**以退出码 1 抓住并报出可操作指引；另把 `.html` 的措辞由"复核"改成"核对"，门禁报了"匹配不到声明语句"（证明 HTML 侧也不会静默），全部随后恢复。

**口径判定（本轮的核心工作，比改数字更重要）**：`architecture.html` 里混着**三种口径**的数字，**不能一律替换成图谱值**——那样会制造真错误。逐条判定结果：

| 位置 | 原值 | 口径 | 处置 |
|---|---|---|---|
| 第 9 章 循环依赖 | 461 模块 / 1275 边 | **文件级**（与图谱同源） | ✅ 改 476 / 1274，并**实算复核**结论仍成立 |
| 页脚 图谱链接 | 461 模块 / 68 功能域 | 文件级（图谱） | ✅ 改 476 / 52 |
| 第 12 章 bridge 巨石 | 266KB / 4300 行 / 路由 2051-3418 / 闸门 2044 | 代码事实 | ✅ 更新为 234KB / 3812 行 / 路由 **2191-2807** / 闸门 **2178**（新增"其余已外迁至 host-/auth-/readonly-routes"） |
| 第 6 章 内核模块地图 | **68 模块** | **内核文件数**（≠ 功能域数 52） | ⛔ **不改**（卡片列举恰好 68 个内核模块，准确） |
| 第 9 章 规模 badge | 1345 节点 / 3356 边 | **DevLens 符号级**读数 | ⛔ **不改**，仅补标"（DevLens 符号级口径）" |
| 第 9 章 图谱覆盖边界 | 253 个文件节点 | DevLens 口径 | ⛔ 不改 |
| 标题 | v2.8.0 | GUI 发布线（`package.json`） | ⛔ 不改 |

并**在文档内显式写明口径差异**（第 12 章新增一条"文档 / 图谱的口径关系"），避免后续把"68 模块"误改成 52 —— 这正是本轮差点踩的坑。

**本轮顺带修正的两处过期内容**：① 原第 12 章称"`docs/architecture.md`（2026-09-12）…其中「外部 Origin 一律 403」等描述已不准确" —— 该说法**已过期**（md 已同步至 09-17，且"外部 Origin 一律 403"经核查**准确**），改为"md 是真源、HTML 是可视化版、三者数字由门禁 C 互校"；② 页脚"基线 978447c + 工作树未提交改动"更新为当前基线（工作树已干净）。

**单文件行数为何不入门禁**：试图断言"bridge.mjs 3812 行"时发现图谱 `stats.loc` 是**全仓总行数**（118,482）而非单文件值；更关键的是单文件行数会随每次重构变动（P2-1 拆巨石必然变），拿它做门禁等于"每改一次源码就红一次"——正是门禁要避免的 churn。故该处按"描述性快照"处理，理由已写进 `GRAPH_CLAIMS` 注释。

- **② 未做**（需先有一套"文件级 SCC"的计算与文档声明口径）。**但本轮已为它铺路**：用图谱数据（476 节点 / 1274 静态边）实算了一次 Tarjan SCC，得 **5 组、最大 3 文件**，首组 `titleGen ↔ chatStore ↔ settingsStore` —— 与 `.html` 原结论**完全一致**，说明该结论在新口径下依然成立，只是尚未自动化。
- **② 未做**（需先有一套"文件级 SCC"的计算与文档声明口径）。
- **原计划提到的 `consistency` 脚本**在仓库中**找不到**（`grep` 无命中）——该编号的来源需确认；本次未凭猜测重建。


---

## 6. 实验（spike）—— **S1–S6 全部已跑完**，结论如下

| # | 问题 | 方法（已执行） | 结论落点 |
|---|---|---|---|
| **S1** ✅ | 文件端点的**实际调用面**多大？ | 全仓 grep 五个端点（排除桥自身定义），按调用点归类 | **结论见下方 S1**；⚠️ 发现 `DirectoryPicker` 需任意目录 ⇒ 读模式不能强拦 |
| **S2** ✅ | 预览**是否**调桥 API？ | 查 6 个技能 HTML 模板的网络调用 + `localStorage` + `brainstorming/scripts/server.cjs` | **结论见下方 S2** ⇒ D2 取修订案，**无需补受限 RPC** |
| **S3** ✅ | CSP 在这套前端可行吗？`style-src 'unsafe-inline'` 能否去掉？ | 静态扫描 `index.html` + `dist` 产物 + `eval` 类 + CodeMirror `style-mod` 注入方式 | **结论见下方 S3** ⇒ `script-src 'self'` 可上；`style-src` 必须留 `'unsafe-inline'` |
| **S4** ✅ | **内核（LLM）能否直调 `/write-file`**，绕过工具审批闸门？ | 查 `kernel/` 对文件端点的引用、`bridge_request` 可指定的参数、Bash 工具的子进程 env 白名单 | **结论：不能**（三重屏障）⇒ §1.3 链**不由提示注入触发** |
| **S5** ✅ | 凭据文件（`~/.yfw/settings.json`）是否经桥端点访问？ | 查 `YFW_SETTINGS_PATH` 的全部使用点 + 主进程读法 | **结论见下方 S5**：桥自身 fs 直读写，**不经 HTTP 端点** |
| **S6** ✅ | DevLens `batchSize` 哪一层生效、并发多少？ | 读 `node_modules/devlensio/dist` 的 config/summarizer/jobs/retry | **结论见下方 S6**（推翻原判断 ⇒ P1-4 降级） |

### S1 结论（调用面 —— 决定 P0-1 的灰度策略）

| 端点 | 调用点数 | 调用点 | 灰度含义 |
|---|---|---|---|
| `/write-file` | **1** | `src/components/editor/FileEditor.tsx:54`（保存文件） | **写模式可立即强拦**（误伤面最小） |
| `/read-file` | 4 | `editor/EditorWindowRoot.tsx:30`、`files/FilePreview.tsx:55`、`lib/knowledgeApi.ts:764`（`readRawDoc`，读知识库原始文档）、`lib/workflowApi.ts:260`（读工作流审计） | 读模式**不能强拦**：知识库文档在 `~/.yfworking` 下 ⇒ **roots 必须含数据根**（与 D1-a"读允许"一致） |
| `/raw-file` | 3 | `editor/FileEditor.tsx:220`（**HtmlPreview，即 §1.3 那条链**）、`:234`、`files/FilePreview.tsx:65` | 收紧 mime/上限影响面小 |
| `/list-dir` | 2 | `chat/DirectoryPicker.tsx:153`、`files/FileBrowser.tsx:35` | ⚠️ **`DirectoryPicker` 以"用户主目录"为起手目录**（`:112` 注释：传入空串落到用户主目录）⇒ **读模式若强拦会把"选目录"功能直接打坏** |
| `/convert-office` | 2 | `editor/FileEditor.tsx:269`、`files/FilePreview.tsx:43` | 同 `/raw-file` |

**派生结论**：**"写强拦 + 读告警"不是保守选择，而是唯一不破坏功能的顺序**（读侧的合法需求本质上是"任意目录"，因为它要服务文件选择器与用户自己的知识库）。

### S2 结论（预览与桥的关系）

- **6 个技能 HTML 模板全部不调用桥**：`fetch(` / `XMLHttpRequest` 命中数**均为 0**。
- `brainstorming` 的互动展示**走它自己的本地服务器**（`skills/brainstorming/scripts/server.cjs`）：`127.0.0.1` 绑定、URL 带 `?key=<token>`、端口绑定 cookie、**WS 侧有 Origin 校验**（对"跨源 localhost 注入"做过加固）⇒ **不经桥**，与 D2-1 无耦合。
- 唯一同源依赖：3 个模板用 `localStorage`，且**全部已 `try{}catch(e){}` 包裹** ⇒ 去掉 `allow-same-origin` 后仅"主题偏好不持久化"，**功能不回归**。
- ⚠️ **副作用（重要）**：`space-generative-art/templates/viewer.html` 从 **cdnjs 加载 p5.js** + Google Fonts ⇒ **CSP 不能对预览载荷套严格 `script-src`**（见 P0-4 的分上下文策略）。

### S3 结论（CSP 可行形态 —— P0-4 的定稿依据）

| 检查项 | 结果 | 对 CSP 的含义 |
|---|---|---|
| `dist`/`index.html` 的 inline `<script>` | **无**（产物是 `<script type="module" crossorigin src="./assets/index-*.js">`） | ✅ `script-src 'self'` **可上**（这是收益最大的一条） |
| `eval` / `new Function` / `document.write` | 全仓命中 **0** | ✅ **不需要** `'unsafe-eval'` |
| `index.html` 的 inline `<style>` | **有 1 处**（`index.html:16-21`，仅 2 条规则，防闪白） | 可**外链化**消除；否则 `style-src` 需 `'unsafe-inline'` |
| CodeMirror 的样式注入 | `style-mod` 在 `document` 上 mount 时走 `createElement('style')` + `textContent`（`node_modules/style-mod/src/style-mod.js:100/135`）——`!root.head` 不成立时不走 Constructable Stylesheets | ❌ **`style-src` 必须保留 `'unsafe-inline'`**（库支持 nonce 但 CM6 不传） |
| CSS-in-JS 库（styled-components/emotion 等） | **未使用** | 无额外 style 注入源 |
| Google Fonts 外链 | 3 行（`index.html:13-15`） | 本地化后消除；否则需放行 `fonts.googleapis.com`/`fonts.gstatic.com` |
| `blob:`/`data:` 图片 | `ChatInput.tsx:333` 把 Blob 读成 dataURL | `img-src` 需含 `data: blob:` |
| 预览载荷（S2 交叉） | p5.js 走 cdnjs | **预览载荷不套严格 CSP** |

**定稿策略（写入 P0-4）**

```
应用外壳：default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline';
         img-src 'self' data: blob:; font-src 'self';
         connect-src http://127.0.0.1:51517 ws://127.0.0.1:51517 http://localhost:51517 ws://localhost:51517;
         frame-src http://127.0.0.1:51517; object-src 'none'; base-uri 'none'; frame-ancestors 'none'
预览载荷：Content-Security-Policy: sandbox allow-scripts   （不加 script-src/default-src）
```

**残留风险（可接受）**：`style-src 'unsafe-inline'` 无法去掉——但它的风险远低于 `script-src 'unsafe-inline'`（CSS 注入不能直接执行 JS；需配合 CSS 选择器泄漏/`expression` 类老漏洞）。仍在 **Report-Only 跑一天**确认无 `script-src` 违规后再切强制。

### S4 结论（内核能否绕过审批直调文件端点）

**不能。三重独立屏障**：

1. **`kernel/` 对 `write-file` / `read-file` / `raw-file` / `list-dir` 的引用数为 0** —— 内核根本不调这些端点（它用自己的 `Read`/`Write`/`Edit` 工具，走 `kernel/permissions.mjs` 审批闸门）。
2. **`bridge_request` 只接受 `route ∈ { browser, app }` 路由名**（`server/app-routing.mjs`），**不能指定任意 HTTP 路径** ⇒ 无 SSRF 到达 `/write-file` 的路径。
3. **Bash 工具的子进程 env 是严格白名单**（`kernel/tools.mjs:57-63`，仅 PATH/HOME/TMP/代理/`PONOS_HOME`，并刻意剥离 `PONOS_CONFIG_DIR`）——**`YFW_BRIDGE_TOKEN` 不在其中** ⇒ 即使 LLM 用 `curl` 打桥，也是 401。

**但有一个残留事实需记录**：内核**进程自身**的 env **含** `YFW_BRIDGE_TOKEN`（`bridge.mjs` 的 `buildChildEnv()` 以 `{ ...process.env, ... }` 构造，未剔除；令牌由 `main.cjs` 注入桥进程）。本机无 procfs，且 Bash 子进程拿不到，**当前不可利用**；但若将来新增"读 `process.env` 并出网"的工具，即成为通路 ⇒ **建议在 `buildChildEnv()` 中显式剔除 `YFW_BRIDGE_TOKEN`**（零风险加固，已并入 P0-1 的改动点）。

### S5 结论（凭据不经桥端点）

**不经。** `YFW_SETTINGS_PATH = join(YFW_HOME, 'settings.json')`（`server/bridge.mjs:650`）的全部使用点只有两处，且都在桥进程内**直接 fs 读写**、**不经过任何 HTTP 端点**：

| 使用点 | 位置 | 性质 |
|---|---|---|
| `loadConfig()` 的恢复逻辑 | `bridge.mjs:663-668` | `existsSync` / `tryReadJsonWithRecovery` / `copyFileSync` |
| `syncKernelSettings()` | `bridge.mjs:652→700` | `safeWriteJsonWithBak(YFW_SETTINGS_PATH, …)` |

旁证：`electron/diag-monitor.cjs:240` 也是**主进程 fs 直读**（诊断用），非走桥。

**派生结论**：
- **D1-a 的"写排除数据根"零副作用** —— 应用自身不需要经桥端点写 `~/.yfw`，排除它不会破坏任何功能；
- 但**读必须允许数据根**：S1 已证 `knowledgeApi.readRawDoc`（`lib/knowledgeApi.ts:764`）经 `/read-file` 读取知识库文档（位于 `~/.yfworking` 下）⇒ 若读也排除，**知识库读取会坏**。故 D1-a 的决定（写排除、读允许）是**唯一正确组合**，不建议后续收紧读侧。

### S6 结论（DevLens 并发真相 —— 推翻原判断）

| 事实 | 证据 |
|---|---|
| **实际并发 = `FILE_BATCH_SIZE = 10`**（硬编码常量） | `node_modules/devlensio/dist/summarizer/types.js:17`；消费者 `summarizer/index.js:253-254`（`fi += FILE_BATCH_SIZE`） |
| `batchSize` **在核心逻辑中零消费** | `grep -rn "\.batchSize" dist/` 在 `config/` 之外**命中 0**；`summarizer/` 完全不读它 |
| `jobs.ts:68` 的 `batchSize: 50` 是 **dummy** | 源码注释：`won't be called — skipSummarization will bypass this` |
| 429 **有指数退避重试** | `summarizer/retry.js`：`maxAttempts: 4`、`baseDelayMs: 1000`、`maxDelayMs: 15000`；可重试 = 429/5xx/网络，不可重试 = 400/401/403/404 |
| 三处 `Promise.all` 确实未限流 | `summarizer/index.js:196 / 233 / 260` |

**派生结论**：
1. **P1-4 降级为观察项**（§4 已重写）——若真触发 429，**改 `batchSize` 无效**，须给 `Promise.all` 加信号量或覆盖 `FILE_BATCH_SIZE`；
2. **撤回我此前"把 `batchSize` 降到 ≤20"的建议**（该字段无消费者）；
3. 此前 `summarize` 失败的**真实原因更可能是 HTTP 402 账号余额**，属外部依赖而非代码缺陷。

---

## 7. 测试计划

### 7.1 攻击性用例（新增，`server/*.test.mjs`）

1. `/read-file?path=../../../../etc/passwd`（Windows：`C:\Windows\win.ini`）→ `403 EOUTSIDE`
2. `/read-file?path=<根>/../<根名>-evil/x` → `403`（前缀绕过）
3. 工作区内建符号链接指向 `C:\Windows`，请求 `link/win.ini` → `403`（realpath 出根）
4. `/write-file` body.path 指向根外 → `403`；指向 3MB → `413`
5. `/read-file?path=` 含 `\0` → `400`
6. `/raw-file` 指向 2GB 文件 → `413`，且内存无增长
7. **预览隔离（关键，S2 修订后的判定）**：在 `allow-scripts`（无 same-origin）iframe 内：
   - `fetch('/read-file?path=…')` → **401**（不是"响应不可读"）；
   - `fetch('/write-file', { method:'POST', mode:'no-cors', headers:{'Content-Type':'text/plain'}, body: JSON.stringify({path, content}) })` → **401**（**必须断言服务端未落盘**——`no-cors` 读不到响应，只能靠副作用判定）；
   - 若把 iframe 换成**同源**（回归对照）→ 上述两者**成功** ⇒ 证明该用例确实在测这条链，不是假绿。
8. **CSP**：应用外壳注入 inline `<script>` → 不执行；**预览载荷对照**：打开 `space-generative-art/templates/viewer.html` → **p5.js 仍能加载**（防 CSP 误伤，见 P0-4）。
9. 凭据保护：`/write-file` 指向 `~/.yfw/settings.json` → `403 EOUTSIDE`（D1-a：写排除数据根）；`/read-file` 同路径 → **允许**（D1-a：读允许），除非 S5 结论改为读也排除。
10. **注入白名单（D2-2）**：断言"预览 frame 的请求不带 `x-yfw-bridge-token`"，同时断言"主窗口请求带" ⇒ 防止实现把两者一起掐掉。
11. **内核 env（S4 加固）**：断言内核子进程 env 不含 `YFW_BRIDGE_TOKEN`。

### 7.2 回归（必须全绿）

- `server/bridge-auth-token.test.mjs`（5 test 块 / 68 断言，**不得修改断言**）
- 文件面板：列目录、打开文本、图片预览、PDF 预览、Office 预览、保存文件、新建文件夹
- 内核侧：`bridge_request` 执行器链路（app-routing / browser-routing）
- 图谱再生成 + 覆盖核对仍 ✅（证明 P2-2 未破坏扫描口径）

---

## 8. 风险与回滚

| 风险 | 概率 | 对冲 |
|---|---|---|
| `roots` 配错 ⇒ 合法路径被拒（用户打不开自己的文件） | **高** | D1 的"读先告警不拦"灰度；错误信息给"加入允许目录"的可操作指引 |
| 去 `allow-same-origin` 破坏互动预览 | **低**（S2 已证：6 模板不调桥；`localStorage` 已 try/catch，仅偏好不持久） | 已无"补受限 RPC"需求；仍保留"预览内 `<script>` 可执行"回归用例 |
| **D2-2 掐错发起者 ⇒ 主窗口/WS 自身失去授权** | **中** | 必须双向断言（预览不带令牌 **且** 主窗口带）；`details.initiator` 不可用时退化为 webContentsId 白名单并复跑 `bridge-auth-token.test.mjs` |
| CSP 打破 CodeMirror/xyflow 内联样式 | 中 | Report-Only 先行；`style-src` 按报告收紧 |
| **CSP 误伤预览载荷的 CDN 依赖（p5.js）** | **中**（S2 新发现） | P0-4 分上下文：预览载荷只加 `sandbox`，**不加** `script-src`；并以 viewer.html 作回归 |
| P1-1 拆分引入行为漂移 | 中 | 纯搬移、逐模块测试、先拆路由不动 handler 逻辑 |
| 死代码误删（实为动态加载入口） | 中 | P2-3 三态判定 + 保留 re-export 一版 |

**回滚粒度**：P0-1/P0-2 由 `fs-guard` 开关（env，如 `YFW_FS_GUARD=off|warn|enforce`）控制 ⇒ **单环境变量回滚，无需改码**；P0-3/P0-4 为前端/主进程各一处的局部改动 ⇒ git revert 即可。

---

## 9. 推进顺序（供 writing-plans 细化）

```
**✅ S1–S6 全部已跑完**（结论见 §6、§0.4）
   → 决策已全部锁定：D1-a（写排除数据根、读允许）；D2 修订案（D2-1 + D2-2 必做）；D3 定稿（script-src 'self' + style-src 'unsafe-inline'）
   → P0-1 + P0-2（含攻击用例 1–6、10、11，当天）
   → P0-3（D2-1 + D2-2，双向断言防掐错）+ P0-4（分上下文 CSP，先 Report-Only）
   → 观察一周（读模式告警数据）→ 收紧为 enforce
   → P1-1 → P1-2 → P1-3 →（P1-4 已降级为观察项）
   → P2-1 → P2-2 → P2-3 → P2-4
```

**由 S1 修正的灰度细节**：写模式（`/write-file`）**可立即 enforce**（全仓仅 1 个调用点）；读模式（`/read-file`、`/list-dir`）**必须 warn 起步**——因为 `DirectoryPicker` 的合法需求是"任意目录"（含用户主目录），`knowledgeApi` 还需读 `~/.yfworking` 下的知识库文档。

---

## 10. 实施记录（P0 已完成并验证）

> 本节记录**已落地**的内容与**实测数字**，供复核与后续收敛。P1/P2 尚未动工。

### 10.1 改动清单

| 文件 | 性质 | 内容 |
|---|---|---|
| `shared/fs-guard.mjs` | **新增** | 单一真源路径闸门：`resolveReadable`/`resolveWritable`/`assertExtAllowed`/`assertSizeOk`/`guardErrorResponse`。realpath **双端**、`path.relative` 包含判定、`denyRoots`（写）+ `denyPaths`（读写）、级别 `off/warn/enforce` |
| `shared/fs-guard.test.mjs` | **新增** | 闸门单测 **18 条**（含符号链接、前缀绕过、NUL、denyPaths 在 warn 下仍生效、`off` 回滚） |
| `server/bridge.mjs` | 改 | **10 个**路径端点全部接入闸门；`assertSizeOk` 的错误统一翻译为 413/400；`/raw-file` 加体积上限（默认 32MB，`YFW_RAW_FILE_MAX_BYTES` 可配）并改**流式**（`createReadStream` + `pipeline`，替代 `readFileSync`）；`svg` 移出 mime 表；`html`/`htm` 响应加 `CSP: sandbox allow-scripts` + `nosniff`；`read-file`/`write-file` 改异步 I/O；`buildChildEnv()` 剔除 `YFW_BRIDGE_TOKEN` |
| `server/bridge-fs-guard.test.mjs` | **新增** | HTTP 层攻击用例 **24 条**（越界读/写、前缀绕过、符号链接、NUL、凭据读写拒绝、raw-file 413/svg/html 头、正例不误伤、默认级别语义） |
| `electron/bridge-header-inject.cjs` | 改 | **D2-2**：新增 `trustedFrameOrigins`（按 `details.frame.origin` 判定可信发起帧）与 `isTrustedFrameOrigin`；**未传清单时不改变既有行为**（灰度护栏） |
| `electron/bridge-frame-trust.test.mjs` | **新增** | 帧信任单测 **11 条**（含"桥 origin 必须不可信""`null` 即使被写进清单也不放行""未传清单保持旧行为"） |
| `electron/csp-policy.cjs` | **新增** | 外壳 CSP 策略 + 主进程注入：只作用于 mainFrame 外壳文档（**不碰桥的 `/raw-file`**），模式 `YFW_CSP_MODE = off/report(默认)/enforce` |
| `electron/csp-policy.test.mjs` | **新增** | CSP 单测 **8 条**（默认 report、非法值回落、`script-src` 无 unsafe-inline/eval、`style-src` 保留 unsafe-inline、不碰预览载荷、无通配） |
| `electron/main.cjs` | 改 | 装配 `installShellCsp`（跳过不受信会话）；`TRUSTED_FRAME_ORIGINS`（`file://` + dev/preview 源）传给注入器 |
| `src/components/editor/FileEditor.tsx` | 改 | **D2-1**：`sandbox="allow-scripts allow-same-origin"` → `"allow-scripts"`（附原因注释） |
| `src/components/files/FilePreview.tsx` | 改 | **D2-1**：同上（office 转换出的 HTML 预览） |

### 10.2 实测验证结果（全绿）

| 套件 | 结果 |
|---|---|
| `shared/fs-guard.test.mjs` | **18/18** |
| `server/bridge-fs-guard.test.mjs`（攻击用例） | **24/24** |
| `electron/bridge-frame-trust.test.mjs` | **11/11** |
| `electron/csp-policy.test.mjs` | **8/8** |
| 既有回归 `server/bridge-auth-token.test.mjs` | **5 test 块 / 68 断言 全绿**（未改动任何断言） |
| 既有回归：`bridge-header-inject`（main.cjs 形状）、`dir-picker-routes`、`docx-ops`、`sheet-ops`、`skill-install`、`knowledge-kernel-env`、`disabled-route`、`readonly-cache` 等 | **全绿** |
| 前端类型检查 `tsc --noEmit` | **通过** |

### 10.3 实施期发现（改变方案的三条）

1. **端点是 10 个不是 4 个**（§1.1 已更正）。只 grep 已知端点名会漏，须用"裸 `resolve(` 调用"这个模式扫。
2. **`details.initiator` 在 Electron 43 不存在**（S7）⇒ D2-2 原设想的机制不可用；改用实测可用的 **`details.frame.origin`**（`file://` / 桥源 / `null` 三态可区分）。**同时实测确认**：沙箱 iframe 内 `localStorage` 抛 `SecurityError`（S2 判断正确，且模板已有 try/catch），且其 `fetch` 仍能发出（CORS 只挡读响应、不挡发送）⇒ 佐证了"仅去 same-origin 不够"。
3. **`normalizeOrigin('file://')` 剥尾斜杠会得到 `'file:'`** —— 这会让**主窗口拿不到令牌、全盘 401**。由 `electron/bridge-frame-trust.test.mjs` 抓出后改为按 URL 规范化。**这是本轮唯一被测试拦下的自身严重缺陷**，值得记：安全加固本身也会引入致命回归。

### 10.4 已知残留（如实记录，勿视为已解决）

| 残留 | 说明 | 处置 |
|---|---|---|
| **默认只做 deny 列表 + 读侧静默放行** | 未设 `YFW_FS_ROOTS`/`YFW_FS_WRITE_ROOTS` 时：写侧只拦 deny（凭据/系统/自启目录），**允许根之外的普通路径仍可写**；读侧 `warn` 不拦。原因：合法用途就是"用户打开的任意文件"（`DirectoryPicker` 起手主目录、`knowledgeApi` 读数据根知识库）。该残留已由测试**显式钉住**，避免被误当已修复 | 严格模式由 `YFW_FS_WRITE_ROOTS` 提供；若要默认更严需另做 UI 授权流 |
| **`style-src 'unsafe-inline'` 去不掉** | CodeMirror 的 `style-mod` 在 document 上 mount 走 `createElement('style')`+`textContent`，CM6 不传 nonce | 需上游改动或换注入方式；风险远低于 `script-src 'unsafe-inline'` |
| **为兼容 `file://` 外壳，策略含 `file:`** | file URL 在 Chromium 下是 opaque origin，`'self'` 未必匹配，故 `script-src`/`style-src` 加了 `file:`。这削弱强度 | enforce 前应在**打包产物**上验证能否只用 `'self'` |
| **CSP 默认 report-only** | 尚未 enforce（spec 的既定分阶段） | 收集一天违规后切 `YFW_CSP_MODE=enforce` |
| **Google Fonts 仍外链** | 本地化（自托管）会**改变字体外观**，属产品可见变更 | **需产品决策**：①自托管 Inter/Sora/JetBrains Mono（OFL 许可，约 1–2MB，外观不变）；②删除外链退到系统字体（外观变化）；③保持现状（策略中已放行两域） |
| **`/install-skill` 未加写拒绝** | 它按设计要写数据根 `skills/`，加 `denyRoots` 会破坏功能 | 只加读侧闸门；若将来收紧需为该端点单列白名单 |
| **PDF 预览 iframe 无 sandbox** | `<iframe src={fileUrl}>`（PDF/图片）未加 sandbox，内容为 `application/pdf`（Chrome 以插件渲染、不进入嵌入方 origin 的 DOM） | **已评估未采纳**：加 `sandbox` 有打断 Chrome PDF 查看器的风险，收益低 |
| **内核进程 env 曾含桥令牌** | `buildChildEnv()` 未剔除 | **已修**（`delete env.YFW_BRIDGE_TOKEN`）；建议再加一条断言测试防回归 |

### 10.5 P1/P2 状态

未动工。顺序见 §9。其中 **P1-4 已降级为观察项**（§6 S6 结论：并发只有 10 且有 429 退避，原判断不成立）。

---

## 11. 实施记录：P1-2 安全规则单一真源（已完成）

> 用户决策：P1/P2 中**只做 P1-2**（其余为高行为风险重构，暂缓）。本节记录做法与**实测更正**。

### 11.1 风险描述更正（重要）

§1.6 原写"漂移会造成**桥放行、内核拦截错位**"。实测该描述**不成立**：

- 桥侧 `highRisk` 在 `server/bridge.mjs:1879` 只是 approval 事件的一个字段；
  渲染层 `src/hooks/useYFWCLI.ts:1520` 把它映射成弹窗文案
  （`risk: isHighRisk ? 'high' : 'medium'`）——**它不决定是否执行、也不决定是否弹窗**。
- 是否审批由内核审批档位 + `kernel/blacklist.mjs`（灾难级一票否决，含 `shutdown`/`reboot`）决定。

⇒ 真实危害是**提示牌错**，两个方向：

| 方向 | 具体 | 危害 |
|---|---|---|
| **漏标** | approval 判高危但 sign 不标：`curl …｜sh`（**远程代码执行**）、`shutdown`、`reboot`、`tskill`、`chkdsk`、`cleanmgr` | 弹窗不显示高危警示，用户更易轻率批准 |
| **过标** | sign 判高危但 approval 不判：`rm file.txt`、`mv x`、`kill 1234`、`git commit --amend` 等 23 条 | 告警疲劳，反而**淹没**上面那 6 条真正危险的 |

另更正一处**失效引用**：`server/highrisk.mjs` 原注释称"与内核 `destructiveCommandWarning.ts` 同构"，
但**该文件不存在**（`find src -name destructiveCommandWarning*` 无结果）。

另：`approval-mode` 的枚举/默认档一致性**此前已有测试把关**
（`server/approval-mode.test.mjs` 直接 import 内核模块逐字比对），并非无保护。

### 11.2 做法

- **新增 `shared/high-risk.mjs`**（单一真源）：一条危险事实**只声明一次**
  （`HIGH_RISK_RULES`: `{id, group, re, tags, sample, note}`），用 `tags` 标明消费方：
  `'approval'`（内核"要不要问"，19 条）/ `'sign'`（桥"要不要标高危"，25 条）。
  同名概念用 `group` 聚拢，使"approval 严 / sign 宽"的差异**可复核**。
  导出 `matchesApprovalTrigger` / `matchesDangerSign` / `matchedRuleIds`（诊断用）。
- **`kernel/highrisk.mjs`、`server/highrisk.mjs` 改为薄转发**（re-export），
  公开 API 与调用点**零改动**（`server/bridge.mjs:48` 静态 import、
  `kernel/permissions.mjs`/`kernel/tools.mjs` 均不动）。
- **保留刻意差异**：归一化不同（内核只 `trim`；桥 `trim` + 剥首尾引号），已注释说明并测试锁定。
- **零行为变化承诺**：抽取时逐字保留原 pattern；pattern 集合经脚本比对
  **approval 19/19、sign 25/25 逐条一致**；判定经 124 条语料比对**零差异**。

### 11.3 测试与验证（全绿）

| 项 | 结果 |
|---|---|
| 新增 `shared/high-risk.test.mjs` | **11/11** |
| 内核打包（验证 `../shared/` 解析） | ✅ 78 模块；产物含新规则 id |
| 内核测试（`permissions-modes`/`blacklist`/`app-approval`/`approval-mode`/`approval-mode-cli`/`app-permissions`） | **55 全绿** |
| 桥侧（`bridge-fs-guard` 24、`bridge-auth-token` 68 断言） | 全绿 |
| `approval-lifecycle`、`browser-whitelist-approval-e2e` | 全绿 |

**漂移锁机制**（`shared/high-risk.test.mjs` 的核心价值）：改动前实测的 124 条黄金判定表**内嵌**在测试里；
另用 `approvalOnlyRuleIds()`/`signOnlyRuleIds()` 按 `sample` **实证**算出两侧分叉集合，
断言其**恰好等于** `KNOWN_DIVERGENCE` 声明的清单。⇒ 将来任一侧增删规则导致新分叉，
**CI 立即失败**，必须显式声明才可通过。每条规则还必须有能命中自己的 `sample`（防"永假 pattern"）。

### 11.4 未做（需你决策，属行为变更）

本项按"零行为变化"落地，**没有**去修 11.1 的两个提示牌缺陷——那会改变用户看到的警示文案，
属产品可见变更。可选：

- **A（推荐）**：给 sign 侧补上那 6 条漏标（至少 `curl-pipe-shell` 远程代码执行），
  并**收窄** `rm-any`/`mv-any`/`kill-any` 等日常命令条目（如 rm 只认带 r/f flag）。
  改完只需更新 `KNOWN_DIVERGENCE` 与既有用例，测试会守住。
- **B**：只补 `curl-pipe-shell`（最小改动，止住最危险的一条漏标）。
- **C**：维持现状（两套广度都不动），仅保留漂移锁。

### 11.5 fix-A 已实施（你选 A：补漏标 + 收窄过标）

分级原则（写进 `shared/high-risk.mjs` 头注释，作为后续新增规则的门槛）：

| 级别 | 含义 | tag |
|---|---|---|
| **T1** | 不可逆 / 系统级 / 远程执行 | `approval` + `sign`（既问也标） |
| **T2** | 可回滚或属常见操作，但值得提醒 | 只 `sign`（标而不问） |
| **T3** | 日常可逆操作 | 都不标 |

**新不变量：`sign ⊇ approval`** —— approval 认定的高危，sign 必须也标；
由 `approvalOnlyRuleIds()` **必须为空**守住（此前正是这条不成立才出现"最危险的命令不标高危"）。

**补漏标（6 条，sign 侧此前不命中）**：`curl-pipe-shell`（远程代码执行）、`shutdown`、`reboot`、
`tskill`、`chkdsk`、`cleanmgr`。另随 T1 提升一并补上的：`rd /s`（`rd` 是 `rmdir` 别名）、
`takeown /f`、`reg delete`、`git checkout -- .`、`git restore .`、`git stash drop`、`git branch -D`、
`drop schema`、`DELETE FROM`、`kubectl delete`、`terraform destroy`。

**收窄过标（15 条，sign 侧不再命中）**：普通 `rm`（无 r/f flag）、`rmdir`（非 /s）、
`del`/`erase`（非 /s）、`format`（不带盘符——**原先 `npm run format` 被判高危**）、
普通 `kill`（SIGTERM）、`Stop-Process`（非 -Force）、普通 `mv`/`move`。
做法是**删掉"任何用法都算"的条目**（`rm-any`/`rmdir-any`/`del-any`/`format-any`/`kill-any`/
`stop-process`/`move-any`/`mv-any`），把确有风险的写法并入对应 T1/T2 条目。

**量化（124 条语料）**：

| 指标 | 改前 | 改后 |
|---|---|---|
| approval 命中 | 44 | 62（**+18**，更严谨） |
| sign 命中 | 71 | 68 |
| 两侧判定分叉率 | **52.7%**（29/55） | **4.8%**（6/124） |
| 漏标条数 | 6 | **0** |

剩余 6 条分叉**全部是单向的 T2**（`kill -9`、`git rebase --hard`、`git merge --force`、
`git commit --amend`、`git commit --amend --no-edit`、`git commit --no-verify`）——即"标而不问"，
每条在 `KNOWN_DIVERGENCE.signOnlyRules` 里都有理由，且测试断言 T2 规模 ≤10。

**注意这次是刻意改变行为（与 11.2 的"零行为变化"相反）**，故测试也相应重构：
`shared/high-risk.test.mjs` 从"黄金表逐条锁定旧值"改为
①approval 侧**单调不减**（重构不得丢规则）②fix-A 的增量/收窄**逐条显式列出**③不变量④漂移锁。
新增 approval 命中 ⇒ **内核会比以前更常弹审批**（这 18 条都是不可逆或系统级操作），属预期。

### 11.6 顺带修掉的一个真漏洞（`git push -f`）

复核发现 approval 侧原 pattern 是 `/\bgit\s+push\s+--force/i`，**不匹配 `git push -f`**——
而 `-f` 恰恰是最常见的强制推送写法，且 sign 侧认它 ⇒ 形成"标了高危却不问"的组合。
已并入 `git-force-push`（`--force|-f`）。同类还有 `git clean -f` 漏掉 `-xdf`。

---

## 12. 实施记录：P1 拆分与 shell 加固（已完成）

### 12.1 shell 拼接加固

| 位置 | 原实现 | 现实现 |
|---|---|---|
| `electron/diag-monitor.cjs` | 4 处 `runProbe([`"${path}"`, …])` + `spawn(args.join(' '), {shell:true})` | 签名改为 `runProbe(exePath, args, ms, tag)`；拼串**只剩一处**，经 `buildCommandLine` 校验+加引号 |
| `electron/app-profiler.cjs` | `exec(`"${exePath}" ${args.join(' ')}`)` | 同一助手；非批处理仍走 `execFile`（无 shell） |

新增 `electron/shell-args.cjs`（单一真源）+ `electron/shell-args.test.mjs`（8 条）：
**拒绝**含 `"` 或 CR/LF 的输入（`"` 可闭合引号后追加命令），仅在遇空白/元字符时加引号
（`--help` 等原样保留 ⇒ 不改变被探测 CLI 收到的参数）。

**如实定性**：这两处参数本是硬编码 flag 或应用内部路径（`exePath` 来自被探测程序的 app spec），
故属**纵深防御**——"不让路径里有引号变成命令执行"，不是对一个已知可达攻击面的紧急修补。

### 12.2 桥路由拆分（`server/bridge.mjs` 4460 → 4247 行）

**未新创接口，而是跟随仓库既有约定**（`server/logs-routes.mjs` / `knowledge-routes.mjs`）：
路由模块**纯算响应、不碰 res/socket**，返回 `{status, body}` / `{stream}` / `null`，桥负责回包。
（故文件名为 `server/files-routes.mjs`、`server/office-routes.mjs`，与本文早期写的 `server/routes/*.mjs` 不同——
听既有约定比听自己的草案更重要。）

- `server/files-routes.mjs`：`/list-dir`、`/read-file`、`/raw-file`、`/write-file`
  （`/raw-file` 以 `{stream:{filePath,headers}}` 交回桥做 `pipeline` 流式回包）
- `server/office-routes.mjs`：`/convert-office`、`/read-sheet`、`/write-sheet`、`/read-docx`、`/write-docx`
  + `runOfficeScript`/`validOfficeFile` + 两张错误码→状态码映射表（原先内联在 handler 里）

抽出后桥侧只剩"解析入参 → 委托 → 回包"，共 3 处 5 行；顺带清掉因迁出而变成死引用的 3 个 import。

### 12.3 去同步 I/O（务实范围，不含糊）

**做了**（在 HTTP 热路径上，阻塞会拖垮桥的单事件循环 ⇒ 影响全部会话）：
`/list-dir`（`readdirSync`+逐条 `statSync` → 异步）、`/read-file`（`statSync`/`readFileSync` → 异步）、
`/write-file`、`/raw-file`（`readFileSync` 整读 → `createReadStream`+`pipeline`）、
以及 office 侧 `validOfficeFile` 的 `statSync` 与临时 JSON 的 `writeFileSync`/`unlinkSync`。

**刻意没做**：`server/bridge.mjs` 其余同步 I/O 多在**启动/配置/技能安装/工具采样**等一次性路径
（微秒级、不在每次请求的热路径上）。全量改写收益与风险不成比例——不做，并在此说明，而非假装已完成。

**一处刻意的"不顺手改"**：`validOfficeFile` 抛错后由调用方通用错误出口处理（原样保留）。
它语义上应是 400，但改它就是行为变更，应单独评估（`server/office-routes.mjs` 内已注明）。

### 12.4 测试（本次新增 19 条，相关全绿）

| 文件 | 条数 | 覆盖 |
|---|---|---|
| `shared/high-risk.test.mjs` | 12 | 单调不减 / fix-A 增量与收窄逐条 / 不变量 / 漂移锁 / 结构 |
| `electron/shell-args.test.mjs` | 8 | 注入载荷拒绝 / 引号策略 / 行为不变 |
| `server/office-routes.test.mjs` | 11 | **路由层直测**：分流、正例（真实 xlsx/docx 经 python）、格式白名单、缺参、方法约束、越界 403、凭据 403 |

`server/office-routes.test.mjs` 暴露了一个**既有覆盖缺口**：`docx-ops`/`sheet-ops` 不起桥（只测 python 层），
而 `bridge-fs-guard` 只覆盖 office 的越界拒绝 ⇒ 抽出后正好补上正例。这正是"可直测"的好处。

回归（本次全部实跑，均 0 失败）：fs-guard 18、high-risk 12、shell-args 8、frame-trust 11、csp-policy 8、
bridge-fs-guard 24、auth-token 5、office-routes 11、dir-picker 4、docx-ops 8、sheet-ops 9、
readonly-cache 13、kernel-bridge 8、kernel-readonly-async 8、health-anchor 1、disabled-route 4、
skill-install 10、skill-detail 8、tag-routes 3、mcp-prompts 16、egress-policy 5、approval-lifecycle 3、
install-default-approval 1、browser-whitelist-approval-e2e 3（认证网）、fidelity-chain 1、
workspace-attribution-wiring 6、ws-heartbeat 1、stall-watchdog 3、backup-retention 12、team-routes 4；
内核 6 个审批相关测试；`build-kernel` 打包通过；`tsc --noEmit` 通过。

### 12.5 未做（P1 剩余 / P2）

- P1 剩余：`bridge.mjs` 仍 4247 行（本次只迁出路由，未拆会话/工具/知识等大块）；
  shell 加固未覆盖 `skills/*/scripts` 内自带的 shell 调用（未评估）。
- P2：5 个巨石拆分（`knowledge.mjs` 2554 / `engine.mjs` 2390 / `tools.mjs` 1902 / `main.cjs` 1787）、
  68 → ~50 域归并、26 个孤立模块三态判定、文档口径纳入 CI。

### 12.6 第二轮拆分（继续 P1：再迁出 8 组端点）

`server/bridge.mjs` 4246 → **3846 行**（连同 12.2，本次会话累计 4460 → 3846）。

| 新模块 | 迁出端点 | 行数 | 关键依赖处理 |
|---|---|---|---|
| `server/collab-routes.mjs` | `/tags`、`/tags/merge`、`/tags/undo`、`/team/{status,create,invite,join,revoke,search-root}`、`/file-collab/…`（11 个） | 343 | 三组在原文件里本就是**连续区间** ⇒ 同属"协作"域；`bridgeCapsCache` 惰性缓存随迁（仅此处使用） |
| `server/host-routes.mjs` | `/known-folders`、`/drives`、`/diag/info`、`/diag/render-frame`、`/transcript/{list,load,search,delete}` | 150 | **按引用**传入 `diagInfo`（render-frame 就地更新）与 `sessions`（判断会话是否在运行） |

**为什么这几组能安全外移**：它们都**不涉及会话状态与工具转发**（本桥最核心、最危险的部分）。
**为什么 provider 探测组（158 行，最大剩余块）没动**：它与桥内部强耦合（`runProbeFor`、
`syncKernelSettings`、`buildChildEnv`、`reply` 的流式用法），收益/风险比明显差于上述两组——
**明确记录为"评估后放弃"，而不是漏掉**。同理 `/config`、`/skills`、`/mcp*`、`/worktrees`、
`/branches`、`/install-skill` 暂留桥内。

**两个必须记住的坑**（都已踩到并处理）：

1. **状态必须按引用传**：`diagInfo.renderFrames` 与 `sessions` 是跨请求共享的活状态，
   传副本 ⇒ diag-monitor 读不到、`/transcript/delete` 的"运行中会话不得删"守卫失效。
   已在守卫测试中断言桥把 `sessions` 传进去。
2. **朴素注释剥离器会被注释里的 `/*` 反噬**：`server/transcript.test.mjs` 的"源码守卫"
   用 `/*`…`*/` 非贪婪配对（可跨行）剥注释，而 `bridge.mjs` 既有注释里存在 `/api/auth/*`、
   `/knowledge/*` 这类序列 ⇒ 会把**相邻整段代码误吞**（实测吞掉 2145→2222、2260→2394）。
   新插入的委托恰好落在被吞区间，守卫随即误报失败。
   **修法**：①新代码注释里不写 `` `xxx/*` ``（改写成 `…`）；②"断言某调用点存在"改用**原始源码**
   而非剥注释文本。此坑同样解释了这类守卫为何"时灵时不灵"。

### 12.7 回归（第二轮）

`node --test --test-concurrency=8` 分批（Node 按文件并发，比逐个串行快很多）：
211 项断言全绿 —— tag-routes、team-routes、bridge-auth-token、bridge-fs-guard、office-routes、
dir-picker-routes、provider-probe、kernel-bridge、readonly-cache、health-anchor-route、
disabled-route、diag-info、transcript、docx-ops、sheet-ops、skill-install、skill-detail-routes、
mcp-prompts-routes、egress-policy、approval-lifecycle、install-default-approval、backup-retention、
workspace-attribution-wiring、fidelity-chain、browser-whitelist-approval-e2e；内核 5 文件 51 项；
`build-kernel` 打包通过；`tsc --noEmit` 退出码 0。

其中 `tag-routes` / `team-routes` / `dir-picker-routes` / `transcript` 是**端到端起桥**测试
（真 spawn 桥 + 真发请求），是本次拆分最强有力的验证：它们同时断言了**安全属性**
（无 token 一律 401、未授权 POST 不得产生写入、运行中会话不得删转录）。

### 12.8 未做（P1 剩余 / P2）

- `bridge.mjs` 仍 3846 行：核心的**会话转发 / 工具分发 / 内核桥接**部分未动（风险最高，应单独排期）；
  provider 探测组评估后放弃（理由见 12.6）。
- P2：5 个巨石拆分（`knowledge.mjs` 2554 / `engine.mjs` 2390 / `tools.mjs` 1902 / `main.cjs` 1787）、
  68 → ~50 域归并、26 个孤立模块三态判定、文档口径纳入 CI。

---

## 13. 实施记录：测试基线与 CI（P2 · 已完成）

### 13.1 补上 CI（此前完全没有）

仓库此前**无任何 CI 配置**，367+ 个测试文件只靠"本地手跑"——任何改动是否破坏既有行为，取决于人是否记得跑、跑得全不全。新增 `.github/workflows/ci.yml`，两个作业：`test`（typecheck + 全量测试）与 `build`（`npm run build` + 内核打包，因为**产物可产出本身就是断言**：类型/导入/打包配置坏了时测试可能全绿，而用户拿到的是坏包）。

两个刻意决策（理由已写进 workflow 注释与 `docs/ci.md`）：

- **runs-on: windows-latest**：本仓库是 Windows 桌面应用，测试含 `C:\…` 字面路径、盘符枚举、`sep` 分支、`taskkill` /PowerShell 探测、预览页 `file://` 帧语义等平台特定断言。跑 Linux 会产生一批与被测行为无关的失败（更糟的是静默跳过），门禁即失效。
- **ELECTRON_SKIP_BINARY_DOWNLOAD=1**：已核查测试**无一处 spawn 真 electron 二进制**（只 require/stub），省下 ~100MB 下载与网络假失败。

### 13.2 测试分层与实测

| 命令 | 内容 | 实测 |
|---|---|---|
| `npm run test:preflight` | 预检 | <1s |
| `node scripts/check-doc-anchors.mjs` | 文档口径 | <1s |
| `npm run test:unit` | shared + electron + src | 1041 项 / 23s |
| `npm run test:server` | server（含端到端起桥） | 694 项 / 91s |
| `npm run test:kernel` | kernel-tests | 1943 项 / 48s |
| `npm run typecheck` | tsc --noEmit | 16s |

合计 **3678 项 / 约 3 分钟**（本机 8 核）。

### 13.3 三个实测得到的结论（都是踩出来的）

1. **`node --test <glob>` 匹配不到文件时不报错、直接 0 退出** ⇒ CI 会**零测试却绿灯**。这是测试基建最经典的静默失败，故加 `scripts/ci-preflight.mjs`：每条 glob 必须匹配到 ≥1 文件，且各层文件数与锚点一致。
2. **并发上限不能随手调高**：把 5 条 glob 合成一次调用并提到 `--test-concurrency=8`，`server/reap-guard.test.mjs` 与 `server/sheet-ops.test.mjs` **失败**（各约 39s）；单独跑均全绿 ⇒ 是资源争抢（它们会 spawn python/子进程且带内部超时），不是真 bug。故 `test:ci` 定为**分层串行**（各层独立进程，失败归因也更清晰），层内并发 4。
3. **本地跑测试可能杀掉你正在用的应用**：`server/bridge.mjs` 在 `EADDRINUSE` 时会自愈式 `taskkill` 命令行含 `yfworking|bridge.mjs` 的进程。预检因此检查 51517 是否被占用并默认拒绝（`--allow-running-app` 可显式跳过；`CI=true` 时跳过该检查）。

### 13.4 文档口径纳入 CI

新增 `scripts/check-doc-anchors.mjs`，只门禁两件"变化慢、脱节后果重"的事：

- **各层测试文件数**（防 13.3-① 那类静默消失）；
- **文档引用的仓库路径是否存在**（防文档腐烂）。

**刻意不门禁**模块数/总行数/巨石行数——它们每次合法重构都会变，硬卡会逼人每次都重跑 `--write`，最终结果是人把检查绕过或删掉。这些数字仍写入 `docs/_anchors.json` 的 `info` 段供查看（当前：源码模块 421 / 108468 行；巨石 `kernel/knowledge.mjs` 2554、`kernel/engine.mjs` 2390、`kernel/tools.mjs` 1902、`electron/main.cjs` 1823、`server/bridge.mjs` 3847）。

> 口径说明：本 spec 早先引用的 "461 模块 / 116,212 行" 来自 DevLens 建图统计，其统计范围与上述口径（git 跟踪的 `.mjs/.cjs/.ts/.tsx`、排除测试与 scripts）不同，故数值有差。以后者为准。

**首次运行即抓出 4 处真实文档腐烂**（文件改名/移动后文档未同步），均已修正。白名单刻意做成**手写**的 `docs/_anchors-allow.json`（每条必须写 reason），与自动生成的锚点文件分离——否则"重新生成"就等于"把所有问题自动放行"，一次 `--write` 就把门禁架空。

### 13.5 CI 顺手抓到的真实回归

`src` 层跑出 1 个失败：某前端守卫断言"端点真的存在于 `server/bridge.mjs`"，而 P1 拆分已把 `/tags`、`/team/*`、`/file-collab/*` 迁到 `server/collab-routes.mjs`。**修法不是把断言改指新文件，而是改扫全部服务端路由模块**（`server/bridge.mjs` + `server/*-routes.mjs`）——该测试的真实意图是"渲染层不得自造端点"，与端点写在哪个文件无关；这样改对后续继续拆分免疫。

---

## 14. P2 进展

| 子项 | 状态 |
|---|---|
| 测试基线 + CI | ✅ 完成（§13） |
| 文档口径纳入 CI | ✅ 完成（§13.4，本轮加固计数口径：只算 git 已跟踪文件，见下） |
| 26 个孤立模块三态判定 | ✅ 完成 → `docs/dead-code-triage.md`（真死 10 / 仅测试 2 应保留 / 动态 23 不得删）。**第一批已删除** 5 个明确遗留的 chat 组件（`MessageBubble`/`TaskCwdBar`/`FirstBytePendingBar`/`KernelStallBar`/`SystemWarningStrip`），删前 grep 确认非注释引用为 0、删后 typecheck+build+三层测试全绿；其余（4 个组件 + `interject.e2e.mjs`）保留待定，理由见该文"清理结果"节 |
| 5 个巨石拆分 | 🚧 进行中：`server/bridge.mjs` 已迁出 15 组端点（§12 的 9 组 + 批次 1 的 `/health`、`/boot-status` + 批次 2 的 5 组身份面/只读面），3904 → 3812 行。另 4 个巨石的**接缝勘察已完成** → `docs/2026-09-17-P2-巨石接缝勘察.md`（含推荐执行顺序与状态耦合清单） |
| 68 → ~50 域归并 | ✅ 完成：**70 → 52 域**（新增 `SRC_DOMAIN_MERGE` 18 条归并表 + 拆 `domainOf`/`domainOfRaw`），覆盖核对仍全 ✅、无文件丢失；新增 `kernel-tests/arch-graph-domains.test.mjs`（8 项守归并表的静默失效形态）；`docs/architecture.md` §12 全量口径已对齐。详见 P2-2 实施结果 |
| 文档口径纳入 CI · ① 图谱数字 | ✅ 完成（含补全）：`check-doc-anchors.mjs` 新增**门禁 C**（**12 条**"文档 ↔ 图谱产物"声明式断言，覆盖 `.md` 与 `.html` **两个**文档）；已做 4 次正反两向验证（改错数字、改措辞均退出码 1）；并判清 `.html` 里的三种口径，**只改同源数字、不动 DevLens 符号级与内核文件数** |
| 文档口径纳入 CI · ② 循环依赖 SCC 证据 | ⏳ 未做（需先定"文件级 SCC"的计算与声明口径）。**本轮已铺路**：用图谱数据实算 Tarjan SCC 得 5 组/最大 3 文件（与文档结论一致），证明该结论在新口径下仍成立 |

### 14.1 本轮对 CI 口径的加固：计数只看 git 已跟踪文件

分层清单与计数逻辑抽到 `scripts/test-tiers.mjs`（预检与门禁共用单一真源）。其中**测试文件数只统计 `git ls-files` 的已跟踪文件**，而"每条 glob 至少匹配一个文件"用工作树扫。

原因：本仓库会同时跑多个任务，工作树里存在**别人尚未提交**的在途测试文件。把它们算进锚点，锚点就记录了"只存在于本机"的数量，**CI 在干净克隆上必然对不上而变红**。预检的比对语义因此是不对称的（工作树数少于锚点=疑似删除；已跟踪数少于锚点=提醒先 `git add`；本地比锚点多属正常）。

### 14.2 顺带修掉的 CI 假失败

`kernel-tests/app-tools-mount.test.mjs` 在 `--test-concurrency=4` 下会因 Windows 句柄未释放而在 `finally` 的 `rmSync` 抛 EPERM——**断言全过、只是清理报错**，于是表现为随机变红（单独跑 3/3 通过）。按仓库既有 `rmSyncRetry` 模式加兜底，之后连跑两次全绿。

未做全仓批量修补：`rmSync` 出现在约 155 个测试文件里，但只有"被 kill 的子进程的 cwd 就是该目录"这一形态有风险（约 47 处）。无命中证据前不做无法审阅的大改动，命中时就地按同一模式修。

---

## 15. P1 批次 1 实施记录与一处**安全核查结论**（重要）

批次 1 已实施并提交（`/worktrees`、`/branches` 去 execSync；`/health`、`/boot-status` 迁入 host-routes）。方案与实施细节见 `docs/2026-09-17-P1剩余重构方案.md`。

**额外发现并修掉一个真实缺陷**：`/worktrees` 用 `l.slice(21)` 解析分支名，而 `branch refs/heads/` 只有 18 字符——每个分支名被**截掉前 3 个字符**（实测：`feature/app-universal-onboarding` → `ture/app-universal-onboarding`；`knowledge-s1` → `wledge-s1`）。工作树面板一直显示错误分支名。

**迁移时踩到的坑（已加测试固化）**：`bootState` 是跨请求共享的**活对象**，必须按引用传入路由模块。传副本不报错、端到端也可能通过，只是启动进度永远停在初始态——这类静默失效已在 `server/host-routes.test.mjs` 用"事后改动必须被下一请求读到"的断言守住。

### 15.1 令牌闸门：核查后确认**没有洞**（记录以免重复误判）

核查 `/api/auth/*` 一带时，单看 `server/bridge-token.cjs` 的 `authorizeBridgeRequest()` 会得出"带非不透明 Origin 即免检 ⇒ 任何网站都能驱动本机桥"的结论——**这是误判**。读完整调用链后确认闸门由**两道**构成，且顺序是关键：

1. **在前**：`server/bridge.mjs` 开头的 `isAllowedOrigin(origin)` 白名单，外部来源（如 `Origin: https://evil.com`）**一律 403**，早于任何分支处理；
2. **在后**：`authorizeBridgeRequest()` 的令牌校验，其中"带非不透明 Origin 直接放行"这一条是 **spec §6.2 D2 的契约要求**（开发态 GUI 在普通浏览器里跑，拿不到注入令牌，渲染层有 58 处 fetch 分布在 27 个文件）。

能走到第二道的 origin 已被第一道收窄到 `null`/`file:`/`localhost`：`null` 视为不透明、必须持令牌；`file:` 与 `localhost` 属可信本机来源。因此"任意 Origin 免检"实际不可达。

**结论**：设计成立，无需改。**但这是一条"改动顺序就可能开出真洞"的脆弱契约**——批次 2 搬迁 auth 端点时必须确认委托点仍在两道闸门之后、且两道顺序不变。

---

## 附录 A · 现状锚点（复核实录）

> 标注 **[改后]** 的为本次实施后的位置/状态。

- **[改后] 闸门本体**：`shared/fs-guard.mjs`（`resolveReadable` / `resolveWritable` / `assertSizeOk` / `assertExtAllowed` / `guardErrorResponse` / `FSGuardError`）
- **[改后] 桥端点装配**：`server/bridge.mjs` 的 `FS_READ_ROOTS` / `FS_WRITE_ROOTS` / `FS_WRITE_DENY_ROOTS` / `FS_CREDENTIAL_PATHS` / `replyGuardError`；`/raw-file` 的 `MAX_RAW_BYTES` + 流式；`buildChildEnv()` 的 `delete env.YFW_BRIDGE_TOKEN`
- **[改后] 注入器**：`electron/bridge-header-inject.cjs` 的 `isTrustedFrameOrigin` + `trustedFrameOrigins`；`electron/main.cjs` 的 `TRUSTED_FRAME_ORIGINS`
- **[改后] CSP**：`electron/csp-policy.cjs`（`buildShellCsp` / `resolveCspMode` / `isShellDocument` / `installShellCsp`）+ `main.cjs` 的装配点
- **[改后] 预览沙箱**：`FileEditor.tsx`（HtmlPreview）与 `FilePreview.tsx`（office HTML）均为 `sandbox="allow-scripts"`
- **闸门判定契约（未改动，是理解本次加固的前提）**：`server/bridge-token.cjs` —— 带**非不透明** Origin ⇒ 免检；无来源/opaque ⇒ 须持令牌；令牌头名 `x-yfw-bridge-token`
- 桥文件端点（改前行号，实施时的定位依据）：`2436/2460/2466/2472/2480` + `2636/2651/2696/2713/3416`；mime 表原 `:2469`

- 桥文件端点：`server/bridge.mjs:2436/2460/2466/2472/2480`；mime 表 `:2469`；`/raw-file` 无体积上限、`/list-dir` 已是异步（改造范式）
- 闸门：`isAllowedOrigin`（`server/bridge.mjs:1989-1997`，**放行任意端口 loopback**）/ 授权调用在 `:2023` 附近；判定契约 `server/bridge-token.cjs`：**带非不透明 Origin ⇒ 免检**；无来源/opaque ⇒ 须持令牌
- 令牌头名：`x-yfw-bridge-token`；注入器 `electron/bridge-header-inject.cjs`（只注入桥 host，排除 `UNTRUSTED_SESSION_PARTITION_PREFIXES`）
- 令牌来源与透传：`electron/main.cjs`（注入桥进程 env）→ `server/bridge.mjs` 的 `buildChildEnv()` 以 `{ ...process.env, ... }` **未剔除令牌** ⇒ 内核进程继承（S4：当前不可利用）
- 回归网：`server/bridge-auth-token.test.mjs`（5 test 块 / 68 断言；含 2026-09-17 实机记录：`Origin: null` 曾使 `GET /config` 以 200 返回明文 authTokens）
- 预览 iframe：`src/components/editor/FileEditor.tsx:216-229`；`dangerouslySetInnerHTML` 于 `:287`、`src/components/files/FilePreview.tsx:152`
- S2 取证面：`~/.yfworking/skills/**/*.html`（6 个模板，**0 处调桥**）；`skills/brainstorming/scripts/server.cjs`（自带 `127.0.0.1` 服务器 + `?key=` 令牌 + WS Origin 校验）
- S4 取证面：`kernel/tools.mjs:57-63`（Bash 子进程 **env 白名单**，不含令牌）；`server/app-routing.mjs`（`bridge_request` 仅接受 `route ∈ {browser, app}`）
- **S1 取证面（调用点全集）**：`/write-file` → `src/components/editor/FileEditor.tsx:54`（唯一）；`/read-file` → `editor/EditorWindowRoot.tsx:30`、`files/FilePreview.tsx:55`、`lib/knowledgeApi.ts:764`、`lib/workflowApi.ts:260`；`/raw-file` → `editor/FileEditor.tsx:220`、`:234`、`files/FilePreview.tsx:65`；`/list-dir` → `chat/DirectoryPicker.tsx:153`、`files/FileBrowser.tsx:35`；`/convert-office` → `editor/FileEditor.tsx:269`、`files/FilePreview.tsx:43`
- **S3 取证面**：`index.html:13-15`（Google Fonts 外链）、`:16-21`（inline `<style>`）、`:25`（无 inline script）；`dist/index.html`（产物同样无 inline script）；`node_modules/style-mod/src/style-mod.js:91`（`!root.head` 判定）、`:100`（`createElement("style")`）、`:135`（`textContent`）；`eval`/`new Function`/`document.write` 全仓命中 0
- **S5 取证面**：`server/bridge.mjs:650`（`YFW_SETTINGS_PATH`）、`:663-668`（`loadConfig` 恢复）、`:700`（`syncKernelSettings` 写）；`electron/diag-monitor.cjs:240`
- **S6 取证面**：`node_modules/devlensio/dist/summarizer/types.js:17`（`FILE_BATCH_SIZE = 10`）、`summarizer/index.js:196/233/260`（未限流 `Promise.all`）、`:253-254`（批次步进）、`summarizer/retry.js`（429 退避）、`src/server/handlers/jobs.ts:68`（dummy config）
- 转换器转义：`server/convert_docx.py`、`server/convert_xls.py`（`escape()` 处理 `& < >`；**Office 预览链不可利用**）
- shell：`electron/diag-monitor.cjs:95`、`electron/app-profiler.cjs:314`
- 窗口：`electron/main.cjs`（`contextIsolation:true` / `nodeIntegration:false` / `sandbox:false` / `backgroundThrottling:false`）
- 规模与耦合：`docs/architecture-graph.html` 内嵌数据（461/1,275/68；平均出度 4.09）；`node tmp/analyze-arch.mjs`
- 分档建议已并入本文：本 spec 第 0、2、3 节曾以"P0–P2 建议清单"形式给出，现已展开为可施工条目

## 附录 B · 关联文档

- `docs/architecture.md` §1–§12（文本真源；§12 全模块索引）
- `docs/architecture-graph.html`（交互式图谱，本文所有结构数字的来源）
- `docs/superpowers/specs/2026-09-17-loop-redesign-phase1-reliability-design.md`（同批 spec，改动面无交集）
- `docs/bridge-contract.md`（桥契约；P0-1 若新增错误码，需在此登记）
