# 溯源核验规则（v2.7）

> **核心原则**：所有从官方源文件中提取的关键字段值，必须在输出时保持精确一致。
> 模型不得对源文件值做任何形式的"改写"、"换词"、"扩写"或"缩写"。

## 工作流

### Step 1: 提取即记录
技能从官方源文件提取到关键字段值时，**立即调用** `set_provenance()` 记录溯源：

```python
from provenance_manager import set_provenance

# 从所得税申报表提取到技术领域后
set_provenance(
    field_name="tech_field_l1",
    value="新能源与节能",          # ← 源文件中的实际值
    source="income_tax_return",     # ← 来源类型
    source_file="9.前三年企业所得税纳税申报表/2022企业所得税年度纳税申报表.pdf",
)

# 从营业执照提取企业名称后
set_provenance(
    field_name="enterprise_name",
    value="深圳派成铝业科技有限公司",
    source="business_license",
    source_file="6.营业执照/营业执照.pdf",
)
```

### Step 2: 输出前核验
所有输出文本必须经过双层核验：

```python
from verify_authoritative_terms import scan_and_correct

corrected_text, corrections = scan_and_correct(output_text, project_root=project_root)
if corrections:
    for c in corrections:
        layer = c.get('layer', '?')
        if layer == 'provenance':
            print(f'[溯源矫正] {c["field_label"]}: "{c["found"]}" → "{c["source_value"]}"')
        else:
            print(f'[术语库矫正] {c["original"]} → {c["corrected"]}')
    output_text = corrected_text
```

### Step 3: 发现变异时
核验发现任何偏离，强制矫正并记录日志。**不允许忽略**。

## 溯源字段清单

| 字段 | 来源 | 一票否决 |
|------|------|---------|
| `tech_field_l1` | 所得税申报表 / 申请书 | ✓ CRITICAL |
| `tech_field_l2` | 同上 | |
| `tech_field_l3` | 同上 | |
| `enterprise_name` | 营业执照 | ✓ CRITICAL |
| `unified_social_credit_code` | 营业执照 | |
| `register_date` | 营业执照 | |
| `high_tech_revenue` | 高新产品收入专项审计报告 | |
| `total_revenue` | 财务审计报告 | |
| `rnd_expense_total` | 研发费用专项审计报告 | |
| `staff_count` | 社保缴费记录 | |
| `tech_staff_count` | 科技人员清单 | |

## 核验原理

```
LLM 输出文本
  │
  ├─→ Layer 1: provenance 溯源核验
  │     for each provenance field:
  │       在输出中搜索与源值"语义相同但词法不同"的片段
  │       找到 → 替换为源值精确值 + 记录矫正日志
  │
  └─→ Layer 2: authoritative_terms.json 静态术语库兜底
        对未知变异进行兜底矫正
```

## 禁止行为

- 禁止将 "新能源**与**节能" 写成 "新能源**及**节能"
- 禁止将源文件中的 "深圳派成铝业科技有限公司" 写成 "深圳派成铝业"
- 禁止对源文件值做任何 "扩写"（如 "高技术服务" → "高技术服务领域"）
- 禁止对源文件值做任何 "缩写"（如 "先进制造与自动化" → "先进制造"）
- 禁止以 "语义相同" 为由跳过矫正
