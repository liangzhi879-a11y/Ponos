# CI 与测试分层

本文件说明仓库的持续集成怎么跑、为什么这么配，以及踩过的坑。配置本体在 `.github/workflows/ci.yml`。

## 一句话总览

```
npm run verify   # = typecheck + test:ci（本地推之前跑这个）
npm run test:ci  # = 预检 → 文档口径 → 单测层 → server 层 → 内核层
```

| 命令 | 内容 | 本机实测 |
|---|---|---|
| `npm run test:preflight` | 预检：Node 版本、测试 glob 必须匹配到文件、端口占用风险 | <1s |
| `node scripts/check-doc-anchors.mjs` | 文档口径（路径存在性 + 各层测试文件数） | <1s |
| `npm run test:unit` | `shared` + `electron` + `src` 三层 | 1041 项 / 23s |
| `npm run test:server` | `server` 层（含起桥的端到端测试） | 694 项 / 91s |
| `npm run test:kernel` | `kernel-tests` 层 | 1943 项 / 48s |
| `npm run typecheck` | `tsc --noEmit` | 16s |

合计 **3678 项断言 / 约 3 分钟**（本机 8 核）。CI 为 2 核 Windows 运行器，实耗会更长，作业超时设 30 分钟。

## 两个刻意的环境决策

**1）`runs-on: windows-latest`（不用 ubuntu）**
本仓库是 Windows 桌面应用，测试含平台特定断言：`C:\…` 字面路径、盘符枚举、`sep` 分支、`taskkill`/PowerShell 探测、预览页 `file://` 帧语义等。跑 Linux 会产生一批**与被测行为无关**的失败（更糟的是静默跳过），门禁随即失去意义——"CI 绿"必须等价于"这台机器上绿"。

**2）`ELECTRON_SKIP_BINARY_DOWNLOAD=1`**
测试只 `require` 或 stub electron 模块，**没有一处 spawn 真二进制**（已核查）。不下载 ~100MB 二进制可显著缩短安装，并避免网络受限时的假失败。

## 为什么要有 `test:preflight`

`node --test <glob>` 在某条 glob **匹配不到任何文件**时**不报错、直接 0 退出**——CI 会显示绿灯而实际一个测试都没跑。这是测试基建最经典的静默失败：门禁看起来在，其实不在。预检把它变成硬失败，并顺带校验各层文件数与 `docs/_anchors.json` 一致（抓"glob 写错导致整层静默消失"）。

预检还检查 **51517 端口是否被占用**（即本应用是否正在运行）。原因见下节。

## ⚠️ 本地跑测试可能杀掉你正在用的应用

`server/bridge.mjs` 监听固定端口 51517；它遇到 `EADDRINUSE` 时会**自愈式 `taskkill`** 掉命令行含 `yfworking` 或 `bridge.mjs` 的进程——也就是你正在使用的应用本体。

因此**请先关闭应用再跑 `npm run test:server` / `test:ci`**。若确认要带风险运行，加 `--allow-running-app`：

```bash
node scripts/ci-preflight.mjs --allow-running-app
```

好消息：测试自身大多用 `YFW_BRIDGE_PORT` 指定**随机端口**，与应用的 51517 不冲突；风险主要来自默认端口路径。CI 上端口必然空闲（`CI=true` 时预检直接跳过该检查）。

## 并发上限为什么是 4（有实测证据）

把全部测试**合成一次调用**并调高并发会引入**假失败**。实测：

| 并发 | 结果 |
|---|---|
| 4（`server` 层独立跑） | 694/694 通过，91s |
| 8（全部层合成一次调用） | `server/reap-guard.test.mjs` 与 `server/sheet-ops.test.mjs` **失败**（各约 39s） |

这两个测试单独跑均全绿，说明是**资源争抢**（它们会 spawn python / 子进程，并带内部超时），不是真 bug。

由此定下两条：**① 各层作为独立进程串行执行**（`test:ci` 用 `&&` 串起来，而不是把 5 条 glob 塞进一次 `node --test`）——既避开跨层争抢，也让失败归因一眼可辨；**② 层内并发上限 4**。

> 反过来也说明：**不要为了"跑得快"随手调高 `--test-concurrency`**，否则你会开始排查并不存在的 bug。

## 文档口径纳入 CI

文档一旦与代码脱节，读者通常**不会**去核对，于是照着过期内容操作。所以把可客观校验的口径变成断言：

- **门禁 A：各层测试文件数**（防上面说的"整层静默消失"）。数字存在 `docs/_anchors.json`，由 `npm run anchors:write` 重新生成。
- **门禁 B：文档引用的仓库路径是否存在**。扫描 `docs/*.md` 与 `docs/manual/**/*.md` 里反引号包裹的相对路径，断言文件真实存在。

**刻意不门禁**：模块数、总行数、巨石行数——它们每次合法重构都会变，硬卡会逼人每次都重跑 `anchors:write`，最终结果是人把检查绕过或删掉，那还不如一开始就别卡。这些数字仍写进 `docs/_anchors.json` 的 `info` 段供人查看。

**刻意不扫描**：`docs/superpowers/{specs,plans,audits}/**`（设计/计划/审计记录，写的是"当时打算建什么"，且常引用外部参考实现）与 `docs/2026-09-15-五引擎架构性能对比分析.md`（对比**他人**引擎的调研笔记）。把它们纳入会让白名单膨胀到上百条，门禁随之失效。

白名单是**手写的** `docs/_anchors-allow.json`（每条必须写 `reason`），刻意与自动生成的 `_anchors.json` 分开：否则"重新生成"就等于"把所有问题自动放行"，一次 `--write` 就把门禁架空了。

发现缺失路径时的处理顺序：**首选改文档**（多半是文件被改名/移动后忘改）；只有确属真·历史引用（构建产物名、文档在说明"该引用已失效"、刻意构造的负例路径）才进白名单。

### 首次启用时抓到的问题

首次运行即抓出 4 处真实文档腐烂，均已修正：`src/types/index.ts`（原文只写了 types/index.ts）、`src/components/mcp/mcpFormat.ts`（原文仍写 settings 目录）、MCP 配置界面路径随目录整理移动并被拆分、以及一处把个人记忆目录写成仓库相对路径的引用。修正前的旧路径不再复述，以免文档又出现"引用不存在的路径"。

## 更新文档锚点

```bash
npm run anchors:write   # 重新生成 docs/_anchors.json（只在计数确实该变时跑）
```

跑完请**看一眼输出了什么**：若有"未处理"的缺失路径，说明有文档腐烂待修。

## 两条流水线作业

| 作业 | 内容 | 为什么单列 |
|---|---|---|
| `test` | typecheck + `test:ci` | 主要门禁 |
| `build` | `npm run build` + `node scripts/build-kernel.mjs` | **产物可产出本身就是断言**：类型、导入、打包配置坏了时，测试可能全绿，而用户拿到的是坏包 |

`concurrency` 设了按分支取消旧跑批：既省额度，也避免"旧提交的绿灯"被误当成当前状态。
