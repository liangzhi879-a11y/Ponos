"""端到端仿真测试：溯源核验全流程

模拟场景：
  1. gxtz-core-tables 技能从所得税申报表提取到 tech_field_l1 = "新能源与节能"
  2. 技能调用 set_provenance() 记录溯源
  3. 模型生成 RD 报告时，误写成 "新能源及节能领域"
  4. 输出前调用 scan_and_correct() 自动检测并矫正
  5. 验证矫正结果
"""
import sys
import os

# 将 _common 加入 path
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'skills', '_common'))

# ============================================================
# Step 1: 模拟从所得税申报表提取技术领域
# ============================================================
print("=" * 60)
print("Step 1: 模拟从所得税申报表提取技术领域")
print("=" * 60)

from provenance_manager import set_provenance, get_provenance, generate_provenance_report

set_provenance(
    field_name="tech_field_l1",
    value="新能源与节能",
    source="income_tax_return",
    source_file="9.前三年企业所得税纳税申报表/2022企业所得税年度纳税申报表.pdf",
)
set_provenance(
    field_name="tech_field_l2",
    value="新型高效能量转换与储存技术",
    source="income_tax_return",
    source_file="9.前三年企业所得税纳税申报表/2022企业所得税年度纳税申报表.pdf",
)
set_provenance(
    field_name="enterprise_name",
    value="深圳派成铝业科技有限公司",
    source="business_license",
    source_file="6.营业执照/营业执照.pdf",
)

print()

# ============================================================
# Step 2: 验证溯源记录
# ============================================================
print("=" * 60)
print("Step 2: 验证溯源记录")
print("=" * 60)

report = generate_provenance_report()
print(f"  已记录字段: {report['total_fields']} 个")
print(f"  一票否决字段: {report['veto_fields']}")
print(f"  缺失字段: {report['gaps']}")

for field_name, field_info in report['fields'].items():
    veto = "CRITICAL" if field_info['veto'] else ""
    print(f"  [{veto}] {field_info['label']} = \"{field_info['value']}\" (来源: {field_info['source']})")

print()

# ============================================================
# Step 3: 模拟模型输出 — 包含多种变异
# ============================================================
print("=" * 60)
print("Step 3: 模拟模型输出（包含偏离）")
print("=" * 60)

model_output = """企业基本信息

企业名称：深圳派成铝业科技  // 模型漏写了"有限公司"
技术领域（一级）：新能源及节能   // 模型把"与"写成了"及"
技术领域（二级）：新型高效能量转换与储存科技  // 模型把"技术"写成了"科技"

研发项目概述：
本项目属于新能源及节能领域，围绕新型高效能量转换与储存科技展开研究，
旨在为深圳派成铝业科技提供技术支持。"""

print(model_output)
print()

# ============================================================
# Step 4: 双层核验
# ============================================================
print("=" * 60)
print("Step 4: 双层核验（provenance + authoritative_terms）")
print("=" * 60)

from verify_authoritative_terms import scan_and_correct

corrected, corrections = scan_and_correct(model_output)

for i, c in enumerate(corrections, 1):
    layer = c.get('layer', '?')
    if layer == 'provenance':
        print(f"  [{i}] [溯源-{c['severity']}] {c['field_label']}: \"{c['found']}\" → \"{c['source_value']}\"")
    else:
        print(f"  [{i}] [术语库] {c.get('original', '?')} → {c.get('corrected', '?')}")

print(f"\n  总矫正: {len(corrections)} 处")
print()

# ============================================================
# Step 5: 验证结果
# ============================================================
print("=" * 60)
print("Step 5: 矫正后文本")
print("=" * 60)

print(corrected)
print()

# ============================================================
# 断言验证
# ============================================================
print("=" * 60)
print("Step 6: 断言验证")
print("=" * 60)

checks = {
    "tech_field_l1 应为 \"新能源与节能\"": "新能源与节能" in corrected,
    "tech_field_l2 应为 \"新型高效能量转换与储存技术\"": "新型高效能量转换与储存技术" in corrected,
    "enterprise_name 应为 \"深圳派成铝业科技有限公司\"": "深圳派成铝业科技有限公司" in corrected,
    "不应残留 \"新能源及节能\"": "新能源及节能" not in corrected,
    "不应残留 \"深圳派成铝业科技\" 后面没有有限公司": "深圳派成铝业科技" not in corrected or "深圳派成铝业科技有限公司" in corrected,
}

all_pass = True
for check, result in checks.items():
    status = "PASS" if result else "FAIL"
    if not result:
        all_pass = False
    print(f"  [{status}] {check}")

print(f"\n{'全部通过!' if all_pass else '存在失败!'}")
sys.exit(0 if all_pass else 1)
