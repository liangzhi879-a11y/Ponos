# YFWorking 完整切换为 Ponos 自研内核 —— 净室产品库设计

- 日期：2026-09-07
- 状态：设计已确认，待复核
- 范围：yfworking 产品线（v2 GUI）从 Anthropic 派生内核（yfw-kernel/claude-code）完整切换到零依赖自研内核（Ponos-turbo），在新净室库重建产品并退役旧内核依赖

---

## 1. 背景与现状

| 事实 | 说明 |
|---|---|
| 在售产品 | YFWorking（yfworking-gui v2.7.5），运行自 `claude-code-gui\release\YFWorking_ms92cd6u` |
| 当前运行内核 | `~/.yfworking/runtime/kernel/cli.mjs`（21.9MB）——**旧 Anthropic 派生内核**（anthropic 标记 409 处、Ponos 标记 0），bootstrap 自 claude-code-gui 的 `yfw-kernel/claude-code` |
| 自研内核 | ponos-dev 净室仓库的 **Ponos-turbo**：`kernel/`（零 npm 依赖，node≥18），`scripts/build-kernel.mjs` 构建单文件 bundle 到 `kernel-dist/cli.mjs`；内核全量测试基线（约 507） |
| 数据契约 | `YFW_HOME = ~/.yfworking`；内核 transcript 权威源写 `~/.yfworking/projects/<sanitize(cwd)>/<sessionId>.jsonl`，`--resume` 恢复；新旧内核同契约为**数据延续**的支点 |
| 代码线分化 | claude-code-gui（yfworking v2，在售功能最全）；ponos-dev（内核联调最成熟，含 2026-09 协议增强，但掺有 v3 平台内容） |

## 2. 目标

在 `C:\Users\T203-15\yfworking` 以全新 git 历史建立 **yfworking 净室产品库**：自研 v2 产品代码 + **先修复审计缺陷、验证通过后的 Ponos 内核** + 从 ponos-dev 移植的协议增强（仅 server/GUI 侧），形成**可独立运行、可完整调试、与旧版并存不冲突**的新 YFWorking，作为产品新起点。

## 3. 硬性约束

1. **旧库保留**：claude-code-gui 源码与调试程序不删除、不迁移，继续可用；一切破坏性处置前必须逐项征询。
2. **v3 隔离**：ponos-dev 的 v3 平台内容（harness / modules / cockpit 等）不进入新库，本次讨论与其无关。
3. **产品线接续 yfworking（v2）**：产品形态 = v2 GUI，不是 v3。
4. **双版并存**：新旧两版端口与前端运行隔离，可同时运行互不干扰。
5. **内核修复先行**：内核审计缺陷在 ponos-dev 修复并验证，随后整体移植（用户决策）。
6. **完整调试应用**：新库具备完整的本地调试链路（dev 起内核、bundle、测试）。

## 4. 完成定义（DoD）

1. **发行物零专有残留**：新库构建产物/安装包可审计——无 anthropic/claude 专有内核代码；内核测试基线在新库全绿。
2. **在售功能零回归**：浏览器/填表/抓取/文档/表格/打包/宠物/技能/企微等产品主要功能冒烟全通过（新旧两版同用例对照）。
3. （尽量兼容，非强制）会话数据延续：transcript 契约与 `~/.yfworking` 布局兼容，老会话可读可续。

## 5. 总体架构与净室库布局（目标态）

```
C:\Users\T203-15\yfworking\            ← 全新 git 历史（git init -b main），产品新起点
├─ kernel/            ← Ponos 内核源码+测试（S3 从 ponos-dev 拷贝"已修复基线"）
├─ kernel-dist/       ← 内核 bundle 产物（构建脚本产出，供打包）
├─ src/  electron/  server/  pet/      ← 自研产品代码（S3 从 claude-code-gui 拷贝）
├─ build/  scripts/  bin/  public/
├─ docs/              ← 自研文档（bridge-contract 等；superpowers 设计/计划随库入库）
├─ 根配置             ← package.json/lock、electron-builder.yml、vite/ts/tailwind/postcss、index.html、skills-lock.json
├─ .env.example       ← 仅占位无密钥（.env 永不入库）
└─ README / LICENSE   ← 新建，自述完整自主知识产权
```

**内核维护策略**：新库持有内核源码副本（自含可调试、可单测）；内核演进主源暂在 ponos-dev，采用**版本化内核同步**约定（固定基线版本 → 定期搬移 + 在新库跑全量测试），杜绝双源漂移。

## 6. 子工程切分与顺序

| 子工程 | 执行位置 | 产出 / 验收门 |
|---|---|---|
| **S1 差异盘点审计**（只读先行） | 只读扫描 | 清单①：claude-code-gui↔ponos-dev 的 GUI/server/electron 差异表；清单②：需移植的协议增强候选（逐项标 影响面/依赖/建议）；清单③：旧内核与专有标识的全部残留引用点 + v3 排除边界文件集 |
| **S2 内核缺陷修复**（先行，可与 S1 并行） | ponos-dev/kernel | 审计 #1-#11 按优先级修复；补回归测试；内核测试基线全绿、门禁可靠（含 #7 守卫测试补回、#11 flaky 治理）。**S3 等待本子工程的修复后基线** |
| **S3 净室库落成** | yfworking 新库 | 自研代码 + 已修复内核 + 配置迁入（拷贝不移动）；git init 全新历史；`npm ci → typecheck → vite build → npm test` 对齐旧库基线 |
| **S4 内核接线与双版隔离** | yfworking 新库 | bridge 内核解析/构建/bundle/bootstrap 全指向本库内核（删 yfw-kernel 分支与旧兜底）；隔离矩阵落地；dev 双版并行冒烟跑通 |
| **S5 协议增强移植** | yfworking 新库 | 按 S1 清单②逐项移植（代码+配套测试）；2026-09 特性（审批门接线、压缩可见化、技能清单去重等）进入新产品，不携带 v3 UI |
| **S6 打包与验收** | yfworking 新库 | YFWorking 品牌安装包；零残留四层审计；在售功能冒烟矩阵；双版并存运行验证；DoD 全项 |

依赖关系：S1/S2 并行 → S3（需 S2 基线）→ S4 → S5（需 S1 清单②）→ S6。

## 7. 迁移清单（S3 用，拷贝不移动）

### 迁入
| 来源 | 内容 |
|---|---|
| claude-code-gui | `src/`、`electron/`、`server/`、`pet/`、`build/`、`scripts/`、`bin/`、`public/`、`docs/`（自研，筛除指向旧内核的过时内容）、根配置（package.json/lock、electron-builder.yml、vite/ts/tailwind/postcss、index.html、skills-lock.json）、BUILD.md 等自研文档 |
| ponos-dev | `kernel/`（**S2 修复后基线**）、内核构建脚本、内核测试与配置文档 |

### 排除（合规隔离）
- `yfw-kernel/`（Anthropic 专有泄漏副本）——绝对不迁
- `node_modules/`、`release/`、`dist/`、`.env`（密钥）、调试临时目录、运行时二进制（node.exe/bun.exe 等；内核零依赖 node≥18 即可跑，运行时方案 S4 敲定）
- ponos-dev 的 v3 平台目录；任何指向旧内核路径的兜底分支

## 8. 隔离矩阵（双版并存）

| 资源 | 旧版基准 | 新版目标 | 机制 |
|---|---|---|---|
| bridge WS 端口 | `YFW_BRIDGE_PORT` 默认 51309 | 独立默认端口 | 环境变量覆盖（S4 定值） |
| vite dev / preview | 5173 / 4173 | 不同端口 | vite.config 环境变量 |
| Electron CDP / 调试口 | 52319（及工具链 9223） | 不同口 | 环境变量 |
| App 身份 / userData | 现 YFWorking | 独立应用标识 | electron-builder appId/productName 区分 |
| 内核运行时落地 | `~/.yfworking/runtime/kernel` | 新版专用目录 | bridge bootstrap 目标常量独立 |
| 数据 / 会话转录 | `~/.yfworking/projects/...` | 默认独立数据根（可环境变量切回旧 home 读老会话） | `YFW_HOME` 覆盖 |
| 技能 / 经验目录 | `~/.yfworking/skills`、`memory` | **共享只读沿用**（不拷贝不冲突） | 内核 `--add-dir` 技能根指向 |

原则：可写且互踩的资源全部隔离；只读资源共享。

## 9. 内核接线（S4 四条主链）

1. **dev**：bridge 内核解析顺序全指向本库 `kernel/`（源）或 `kernel-dist/cli.mjs`；删除 yfw-kernel 分支与旧兜底；`PONOS_KERNEL` 覆盖保留作调试逃生口。
2. **构建**：`scripts/build-kernel.mjs` 在本库产出 `kernel-dist/cli.mjs`。
3. **bootstrap**：主进程把内核拷到新版专用运行时目录（不与旧 `~/.yfworking/runtime/kernel` 互覆）。
4. **打包**：electron-builder 将 `kernel-dist` 打入 `resources/app`，仅指向新内核。

## 10. 移植方法（S5）

- 移植单元 = 代码改动 + 配套测试，沿用"测试权威"惯例（基线内先有/先跑测试再改实现）。
- 随 `kernel/` 整体迁入的内核侧能力（审批门内核部分、守卫自愈、CJK 估算等）**不重复移植**；仅移植 server/GUI 侧接线与 UI。
- 以 S1 清单②为准，不携带 v3 平台 UI。

## 11. 验收与零残留审计（S6）

1. **功能冒烟矩阵**：在售功能逐项跑通；新旧两版并行开、同用例对照。
2. **零残留四层审计**：
   - 代码面：全库 grep 不命中专有内核路径/标识（仅允许协议字段名与许可证文本）；
   - 产物面：安装包内 cli.mjs 标记探测——ponos 标记>0 且 anthropic 标记=0（对照旧内核 21.9MB / 409 命中）；
   - 依赖面：内核零 npm 依赖（沿用 deploy-smoke 断言）；
   - 测试面：内核基线 + 产品基线全绿。
3. **双版并存验证**：同时启动新旧两版，端口/数据根/内核落地目录互不干扰，各完成一轮真实对话。

## 12. 内核审计缺陷修复清单（S2 输入，来自外部审计）

> 文件行号以 ponos-dev/kernel 审计时点为准；修复时必须用测试锁定再改实现。

### P0 — 正确性缺陷
1. **子 Agent 循环缺 stop_reason 处理**（engine.mjs runSubAgentLoop 约 978 行）：子 lane 不消费 stop_reason，主循环的"length 截断拒执残缺 tool_use"保护在子 lane 失效 → 补 stop_reason 消费 + P0-2 同款截断拒执。
2. **压缩摘要请求不做孤儿 tool_use 补丁**（compact.mjs assembleSummaryRequest/runSummarizer 约 244/309）：摘要请求直接用 covered 消息，resume 后 covered 区间若含孤儿 tool_use → 400 → 压缩失败 → 溢出兜底同步失败 → 整轮死于 overflow-compact-failed → 摘要请求前过 patchOrphanToolUses。
3. **health chainDepth 用累计值而非增量**（health.mjs:73）：`compactCount` 是会话累计值，任意一次压缩后 10 轮内血条恒红 + suggestNewSession → 改为统计窗口内压缩的**增量**次数；补跨多轮测试。

### P1 — 健壮性缺口
4. **子 lane 缺失败熔断（守卫④）**：对齐主循环 errorStreak/MAX_ERROR_ITERATIONS。
5. **子 lane 缺上下文溢出（400）自愈**：对齐主循环 forceCompact + 输出预算收窄双路自愈。
6. **审批挂起无超时**（engine.mjs:866）：审批等待加超时（对齐浏览器挂起 120s 风格），超时降级/显式失败，防 GUI 静默崩溃后轮次永久挂起。
7. **loop 守卫零测试覆盖**：把 engine-guard 系列回归测试补回 release（守卫①墙钟/②迭代上限/③生成重复/③b 句级近重复/④熔断/⑤同工具提醒/空闲看门狗/R3-2 自愈+计划尾），防止误伤漏判无感知。

### P2 — 次要 / 已知取舍
8. **子 lane 摘要混入 thinking**：与主循环一致，只累加 text。
9. **流重连文本重复**：审计已注明"接受"的已知取舍，维持现状并在代码注释/文档明示（可选：engine 层半截文本处理改进，评估后再定）。
10. **子 lane 缺 R3-2 与⑤同工具提醒**：评估移植成本后决定。
11. **全量测试套件 flaky**（非 agent loop 缺陷但影响门禁）：bridge/spawn 类测试并行 collect timeout（~5s）→ 治理（提升收集超时 / 分片执行 / 隔离 spawn 类测试），保证全量门禁可靠。

### 建议修复顺序（S2 内）
#1 → #3 → #2 → #7 → #4/#5/#6 → P2（#8 先；#9/#10/#11 按取舍）。

## 13. 风险与开放项

| 项 | 说明 | 处理 |
|---|---|---|
| S1 盘点工作量 | 两线 GUI/server 差异可能大 | 先目录级 diff 聚焦"产品功能归属"，避免文件级深挖无底洞 |
| 协议契约偏差 | 新内核与产品 server 的协议增量 | 由 S1 清单③ + S4 接线测试兜住 |
| 双版并存细节 | 端口/userData 全量清单 | S4 前以隔离矩阵为纲逐项落地，并用实测验证 |
| 运行时二进制 | bun/node 随包方式未定 | S4 敲定（内核零依赖，倾向打包内 node 或系统 node） |
| 数据延续 | 不在 DoD 但尽量兼容 | S4 保留 `YFW_HOME` 覆盖机制，老会话可读 |
| 旧库/旧产物处置 | 退役 yfw-kernel 属破坏性操作 | 全部逐项征询后执行，本次设计不预设 |
| 审计行号漂移 | S2 修复前代码可能已变 | 以测试先锁行为，再对照行号定位 |
