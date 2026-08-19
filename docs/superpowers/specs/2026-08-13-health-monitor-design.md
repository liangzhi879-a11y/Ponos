# 智能健康监控系统设计（Health Monitor）

日期：2026-08-13
状态：已确认设计，待实施

## 背景与动机

用户评估结论（2026-08-13）：主模型 deepseek-v4-flash 上下文窗口 200K，有效窗口 180K，
自动压缩阈值 167K。普通任务在 2-3 次自动压缩后出现"摘要的摘要"嵌套，上下文细节逐层
丢失，agent 执行能力断崖下降。当前 GUI 对压缩一无所知，用户无法感知任务质量正在劣化。

目标：建立智能监控系统，在任务质量严重下降时输出提示，提醒用户新建会话。

## 设计决策（用户确认）

| 决策点 | 选择 |
|---|---|
| 信号来源 | **内核全包办**：内核判定质量下降并输出事件，前端只展示 |
| 判定规则 | **综合健康分**：多因子加权，分绿/黄/红三档 |
| 提醒形式 | **横幅 + 一键新建会话**，可携带压缩摘要 |
| 监控范围 | **仅主会话**（子 agent 短命，不监控） |

## 架构与数据流

```
内核 (每轮 query 完成后)
  └→ healthMonitor.ts 记录 turnStats → 计算健康分 → 档位变化时
       stdout 输出一行: {"type":"yfw_health",...}
bridge.mjs  └→ 逐行解析，任何 JSON 行已原样转发 {type:'event'}（bridge.mjs:720-724）
GUI 前端     └→ 过滤 event.type==='yfw_health' → healthStore → HealthBanner 横幅
```

- 内核新增 `src/services/health/healthMonitor.ts`，模块级状态。bridge 按会话 spawn 独立
  内核进程，天然按会话隔离，主会话专属（子 agent 进程不打健康事件）。
- 输出通道复用现有链路：bridge 对任意可解析 JSON 的行都 `send({type:'event', data:parsed})`，
  GUI 端只加一层过滤，**bridge 零改动**。
- 内核侧改动点：`query.ts` 每轮尾部 + `compact.ts` 压缩成功后，各调一次
  `healthMonitor.record(...)`。

## 健康分模型（初始权重，内核常量可调）

### 模型自适应归一化层（核心）

判定前先按模型归一化，复用内核现有 `getContextWindowForModel`（context.ts）与
`getEffectiveContextWindowSize`（autoCompact.ts）自动解析当前模型窗口，不硬编码：

| 模型 | 上下文窗口 | 可靠注意力上限 | 有效窗口 | 压缩断崖点 | 剩余轮数换算基准 |
|---|---|---|---|---|---|
| deepseek-v4-flash | 200K | 160K | 180K | 2-3 次 | 每轮 3-8K |
| deepseek-v4-pro[1m] | 1M | 800K | 980K | 5-6 次 | 每轮 3-8K |

自适应使同一套健康分在不同模型上语义一致：flash 压缩 3 次即红档，pro[1m] 压缩 3 次
仍是黄档（它有 800K 可靠余量可以继续）。

#### 可靠注意力上限（reliableAttentionRatio）

全注意力模型不存在硬性注意力上下文大小，但注意力质量随序列变长**分级衰减**：
注意力稀释（权重摊薄）、lost-in-the-middle（中段内容易被忽略）、位置编码外推误差。
经验上检索/遵循质量在名义窗口的 70-85% 处开始显著下降。

- 常量 `reliableAttentionRatio`，**默认 0.8**；支持按模型覆盖
  （`reliableAttentionRatioByModel: { 'deepseek-v4-flash': 0.8, ... }`）
- 标定手段：模型接入时做**一次性 needle-in-haystack 测试**（事实埋在不同深度测命中
  率），得出该模型的精确比例；不做每会话标定，成本可忽略
- 预警基准：`attentionCeiling = min(有效窗口, 名义窗口 × 比例)`，水位计分以此为分母

### 因子与加分（归一化后）

| 因子 | 触发 | 加分 | 模型自适应 |
|---|---|---|---|
| 压缩次数 compactCount | 归一化 | count>0 ? max(40, 70×min(count,cap)/cap) : 0 | cap=断崖点：flash 3 / pro[1m] 6 |
| 压缩链深度（10 轮内压缩数） | ≥2 次起算 | (chain−1)×15 | 链窗口 10 轮 |
| 上下文剩余水位 | 剩余 <25% / <12%（**可靠注意力上限**比） | +45 / +70 | 按 `attentionCeiling` 换算为**绝对剩余 token 阈值**：flash 40K/19K，pro[1m] 200K/96K |
| **剩余可执行轮数** | 剩余 token ÷ 近 10 轮平均消耗，<10 / <5 轮 | +20 / +30 | 每轮平均消耗按模型实际观测，自适应 |
| 连续压缩失败 | 每次 | +10 | 封顶 3 |

> 注意力衰减语义：黄档锚定"剩余 20% 名义窗口"（= 注意力质量开始下降的位置，
> flash 40K / pro 200K），即可靠上限的 25%；旧设计要等剩余 15% 有效窗口（flash 27K）
> 才预警。改用 attentionCeiling 作分母后，预警时机被**提前**到注意力实际衰减点。

> 剩余轮数是"最用户可行动"的信号：同一剩余百分比，flash 只够 5-13 轮而 pro[1m] 还够
> 25-60 轮，直接显示"剩余约 N 轮"比"剩余 15%"更直观。低轮数（<5）时无论其它因子
> 如何都强制升档。

### 档位

- **0-40 绿 / 40-70 黄（注意）/ ≥70 红（建议新建）**；剩余轮数 <5 时强制红档
- 压缩计分归一化到断崖点，保证 flash 3 次红档、pro[1m] 3 次仍黄档。
- 状态机去抖：同档位只发一次变更事件；红档 5 分钟内不重复弹
- 计算与判断全程 try/catch，失败静默降级，绝不影响主流程

## 事件协议（内核 → GUI，两路）

```
{"type":"yfw_health","score":72,"tier":"red","compactCount":3,
  "remainingPct":8,"remainingTurns":4,"suggestNewSession":true,
  "reason":"已连续压缩3次，剩余约4轮"}
{"type":"yfw_summary","text":"<最近一次压缩摘要全文>","compactCount":3}
```

- `yfw_health`：档位**变化**时发一次（去抖状态机）；`remainingTurns` 为模型自适应
  估算的剩余可执行轮数；`remainingPct` 为相对 `attentionCeiling` 的剩余比例
- `yfw_summary`：每次压缩成功后发一次（20K token 摘要 ≈ 15KB 文本，WebSocket 传输
  无压力），GUI 存进 healthStore 供"携带摘要"使用

## GUI 展示（新增 2 个组件 + 1 个 store）

| 组件 | 行为 |
|---|---|
| `healthStore`（zustand） | 收健康事件与摘要；只保留最新值；红档 5 分钟冷却 |
| `HealthBanner`（黄灯） | 聊天区顶部细条："上下文健康度下降（剩余 25%，约 8 轮），建议适时开始新会话" |
| `HealthBanner`（红灯） | 醒目横幅（含剩余轮数）+ 「新建会话」按钮 + 「携带摘要」勾选（默认开） |

- 新建会话流程：点按钮 → 若勾选"携带摘要"且 store 有 `yfw_summary` → 新会话首条
  消息自动填入摘要文本（用户可编辑）→ 创建会话并跳转
- 复用现有新建会话 API，不新开 IPC 通道

## 测试

1. **内核单测**：healthMonitor 分数计算、档位边界（40/70）、去抖状态机（同档不重复
   发、红档冷却）
2. **模型自适应单测**：同一状态分别注入 flash 与 pro[1m] 窗口 → flash 3 次压缩红档、
   pro[1m] 3 次压缩仍黄档；剩余轮数估算随平均消耗变化
3. **注意力上限单测**：`reliableAttentionRatio` 变化（0.7/0.8/0.9）时黄档触发点随之
   移动；ratio 缺失时回落默认 0.8；flash 在 40K 剩余处开始黄档
4. **GUI 组件测试**：三档渲染、按钮动作、摘要注入首条消息、横幅文案含剩余轮数
5. **端到端**：手工脚本模拟多次压缩 → 观察黄灯→红灯渐变 → 一键新建携带摘要

## 改动文件清单

| 文件 | 改动 |
|---|---|
| `yfw-kernel/claude-code/src/services/health/healthMonitor.ts` | 新增，核心判定（含 reliableAttentionRatio 常量与按模型覆盖表） |
| `yfw-kernel/claude-code/src/query.ts` | 每轮尾部调 record |
| `yfw-kernel/claude-code/src/services/compact/compact.ts` | 压缩成功后发 yfw_summary |
| `src/stores/healthStore.ts` | 新增 |
| `src/components/HealthBanner.tsx` | 新增，接入 ChatWindow |
| `src/...` 新建会话处 | 摘要注入 |

## 非目标（YAGNI）

- 不监控子 agent 会话
- 不做桌面系统通知
- 不做会话健康度历史视图
- 不做基于模型自评的软信号
