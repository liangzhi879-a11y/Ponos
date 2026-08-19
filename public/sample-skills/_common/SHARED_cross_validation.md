# SHARED: 交叉验证协议 — 所有 gxtz-* 技能共享
# 来源: gxtz-core-tables SKILL.md v1.34.0 (extracted 2026-07-21)
# 修改此文件即可同步所有技能

## 交叉验证协议（双模型校验）

> **核心原则**：在关键决策点，主模型的判断必须经校验模型（MiniMax M3）交叉验证。
> 校验模型审核主模型的结构化"证据包"——检查推理自洽性、证据链完整性、政策符合性。

### 触发条件

| 场景 | 校验点ID | 强制等级 |
|------|---------|---------|
| RD-PS-IP 三角映射 | `rd_ps_ip_mapping` | 🔴 强制 |
| 发票→PS 匹配 | `invoice_match_accuracy` | 🔴 强制 |
| 科技人员占比 | `staff_count_ratio` | 🔴 强制 |
| 成果转化链条 | `conversion_chain` | 🟡 建议 |
| 立项书格式 | `format_compliance` | 🟡 建议 |
| 专审报告核对 | `cross_report_consistency` | 🔴 强制 |

### 执行步骤

**第一步**：agent 将工作底稿写入证据包 JSON（含 files_processed / extraction_results / decisions / policy_context）

**第二步**：调用交叉验证器
```
python cross_model_validator.py validate --checkpoint-file <证据包路径> --skill <技能名>
```

**第三步**：根据退出码处置

| 退出码 | 含义 | agent动作 |
|--------|------|----------|
| 0 | pass | ✅ 继续 |
| 2 | blocked | ⛔ 停止，等待人工仲裁 |
| 3 | needs_human | ⚠️ 暂停，请求用户决策 |
| 4 | needs_self_check | ⚡ 补充证据后重新校验 |

### 争议分类

| 类型 | 含义 | 处置 |
|------|------|------|
| Type A（事实性） | 数据提取错误 | 🔴 回源核实修正 |
| Type B（判断性） | 关联逻辑分歧 | 🟡 等待人工仲裁 |
| Type C（格式性） | 措辞差异 | 🟢 记录不阻塞 |

> **禁止**：跳过强制校验点 / blocked时继续 / 忽略Type A / 未验证经验写入经验库
