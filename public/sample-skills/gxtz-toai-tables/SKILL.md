---
name: gxtz-toai-tables
description: "TOAI汇总表生成 — 四表联动汇总/高新技术产品收入占比/研发费用占比。基于RD/PS/IP三表生成TOAI汇总表，用于向系统/AI一次性提交企业核心数据。包含3个Sheet：企业情况（6行）、RD-研发项目（11列）、IP-知识产权（10列）。完成四表联动校验。对应TRAE源技能gxtz-core-tables的TOAI表部分（第六步）。"
version: "1.40.1"
triggers:
  - TOAI表
  - 汇总表
  - 四表汇总
  - 高新汇总
  - TO-AI汇总
  - 核心数据汇总
  - 向系统提交数据
  - 企业情况汇总
---

## 角色定位

本技能负责高新技术企业认定中**TOAI汇总表**的生成与校验。基于RD表、PS表、IP表三表数据汇总生成，用于向系统/AI一次性提交企业核心数据。

## 前置依赖

- RD表.xlsx / PS表.xlsx / IP表.xlsx（必须全部先生成完成）

## 输出文件

- `TO-AI.xlsx`（存放到 `00_核心表格/` 目录）
- 3个Sheet：企业情况（6行）、RD-研发项目（11列）、IP-知识产权（10列）

## 核心脚本

```bash
# 生成TOAI汇总表
python {{YFW_SKILLS}}/_common/generate_toai_table.py --rd RD表 --ps PS表 --ip IP表
# 校验TOAI汇总表
python {{YFW_SKILLS}}/_common/validate_toai_table.py --input "00_核心表格/TOAI汇总表.xlsx"
```

## TOAI表格结构

### Sheet1 - 企业情况（6行数据）

| 名称 | 内容 | 说明 |
|------|------|------|
| 名称 | 企业全称 | 与营业执照一致 |
| 官网 | 企业官方网站URL | 如无可填"无" |
| 简介 | 企业简介 | 约300-500字，含成立时间、主营业务、核心产品、资质荣誉等 |
| 高新技术产品 | PS编号:产品名称 | 如"PS01:精密高强度铝合金门窗；PS02:智能高强度幕墙系统" |
| 经营范围 | 完整经营范围文本 | 与营业执照一致 |
| 高新技术领域 | 8大领域/子领域 | 如"先进制造与自动化/新型机械/机械基础件及制造技术" |

### Sheet2 - RD-研发项目（11列）

| 列 | 字段名 | 说明 |
|:--:|------|------|
| 1 | 编号 | 整数序号（1, 2, 3...） |
| 2 | 项目名称 | RD项目全称 |
| 3 | 开始时间 | YYYY-MM-DD |
| 4 | 完成时间 | YYYY-MM-DD |
| 5 | 研发预算（万） | 项目预算金额 |
| 6 | 实际费用（万） | 实际支出金额 |
| 7 | 负责人 | 项目负责人姓名 |
| 8 | 研发人数 | 参与研发人员数量 |
| 9 | 人工费 | 人工费用金额（万元） |
| 10 | 关联PS | 如"PS01"或"PS01,PS02" |
| 11 | 关联IP | 如"IP10,IP14,IP16" |

### Sheet3 - IP-知识产权（10列）

| 列 | 字段名 | 说明 |
|:--:|------|------|
| 1 | 知识产权编号 | IP01, IP02... |
| 2 | 知识产权名称 | 完整专利/软著名称 |
| 3 | 类别 | 发明授权/实用新型/软件著作权 |
| 4 | 获得方式 | 自主研发/受让/受赠 |
| 5 | 专利号/著作权号 | ZL202110846354.8 |
| 6 | 授权日期 | YYYY-MM-DD |
| 7 | 知识产权所属单位或个人 | 企业全称 |
| 8 | 摘要(限400字) | 国家知识产权局公布的摘要（软著填"无"） |
| 9 | 先进性说明(限400字) | 核心关键技术先进性说明 |
| 10 | 支持作用说明(限400字) | 对产品核心技术的支持作用说明 |

## 生成函数

```python
def generate_to_ai_excel(enterprise_info, rd_list, ip_list, output_path):
    """生成TO-AI汇总Excel表格
    
    将企业情况、RD研发项目、IP知识产权三表合一。
    
    Args:
        enterprise_info: dict，企业信息，包含：
            - name: 企业全称
            - website: 官方网站URL
            - intro: 企业简介（约300-500字）
            - high_tech_products: [{'ps_id': 'PS01', 'ps_name': '产品名'}, ...]
            - business_scope: 经营范围
            - tech_field: 高新技术领域
        rd_list: list，RD研发项目列表，每项dict包含：
            - rd_id: 编号（整数）
            - rd_name: 项目名称
            - start_date: 开始时间（YYYY-MM-DD）
            - end_date: 完成时间（YYYY-MM-DD）
            - budget: 研发预算（万元）
            - actual_cost: 实际费用（万元）
            - leader: 负责人
            - rnd_staff_count: 研发人数
            - labor_cost: 人工费（万元）
            - related_ps: 关联PS
            - related_ip: 关联IP
        ip_list: list，IP知识产权列表，每项dict包含：
            - ip_id: 知识产权编号（IP01, IP02...）
            - ip_name: 知识产权名称
            - ip_category: 类别
            - acquire_method: 获得方式
            - patent_number: 专利号/著作权号
            - auth_date: 授权日期
            - owner: 所属单位或个人
            - abstract: 摘要（限400字，软著不用提供）
            - key_tech_advanced: 先进性说明（限400字）
            - core_support: 支持作用说明（限400字）
        output_path: 输出文件路径
    
    Returns:
        dict: {
            'file_path': str,
            'sheet_count': int,  # 3
            'validation': dict,  # 校验结果
        }
    """
    import openpyxl
    from openpyxl.styles import Font, Alignment, PatternFill, Border, Side
    
    wb = openpyxl.Workbook()
    
    # 样式定义
    header_font = Font(name='宋体', bold=True, size=11, color='FFFFFF')
    header_fill = PatternFill(start_color='4472C4', end_color='4472C4', fill_type='solid')
    data_font = Font(name='宋体', size=10)
    title_font = Font(name='宋体', bold=True, size=12)
    wrap_alignment = Alignment(wrap_text=True, vertical='top', horizontal='left')
    center_alignment = Alignment(horizontal='center', vertical='center', wrap_text=True)
    thin_border = Border(
        left=Side(style='thin'), right=Side(style='thin'),
        top=Side(style='thin'), bottom=Side(style='thin')
    )
    
    # ========== Sheet 1: 企业情况 ==========
    ws1 = wb.active
    ws1.title = '企业情况'
    
    ps_str = ''
    if enterprise_info.get('high_tech_products'):
        ps_items = [f"{ps['ps_id']}:{ps['ps_name']}" for ps in enterprise_info['high_tech_products']]
        ps_str = '；'.join(ps_items)
    
    enterprise_rows = [
        ('名称', enterprise_info.get('name', '')),
        ('官网', enterprise_info.get('website', '')),
        ('简介', enterprise_info.get('intro', '')),
        ('高新技术产品', ps_str),
        ('经营范围', enterprise_info.get('business_scope', '')),
        ('高新技术领域', enterprise_info.get('tech_field', '')),
    ]
    
    for row_idx, (label, value) in enumerate(enterprise_rows, 1):
        ws1.cell(row=row_idx, column=1, value=label).font = title_font
        ws1.cell(row=row_idx, column=1).alignment = center_alignment
        ws1.cell(row=row_idx, column=1).fill = PatternFill(start_color='D9E1F2', end_color='D9E1F2', fill_type='solid')
        ws1.cell(row=row_idx, column=1).border = thin_border
        ws1.cell(row=row_idx, column=2, value=value).font = data_font
        ws1.cell(row=row_idx, column=2).alignment = wrap_alignment
        ws1.cell(row=row_idx, column=2).border = thin_border
    
    ws1.column_dimensions['A'].width = 18
    ws1.column_dimensions['B'].width = 80
    
    # ========== Sheet 2: RD-研发项目 ==========
    ws2 = wb.create_sheet('RD-研发项目')
    rd_headers = ['编号', '项目名称', '开始时间', '完成时间', '研发预算（万）', 
                  '实际费用（万）', '负责人', '研发人数', '人工费', '关联PS', '关联IP']
    
    for col_idx, header in enumerate(rd_headers, 1):
        cell = ws2.cell(row=1, column=col_idx, value=header)
        cell.font = header_font
        cell.fill = header_fill
        cell.alignment = center_alignment
        cell.border = thin_border
    
    for row_idx, rd in enumerate(rd_list, 2):
        values = [
            rd.get('rd_id', row_idx - 1), rd.get('rd_name', ''),
            rd.get('start_date', ''), rd.get('end_date', ''),
            rd.get('budget', 0), rd.get('actual_cost', 0),
            rd.get('leader', ''), rd.get('rnd_staff_count', 0),
            rd.get('labor_cost', 0), rd.get('related_ps', ''),
            rd.get('related_ip', ''),
        ]
        for col_idx, val in enumerate(values, 1):
            cell = ws2.cell(row=row_idx, column=col_idx, value=val)
            cell.font = data_font
            cell.alignment = wrap_alignment if col_idx == 2 else center_alignment
            cell.border = thin_border
    
    # ========== Sheet 3: IP-知识产权 ==========
    ws3 = wb.create_sheet('IP-知识产权')
    ip_headers = [
        '知识产权编号', '知识产权名称', '类别', '获得方式', '专利号/著作权号', '授权日期',
        '知识产权所属单位或个人',
        '国家知识产权局官方网站上公布的摘要(限400字，软件著作权不用提供)',
        '与本知识产权相关的核心关键技术先进性说明(限400字)',
        '该知识产权与本企业产品（服务）核心技术的支持作用说明(限400字)'
    ]
    
    for col_idx, header in enumerate(ip_headers, 1):
        cell = ws3.cell(row=1, column=col_idx, value=header)
        cell.font = header_font
        cell.fill = header_fill
        cell.alignment = center_alignment
        cell.border = thin_border
    
    for row_idx, ip in enumerate(ip_list, 2):
        values = [
            ip.get('ip_id', f'IP{row_idx-1:02d}'), ip.get('ip_name', ''),
            ip.get('ip_category', ''), ip.get('acquire_method', '自主研发'),
            ip.get('patent_number', ''), ip.get('auth_date', ''),
            ip.get('owner', ''),
            '无' if ip.get('ip_category') == '软件著作权' else ip.get('abstract', ''),
            ip.get('key_tech_advanced', ''), ip.get('core_support', ''),
        ]
        for col_idx, val in enumerate(values, 1):
            cell = ws3.cell(row=row_idx, column=col_idx, value=val)
            cell.font = data_font
            cell.alignment = wrap_alignment if col_idx >= 8 else center_alignment
            cell.border = thin_border
    
    wb.save(output_path)
    
    return {
        'file_path': output_path,
        'sheet_count': 3,
        'enterprise_row_count': len(enterprise_rows),
        'rd_row_count': len(rd_list),
        'ip_row_count': len(ip_list),
    }
```

## 校验函数

```python
def validate_to_ai_excel(file_path):
    """校验TO-AI Excel表格格式和数据完整性
    
    校验项：
    - Sheet数量是否为3
    - Sheet名称是否正确
    - 企业情况Sheet的6行标签是否完整
    - RD表和IP表头是否正确
    - IP表第8-10列（摘要/先进性/支持作用）是否超过400字限制
    
    Returns:
        dict: {'passed': bool, 'errors': list, 'warnings': list}
    """
    import openpyxl
    
    wb = openpyxl.load_workbook(file_path)
    result = {
        'file_path': file_path,
        'sheets': wb.sheetnames,
        'passed': True,
        'errors': [],
        'warnings': [],
    }
    
    # 校验Sheet数量
    if len(wb.sheetnames) != 3:
        result['passed'] = False
        result['errors'].append(f'Sheet数量应为3，实际{len(wb.sheetnames)}')
    
    # 校验Sheet名称
    expected_sheets = ['企业情况', 'RD-研发项目', 'IP-知识产权']
    for s in expected_sheets:
        if s not in wb.sheetnames:
            result['passed'] = False
            result['errors'].append(f'缺少Sheet: {s}')
    
    # 校验企业情况Sheet
    if '企业情况' in wb.sheetnames:
        ws = wb['企业情况']
        expected_labels = ['名称', '官网', '简介', '高新技术产品', '经营范围', '高新技术领域']
        for i, label in enumerate(expected_labels, 1):
            if ws.cell(row=i, column=1).value != label:
                result['warnings'].append(f'企业情况Sheet第{i}行标签应为"{label}"')
        if not ws.cell(row=1, column=2).value:
            result['errors'].append('企业名称为空')
            result['passed'] = False
    
    # 校验RD-研发项目Sheet
    if 'RD-研发项目' in wb.sheetnames:
        ws = wb['RD-研发项目']
        expected_headers = ['编号', '项目名称', '开始时间', '完成时间', '研发预算（万）', 
                           '实际费用（万）', '负责人', '研发人数', '人工费', '关联PS', '关联IP']
        for i, header in enumerate(expected_headers, 1):
            if ws.cell(row=1, column=i).value != header:
                result['warnings'].append(f'RD表第{i}列表头应为"{header}"')
        if ws.max_row < 2:
            result['errors'].append('RD表无数据行')
            result['passed'] = False
    
    # 校验IP-知识产权Sheet
    if 'IP-知识产权' in wb.sheetnames:
        ws = wb['IP-知识产权']
        # 校验400字限制
        for row_idx in range(2, ws.max_row + 1):
            for col_idx in [8, 9, 10]:
                val = ws.cell(row=row_idx, column=col_idx).value
                if val and len(str(val)) > 400:
                    result['warnings'].append(f'IP表第{row_idx}行第{col_idx}列内容超过400字（{len(str(val))}字）')
    
    if result['errors']:
        result['passed'] = False
    
    return result
```

## 撰写要求

1. 企业简介约300-500字，包含成立时间、主营业务、核心产品、资质荣誉等
2. 高新技术产品按"PS编号:产品名称"格式，分号分隔
3. RD项目编号为整数序号（1, 2, 3...），日期格式YYYY-MM-DD
4. IP类别为发明授权/实用新型/软件著作权，获得方式为自主研发/受让/受赠
5. 摘要、先进性说明、支持作用说明各限400字（软件著作权不用提供摘要）
6. 关联PS格式如"PS01"或"PS01,PS02"，关联IP格式如"IP10,IP14,IP16"

## 高新技术领域填写

TO-AI 表格 Sheet1 企业情况"高新技术领域"行填写值必须与RD/PS表一致。

优先级：所得税申报表 > 申请书 > 项目资料推断

## 审核校验

### 校验项
- Sheet数量是否为3（企业情况/RD-研发项目/IP-知识产权）
- Sheet名称是否正确
- 企业情况Sheet的6行标签是否完整
- RD表和IP表头是否正确
- IP表第8-10列（摘要/先进性/支持作用）是否超过400字限制
- 校验结果返回passed/errors/warnings

### 审核报告要求
审核通过条件：
- TO-AI表格3个Sheet完整（企业情况6行+RD表头+数据行+IP表头+数据行）
- 字段完整
- 400字限制校验通过

## 通用禁止事项

1. 禁止编造内容，所有数据必须来自真实文件
2. 禁止跳过脚本执行
3. 禁止跳过审核步骤
4. 禁止自行兜底
5. 禁止合并/简化字段名
6. 字段字数超标时禁止算法截断，通过优化表述调整字数
7. 禁止从零模仿模板生成表格
