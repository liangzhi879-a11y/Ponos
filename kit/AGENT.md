# kit/AGENT.md —— agent 入口（**读这份就够**）

> ★ **本文件不承载清单内容**，只给指针：完整的四段条目 + 四条断言与基线纪律 + CI 锚点以
> `node kit/gui.mjs --agent` 的输出为准。**单一真源 = `kit/lib/agent-guide.mjs`**（纯数据，可 JSON 序列化），
> 渲染层 `renderAgentGuideText()` 与 GUI 第 8 段视图消费的是同一份对象。
> 为什么刻意不把清单抄在这里：两个出口（终端文本 / GUI 视图）若各留一份副本，迟早漂移，
> 而"agent 读的规范"与"人看到的规范"不一致是最坏的一种漂移。human 视图见仓库根的 `kit-report.html`
> （`npm run kit:gui` 生成，**产物不入仓**）。

## 单一真源一览（改前先认清"改的是真源还是副本"）

| 概念 | 单一真源 | 副本 / 消费方（**别手改**） |
|---|---|---|
| 版本线 / 契约快照 | `kit/manifest/versions.json`（`npm run kit:sync` 重写事实字段） | `kit-report.html`、`kit-stamp.json` |
| 依赖 / 内嵌 Python / 体积 | `kit/manifest/deps.json` | `docs/ci.md` 的计数 |
| 契约面 ↔ 文档 | `docs/bridge-contract.md` §5/§6/§7/§7.1/§11/§12 + `kit/manifest/contract-scope.json` | 台账 `#channels`（快照） |
| **品牌名称 / 标识** | **`kit/manifest/brand.json`（改它 = 重新定义，CT10 把关；`node scripts/brand.mjs show\|check\|set`）** | `version.mjs` 的两行注释、`versions.json` 的 `lines[].label` 由 `set`/sync 同步；`productName`/`<title>`/npm 包名/appId 要**手工**改（`set` 会列清单 + 给建议值） |
| agent 套件规范 | `kit/lib/agent-guide.mjs` | 本文件（只给指针）、GUI 第 8 段 |

## 开工前（3 步）

1. 读 `kit/README.md` 的「契约快照与范围登记」（含 **committed 口径**）与「规则表」（`CT0`–`CT10`）。
2. 先跑 `npm run kit:check` 拿**基线**红灯/黄灯（本仓现状：红 0 / 黄 5 / 基线 5）——避免把存量问题当自己造的。
3. `git worktree list` 确认并行工作线（本仓常态 4+ 条）；**绝不** `git add -A`（本仓常态约 40 项他人在途改动）。

## 改契约面（路由 / WS / IPC / 工具 schema / 台账 / 版本线）时

1. **先提交，再 `npm run kit:sync`**（台账按提交态落盘；在途差异不入账），然后单独提交台账变化。
2. `channels` 的差异（`routes`/`wsOut`/`wsIn`/`tools`）要**人确认**——快照变了就是契约真变了。
3. `docs/bridge-contract.md` 的 §7/§7.1 + §5/§6（WS **按方向**）+ §11 + §12 与实现同步，否则提交后 `CT2`/`CT3` 红。
4. 该文档**不许** `git add <path>`（他人在途改动多）⇒ 走 `kit/README.md` 的**局部暂存**流程，提交后把工作树补回同步。
5. 改工具指纹口径：`shapeOfNode` → `contract-tools.test.mjs` 的两份关键字名单 → `kit:sync` → `node kit/sync-fingerprints.mjs <in> <out>`。

## 交付前（缺一不可）

1. `npm run kit:check` ⇒ **红 0**（EXIT=0）。
2. `node --test --test-timeout=120000 "kit/**/*.test.mjs"` ⇒ 全绿（★ glob **必须加引号**，否则漏 `kit/cli.test.mjs`）。
3. `npm run verify:ci` ⇒ EXIT=0。
4. `node scripts/check-doc-anchors.mjs` ⇒ EXIT=0（新增测试文件先 `git add`，再 `npm run anchors:write`）。
5. 动了端点/工具面 ⇒ **盘根**干净克隆复算 `routes`/`wsOut`/`wsIn`/`tools` 数与基线比，并自证 `import nanoid` 失败。

## 红灯怎么修

- `CT1` 快照 ↔ 代码：跑 `npm run kit:sync`（先提交）。
- `CT2` 文档缺声明：补 `docs/bridge-contract.md` §7/§7.1/§11/§12 + §5/§6，**或**登记 scope。
- `CT3` 文档 ↔ 快照：文档与实现同步；★ method 是**逐个判**的，写了方法就得有相容的代码键。
- `CT4`/`CT4B`/`CT4C` 范围登记：`members` 逐条精确、禁通配、每条写 `reason`，新增范围同时上调封顶值。
- `CT6` 快照 ↔ 运行时：现场重算（`toolSchemas()` 出口 / 静态计数 / 结构指纹）。
- `CT8` 在途差异：**黄灯只报不拦**，提交后自己变空——**不要**为它加基线。
- `CT9` 基线：必须仍是 5 条且全 `CT9`（动它等于伪造门禁）。
- `CT10` 品牌声明点：跑 `node scripts/brand.mjs check`（读工作树）看哪条没跟上真源
  （`kit/manifest/brand.json`）；要**重新定义**品牌走 `node scripts/brand.mjs set <layer> <name>`。

## 四条断言与基线纪律（★ 与 README 的「四条铁律」是**两份**不同清单）

1. **不许放宽断言**（删断言 / 精确改包含 / 用实际值当期望值 = 拆门禁）。
2. **不许恒真断言**（`assert.ok(true)`、恒真式、拿实现算出的值当期望）。
3. **不许 `|| true` 吞错**（CI 步骤不许 `continue-on-error` / `; exit 0` 把红变绿）。
4. **不许靠加基线让红变绿**（`drift-baseline.json` 每条写 reason + 摘除条件、条目数不得增加；
   契约对账类 `CT0`–`CT8` 与品牌 `CT10` **不支持**基线豁免，只有 `CT9` 的历史欠账可登记）。

## CI 锚点

`.github/workflows/ci.yml:72` → `npm run kit:check`（**单独一步**，归因用：台账漂移 ≠ 测试挂了；
`npm run test:ci` 链路里也含它，本地一条命令可跑全）。行号由 `kit/lib/gui-data.test.mjs` 对着 ci.yml 复核。

> 完整清单以 `node kit/gui.mjs --agent` 为准（单一真源 `kit/lib/agent-guide.mjs`）；GUI 视图见 `kit-report.html`。
