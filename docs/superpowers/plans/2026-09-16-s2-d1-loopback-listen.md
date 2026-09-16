# Plan：S2-D1 收窄 bridge 监听到回环（2026-09-16）

> 对应 spec：`docs/superpowers/specs/2026-09-14-team-collaboration-design.md` §6.2 D1、§10「S2 验收 1/2」。
> 本轮范围：**只做 D1**（收窄监听）+ 其配套的本地客户端一致性与回归网。**D2（token 鉴权）不在本轮**。

## 1. 前置盘点：谁在连 51517（本轮第 1 步产物）

### 1.1 运行态实测（netstat -ano，2026-09-16）

| PID | 进程 | 可执行路径 | 与桥的连接 |
|---|---|---|---|
| 19564 | node（bridge 自身） | `release/YFWorking/node.exe` | **LISTEN `0.0.0.0:51517` + `[::]:51517`**（全接口） |
| 25660 | electron（主进程 + 渲染层） | `release/YFWorking/electron/electron.exe` | `[::1]×2`、`127.0.0.1×1` |
| 23792 | electron（第二个实例/窗口） | 同上 | `[::1]×2` |
| 13968 | python（桌宠） | `D:\Python 3.12.0\python.exe` | `[::1]×1` |

⇒ **局域网可达属实**（`0.0.0.0`/`[::]` 均 LISTENING）；且**现有客户端已走回环**，其中 IPv6 回环 `[::1]` 是主路径之一。

### 1.2 代码级客户端清单（穷尽搜索结果）

| # | 客户端 | 落点 | 地址写法 |
|---|---|---|---|
| C1 | 渲染层全部窗口（主窗/编辑器窗/个人设置窗/cockpit 宿主） | `src/lib/config.ts:14` `getBridgeUrl()` / `getWsUrl()`；消费方 `src/hooks/useYFWCLI.ts:170` 等全量 fetch | `http://localhost:${__BRIDGE_PORT__}` |
| C2 | Electron 主进程健康轮询 | `electron/main.cjs:207` `BRIDGE_READY_URL` → `:482 http.get` | `http://localhost:${PORT}/health` |
| C3 | Electron 主进程 WS 客户端 | `electron/main.cjs:794` `connectBridgeClient` | `ws://localhost:${PORT}` |
| C4 | 桌宠（python） | `pet/jiajia-pet.py:62` | `ws://localhost:${PORT}` |
| C5 | 主进程诊断 | `electron/main.cjs:222/264`、`electron/diag-monitor.cjs:121` | 已是 `127.0.0.1` |
| C6 | 既有兜底基址 | `src/lib/bridgeBase.ts` | 已是 `127.0.0.1`（上一轮建立） |

非客户端（不连桥）：`bin/cli.mjs`（dev 启动器，仅 killPort/打印）、`start.bat`（设 env）、`public/cockpit/*`（iframe 只与宿主 postMessage）。

## 2. 设计决策：为什么是「单栈 127.0.0.1 + 客户端统一 host」

spec 字面为 `listen(PORT, '127.0.0.1')`。若**只改服务端**，实测中经 `[::1]` 连接的 C1/C3/C4 会退化为"依赖客户端 Happy-Eyeballs 回退"，属**静默失联风险**（用户明确要求先排除）。两种可选实现：

- **A 回环双栈**（`127.0.0.1` + `::1` 两个 server）：客户端零改动、失联风险最低；代价是本文件需抽出 HTTP handler 与 WS connection handler（约千行 handler 的机械搬移 + 双份自愈逻辑），且 `netstat` 会出现 `[::1]` 监听，与 §10 S2-1「仅监听 127.0.0.1」字面不符。
- **B 单栈 + 客户端统一**（本轮采用）：服务端绑 `127.0.0.1`（严格 spec 字面、netstat 结论干净），客户端 C1–C4 显式写 `127.0.0.1`（去掉 `localhost` 的双栈解析不确定性）。

选 B 的理由：① 安全收益等价（A/B 都只对回环开放，不涉局域网）；② 客户端逐处显式化后，**"谁连桥"变成可 grep 的静态事实**，不再依赖 DNS 解析顺序——这正是本次事故风险的根因；③ 改动面小且全部可断言。

**保留 `localhost` 的地方**：`server/bridge.mjs` 的监听就绪日志（12 个 `server/*.test.mjs` 以 `http+ws://localhost:<port>` 作就绪判据，改文案会无谓扩大 diff）——只在其后**追加一行**明确回环地址，保证信息准确。

## 3. 任务

- **T1** `server/bridge.mjs`：`httpServer.listen(PORT, '127.0.0.1', cb)` + 说明性注释（为何不是 0.0.0.0、IPv6 由客户端 host 统一覆盖）；追加回环地址日志行。
- **T2** 客户端 host 统一为 `127.0.0.1`：`src/lib/config.ts:14`、`electron/main.cjs:207`、`electron/main.cjs:794`、`pet/jiajia-pet.py:62`。
- **T3** 回归网 `server/bridge-listen-loopback.test.mjs`：静态断言（listen 带 host；四处客户端无 `//localhost:`）+ 真机断言（起真桥于隔离 home/随机端口：`127.0.0.1` 可达、**局域网 IP 不可达**、WS 握手成功、netstat 无 `0.0.0.0`/`[::]` 监听）。
- **T4** 门禁：`npm run typecheck` + `server` 全量 + `src` 全量 + `kernel-tests`（未改内核，作零回归对照）。
- **T5** 发布同步：`release/YFWorking/{server/bridge.mjs, electron/main.cjs, pet/jiajia-pet.py}` + `dist/`（config.ts 改动需重建）。

## 4. 验证与证据

1. 真机：隔离实例 `netstat` 仅 `127.0.0.1:<port>` LISTENING；`curl 127.0.0.1/health` 200；`192.168.11.216:<port>` 连接被拒。
2. 真机：WS 客户端（`ws` 包，模拟 C3/C4）连 `ws://127.0.0.1:<port>` 握手成功。
3. 守门演练（防假绿）：临时把 listen 回退为无 host → 新测试必须精准变红。
4. 门禁全绿。

## 5. 边界（诚实说明）

- 本轮**不含 D2（鉴权）**：收窄只切断局域网路径；本机任意进程仍可无凭据调桥（D2 才解决）。
- 用户**正在运行的实例**仍是旧代码（旧桥绑 0.0.0.0、旧前端走 localhost），重启应用后新行为才生效；旧桥 + 新前端（127.0.0.1）同样可通，不存在半升级失联窗口。
- `bin/cli.mjs:62` 的 `vite --host 0.0.0.0`（dev server 全接口）是**另一处暴露面**，不属 D1，未动（记录为后续条目）。
- 未盘点到的第三方脚本若硬编码 `localhost:51517`，在已收窄的桥上可能先试 `::1` 失败（多数运行时有回退）；这是"显式 127.0.0.1"策略的已知代价，已在文档披露。
