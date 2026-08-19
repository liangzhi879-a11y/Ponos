# SHARED: 权威术语强制核验 — 所有 gxtz-* 技能共享
# 来源: gxtz-core-tables SKILL.md v1.34.0 (extracted 2026-07-21)

## 权威术语强制核验（v2.6 - 强制）

> 本规则适用于所有高企认定技能输出。**违反本规则可导致项目核验无效（一票否决）。**

### 强制性规则

**输出前强制扫描**：所有文本内容最终输出前调用术语核验：
```python
from verify_authoritative_terms import scan_and_correct
corrected_text, corrections = scan_and_correct(output_text)
```

**XLSX逐单元格核验**：
```python
from verify_authoritative_terms import verify_output_file
result = verify_output_file(output_path)
```

### 禁止的变异（示例）

| 错误输出 | 正确术语 | 严重性 |
|---------|---------|--------|
| 新能源**及**节能 | 新能源**与**节能 | CRITICAL |
| 先进制造**及**自动化 | 先进制造**与**自动化 | CRITICAL |
| 高技术服务**业** | 高技术服务 | CRITICAL |
| 航空航天**技术** | 航空航天 | ERROR |
| 电子信息技术 | 电子信息 | ERROR |

### 数据来源

`_common/authoritative_terms.json`，基于：
- 《高新技术企业认定管理办法》（国科发火〔2016〕32号）
- 《高新技术企业认定管理工作指引》（国科发火〔2016〕194号）
- 《国家重点支持的高新技术领域》

### 核验失败处理

无法自动矫正时：标记文件 → 列出无法矫正术语 → 禁止输出直到人工确认
