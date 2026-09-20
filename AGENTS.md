# AGENTS.md —— 所有在本仓执行开发工作的 agent 的**入口**

> 本文件是**自动注入入口**：多数 agent 工具（Cursor / Windsurf / Codex / Cline 等）会在开工时自动读取仓库根
> 的 `AGENTS.md`，因此**规范不必靠 agent 自觉去找**。内容刻意**极短**——只有入口与硬规矩；
> **完整清单不写在这里**，唯一真源是 `kit/lib/agent-guide.mjs`（避免"同一份规则抄两遍"必然漂移）。

## 本仓有契约门禁（DevKit）

本仓用 `kit/` 做**契约快照门禁**：路由 / WS / IPC / 工具 schema / 台账 / 版本线一旦与合同文档
（`docs/bridge-contract.md`）或快照（`kit/manifest/versions.json`）不一致，`npm run kit:check` 就会**红**，
CI（`.github/workflows/ci.yml`）会拦。**任何改动契约面的开发都必须按套件规范执行。**

## 开工前必做（两条）

1. **读规范**：`npm run kit:agent`（打印完整清单的纯文本；真源 `kit/lib/agent-guide.mjs`），或读 `kit/AGENT.md`。
2. **先拿基线**：`npm run kit:check` —— 本仓常有 4+ 条并行工作线，红/黄未必是你造的。

## 交付前必做（一条都不能省）

```bash
npm run kit:check                                      # 红 0（EXIT=0）
node --test --test-timeout=120000 "kit/**/*.test.mjs"   # 全绿；★ 引号必须有
npm run verify:ci                                      # EXIT=0
```

★ **引号不是风格问题**：不加引号时 shell 把 `**` 当单个 `*` ⇒ 只跑 `kit/lib/*.test.mjs`，
**静默漏掉** `kit/cli.test.mjs` 与 `kit/gui.test.mjs`（照样打印"全绿"）。

## 四条断言与基线纪律（红线，别越）

1. **不许放宽断言**（删断言、把"精确相等"改成"包含"、把期望值改成实际值 = 拆门禁）。
2. **不许恒真断言**（`assert.ok(true)`、"用实现算出的值当期望值" = 做假）。
3. **不许 `|| true` 吞错**（CI 不许 `continue-on-error` / `|| true` / `; exit 0` 把红变绿）。
4. **不许靠加基线让红变绿**（`drift-baseline.json` 只放真实的已知差异；契约对账类 CT0–CT8 不支持豁免）。

> ★ 这四条与 `kit/README.md` 里那套「**四条铁律**」（sync 字段 / 放行可见 / 扫描域=`git ls-files` /
> 真仓数字口径）是**两份不同清单**，**并行生效**。别把"铁律 4"当成同一个东西。

## 别踩的坑（本仓实测）

- **不许 `git add -A`**：常态**数十项**他人在途改动（`server/`、`src/` 等），要按文件精确暂存。
- **`docs/bridge-contract.md` 不许 `git add <path>`**（会夹带他人在途改动）⇒ 走局部暂存流程（见 `kit/README.md`）。
- **改动契约面后先提交再 `npm run kit:sync`**：台账按**提交态**生成，未提交的改动不入账。
- **改动 `docs/bridge-contract.md` 的 §7/§7.1/§12 必须与实现同步**，否则 `CT3` 红。
- **`CT9` 基线必须保持 5 条且全 `CT9`** —— 动它等于伪造门禁。
- **想看门禁全貌**：`npm run kit:gui` → 生成 `kit-report.html`（自包含单文件，`file://` 打开；
  八段：概览 / 红灯与黄灯 / 规则矩阵 / 台账 / 依赖域 / 版本控制 / 品牌标识与名称 / Agent 套件规范）。

## 单一真源一览（缺了就是漂移）

| 内容 | 真源 |
|---|---|
| agent 规范清单 | `kit/lib/agent-guide.mjs`（`npm run kit:agent`） |
| 契约快照 | `kit/manifest/versions.json`（`npm run kit:sync` 生成，concierge 人工确认） |
| 「只报不拦」规则集 | `kit/lib/report.mjs#NON_BLOCKING_RULES` |
| 版本线台账 | `kit/manifest/versions.json#lines`（推进用 `node scripts/bump-version.mjs`） |
| 版本快照/回退 | 归 `docs/superpowers/specs/2026-09-15-version-manager-design.md` 的 version-manager 工作线（**不在本 GUI 内**） |
| 品牌名称/标识 | `kit/manifest/brand.json`（改它 = **重新定义品牌**；`node scripts/brand.mjs show\|check\|set <layer> <name>`；一致性由 **CT10** 把关，**不可基线豁免**） |

<!-- 维护约定：本文件只放"入口 + 红线 + 坑"。完整清单改 kit/lib/agent-guide.mjs；若要加规则，加在真源里。 -->
