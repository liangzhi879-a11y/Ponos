# 实施计划：会话知识范围（Session Knowledge Scope）

Spec：`docs/superpowers/specs/2026-09-15-session-knowledge-scope-design.md`
来源任务：`docs/待处理清单.md` → `P1 会话模式关联经验库之外的知识库`

## 执行纪律

- 每任务落地后立即跑该任务的**验证命令**；红则修，不带着红往下走。
- 零回归锁：`kernel-tests/knowledge*.test.mjs`（296 项）在 T6 前后各跑一次，比对数量与结果。
- 命名/风格沿用现有实现：`why` 注释写"为什么这么定"，不写"做了什么"。

## 任务

### T1 内核：范围解析（纯函数，先写测试）

- `kernel/knowledge.mjs` 新增 `resolveSessionKnowledgeScope({ configDir, requested })`（§3.2）。
- 复用同文件 `discoverSpaces()`；新增常量 `MAX_ASSOC_SPACES = 8`、`LARGE_SPACE_DOCS = 1000`。
- **验证**：`node --test kernel-tests/knowledge-session-scope.test.mjs`（T9 建）
  —— 缺省只含 experience/session-memory；关联生效；不存在 id 进 missing；超 8 个进 dropped。

### T2 内核：CLI 参数与注入接线

- `kernel/cli.mjs:108` 附近登记 `knowledgeSpaces: null`；`:175` 风格加 `case '--knowledge-spaces'`（数组化，逗号分隔）。
- 注入段（`:826`）先解析 scope，再 `buildKnowledgeInjection({ ..., spaces: scope.spaces })`。
- `wire.system('init', ...)`（`:875`）增 `knowledge_spaces: scope.spaces`。
- **验证**：`node --test kernel-tests/knowledge-session-spaces.test.mjs`（真进程，T9 建）
  —— init 帧含 `knowledge_spaces`，且传参时不缺项。

### T3 内核：工具层范围（可调用性的反面）

- `kernel/tools.mjs:1079` `createToolRegistry` 增参 `knowledgeSpaces = null`。
- 新增闭包 helper `scopedSpaces(requested)`：`null` 范围 → 原样返回；否则求交，空交 → `{ deny: 文案 }`。
- `KnowledgeSearch.run`（:1471）与 `MemorySearch.run`（:1385）接上；越界文案按 §3.4 统一。
- **验证**：`node --test kernel-tests/knowledge-session-spaces.test.mjs` 中"工具越界"用例 +
  `kernel-tests/knowledge-search.test.mjs` 零回归。

### T4 engine 转发 + cli 传参

- `kernel/engine.mjs:785` 增 `knowledgeSpaces: opts.knowledgeSpaces || null`。
- `kernel/cli.mjs` 的 engine opts（:640 附近）传 `knowledgeSpaces: scope.spaces`。
- **验证**：`node --test kernel-tests/knowledge-session-spaces.test.mjs`（工具不可用的反例要真的被拒）。

### T5 提示词：让可调用性对模型可见

- `kernel/prompt.mjs:156` 增入参 `knowledgeScope = null`；在 `:219` 之前渲染 §3.5 区块。
- `kernel/cli.mjs` 组装 `knowledgeScope`（含"未关联但存在"的库名）。
- **验证**：真进程 `PONOS_MOCK_SYS_PROBE` 探针（针脚 = `【本会话知识库】`）命中/不命中两态。

### T6 膨胀护栏 + 观测

- `kernel/knowledge-inject.mjs`：`renderRecall` 加每空间配额 `MAX_RECALL_PER_SPACE = 4`；
  stats 增 `spacesRequested` / `spacesDropped` / `spacesCapped`。
- **验证**：`node --test kernel-tests/knowledge-inject.test.mjs`（既有断言）+ 新用例；
  前后各跑一次 `kernel-tests/knowledge*.test.mjs` 比对。

### T7 桥与前端透传

- `server/bridge.mjs`：`getOrCreateSession(..., knowledgeSpaces = null)`；`args.push('--knowledge-spaces', ...)`；
  范围签名 `_spawnKnowledgeSig` + 变更时 reap（复用 :1134 的模型热切换分支）。
- `src/hooks/useYFWCLI.ts:343` 透传；`src/types/index.ts:141` 加字段；`src/stores/chatStore.ts` version 3→4 + migrate。
- **验证**：`node --test server/bridge-args.test.mjs`（静态守卫：参数名两端同现）+ `src/stores/chatStore.test.ts`。

### T8 GUI 入口

- `KnowledgeSidebar`：空间信息栏加「关联到当前会话」开关 + 大库提示（G4）。
- `SessionModeBar`：已关联时 `📚 N` 徽标。
- i18n：`src/i18n/translations/zh-CN.ts` / `en-US.ts` 增键。
- **验证**：`npm run typecheck` + `npm run build`（TS 编译 + 打包通过）。

### T9 测试补齐

- 新增 `kernel-tests/knowledge-session-scope.test.mjs`（纯函数）。
- 新增 `kernel-tests/knowledge-session-spaces.test.mjs`（真进程：范围内可调用 / 范围外被拒 / 提示词可见性）。
- 新增 `server/bridge-args.test.mjs`（静态守卫，防漏登记）。
- **验证**：逐个跑通 + 全量知识用例零回归。

### T10 收尾

- 待处理清单勾选（DoD 证据齐全才勾）。
- 系统整体审查：`npm run typecheck` + 知识用例 + server 用例 + `src` 用例。
- 输出本轮摘要（任务/结果/证据/清单变更/下一轮建议）。
