# P1 应用内网络代理配置（待处理清单第 30 项）实施方案

> 状态：**方案待批**（本文只出方案，不含代码改动）
> 日期：2026-09-17
> 对应清单项：`P1` 应用内增加网络VPN代理配置功能
> 结论先行：**不需要改任何一处业务调用点** —— 一个 Node 开关（`NODE_USE_ENV_PROXY`）+ 一个 Electron API
> （`session.setProxy`）即可覆盖全部出网面；本项真正的风险不是"能不能代理"，而是**别把自己代理掉**
> （桥回环必须走白名单）。

---

## 0. 范围澄清（先对齐预期，避免做偏）

"网络 VPN 代理"在实际使用中是三类完全不同的东西，方案边界必须写清：

| 类型 | 典型形态 | 应用要不要改 | 本方案是否覆盖 |
|---|---|---|---|
| **系统级 VPN（TUN/全局路由）** | Clash TUN、WireGuard、公司 VPN 客户端 | **不用改**：系统层已改路由，应用无感 | 不覆盖（也不需要） |
| **HTTP/HTTPS 代理** | Clash `7890`、V2Ray 混合端口、公司 MITM 代理 | 需要（本次目标） | ✅ 覆盖 |
| **SOCKS5 代理** | `socks5://127.0.0.1:1080` | 需要 | ✅ 覆盖（Node 侧标注为实验性） |

**明确不做**（可作为后续项）：分应用路由、PAC 脚本、按 provider 分别配置代理、
代理连接的可视化测速、系统代理的自动探测复用（v1 只做 `system` 档透传给 Chromium）。

---

## 1. 现状：全仓零代理支持（实测）

```
grep -rn "HTTP_PROXY|HTTPS_PROXY|NO_PROXY|ProxyAgent|proxy" -i \
  kernel/ shared/ server/ electron/ src/ bin/     # 排除 node_modules 与 test
```

结果：除下面两处**透传**外，**没有任何代理逻辑**（无配置字段、无 UI、无 env 注入、无 session 代理）：

- `kernel/tools.mjs:57-67` 的 `ENV_WHITELIST` **已包含** `HTTP_PROXY/HTTPS_PROXY/NO_PROXY`（含小写变体）
  ⇒ Bash / python 子进程**已能继承**代理变量（无需改）。
- `kernel/mcp.mjs:27-31` 的 `ENV_KEEP` 是**另一套**白名单，**不含**代理变量
  ⇒ MCP stdio 子进程拿不到代理（**需补**，见 Step 4）。

### 1.1 出网面清单（本方案的完整作业面）

| # | 出网主体 | 位置 | 网络栈 | 生效通道 |
|---|---|---|---|---|
| 1 | 模型 API 调用（chat/completions） | `kernel/api.mjs:1135` | Node fetch（undici） | Node 轨 env |
| 2 | `WebFetch` 工具 | `kernel/tools.mjs:750` | Node fetch | Node 轨 env |
| 3 | `WebSearch` 工具 | `kernel/tools.mjs:1009` | Node fetch | Node 轨 env |
| 4 | 工作流 HTTP 节点 | `kernel/workflow-nodes.mjs:381` | Node fetch | Node 轨 env |
| 5 | MCP over HTTP | `kernel/mcp-http.mjs:121` | Node fetch | Node 轨 env |
| 6 | **MCP stdio 子进程** | `kernel/mcp.mjs:27` | 子进程自身的网络栈 | **补 `ENV_KEEP`** |
| 7 | 桥的 provider 探测 | `server/provider-probe.mjs:39/97` | **`http`/`https` 模块**（非 fetch） | Node 轨 env（已实测对 `https.get` 同样生效） |
| 8 | 主进程「应用智控」http 后端 | `electron/app-runner-http.cjs` | Node fetch（Electron 主进程） | Node 轨 env |
| 9 | 内置浏览器 / 自动化浏览器 | `electron/browser-executor.cjs`、`persist:automation-*` 分区 | **Chromium** | **Chromium 轨**（`session.setProxy`） |
| 10 | Bash / python / OCR 子进程 | `kernel/tools.mjs` | 子进程自身的网络栈 | 白名单已含 ✅（零改动） |

**一句话**：1–8 走 **Node 轨**（env），9 走 **Chromium 轨**（`setProxy`），10 本来就通。

---

## 2. 关键技术事实（全部实测，附复现命令）

> 这几条是方案的承重墙。每条都在本机（Windows，dev node v24.14.1 / 打包版自带 `release/YFWorking/node.exe` v24.14.1 / Electron 43.2.0）实测过。

**F1. Node 24 支持环境变量代理开关，且对 `fetch` 与 `https.request` 都生效。**
```bash
NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:1 node -e "fetch('https://example.com')"
# → 失败 ECONNREFUSED（证明"确实走了代理"，而非静默直连）
```
`server/provider-probe.mjs` 用的是 `https.get`（不是 fetch），**同一条命令对 `https.get` 也复现成功**
⇒ 不需要为它单独改代码。

**F2. 打包版自带 node 支持该开关。** `release/YFWorking/node.exe` = v24.14.1（`resolveNode()` 优先用它，
即生产运行时与 dev 同为 Node 24）⇒ 方案不依赖"用户机器上的 node 版本"。

**F3. SOCKS5 也支持（实验性）。** `HTTPS_PROXY=socks5://127.0.0.1:1` 生效并打
`ExperimentalWarning: SOCKS5 proxy support is experimental`。⇒ 可支持，但必须在文档与 UI 旁注明"实验性"。

**F4. `NO_PROXY` 能保住回环（本方案最关键的一条）。**
```bash
NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:1 NO_PROXY=127.0.0.1,localhost \
  node -e "fetch('http://127.0.0.1:51517/boot-status')"
# → HTTP 401（直连到桥，被鉴权闸拒绝；若被代理劫持会是 ECONNREFUSED）
```
⇒ 只要把回环并入 `NO_PROXY`，**桥与本机服务不会被代理劫持**（这是最容易把应用搞瘫的坑）。

**F5. Electron 主进程的 `globalThis.fetch` 是 Node undici，吃 env 开关；`session.setProxy` 只影响 Chromium 栈。**
真机探针（Electron 43.2.0）：
- 带 `NODE_USE_ENV_PROXY=1` + 坏代理 → 主进程 `fetch` **ECONNREFUSED**（受 env 影响）；
- 调 `session.setProxy({proxyRules:'http://127.0.0.1:1'})` 后，同一次 `fetch` **仍 200**（不受 session 影响）。

⇒ **两轨必须分别配，不能指望一个 API 全管**。

**F6. 桥 → 内核的 env 是 `...process.env` 展开。** `buildChildEnv()`（`server/bridge.mjs:1054`）先展开
`process.env` 再补 `PONOS_CONFIG_DIR`/`YFWORKING_HOME`/`PONOS_HOME` ⇒ **只要桥进程有代理 env，内核子进程天然继承**；
且内核每次调用都是**新 spawn** ⇒ 内核轨**改配置即时生效、无需重启**。

**F7. MCP stdio 白名单不含代理变量**（`kernel/mcp.mjs:27`，见 §1）。

---

## 3. 设计：双轨 + 一个纯函数收口

```
                  ┌──────────────────────────────────────────┐
  config.json ──▶ │ shared/proxy-config.mjs（新，纯函数）      │
  network.proxy   │  · 校验 URL / 归一协议                    │
                  │  · 产出 nodeEnv（Node 轨）                │
                  │  · 产出 {proxyRules, proxyBypassRules}    │
                  │  · **强制并入回环** 到绕过列表             │
                  └────────────┬─────────────┬───────────────┘
                               │             │
                    Node 轨 env │             │ Chromium 轨 setProxy
                               ▼             ▼
        ┌──────────────────────────────┐  ┌──────────────────────────────┐
        │ 桥进程（自身出网 + 派生子进程） │  │ Electron 各 session           │
        │  · provider-probe             │  │  · defaultSession（主窗口）    │
        │  · buildChildEnv → 内核        │  │  · persist:automation-*（浏览器）│
        │  · 内核 → MCP/Bash/python     │  │  经 session-created 钩子统一装上 │
        └──────────────────────────────┘  └──────────────────────────────┘
```

**收口原则**：代理参数只在一个纯函数里算（可单测、无 IO），两个进程各自"取参数、下发"。
禁止在调用点各自拼 env/URL —— 回环白名单漏一处就是一次"应用自己连不上自己"的生产事故。

---

## 4. 配置设计

`~/.yfw/config.json` 新增（**默认 `off`，零回归**）：

```jsonc
{
  "network": {
    "proxy": {
      "mode": "off",                       // off（默认）| system | manual
      "url": "http://127.0.0.1:7890",      // manual 必填；支持 http/https/socks5
      "bypass": ""                         // 用户追加的绕过项（逗号分隔）；回环由代码强制并入
    }
  }
}
```

| 字段 | 语义 | 说明 |
|---|---|---|
| `mode: off` | 完全不做任何代理 | 与本方案落地前的行为**逐字节一致**（验收基线） |
| `mode: system` | 跟随系统代理 | Node 轨：读系统代理无标准 API ⇒ **v1 该档只作用于 Chromium 轨**（`setProxy({mode:'system'})`），Node 轨明确告知"请用 manual"，不猜 |
| `mode: manual` | 显式填 URL | 两轨都生效 |
| `url` | 代理地址 | 允许 `user:pass@host:port`（凭据**不新增字段**，复用既有 provider 密钥的同级保管方式） |
| `bypass` | 追加绕过 | **只能追加**；回环（`127.0.0.1,localhost,::1`）与打包版所需的本地域由代码强制并入，用户改不掉 |

**关于 `system` 档的取舍**：Chromium 能跟随系统代理，而 Node 没有跨平台读取系统代理的标准 API
（Windows 要读注册表、macOS 要 `scutil`、Linux 看 gsettings）。v1 **不实现**这些平台探测 ——
宁可明确告诉用户"Node 侧请填 manual"，也不做"看起来能跟随、其实只有一半生效"的半吊子功能
（那会让 WebFetch 走直连、模型调用走代理，排障成本极高）。

---

## 5. 实施步骤（bite-sized，每步含验证）

### Step 1｜`shared/proxy-config.mjs`（纯函数）+ 单测

- 导出：`normalizeProxyConfig(cfg)`、`nodeProxyEnv(proxyCfg, baseEnv)`、`chromiumProxyOptions(proxyCfg)`、
  `LOOPBACK_BYPASS`（常量）。
- 校验：`manual` 必须有合法 URL 且协议属 `http|https|socks5`，否则**返回错误、不静默降级为 off**
  （静默降级会让用户"以为配好了"，实际全走直连）。
- `nodeProxyEnv` 输出：`NODE_USE_ENV_PROXY=1`、`HTTP_PROXY`/`HTTPS_PROXY`（大写 + 小写各一份，
  兼容读小写的工具链）、`NO_PROXY`（用户 bypass ∪ 回环，**去重、去空白**）。
- **验证**：单测断言
  ① `off` ⇒ 返回空对象（不得注入任何变量）；
  ② `manual` ⇒ `NO_PROXY` **必含** `127.0.0.1`（反向断言：构造只填 bypass 的用例，回环仍在）；
  ③ 非法 URL ⇒ 报错而非降级；
  ④ 幂等：同一配置算两次结果逐字节一致。

### Step 2｜桥侧：自身出网 + 派生子进程（Node 轨）

- `server/bridge.mjs`：`loadConfig()` 后计算代理参数；`buildChildEnv()` 里合并 `nodeProxyEnv(...)`
  （**合并顺序**：先 `...process.env`，再代理变量 —— 让**应用配置覆盖**外部 env，行为可预期）。
- 桥进程**自身**出网（`provider-probe`）：因 F1 已证明开关对 `https.get` 生效，v1 **不改探测代码**，
  只需保证桥进程启动时带上 env（见 Step 3）。⚠️ 若实测发现某条路径不吃 env，**降级方案**是给
  `provider-probe` 的 `lib.get` 传 `agent`（用 `proxyEnv` 造一个 `https-proxy-agent` 等价物）——
  这属于实现期的兜底，不进 v1 设计。

- **验证**：起一个**本地假代理**（`http.createServer` 记录收到的请求行/`CONNECT`），
  把 `mode=manual` 指向它，断言"内核子进程 env 里确有代理变量"（直接断言 env，不依赖真实出网）。

### Step 3｜主进程：桥启动 env + Chromium 轨 `setProxy`

- `electron/main.cjs`：拉起桥时把 Step 2 的 Node 轨变量注入桥进程 env
  （**须早于桥启动**；这是"改代理后桥侧需重启"的根因，必须写进 UI 提示）。
- Chromium 轨：调用 `session.setProxy({ proxyRules, proxyBypassRules })`，覆盖
  **`defaultSession` + 每个 `persist:automation-*` 分区**；复用既有
  `app.on('session-created')` 钩子（该钩子今天已用于令牌注入，直接在同一处加一行，注意
  **`session-created` 钩子里不要注入令牌到 automation 分区**的既有约束，代理设置**相反**：
  automation 分区**要**设代理）。
- **验证**：真机探针（照今日 401 修复的做法）——带坏代理后：
  ① 内置浏览器加载外网应失败；② **桥回环通信仍 200/401 正常**（F4 的回归锁）。

### Step 4｜MCP stdio 白名单补代理变量

- `kernel/mcp.mjs` 的 `ENV_KEEP` 增加 `HTTP_PROXY/HTTPS_PROXY/NO_PROXY` 及小写变体
  （与 `kernel/tools.mjs` 的既有做法**逐字对齐**，避免两套白名单再次漂移）。
- **验证**：单测断言 `mcpChildEnv()` 输出含代理变量；并加一条"两侧白名单一致性"断言
  （直接比对两个文件的代理变量集合，防止将来只改一处）。

### Step 5｜设置 UI + i18n

- 落点：`src/components/settings/SettingsView.tsx` 的 `general` 分区（`section === 'general'` 分支）
  内加"网络代理"块：三档单选 + URL 输入 + bypass 输入 + 保存按钮；**并列一行说明**
  "改完需重启应用才作用于桥与主进程"（内核侧即时生效，如实区分）。
- 复用既有 `fetchBridgeConfig`/`saveBridgeConfig`（`src/lib/config.ts`）与设置项校验范式
  （参考 `normalizeLogPolicyUi` / `normalizeKnowledgeImportPolicyUi`：**归一化函数独立成文件 + 单测**）。
- i18n：`zh-CN`/`en-US` 双语同步（既有纪律：两语言文件都改）。
- 凭据脱敏：回显 URL 时密码段打码（沿用 provider `authToken` 的脱敏惯例）；代理 URL 不得进日志。
- **验证**：归一化单测 + 真机看三项交互（切档不丢值、非法 URL 就地报错、保存后重进设置仍在）。

### Step 6｜端到端验收（负向为主）

| 用例 | 期望 |
|---|---|
| `off` | 与今日行为逐字节一致：`git stash` 前后跑同一组测试结果相同；桥回环正常 |
| `manual` + 本地假代理 | 假代理**确实收到**内核的模型请求与 `CONNECT`（证明不是"配了但没走"） |
| `manual` + 坏代理（`127.0.0.1:1`） | 内核请求**快速失败**且错误信息可读；桥回环**仍通**（F4 锁） |
| `manual` + 非法 URL | 保存时就地报错，**不得**静默变直连 |
| 改配置后不重启 | 内核轨**即时**生效；桥/主进程轨按提示需重启（如实告知，不假装即时） |
| SOCKS5 | 可用（附实验性告警），文档标注 |
| 重启后 | 配置持久化、仍生效 |

---

## 6. 风险与坑（按严重度排序）

1. **⚠️ 最高危：把自己代理掉。** 若回环没进 `NO_PROXY`，桥通信会走代理 —— 表现为"应用突然连不上
   自己的后端"，而错误信息（`ECONNREFUSED` 指向代理端口）**完全不提代理**，极难定位。
   对策：回环由代码**强制并入**且不可被用户配置覆盖（Step 1 反向断言锁死）。
2. **半生效比不生效更难查。** `system` 档若只覆盖 Chromium，会出现"浏览器能上网、模型调用不能"的组合。
   对策：v1 明确该档只作用于 Chromium，并在 UI 旁注明 Node 侧请用 manual（不猜、不假装）。
3. **改配置后的生效时机不一致**：内核即时、桥与主进程需重启。对策：UI 如实分列说明（不写"立即生效"）。
4. **TLS 拦截型代理（公司 MITM）**：需 `NODE_EXTRA_CA_CERTS` 指自签 CA。v1 **文档记录、不实现**；
   错误提示里给出线索（避免用户误判为模型/密钥问题）。
5. **凭据泄露面**：代理 URL 可能含密码 —— 不得进日志、不得在 `/config` 明文回显（现有 `/config`
   已有 provider `authToken` 字段，属既有现状，本项**不要再加一个**）。
6. **测试隔离**：单测一律不依赖真实外网（用本地假代理断言"请求到达"），否则 CI 会因网络环境飘红。
7. **`ENV_WHITELIST` / `ENV_KEEP` 两套白名单漂移**：本次必须加一致性断言（Step 4），
   否则将来改一处、漏一处，症状是"MCP 能连、Bash 不能连"这类无头案。

---

## 7. 工作量与优先级建议

| 步骤 | 内容 | 估时 |
|---|---|---|
| Step 1 | 纯函数 + 单测 | 2h |
| Step 2 | 桥侧 env（含假代理验证） | 2h |
| Step 3 | 主进程 env + Chromium 轨 setProxy（真机探针） | 3h |
| Step 4 | MCP 白名单 + 一致性断言 | 1h |
| Step 5 | 设置 UI + i18n | 3h |
| Step 6 | 端到端验收 | 2h |
| | **合计** | **≈ 1.5 人日** |

**建议优先级**：本项对"在内网/需代理环境下使用模型 API"的用户是**阻断级**（不配代理则完全不可用），
且实现面集中、无新依赖（Node 24 内置能力），**建议排在子代理并发（第 10 项）之前**。

---

## 8. 与既有安全工作的关系（不冲突，需并跑）

- 本方案会在 `session-created` 钩子上"加"代理设置，而今日的令牌注入器在同一钩子上"排除"
  `persist:automation-*` 分区。两者**方向相反但互不干扰**：令牌注入**不得**进 automation 分区，
  代理设置**必须**进 automation 分区。实现时应在同一处加注释交叉引用，避免后来者"见一处改两处"。
- 代理开启后，`NO_PROXY` 回环白名单同时**保护了桥的鉴权通道**（否则回环被劫持 = 全部请求 401/失败），
  与 D2 令牌闸是互补而非替代关系。
