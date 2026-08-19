# 全栈运行效率优化设计（渐进三批次）

日期：2026-08-14
状态：已批准（头脑风暴阶段）
参考：deepseek-harness（DeepSeek AI 开源 agent harness，插件化微内核 + compaction/jobs/schedule/subprocess/session 持久化 capability seam）

## 1. 背景与目标

claude-code-gui（YFWorking 桌面应用：Electron + React + TS + Vite + Zustand，WebSocket bridge.mjs ↔ CLI 内核 yfw-kernel/claude-code，附带 python 桌面宠物）存在四类运行效率问题：

| 维度 | 现状 | 痛点 |
|---|---|---|
| 响应延迟 | 每次任务 spawn 新 CLI 进程 + `--resume` 全量恢复；resume 时重复注入技能清单 | 首 token 慢、长任务启动开销 |
| token 成本 | `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 默认 1M；resume 重复注入完整技能清单 | 长会话 token 膨胀、费用高 |
| 界面卡顿 | 消息全量渲染、历史 markdown 反复解析、流式 token 每 token 触发重渲染 | 大会话滚动/流式卡顿 |
| 资源占用 | localStorage 全量 JSON 会话、启动全量加载 | 启动慢、内存占用高 |

目标：在不降低 agent 功能与运行效果（"不打折"红线）的前提下，系统性提升四维效率。收益/成本比最高优先，渐进式分三批次落地，每批独立构建、同步副本、用户验收后进入下一批。

## 2. 原则（红线）

1. **agent 功能/运行效果零打折**：任何可能影响模型决策质量或用户可见功能的改动，一律默认保守、提供配置开关、可一键回退。若某项优化经验证会降低输出质量，宁可不做。
2. **纯 JS 依赖优先**：当前 49 个生产依赖全部为纯 JS（无原生模块）。新增依赖须保持纯 JS（如虚拟化选 `@tanstack/react-virtual`），避免 electron-builder 原生模块打包问题（已知 NSIS 打包有坑，见记忆）。
3. **每批独立验证**：每批完成 → tsc/vite build 通过 → 同步调试版副本（YFDesigningDebug）→ 用户验收 → 再进下一批。
4. **改动边界**：全栈可改（前端、bridge、electron、内核源码与 bundle）。

## 3. 已排除/已完成项

- 技能清单扫描缓存：bridge.mjs `skillDirFingerprint` + `appendSkillList` 段落缓存（660-684 行）已实现，不再重复建设。
- 前端会话存储裁剪：chatStore persist 已 `slice(-100)`，不再改动持久化上限（虚拟化批次处理大列表渲染本身）。

## 4. 批次 1：前端渲染层（界面卡顿）

### 4.1 消息列表虚拟化

- 引入 `@tanstack/react-virtual`（纯 JS）。
- 仅渲染可视区消息 + 前后 overscan；保留全部既有交互能力：
  - 搜索/跳转定位（`scrollToIndex` + 滚动行为配置）
  - 消息选中/复制、附件、markdown 渲染、提问卡片、里程碑标记等既有渲染逻辑不变
- 数据模型不变（chatStore 消息数组原样传入），只换渲染容器。
- 边界情况：消息高度动态（markdown 长度不一）→ 使用 `estimateSize` + 动态测量；折叠长代码块不影响测量。

### 4.2 markdown AST 缓存

- 历史消息（非流式更新中）的 react-markdown 解析结果按 `content` 键缓存（模块级 Map + LRU 上限，如 200 条），避免滚动/重渲染时反复解析。
- 流式更新中的当前消息不做缓存（内容实时变化）；结束后写入缓存。
- 缓存失效：内容变化即键变化，天然失效；无其他依赖。
- 主题相关渲染若存在（代码块高亮配色），缓存键加 theme 前缀。

### 4.3 流式 token 批处理渲染

- `useYFWCLI.ts` 收到的 token 流事件：改为 rAF（requestAnimationFrame）按帧批量 flush（16ms 合并窗口），避免每 token 触发 setState → 全消息重渲染。
- `MessageBubble` 等消息组件 `React.memo` 化，配合 Zustand selector 精确订阅，减少无关重渲染。
- 保证不丢 token：flush 前队列非空则保底一次同步兜底（如页面隐藏/切走时 rAF 暂停，用 `visibilitychange` 补 flush）。

## 5. 批次 2：bridge 链路层（响应延迟）

### 5.1 spawn 开销最小化

- 逐项核对 `getOrCreateSession` 注入的 spawn env（如 CLAUDE_CODE_AUTO_COMPACT_WINDOW 等），确认每一项必要性，去除冗余项。
- `--resume` 路径：核对 resumePromptFile 注入内容，避免重复拼接与无关内容加载。

### 5.2 resume 技能清单精简注入

- 新会话：注入完整技能清单（现状不变）。
- resume 会话：注入精简版（技能 id + 一句触发词），省 token；**默认开启精简，配置开关可回退全量**（红线保险）。
- 精简版仍保证模型能列出可用技能并调用（技能名唯一可定位，SKILL.md 路径由前端 fetchSkills 提供，与现有 buildSkillPrompt 一致）。

### 5.3 首 token 计时探针

- bridge 记录每次 spawn → 首个 output 事件耗时，输出到日志（`[bridge] first-token <ms>`），供批次验证量化对比。

## 6. 批次 3：内核 token 成本层（token 成本）

### 6.1 工具结果修剪（对标 deepseek-harness compaction-tool-result-pruner）

- 仅对超长冗余工具输出（如大文件读取全文、超长命令输出）做截断 + 摘要提示（"已截断，前 N 字符，末尾 M 字符，可针对片段追问"）。
- 截断阈值初始值 20000 字符、前后保留各 4000 字符，均通过配置项可调；默认极保守；可整体关闭（等于现状，零风险）。
- 不触碰：对话消息、思考内容、用户指令、技能定义。
- 内核 patch 位置：yfw-kernel/claude-code 工具结果注入路径（源码修改 + `scripts/build-bundle.ts` 重新 bundle + 同步两份 cli.mjs）。

### 6.2 压缩窗口校准

- 先加探针统计长会话实际上下文利用率（每次请求 token 用量），再评估 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 下调空间。
- 唯一标准：不降输出质量。不达标就不调（宁可不做也不打折）。

## 7. 验证方式（每批）

| 批次 | 验证方法 |
|---|---|
| 1 | 万级消息会话滚动帧率（devtools performance）、流式期间 UI 交互响应；原有交互逐项回归 |
| 2 | spawn→首 token 耗时对比日志；resume token 用量对比（精简 vs 全量） |
| 3 | 同任务修修剪前后输出质量人工比对；token 用量对比（usage 探针） |

每批：`tsc && vite build` 通过 → 同步 YFDesigningDebug 副本（dist/electron/server）→ 用户验收。

## 8. 部署与回滚

- 每批改动独立提交，commit message 标注批次。
- 回滚：配置开关优先（如 resume 精简、工具修剪均可一键关闭）；结构性改动（虚拟化）通过 git revert 回退该批 commit。
- 同步目标：YFDesigningDebug 调试版副本（桌面快捷方式指向）；如涉及内核需同时 patch 两份 cli.mjs（release 与调试版），重启需用户确认。

## 9. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 虚拟化破坏既有交互（搜索跳转/复制/附件） | 批次 1 专项回归清单；数据模型不动；可 revert |
| resume 精简清单导致模型"忘记"技能 | 默认保留技能名+触发词定位；配置开关一键回退全量；验收时专项测试技能调用 |
| 工具结果修剪降低模型判断质量 | 极保守阈值 + 可关闭；人工比对验收不通过即回退 |
| 内核 bundle 重建引入回归 | 每批同步两份 cli.mjs 前先本地 `tsc`/单测；验收后再推广 |
