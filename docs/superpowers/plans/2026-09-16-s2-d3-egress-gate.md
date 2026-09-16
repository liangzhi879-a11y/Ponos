# Plan：S2-D3 数据出网闸（2026-09-16）

> 对应 spec：`docs/superpowers/specs/2026-09-14-team-collaboration-design.md` §6.2 D3、§9「S2 出网闸」、§10「S2 验收 3」、§5.1 数据实体分层、§4 原则 P1/P2。
> 前置：D1（收窄监听）、D2（token 鉴权）已完成（`docs/superpowers/plans/2026-09-16-s2-d1-loopback-listen.md`、`2026-09-16-s2-d2-bridge-token.md`）。
> 本轮范围：**只做 D3**。D4（`authorId`/`workspaceId` 落盘）、D5（`byAuthor`）、D6（标签实体化）**不在本轮**。

## 0. 闸门裁定记录（开工前置，2026-09-16 用户裁定）

spec 存在一处**内部矛盾**，本轮按用户裁定执行，此处留痕：

| 出处 | 原文 | 对 D3 的结论 |
|---|---|---|
| §13 决策闸门表（`:785`） | `| **S2 的 D3–D6** | 📌 **#4**（D6 标签别名合并是否需人工审核） | — |` | 字面读 ⇒ **D3 也要先确认 #4** |
| §14 批注明细（`:805`） | `| 4 | 标签别名合并是否需人工审核 | … | §6.2 D1–D6 表后 | **S2 的 D6 开工前必答** |` | 字面读 ⇒ **#4 只卡 D6** |
| §6.2 表后批注（`:557`） | 「#4 —— 标签别名合并是否需人工审核。… **D6 落码前必须先定**」 | 与 §14 一致：**只卡 D6** |

**用户裁定**：① 采信 §14/§6.2 批注明细 —— **D3 无前置批注，可开工**；§13 表的 "D3–D6" 是汇总写法。② **#4 一并裁定为「自动合并 + 可撤销」**（5–20 人规模，§14-4 倾向），该裁定已解锁 **D6**（本轮不实现，仅记录）。③ D3 落点范围 **仅 bridge 请求入口**（照 §6.2 字面，不扩到 `kernel/` 同步路径，避免越线）。
> §0 闸门规则（`:24`）「推进到任何批注点前，必须先与用户确认；确认后方可落码」已满足：上述三点均为用户明确裁定。

## 1. 契约（spec 原文拆解）

| 来源 | 原文 | 落为本轮的可验证命题 |
|---|---|---|
| §4 P2 | 出网闸为**白名单式**：数据实体默认 `local-only`，**显式标记才可外发**。黑名单式屏蔽必漏 | 未知实体 / 未显式标记 ⇒ 拒；只有显式 `sync-ok` 才可能放行 |
| §4 P1 | 热状态（运行中会话/审批/浏览器/工具执行/**凭据**）纯本地、**永不**参与同步 | 热类实体 **即使被显式标记也拒**（"永不"优先于显式标记） |
| §5.1 | 冷·敏感（transcript 全文、绝对路径、命令）**默认不同步**；显式分享时**必须过 `kernel/redact.mjs`** | 敏感类实体放行需 **`sync-ok` + redact 证据** 双条件 |
| §5.1 | 冷·内容（知识/经验/工作流定义/文件版本/标签）双向；冷·遥测（消耗量/会话元数据/运行审计）单向上行 | 这两类在 `sync-ok` 下可放行（遥测仅上行） |
| §6.2 D3 | 白名单式闸门**落在 bridge 请求入口**（与 D2 同层——所有读写的**唯一仲裁点**）；数据实体带 `syncPolicy`（**默认 `local-only`**） | 判定内核 + 在 bridge 入口建立**唯一**判定面；`syncPolicy` 默认值可查询、可断言 |
| §9 S2 出网闸 | 单测：默认 `local-only` 的数据**不出网**；显式标记才出 | 正反两面单测（只测"拒绝"会在"闸门全拒"时假绿） |
| §10 S2-3 | 出网闸：**默认配置下，transcript/config 等敏感数据「无任何出网路径」** | 真机断言默认档下 `transcript`/`config`/凭据类**全部** `allowed:false` |
| §6.2 D3 备注 | 与 D2 同层 | 闸门面挂 D2 建立的同一请求入口，复用同一套豁免/判定风格 |

## 2. 关键判断：单机版（L1）下 D3 究竟交付什么

spec §0 明确 **S2 是"协同地基"**、当前**只做个人版**；团队源（Team Source）属 **S3**（§7 边界）。因此单机版**不存在真实的同步链路**——若我去造一条同步路由，就是实现了 S3 的东西（越线）。D3 在 L1 的正确交付物是：

1. **判定内核（白名单，唯一实现）**：把"什么数据允许过团队源"固化下来，供 S3 的同步链路**导入即用**，使后来者无法绕过（P7「不造平行体系」：不新造分发协议，只做判定）。
2. **在 bridge 入口建立唯一判定面**：`/egress/policy`（**受 D2 token 保护**的只读端点），暴露各实体 `syncPolicy` 与当前档位 —— 这是"唯一仲裁点"在单机版唯一可观测、可测的形态；同时它是 S3 接线时的既定入口。
3. **不改 `kernel/`**：不落 `authorId`（D4）、不加 `byAuthor`（D5）、不实体化标签（D6）。

**明确不做**：不造同步路由、不造团队源抽象（S3）、不造分发协议（P7）、不做审计落盘体系（D3 未要求"越权留痕"，那是 P6 软权限的事）。判定结果以**审计条目**形式返回给调用方，落盘由 S3 决定。

## 3. 设计

### 3.1 实体分层与默认策略（`server/egress-policy.cjs`，唯一实现）

| 档 | 实体 | 依据 | 判定 |
|---|---|---|---|
| `hot`（热·永不） | `config`（含明文 provider token）、`credential`、`conversation`、`approval`、`browser`、`tool-exec` | §5.1 表尾「热 … ❌ 永不」+ §4 P1 | **一律拒**，显式标记也无效 |
| `sensitive`（冷·敏感） | `transcript`、`abs-path`、`command` | §5.1「❌ 默认不同步；显式分享时**必须过 `kernel/redact.mjs`**」 | `sync-ok` **且** redact 证据 ⇒ 放行，否则拒 |
| `cold-content`（冷·内容） | `knowledge`、`experience`、`workflow-def`、`file-version`、`tag` | §5.1「✅ 双向」 | `sync-ok` ⇒ 放行 |
| `cold-telemetry`（冷·遥测） | `usage`、`session-meta`、`audit` | §5.1「⬆️ 单向上行」 | `sync-ok` ⇒ 放行（仅上行，方向由调用方约束） |

- **默认**：一切实体 `syncPolicy = 'local-only'`（P2）；整档开关 `mode` 默认 `'local-only'`，**整档 local-only 时全部拒**（§10 S2-3 的"无任何出网路径"）。
- **未知实体 ⇒ 拒**（白名单式，黑名单必漏）。
- 判定签名：`authorizeEgress(entity, { policy, redacted, mode })` → `{ allowed, reason, audit }`；`reason` 用稳定枚举（便于断言与排障），`audit` 不含数据正文。
- redact 证据：调用方须传入"已过 `kernel/redact.mjs`"的布尔标记（由 S3 在真的调用 `redactText`/`redactEntry` 后置位）；本模块**不**代替 redact 执行（避免把两个关注点揉在一起）。

### 3.2 bridge 接线（唯一仲裁点）

`server/bridge.mjs` 新增 `GET /egress/policy`（**受 D2 闸门保护**，无 token 的 curl 同样 401）：
返回 `{ mode, entities: [{ entity, tier, policy, allowed, reason }] }`。这是**只读**判定面，不改任何数据、不新增出网能力。

### 3.3 为什么 `/health`、`/api/auth/*` 之外还要加端点

D2 的豁免面**只**含 `/health` 与 `/api/auth/*`，新端点因此**自动**受 token 保护 —— 无需改 D2 的豁免清单，也不会削弱 D2。

## 4. 任务

- **T1** 新增 `server/egress-policy.cjs`：实体分层表、`syncPolicy` 默认值、`authorizeEgress`（含"热·永不优先于显式标记"）、`listEgressPolicy`（供端点与排障）、稳定 reason 枚举。
- **T2** `server/bridge.mjs` 接线 `GET /egress/policy`（放在 D2 闸门之后、与既有路由同层）。
- **T3** 回归网 `server/egress-policy.test.mjs`：单测（§9 两面 + 热·永不 + 敏感需 redact + 未知实体拒 + 默认档全拒）+ 静态（白名单默认值、不得 fail-open、桥侧唯一接线）+ 真机（`/egress/policy` 无 token 401、带 token 200、默认档 transcript/config 均 `allowed:false`）。
- **T4** 门禁：typecheck + `server/*.test.mjs` 全量 + `src` 全量 + `electron`/`shared` + `kernel-tests` 对照。
- **T5** 发布同步（`release/YFWorking/server/`）与清单更新。

## 5. 验证

1. 单测正反两面（§9 原文）：默认 `local-only` 不出网；显式标记才出。
2. 真机：默认档下 `transcript` / `config` / `credential` 全部 `allowed:false`（§10 S2-3 字面验收）。
3. **守门演练（防假绿）**：把判定临时改成"默认放行"（fail-open）→ 回归网必须精准变红。
4. 门禁全绿 + release 同步 md5 一致。

## 6. 边界（诚实说明）

1. **单机版无真实同步链路** ⇒ 本轮交付的是"判定内核 + 唯一判定面"，**不是**一条可跑的同步通道；真实出网路径由 S3 建立，届时必须先过本闸门（届时补一条"桥内不得绕过闸门"的静态守卫）。
2. **provider 校验路由**（`/test-provider` `/probe-provider` `/verify-provider`）会访问**用户自己配置的 provider**，属"用户显式操作 + 热·凭据"范畴，**不是**"把本地数据过团队源"，故**不纳入**本闸门（§5.1「出网」= 过团队源）。此点若与你的理解不同，请在评审时指出。
3. 不落 `authorId`/`workspaceId`（D4）、不加 `byAuthor`（D5）、不实体化标签（D6）——本轮严格不提。
4. 审计仅**返回条目**、不落盘（D3 未要求；落盘策略属 S3/企业版）。
5. `#4` 的裁定（自动合并 + 可撤销）**已记录但未实现**，D6 落地时按其执行。

## 7. 实施记录与验证（2026-09-16）

| 项 | 结果 |
|---|---|
| 交付物 | `server/egress-policy.cjs`（唯一实现）+ `server/egress-policy.mjs`（ESM 转发层）+ `server/bridge.mjs` 接线 `GET /egress/policy` + `server/egress-policy.test.mjs`（**5 用例**） |
| 实体分层 | 18 个实体四档：热·永不 6（`config`/`credential`/`conversation`/`approval`/`browser`/`tool-exec`）、冷·敏感 3（`transcript`/`abs-path`/`command`）、冷·内容 5、冷·遥测 3 |
| 判定优先级 | 整档封闭 → 未知实体 → 热·永不 → 未标记 → 敏感需脱敏 → 放行（每条都有 spec 出处，见模块头注释） |
| `npm run typecheck` | ✅ 零错误 |
| `server/*.test.mjs` | ✅ **567/567 pass**（基线 562 + 本轮新增 5） |
| `src/**/*.test.ts` | ✅ 635/635 pass；`electron/*` + `shared/**/*` ✅ 210/210 pass |
| `kernel-tests/*.test.mjs` | ✅ 分段实跑均 pass（本轮**未触碰** `kernel/`，作零回归对照；全量单次超 Bash 时限，按文件段分批跑） |
| **守门演练 A**（整档封闭失效） | ✅ 注入 `if (false && mode !== SYNC_ENABLED)` → 默认档用例精准变红（`允许出网`/`allowedEntities 非空`）；恢复回绿 |
| **守门演练 B**（默认 policy 改松） | ✅ 注入 `policy = SYNC_POLICY.SYNC_OK` → 单测 + 静态断言**双抓**（`authorizeEgress 的 policy 默认必须是 local-only`、`未显式标记的实体不得出网`） |
| **守门演练 C**（敏感档改松） | ✅ 注入 `transcript: EGRESS_TIERS.content` → **3 处**命中（单测 `敏感类缺脱敏证据必须拒`、静态 `transcript 必须留在冷·敏感档`、真机 `transcript 必须 allowed:false`）——证明真机面确实覆盖分档，不是摆设 |
| **发布副本真机探针**（端口 52236） | ✅ 无 token → **401**（受 D2 保护）；带 token → **200**，`mode = local-only`、**`allowedEntities = []`**（§10 S2-3 字面验收）；点名实体实测：`transcript` sensitive/`config` hot/`credential` hot 全部 `allowed:false, reason=mode-local-only`；探针已回收（仅 TIME_WAIT）、你的 51517 实例未被触碰 |
| 同步一致性 | ✅ `release/YFWorking/server/{egress-policy.cjs, egress-policy.mjs, bridge.mjs}` md5 逐一一致；本轮无渲染层改动，`dist/` 无需重建 |

**一处需记住的坑**：Bash 里验证 curl 时把令牌写成 `-H "x-yfw-bridge-token: ***"` 字面量会被工具层处理掉 → 必须**先定义 shell 变量再引用**（`TOK='...'; curl -H "x-yfw-bridge-token: $TOK"`），否则得到的是 401 假红。
