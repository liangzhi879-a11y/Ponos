<!-- SECTION_BEGIN: cross_validation_protocol -->
## 交叉验证协议（双模型校验，关键决策点强制执行）

> **核心原则**：在关键决策点，主模型（DeepSeek）的判断必须经校验模型（MiniMax M3）交叉验证。
> 校验模型不接收原始文件，而是审核主模型的结构化"证据包"（工作底稿）——检查推理自洽性、证据链完整性、政策符合性。
> 这是质量保证的最后一道防线，**禁止跳过**。

### 触发条件（agent 自主识别，命中任一即触发）

| 场景 | 校验点ID | 触发时机 | 强制等级 |
|------|---------|---------|---------|
| RD-PS-IP 三角映射完成 | `rd_ps_ip_mapping` | 核心表生成后、提交前 | 🔴 强制 |
| 发票→PS 匹配完成 | `invoice_match_accuracy` | 匹配结果生成后、写入表前 | 🔴 强制 |
| 科技人员占比计算 | `staff_count_ratio` | 人员清单整理后 | 🔴 强制 |
| 成果转化链条构建 | `conversion_chain` | 成果转化材料整理后 | 🟡 建议 |
| 立项书格式合规检查 | `format_compliance` | 立项书生成后、提交前 | 🟡 建议 |
| 专审报告核对完成 | `cross_report_consistency` | 5维度核对后 | 🔴 强制 |
| IP 数量/状态校验 | `ip_completeness` | IP 材料整理后 | 🟡 建议 |
| PS 收入占比校验 | `ps_revenue_ratio` | PS 材料整理后 | 🟡 建议 |

### 执行方式（RunCommand 调用，禁止跳过）

在到达上述校验点时，agent 必须按以下步骤执行：

**第一步：构建证据包（Evidence Package）**

agent 将本次决策的结构化"工作底稿"写入 JSON 文件。证据包必须包含：
- `files_processed`：本次处理的文件清单（路径、类型、摘要）
- `extraction_results`：从文件中提取的关键事实（含源锚点：文件路径、sheet、行列）
- `decisions`：做出的决策列表（含输入、结果、推理依据、置信度）
- `policy_context`：应用的政策规则和阈值

> ⚠️ **证据包是 MiniMax 校验的唯一依据**。每个决策必须标注 `evidence_anchors`（证据锚点），
> 否则 MiniMax 无法判断推理是否成立。**没有锚点的决策等于没有证据**。

**第二步：调用交叉验证器（RunCommand）**

```
python c:\Users\T203-15\Desktop\2023guogao\.trae\skills\_common\skill_orchestrator.py checkpoint ^
    --skill {当前技能名} ^
    --checkpoint-id {校验点ID} ^
    --evidence-file {证据包路径} ^
    --output-file {验证结果输出路径}
```

或直接调用底层验证器：

```
python c:\Users\T203-15\Desktop\2023guogao\.trae\skills\_common\cross_model_validator.py validate ^
    --checkpoint-file {证据包路径} ^
    --skill {当前技能名}
```

**第三步：根据退出码处置**

| 退出码 | 状态 | 含义 | agent 动作 |
|--------|------|------|-----------|
| 0 | `pass` | 双模型共识 | ✅ 继续后续步骤 |
| 2 | `blocked` | 存在关键争议 | ⛔ 立即停止，输出争议报告，等待人工仲裁 |
| 3 | `needs_human` | 需人工仲裁 | ⚠️ 暂停，输出仲裁报告，使用 AskUserQuestion 请求用户决策 |
| 4 | `needs_self_check` | 需主模型自查 | ⚡ 根据 MiniMax 的 `requests_for_clarification` 补充证据后重新校验 |
| 1 | `error` | 执行错误 | ✗ 检查 API 配置和证据包格式，修复后重试 |

### 证据包构建示例（参考模板）

```json
{
  "protocol_version": "2.0",
  "checkpoint_id": "gxtz-invoice-ps-matching:invoice_match_accuracy",
  "primary_model": "deepseek",
  "skill": "gxtz-invoice-ps-matching",
  "evidence_manifest": {
    "files_processed": [
      {"file": "发票明细2025.xlsx", "type": "excel", "summary": "847行发票数据", "rows_processed": 847}
    ],
    "total_files": 1
  },
  "extraction_results": [
    {
      "claim_id": "PS-001",
      "claim": "PS-001 智能录播系统",
      "source_anchor": {"file": "申请书.docx", "section": "PS表", "extraction_method": "正则匹配"},
      "confidence": "high"
    }
  ],
  "decisions": [
    {
      "decision_id": "MATCH-001",
      "type": "invoice_to_ps_match",
      "input": {"invoice_goods_name": "智能录播主机V3", "ps_list": ["PS-001 智能录播系统"]},
      "result": "匹配到 PS-001",
      "rationale": "货物名称'智能录播主机V3'是PS-001'智能录播系统'的子产品，语义包含关系",
      "confidence": "high",
      "evidence_anchors": ["PS-001 来自申请书PS表", "发票货物名称包含'智能录播'关键词"]
    }
  ],
  "policy_context": {
    "rules_applied": ["PS名称必须从申请书提取，非发票反推"],
    "thresholds": {"ps_coverage_min": 0.60}
  }
}
```

### 争议处置规则（三级分类）

| 类型 | 含义 | 处置方式 | 优先级 |
|------|------|---------|--------|
| **Type A**（事实性） | 数据提取、计算结果错误 | 🔴 回溯源文件核实，修正后重新校验 | 最高 |
| **Type B**（判断性） | 匹配判定、关联逻辑分歧 | 🟡 标记争议，等待人工仲裁 | 高 |
| **Type C**（格式性） | 措辞、格式等非关键差异 | 🟢 记录但不阻塞流程 | 低 |

> **禁止行为**：
> 1. 禁止跳过强制校验点直接提交
> 2. 禁止在 MiniMax 返回 `blocked` 时继续执行
> 3. 禁止忽略 Type A 争议（必须回源核实）
> 4. 禁止将未交叉验证的经验直接写入 experience_base（需经 capture-cv 验证）

### 经验交叉验证（capture 时）

agent 在技能执行中发现值得记录的经验时，**必须先经过 MiniMax 交叉验证**再写入经验库：

```
python c:\Users\T203-15\Desktop\2023guogao\.trae\skills\_common\cross_model_validator.py capture-cv ^
    --project-root "c:\Users\T203-15\Desktop\2023guogao" ^
    --skill {当前技能名} ^
    --enterprise "{企业名称}" ^
    --problem-type {common_issue|validation_rule|...} ^
    --problem-desc "问题描述" ^
    --solution "解决方案"
```

验证通过后，再调用 `project_context_manager.py capture --cross-validated consensus` 写入经验库。
争议经验标记为 `disputed` 状态，等待人工仲裁。

### 与其他机制的协同

- **自主确认机制（A/B/C/D）**：agent 自主发现的异常 → 先尝试自行解决 → 若涉及关键决策点，触发交叉验证
- **质疑与协同审查（E/F/G/H）**：G 类（跨技能不一致）必须触发交叉验证
- **审核验证标准**：`validate_*.py` 是格式/逻辑校验，交叉验证是决策质量校验，两者互补不可替代
<!-- SECTION_END: cross_validation_protocol -->
