# SHARED: 溯源核验规则 — 所有 gxtz-* 技能共享
# 来源: gxtz-core-tables SKILL.md v1.34.0 (extracted 2026-07-21)

## 溯源核验 — 以源文件值为基准（v2.7 - 强制）

> **核心原则**：所有从官方源文件中提取的关键字段值，必须在输出时保持精确一致。
> 模型不得对源文件值做任何形式的"改写"、"换词"、"扩写"或"缩写"。

### 工作流

**Step 1: 提取即记录** — 调用 `set_provenance()` 记录溯源：
```python
from provenance_manager import set_provenance
set_provenance(field_name="tech_field_l1", value="新能源与节能",
               source="income_tax_return", source_file=".../所得税申报表.pdf")
```

**Step 2: 输出前核验** — 调用双层核验：
```python
from verify_authoritative_terms import scan_and_correct
corrected_text, corrections = scan_and_correct(output_text, project_root=project_root)
```

**Step 3: 发现变异时** — 强制矫正并记录日志，不允许忽略。

### 溯源字段清单

| 字段 | 来源 | 一票否决 |
|------|------|---------|
| `tech_field_l1/l2/l3` | 所得税申报表 / 申请书 | ✓ (l1) |
| `enterprise_name` | 营业执照 | ✓ CRITICAL |
| `unified_social_credit_code` | 营业执照 | |
| `high_tech_revenue` / `total_revenue` | 专项审计报告 / 财务审计报告 | |
| `rnd_expense_total` | 研发费用专审报告 | |
| `staff_count` / `tech_staff_count` | 社保缴费记录 / 科技人员清单 | |

### 禁止行为

- 禁止 "新能源**与**节能" → "新能源**及**节能"
- 禁止 "深圳派成铝业科技有限公司" → "深圳派成铝业"
- 禁止对源文件值做扩写或缩写
- 禁止以"语义相同"为由跳过矫正
