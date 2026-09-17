# Plan：S2-D2 bridge 鉴权（token 闸）（2026-09-16）

> 对应 spec：`docs/superpowers/specs/2026-09-14-team-collaboration-design.md` §6.2 D2、§10「S2 验收 2」、§9「S2 安全」。
> 前置：D1 已完成（`docs/superpowers/plans/2026-09-16-s2-d1-loopback-listen.md`）。§13 决策闸门：**D1/D2 无前置决策，可直接开工**。
> 本轮范围：**只做 D2**。D3（出网闸）未做，故本文件的边界一节明确列出 D2 单独不能解决的问题。

## 1. 契约（spec 原文拆解）

| 来源 | 原文 | 落为本轮的可验证命题 |
|---|---|---|
| §6.2 D2 | 无 Origin / 非浏览器客户端**必须持 token** | 请求**不带 Origin 头**且无有效 token ⇒ **401** |
| §6.2 D2 | Origin 白名单降级为**第二道**而非唯一一道 | 带 Origin 的请求仍走 `isAllowedOrigin`（403），但**不再存在"无 Origin 即放行"的旁路** |
| §6.2 D2 | token 由 **Electron main 侧注入**，不经局域网可读通道 | 令牌由 main 进程生成并经 spawn env 注入桥；不写日志正文、不出现在任何 HTTP 响应里 |
| §6.2 D2 | 保持现有 **auth 小窗**语义不破 | `/api/auth/*`（口令 setup/login/logout/change-password/status）保持**免 token**，与 `auth.json`/scrypt/锁定逻辑零改动 |
| §10 S2-2 | 无 Origin 且无 token → 401；**携带正确 token 的本地客户端全通** | 正反两面都要断言（只测 401 会在"闸门把所有人都挡了"时假绿） |
| §9 S2 安全 | 本地既有客户端（**桌宠 / 执行器 / 小窗**）全通 | 按 Origin 分类逐一验通：小窗=渲染层（带 Origin）不动；桌宠/执行器=非浏览器（给 token） |

## 2. 前置盘点：按「是否带 Origin」给全部调用方分类（决定谁能零改动）

| 类 | 调用方 | 请求携带 | D2 后需要什么 |
|---|---|---|---|
| **A. 浏览器上下文**（带 Origin） | 渲染层全部窗口（主窗/编辑器窗/个人设置窗/cockpit 宿主）：**58 处 fetch、27 个文件**；**唯一 1 处 WS** = `src/hooks/useYFWCLI.ts:170` | 打包版 `Origin: null`（`file://`），dev 版 `Origin: http://localhost:5197` | **零改动**（继续走 origin 白名单这一道） |
| **B. 非浏览器本机**（无 Origin） | Electron 主进程：`/health` 轮询 `electron/main.cjs:207`、WS 事件通道 `:794`、`electron/diag-monitor.cjs:121`；桌宠 `pet/jiajia-pet.py:62`（python） | 无 Origin 头 | **必须带 token**（本轮给它们注入） |
| **C. dev 浏览器形态** | `bin/cli.mjs` → `openBrowser('http://localhost:5197')`：**dev 的 GUI 跑在普通浏览器里** | `Origin: http://localhost:5197`（白名单内） | 零改动（该形态**无法**接受 main 注入的 token，故不能把"带 Origin 也要 token"作为本轮方案） |
| **D. 测试/脚本** | 39 个 `server/*.test.mjs`、`kernel-tests/*.test.mjs` 各自 spawn 桥；`scripts/verify-*.mjs`、`server/interject.e2e.mjs` | 无 Origin | 走 §5 的测试策略处理 |

**为什么 A 类零改动是硬约束而不是偷懒**：C 类（dev 浏览器）拿不到 main 注入的 token，而 A 类有 58 处 fetch 散在 27 个文件。若采用"带 Origin 也必须带 token"，就必然要改渲染层 58 处 + dev 形态直接失去可开发性 ⇒ **既越线又高风险**。spec 的措辞正是"**无 Origin** / 非浏览器客户端必须持 token" ⇒ A/C 两类继续由 origin 闸（第二道）负责，B/D 两类由 token 闸负责。

## 3. 设计

### 3.1 闸门语义（`server/bridge.mjs`）

在既有 origin 拒绝（`:1884`）与 OPTIONS 预检应答之后、路由之前插入 token 闸：

```
无 Origin 头 且 路径不在豁免清单 且 未带有效 token  ⇒ 401 { error: 'Unauthorized' }
```

- **豁免清单**（窄到必须，逐条给理由）：
  - `/api/auth/*` —— 登录屏本身；（spec 明令"auth 小窗语义不破"）
  - `/health` —— 就绪探针，响应体仅 `{status:'ok',pid}`，无任何敏感数据；且启动兜底、脚本探活都靠它（把探针也上锁会把"桥没起来"与"token 没配上"两种故障混在一起，难以归因）
  - `OPTIONS` 预检 —— 浏览器预检不带自定义头语义，且已有 `isAllowedOrigin` 兜底
- **比较方式**：`crypto.timingSafeEqual`（等长校验后比较），不用 `===`——令牌定长 hex，防时序侧信道是零成本的正确做法。
- **WS 握手**（`:3143`）：同一条闸门。Node/py 客户端可用 header；同时在 URL query 支持 `?token=`（浏览器 WS 无法自定义 header 时的通用退路，也便于脚本/桌宠）。
- 401 响应**不回显**期望值、不提示"token 缺失 vs 错误"的差异（避免给探测者信息）。

### 3.2 令牌来源与分发（"不经局域网可读通道"）

- 优先级：`process.env.YFW_BRIDGE_TOKEN`（main 注入）→ **复用已有落盘文件** → 新生成并落盘 `<YFW_HOME>/runtime/bridge-token`（**0600**）。
- **fail-closed**：无论来源如何，闸门始终开启——绝不存在"没配 token 就不校验"的分支（这是本轮最关键的一条；若做成"配了才校验"，则 main 侧注入一旦失效即静默敞开）。
- **为什么必须落盘并复用（实施中新增的关键决策）**：main 存在**接管遗留桥**的既有逻辑（`bridgeAdopted` / `startHealthMonitor`：上一实例被强杀后桥可能仍活着，或用户手工起过桥）。若 main 每次启动都新生成令牌，接管后 main 对桥的每个调用都会 401 —— 表现为"启动卡死、诊断 bridge error"，比原来的风险更糟。落盘 + 复用让"同一台机器上的桥与 main"始终共享同一令牌，跨重启稳定。
- **单一实现（实施中新增）**：解析规则放在 `server/bridge-token.cjs`，由 `server/bridge.mjs`（ESM，经 `bridge-token.mjs` 转发层）与 `electron/main.cjs`（CJS）**共用同一份**。两侧各写一份必然漂移，漂移的后果正是上面那条 401 卡死。CJS 双用先例：`server/yfw-home.cjs`、`electron/kernel-paths.cjs`。
- 分发路径：main 解析令牌 → spawn env 注入桥 + 同一令牌经 env 给桌宠（`pet/jiajia-pet.py` 读 env，读不到回落到落盘文件，覆盖"桌宠被单独启动"的情形）；诊断模块经 `bridgeToken` 参数拿到令牌。
- **dev 形态的两种组合都被覆盖**（实测拓扑）：`bin/cli.mjs` 只起桥 + vite 并用浏览器打开 GUI（桥自生成 + 落盘，GUI 带 Origin 走 origin 闸）；`npm run electron` 起 main（`VITE_DEV_SERVER_URL=http://localhost:5197`）时 main 会**接管**已有的桥——因两侧都走"复用同一落盘令牌"，接管后依旧同令牌，不会 401。`bin/cli.mjs` 不探 `/health`（只 killPort + spawn），故 dev 启动流程不受闸门影响。
- **日志只打印落盘路径/来源，不打印令牌值**；令牌不出现在 `/config`、`/health` 或任何响应体中（"不经局域网可读通道"的落地，并由新回归网静态断言守住）。

### 3.3 不做的事（划清边界）

- 不改渲染层（A/C 两类零改动）——见 §2 的硬约束论证。
- 不引入会话/过期/刷新机制（D2 只要"必须持 token"，多用户会话是 S5 企业版的事）。
- 不把 `Origin: null` 纳入 token 闸（那会连带渲染层 58 处 + dev 形态）——**残留风险在 §6 明确披露**。

## 4. 任务（实施结果）

- **T1** ✅ `server/bridge-token.cjs`（唯一实现，CJS 双用）+ `server/bridge-token.mjs`（ESM 转发层）：`resolveBridgeToken`（env → 复用落盘 → 新生成并 0600 落盘）、`isTokenValid`（timing-safe）、`isTokenExemptPath`、`extractToken`、`authorizeBridgeRequest`（HTTP/WS 共用判定）。
- **T2** ✅ `server/bridge.mjs`：HTTP 闸（OPTIONS 之后、路由之前 401）+ WS 闸（`wss.on('connection')` 内 1008，与既有 origin 拒绝同形态）+ 启动日志只报来源/路径。
- **T3** ✅ 客户端贯通：`electron/main.cjs`（解析令牌、spawn env 注入桥、`/boot-status` 带令牌、WS 带头、桌宠 env、诊断模块传 `bridgeToken`）、`electron/diag-monitor.cjs`（`getJson` 支持 headers）、`pet/jiajia-pet.py`（env → 落盘文件回落 → WS 带头）。
- **T4** ✅ `server/bridge-auth-token.test.mjs`（5 用例：纯函数 / 静态贯通 / 真机 HTTP 闸 / 真机自生成 fail-closed / 真机 WS 闸）。
- **T5** ✅ 发布同步（`release/YFWorking/`：bridge.mjs、bridge-token.{cjs,mjs}、main.cjs、diag-monitor.cjs、jiajia-pet.py，md5 逐一比对一致；本轮无渲染层改动，`dist/` 无需重建）。

## 5. 测试策略（含既有 39 个 spawn 桥的测试怎么办）

**原则：既有回归网不得因本轮改动而变形或放水。**

1. **实测失败面（不预估，先量）**：闸门接入后立刻全量跑 `server/*.test.mjs` → **557 项中 25 项失败，落在 14 个文件**（`ws-heartbeat`/`stall-watchdog`/`reap-guard`/`pending-replay`/`health-anchor-route`/`fidelity-chain`/`dir-picker-routes`/`diag-info`/`cancel-corpse`/`approval-lifecycle`/`app-page-spawn`/`answer-resume`/`install-default-approval`，另 `approval-mode` 复核后确认与鉴权面无交集）。逐个核对后确认：**全部是"无 Origin 的本机客户端"这一类的合法测试客户端**（fetch/http.get/ws），不是设计缺陷 ⇒ 逐个补令牌。
   - **踩坑（值得记）**：首轮我是用"失败用例名前 20 字符去测试文件里反查"来定位文件的，这个映射**漏掉了 `install-default-approval`**（`P0-4` 用例，spawn 桥后 `fetch('/config')`，注释还写着"GET /config 无鉴权"——现已随改动作废）。教训：**定位受影响文件要靠 stack trace 里的 `file:///...test.mjs`，不要靠用例名反查**。
2. **补令牌的方式（拒绝全局后门）**：新增测试助手 `server/test-bridge-auth.mjs`（导出固定测试令牌 + `bridgeEnv`/`authHeaders`/`withToken`），12 个文件各自在 spawn env / 请求侧带上令牌（`import('./bridge.mjs')` 形态的文件必须在 import **之前**设 `process.env.YFW_BRIDGE_TOKEN`）。**明确不采用**"在 npm test 里全局关掉鉴权"这类省事写法：那会让 39 个 spawn 桥的测试从此不再经过闸门，也会让后来者忘记带令牌时静默绕过。
3. 新增回归网 `server/bridge-auth-token.test.mjs` 必须**正反两面**（见 §5 实现后的实际断言清单）：
   - 纯函数：无 Origin 无 token 拒、带 token（头/query）放行、错 token 拒、**空 Origin 拒**（可构造旁路）、带 Origin 交 origin 闸、豁免面只含 `/health` 与 `/api/auth/*`、期望值为空一律失败；
   - 静态：闸门存在、**无 fail-open 分支**、令牌不进日志、令牌贯通 main（spawn env/`/boot-status`/WS/诊断）与桌宠；
   - 真机：无 Origin 无 token → **401**（GET 与 POST 都拦在路由之前）；错 token → 401；带头部/query → 200；`Origin: null`（打包版渲染层形态）与 `Origin: http://localhost:5197`（dev 形态）无 token → **200**；外部 Origin → 403（第二道未被削弱）；`/health`、`/api/auth/status` → 200，而 `/diag/info` → 401；
   - 真机：WS 无令牌被拒（1008/握手错误）、带头部或 query 通、**渲染层 WS（`Origin: null`）仍通**；
   - 真机：**无 env 令牌时自生成落盘（0600）且照样 401**（"没配 token 就放行"的 fail-open 写法会被这一条抓住），并断言令牌值不出现在启动日志里。
4. 守门演练（防假绿）：把闸门临时短路 → 新回归网必须精准变红（见 §7 实测记录）。

## 6. 边界与残留风险（诚实披露）

1. **`Origin: null` 的沙箱 iframe 残留**：恶意网页可经 `<iframe sandbox>` 获得 `Origin: null` 从而仍被 origin 闸放行。关闭它必须让渲染层 58 处 fetch 全部带 token（或 main 侧 webRequest 注入），**超出 D2 文档要求**，本轮不做，记录为后续条目。
   - **【2026-09-17 更新】关闭的前置条件已落地**：上面建议的"main 侧 webRequest 注入"已随 401 兼容性修复实现（`electron/bridge-header-inject.cjs` + `main.cjs` 双点安装，见 `docs/2026-09-17-打包版渲染层401修复.md`），故本项现在**可以关闭**（把 `'null'` 从"免令牌"中摘除即可）。
   - **【2026-09-17 实测确认该残留是真实可利用的**（不再只是理论）：重启后的运行实例上，仅带 `Origin: null`、**不带任何令牌**即 `/config` → **200**（响应含 4 个 provider `authToken` 明文，长度 35/125/43/35）、`/list-dir` → **200**、`OPTIONS` 预检 → **204** 且 `ACAO: null` + `Allow-Methods: GET, POST, PUT, PATCH, DELETE`（读写皆可）。已登记为 `docs/待处理清单.md` 的 `P1` 条目，待批准后实施。
2. **无 Origin 的 GET 型 CSRF 已被堵住**（`<img>`/`<script>`/`<form>` 不带 Origin）——这是 D2 相对 D1 的实质增益；但**本地进程**仍可读 token 文件/环境变量，故 token 不是进程级隔离（任何本机同用户进程本就能读写 `~/.yfw`，这属模型边界而非 D2 缺陷）。
3. **不含 D3 出网闸**：D2 只解决"谁能调桥"，不解决"数据出网"。
4. **渲染层 58 处 fetch 与 1 处 WS 本轮未动**（有意），故不存在"半升级失联"：渲染层行为与 D2 前完全一致。
   - **【2026-09-17 更正】该断言经实测**（上文"渲染层与 D2 前完全一致"）**不成立**：它隐含假设"打包版 `file://` 页面会带 `Origin: null`"，而打包版内核 **Electron 43.2.0 / Chromium 150 根本不带 Origin** ⇒ 渲染层全部 HTTP 请求被 D2 判为"无 Origin 且无令牌"→ **401**，生产上表现为工作流/知识库面板回显 `Unauthorized`（这正是 2026-09-17 那次故障的成因，修复见 `docs/2026-09-17-打包版渲染层401修复.md`）。教训：**"渲染层零改动"不等于"渲染层行为不变"**，闸门类改动必须用**打包版内核**（而非系统浏览器/Node 客户端）做端到端验证。
5. **WS 的拒绝形态是"先 upgrade 再 1008 关闭"**（沿用既有 origin 拒绝的形态），不是 HTTP 401 —— 安全性质（对端无法收发任何消息）等价，但客户端看到的是 1008 而非 401，验收语句里的"返回 401"只适用于 HTTP 请求。

## 7. 实施记录与验证（2026-09-16）

| 项 | 结果 |
|---|---|
| `npm run typecheck` | ✅ 零错误（本轮无 TS 改动） |
| `server/*.test.mjs` | ✅ **562/562 pass**（基线 557 + 本轮新增 5） |
| `src/**/*.test.ts` | ✅ 635/635 pass（渲染层零改动） |
| `electron/*.test.mjs` + `shared/**/*.test.mjs` | ✅ 210/210 pass（含诊断模块） |
| `kernel-tests/*.test.mjs` | ✅ 1798 项：1797 pass / 0 fail / 1 skipped（首轮出现的 `engine-ask-user`「等待有界」并行 flake 本轮未复现；未触碰 `kernel/`） |
| **守门演练** | ✅ 把 HTTP/WS 闸门临时短路为 `if (false && !authz.ok)` → 3 个真机用例**精准变红**：`无 Origin 无 token 的 GET 必须 401（实际 200）`（报错里直接打印出被放行的 `/known-folders` 目录清单——即闸门失效时会泄露什么）、`自生成模式下无令牌请求仍必须 401`、`无令牌 WS 必须被拒（实际 accepted:true）`；恢复后回绿 5/5，`false &&` 残留 0 |
| **发布副本真机探针**（`release/YFWorking`，端口 52234，env 注入令牌） | ✅ `netstat` 仅 `127.0.0.1:52234 LISTENING`；无 token → **401**；正确 token → **200**；错误 token → **401**；`Origin: null`（渲染层形态）→ **200**；`/health` → **200**（免令牌） |
| **发布副本真机探针**（端口 52235，**不给** env 令牌） | ✅ 自生成并落盘 `runtime/bridge-token`（64 位 hex）；无 token → **401**（fail-closed 成立）；持落盘令牌 → **200** |
| 同步一致性 | ✅ 6 个产品文件与 `release/YFWorking/` md5 逐一一致；探针进程已回收、52234/52235 零残留；用户运行中的 51517 实例（旧代码）未被触碰 |
| **首版回归网的自身缺陷（已修，记录以免重犯）** | 真机用例首版用单次请求判 401/200，全量并发跑时**假红**（`{"status":0,"error":"timeout"}`）——根因同 D1：监听回调内紧跟 `autoInstall*`/`autoProbe*`，数百测试并发时事件循环被占住。改为"带预算重试，且**只对连接层失败重试**"（收到任何 HTTP 状态即视为确定性结果），语义不受影响。另：批量替换调用点时曾把 helper 内部那行也替换掉，造成自递归假红——改一处错一行也会被真机用例立刻抓住。 |
