# 权威术语强制核验规则（v2.6）

> 本规则适用于所有高企认定技能输出。**违反本规则导致的术语错误可能直接导致项目核验无效（一票否决）。**

## 强制性规则

### 1. 输出前强制扫描
技能生成的**所有文本内容**（RD报告、PS描述、成果转化说明、TO-AI表格、审核报告等）在最终输出前，必须调用权威术语核验模块：

```python
from verify_authoritative_terms import scan_and_correct

# 所有输出文本都需过检
corrected_text, corrections = scan_and_correct(output_text)
if corrections:
    print(f'[术语矫正] {len(corrections)} 处权威术语已自动矫正')
    for c in corrections:
        print(f'  {c["original"]} → {c["corrected"]}')
    output_text = corrected_text
```

### 2. XLSX 输出必须逐单元格核验
生成 Excel 文件后，必须调用 `verify_output_file()` 对整个文件进行术语核验：

```python
from verify_authoritative_terms import verify_output_file

result = verify_output_file(output_path)
if result['corrections_made'] > 0:
    print(f'[!] 已自动矫正 {result["corrections_made"]} 处权威术语')
```

### 3. 禁止的变异（部分示例）
| 错误输出 | 正确术语 | 严重性 |
|---------|---------|--------|
| 新能源**及**节能 | 新能源**与**节能 | CRITICAL - 一票否决 |
| 新能源**和**节能 | 新能源**与**节能 | CRITICAL |
| 先进制造**及**自动化 | 先进制造**与**自动化 | CRITICAL |
| 先进制造**和**自动化 | 先进制造**与**自动化 | CRITICAL |
| 资源**及**环境 | 资源**与**环境 | CRITICAL |
| 高技术服务**业** | 高技术服务 | CRITICAL |
| 航空航天**技术** | 航空航天 | ERROR |
| 电子信息技术 | 电子信息 | ERROR |

### 4. 数据来源
所有权威术语定义来自 `_common/authoritative_terms.json`，该文件基于：
- 《高新技术企业认定管理办法》（国科发火〔2016〕32号）
- 《高新技术企业认定管理工作指引》（国科发火〔2016〕194号）
- 《国家重点支持的高新技术领域》

### 5. 隐患自查新增维度
在7维隐患自查中，新增第8维——**权威术语一致性**：
- 检查所有涉及高新技术领域名称的字段是否与 `authoritative_terms.json` 一致
- 检查 "与"/"及"/"和" 连词是否使用了正确的 "与"
- 检查领域名称是否被LLM "创造性改写"

### 6. 核验失败处理
如果 `scan_and_correct()` 无法自动矫正（即术语不在已知变异映射中），必须：
1. 标记该文件为"未通过权威术语核验"
2. 列出无法矫正的具体术语
3. 禁止输出该文件，直到人工确认
