# 驾驶舱重构设计（2026-08-31）

> 承接 `2026-08-31-frontend-upgrade-design.md`（前端整体升级：登录 → 驾驶舱 → 工作台）。
> 本文聚焦驾驶舱自身的改造：数据链路修复 + 信息架构重构 + 可视化/品牌视觉升级。

## 1. 背景与问题

驾驶舱（`src/components/cockpit/CockpitView.tsx`）当前为 2×2 统计数字卡片 + SVG 连线，
用户反馈四个问题：

1. **信息太少**：只有 4 个数字卡，缺少实质内容（最近会话、运行中任务、趋势）。
2. **token 统计不显示**（一直是 0/空）——数据链路缺陷。
3. **可视化程度低**：图表/图谱少，藏在 Token 面板里，驾驶舱本身没有。
4. **视觉素**：布局单调、缺层次感与品牌感。

## 2. 根因分析（token 显示 0）

已定位三个数据链路缺陷：

| # | 缺陷 | 位置 | 影响 |
|---|------|------|------|
| 1 | `recordUsage` 定义了但**无调用点** | `src/stores/tokenStatsStore.ts:81` | 新会话 token 从不实时累加 |
| 2 | 回填走逐会话 `backfillConversation`，限 3 个 transcript、bridge 未就绪静默失败 | `tokenStatsStore.ts:92-113` | 历史数据常为 0 |
| 3 | bridge 已有现成聚合端点 `/transcript/stats`（全量 totals/byDate/byModel/cost_usd/cacheRate），前端未使用 | `server/bridge.mjs:1568-1592` | 重复低效实现，数据不可靠 |

## 3. 改造范围（用户确认）

**驾驶舱 + 数据链路**。不改：bridge 端点（复用 `/transcript/stats`）、全局 store 重构、
其它 UI 区域（聊天/侧栏/文件）、不引入图表库（手写 SVG，零依赖）。

## 4. 设计

### 4.1 数据链路修复

**① `tokenStatsStore` 新增 `refreshFromServer()`（主数据源）**
- 调 `/transcript/stats`，映射进 `stats`：
  - `totalInput`/`totalOutput` ← `totals.input_tokens`/`output_tokens`
  - `byDay` ← `byDate`（服务端键已是 `YYYY-MM-DD`，与 `toDayKey` 同格式，直接使用不重复转换；服务端按 UTC 切片，本地时区展示可能有 ±1 天偏差，接受）
  - `byModel` ← `byModel`
- 成功 → 更新 stats + lastUpdatedAt；失败 → 保留现有 stats，置 `lastError`（不静默吞掉）
- 进入驾驶舱时**总是先 refreshFromServer()**，以服务端为准覆盖本地

**② `usePonosCLI.ts` 补 `recordUsage` 调用点**
- 消息流收到 `result` 事件（轮次结束、带 usage）时调
  `recordUsage({input, output}, {conversationId, model})`
- 新会话实时累加；历史由 `/transcript/stats` 全量补齐

**③ 持久化降级为缓存**
- persist 保留（离线可看），但刷新时以服务端为准覆盖

**④ 错误态**
- 驾驶舱显示"数据暂不可用 + 重试按钮"，不显示误导性 0

**数据流**：
```
进入驾驶舱 → refreshFromServer() → /transcript/stats → 全量更新 stats
新会话轮次结束 → recordUsage() → 实时增量累加
失败 → lastError + 重试（不吞错）
```

### 4.2 信息架构（三层布局）

```
┌──────────────────────────────────────────────┐
│ ① 品牌 Hero：欢迎 + 版本徽章 + 快捷操作       │
├──────────────────────────────────────────────┤
│ ② 状态总览条 Stat Strip（运行任务/今日会话/   │
│    今日Token/桥接状态/完成率）                │
├──────────────────────────┬───────────────────┤
│ ③ 主网格（升级四卡）       │ ④ 右侧栏           │
│   会话·任务 / Token /     │   最近会话列表      │
│   文件 / 技能             │   + 运行中任务      │
└──────────────────────────┴───────────────────┘
```

**① 品牌 Hero**
- 大标题「欢迎回来」+ 副标题（当前项目目录名，lastCwd basename）
- 版本徽章：内核 `dev 0.1` · 应用 `dev 3.0.0`（version.mjs 注入）
- 快捷操作：新建会话（主按钮）/ 打开文件 / 查看 Token

**② 状态总览条 Stat Strip**
- 一行紧凑指标：运行任务数（脉冲点动画）、今日会话、今日 Token、桥接状态（在线青点/离线红点）、完成率
- 数字从卡片移出，卡片腾空间放实质内容

**③ 主网格四卡升级**
- **会话·任务卡**：总会话/今日/运行中/完成率 + 最近 3 条会话标题（hover 显示，点击直达）
- **Token 卡**：总量/今日/7日 + 30 日趋势迷你图 + 输入/输出堆叠条
- **文件卡**：文件/目录数 + 错误重试（保留）；点击进右栏
- **技能卡**：技能/Agent 数 + 技能分类环形图（按命名前缀 gxtz-*/yfwx-*/yfwdoc-*/space-* 聚合）

**④ 右侧栏（新增）**
- 最近会话列表：updatedAt 倒序前 6 条（标题 + 时间 + token 迷你条），点击直达
- 运行中任务区：实时状态，与左侧任务栏同源

### 4.3 可视化与品牌视觉

**图表组件（提取公共，零依赖手写 SVG）**
- `TrendChart`（30 日线图 + 面积渐变）← 从 TokenStatsPanel 提取
- `DonutChart`（环形图）← 从 TokenStatsPanel 提取
- `BarStack`（输入/输出堆叠条）新增

**品牌视觉**
- Hero 标题渐变文字（品牌粉→电青，与连线同色系 `var(--brand-500)`→`var(--accent-cyan)`）
- 卡片图标统一品牌色圆角方块底（`bg-brand-500/10 text-brand-500`）
- 连线层保留，hover 透明度提升（现有行为）
- 全 CSS 变量，Shadow 主题深/浅自适应，无硬编码 hex

### 4.4 组件结构

```
src/components/charts/TrendChart.tsx      ← 提取（30日线图）
src/components/charts/DonutChart.tsx      ← 提取（环形图）
src/components/charts/BarStack.tsx        ← 新增（堆叠条）
src/components/cockpit/CockpitView.tsx    ← 重构（Hero/StatStrip/网格/右栏）
src/components/cockpit/RecentSessions.tsx ← 新增（右侧最近会话）
src/components/cockpit/RunningTasks.tsx   ← 新增（运行中任务）
src/stores/tokenStatsStore.ts             ← refreshFromServer + 数据源切换
src/hooks/usePonosCLI.ts                  ← recordUsage 调用点
```

### 4.5 不做（YAGNI）

- 不新增 bridge 端点
- 不做实时推送/WebSocket 图表流
- 不重构全局 store / 不改其它 UI 区域
- 不引入图表库（recharts/chart.js 等）

## 5. 测试

- `tokenStatsStore`：新增 `refreshFromServer` 单测（mock fetch /transcript/stats 成功/失败分支）
- `usePonosCLI`：`recordUsage` 调用点测试（result 事件触发）
- 现有 `src/stores/*.test.ts` 全量回归
- 手动验证：驾驶舱 token 显示真实值；新会话后 token 实时增加；bridge 离线显示重试态

## 6. 验收标准

1. 驾驶舱 token 统计显示真实数据（非 0），新会话后实时累加
2. 驾驶舱含：Hero + Stat Strip + 升级四卡 + 右侧最近会话/任务栏
3. Token 卡含 30 日趋势图 + 输入/输出堆叠条；技能卡含分类环形图
4. 全部主题变量适配，无硬编码 hex；深/浅主题均正常
5. bridge 离线时显示"数据暂不可用 + 重试"，不显示误导 0
6. 全量测试通过（`node --test src/stores/*.test.ts` 及仓库测试命令）
