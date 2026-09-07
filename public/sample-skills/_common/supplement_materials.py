#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
补充资料机制工具（supplement_materials）

用途：所有技能给用户提供一个补充资料清单文档，告诉用户把补充资料放到指定目录；
      技能执行时先检查补充目录，读取分析新文件，整理后更新文件图谱和经验库。

核心原则（v1.2.0优化）：
1. 详细列出每项需补充的资料：每项必须包含具体内容要求、数量、时间范围、命名规范、质量要求
2. 只输出需要补充的资料：基于本地资料筛查结果对比，已有资料不输出
3. 排除财务资料：财务类资料不输出（由财务技能单独处理）
4. 明确告诉客户如何提供：每项资料说明"客户需要做什么"、"提供什么格式"、"放在哪里"

CLI 用法：
    # 扫描补充资料目录
    python supplement_materials.py scan --project-root "项目根目录" --skill "技能名"

    # 整理补充资料
    python supplement_materials.py organize --project-root "项目根目录" --skill "技能名"

    # 生成补充资料清单
    python supplement_materials.py checklist --project-root "项目根目录" --skill "技能名"

输出：JSON 格式结果
"""

import os
import json
import shutil
import re
import argparse
from datetime import datetime

KNOWLEDGE_BASE_DIR = os.path.join('.trae', 'project_knowledge')
FILE_MAP_PATH = os.path.join(KNOWLEDGE_BASE_DIR, 'file_map.json')

# ============================================================
# 兼容性导入：尝试从同目录模块导入依赖函数
# 模块五依赖模块一（archive_extractor）和模块二（knowledge_base）的函数
# 以及模块四（file_map）的 load_file_map / add_file_to_map 函数
# ============================================================

try:
    # 从模块一导入文件扫描函数
    from archive_extractor import scan_files_with_archive_support
except ImportError:
    def scan_files_with_archive_support(data_dir, file_patterns=None, archive_temp_dir=None, _depth=0, max_depth=15):
        """占位实现：模块一不可用时使用基础os.walk扫描"""
        found_files = []
        if not os.path.isdir(data_dir):
            return found_files
        for root, dirs, files in os.walk(data_dir):
            dirs[:] = [d for d in dirs if not d.startswith('.')]
            for fname in files:
                found_files.append(os.path.join(root, fname))
        return found_files

try:
    # 从模块二导入知识库更新函数
    from knowledge_base import update_knowledge_after_skill
except ImportError:
    def update_knowledge_after_skill(skill_name, enterprise_name, application_year,
                                      nodes=None, edges=None, progress_item=None,
                                      file_structure_entries=None, data_summary_updates=None,
                                      experience_entry=None):
        """占位实现：模块二不可用时仅打印日志"""
        print(f"[知识库] {skill_name} 欲更新知识库但 knowledge_base 模块不可用")


def load_file_map():
    """加载文件图谱（模块四的兼容实现）
    
    读取 .trae/project_knowledge/file_map.json 文件图谱。
    模块四（file_map）未抽取为独立文件时使用此兼容实现。
    """
    if os.path.exists(FILE_MAP_PATH):
        try:
            with open(FILE_MAP_PATH, 'r', encoding='utf-8') as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError):
            pass
    return None


def add_file_to_map(file_path, category='', file_type='', related_id=None,
                    related_name=None, content_summary='', validity='valid',
                    keywords=None, skill_name=''):
    """添加文件到图谱（模块四的兼容实现）
    
    将文件信息记录到 .trae/project_knowledge/file_map.json。
    模块四（file_map）未抽取为独立文件时使用此兼容实现。
    """
    file_map = load_file_map() or {'files': {}, 'categories': {}, 'quick_index': {}}
    files = file_map.setdefault('files', {})

    file_key = os.path.abspath(file_path)
    files[file_key] = {
        'path': file_path,
        'category': category,
        'file_type': file_type,
        'related_id': related_id or '',
        'related_name': related_name or '',
        'content_summary': content_summary,
        'validity': validity,
        'keywords': keywords or [],
        'added_by': skill_name,
        'added_at': datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    }

    # 更新类别索引
    categories = file_map.setdefault('categories', {})
    if category not in categories:
        categories[category] = []
    if file_key not in categories[category]:
        categories[category].append(file_key)

    try:
        os.makedirs(os.path.dirname(FILE_MAP_PATH), exist_ok=True)
        with open(FILE_MAP_PATH, 'w', encoding='utf-8') as f:
            json.dump(file_map, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


# ============================================================
# 详细补充资料清单模板（v1.2.0 重构）
# 每项包含：
#   - name: 资料名称
#   - category: 资料类别（基础信息/知识产权/研发项目/高新产品/科技人员/管理证明/合同发票/照片资料）
#   - content_requirements: 详细内容要求（列出客户需要提供的具体内容）
#   - quantity_required: 数量要求（如"3份"、"按IP数量"、"≥10份"）
#   - time_range: 时间范围要求
#   - format: 格式要求
#   - size_limit: 大小限制
#   - naming_convention: 命名规范（具体示例）
#   - quality_requirements: 质量要求
#   - is_financial: 是否为财务资料（True则不输出，由财务技能处理）
#   - required: 是否必须
#   - check_field: 在analysis_results中对应的字段路径，用于判断是否已有
#                  格式：(category_key, field_name) 如 ('basic_info', 'business_license')
#   - check_type: 判断方式（'boolean'字段为True即存在 / 'list_count'列表数量 / 'list_min'列表至少N项）
#   - check_threshold: 配合check_type使用的阈值（仅list_min时使用）
#   - customer_action: 客户具体操作指引（从哪里获取、如何提供）
# ============================================================

SUPPLEMENT_TEMPLATES = {
    'gxtz-info-collector': {
        'subdir': '07_资料收集清单',
        'items': [
            # === 基础信息类 ===
            {
                'name': '营业执照扫描件',
                'category': '基础信息',
                'content_requirements': [
                    '最新版营业执照（三证合一或五证合一）',
                    '包含企业名称、统一社会信用代码、成立日期、注册资本、经营范围',
                    '在有效期内，无经营异常'
                ],
                'quantity_required': '1份',
                'time_range': '当前有效',
                'format': 'PNG/JPG',
                'size_limit': '≤500KB',
                'naming_convention': '营业执照.png',
                'quality_requirements': '分辨率≥300dpi，文字清晰可辨，四角完整',
                'is_financial': False,
                'required': True,
                'check_field': ('basic_info', 'business_license'),
                'check_type': 'boolean',
                'customer_action': '从工商档案中提取最新营业执照，扫描或拍照后保存为PNG格式'
            },
            {
                'name': '企业承诺书',
                'category': '基础信息',
                'content_requirements': [
                    '高新技术企业认定申请书中的企业承诺书页面',
                    '法定代表人签字（手写签字，非打印）',
                    '加盖企业公章（红色印章）',
                    '承诺内容完整，无修改痕迹'
                ],
                'quantity_required': '1份',
                'time_range': '申报当年',
                'format': 'PDF',
                'size_limit': '≤2MB',
                'naming_convention': '企业承诺书.pdf',
                'quality_requirements': '签字和公章清晰可辨，无遮挡',
                'is_financial': False,
                'required': True,
                'check_field': ('basic_info', 'commitment_letter'),
                'check_type': 'boolean',
                'customer_action': '从高新认定申请书导出承诺书页面，法人签字并加盖公章后扫描为PDF'
            },
            {
                'name': '法定代表人身份证扫描件',
                'category': '基础信息',
                'content_requirements': [
                    '身份证正反面（人像面+国徽面）',
                    '在有效期内',
                    '信息清晰可辨'
                ],
                'quantity_required': '1份（正反面合并）',
                'time_range': '当前有效',
                'format': 'PDF/JPG',
                'size_limit': '≤2MB',
                'naming_convention': '法人身份证.pdf',
                'quality_requirements': '分辨率≥300dpi，无遮挡，无反光',
                'is_financial': False,
                'required': False,
                'check_field': ('basic_info', 'legal_person_id'),
                'check_type': 'boolean',
                'customer_action': '法人身份证正反面扫描或拍照，合并为一个PDF文件'
            },
            # 财务资料项（is_financial=True，不输出）
            {
                'name': '财务审计报告',
                'category': '财务资料',
                'is_financial': True,
                'check_field': ('financial', 'audit_reports'),
                'check_type': 'list_min',
                'check_threshold': 3
            },
            {
                'name': '研发费用专项审计报告',
                'category': '财务资料',
                'is_financial': True,
                'check_field': ('financial', 'rd_audit_report'),
                'check_type': 'boolean'
            },
            {
                'name': '高新技术产品收入专项审计报告',
                'category': '财务资料',
                'is_financial': True,
                'check_field': ('financial', 'ps_audit_report'),
                'check_type': 'boolean'
            },
            {
                'name': '企业所得税年度纳税申报表',
                'category': '财务资料',
                'is_financial': True,
                'check_field': ('financial', 'tax_returns'),
                'check_type': 'list_min',
                'check_threshold': 3
            },
            {
                'name': '纳税证明',
                'category': '财务资料',
                'is_financial': True,
                'check_field': ('financial', 'tax_certificates'),
                'check_type': 'list_min',
                'check_threshold': 3
            },
            {
                'name': '研发费用辅助账',
                'category': '财务资料',
                'is_financial': True,
                'check_field': ('financial', 'rd_auxiliary_account'),
                'check_type': 'list_min',
                'check_threshold': 3
            },
        ]
    },
    'gxtz-ip-materials': {
        'subdir': '02_知识产权证明',
        'items': [
            {
                'name': 'I类知识产权证书扫描件（发明专利/集成电路布图设计）',
                'category': '知识产权',
                'content_requirements': [
                    '所有I类知识产权证书：发明专利证书、集成电路布图设计登记证书',
                    '证书首页（含专利号、授权日期）',
                    '权利要求书首页',
                    '说明书首页',
                    '权利人名称必须为申报企业全称',
                    '授权日期不限（I类无时间限制）'
                ],
                'quantity_required': '每项I类知识产权1份PDF',
                'time_range': '授权日期不限',
                'format': 'PDF',
                'size_limit': '单个≤2MB',
                'naming_convention': 'IP{编号}_{知识产权名称}.pdf，例：IP01_一种XXX方法.pdf',
                'quality_requirements': '300dpi扫描，文字清晰可辨，无遮挡',
                'is_financial': False,
                'required': True,
                'check_field': ('ip', 'i_class_certificates'),
                'check_type': 'list_min',
                'check_threshold': 1,
                'customer_action': '从国家知识产权局官网或专利证书档案中，导出/扫描每项I类IP的证书扫描件，按命名规范保存'
            },
            {
                'name': 'II类知识产权证书扫描件（实用新型/外观设计/软件著作权）',
                'category': '知识产权',
                'content_requirements': [
                    '所有II类知识产权证书：实用新型专利证书、外观设计专利证书、软件著作权登记证书',
                    '授权日期建议在近三年内（2023-2025）',
                    '证书首页（含专利号/登记号、授权日期）',
                    '权利人名称必须为申报企业全称'
                ],
                'quantity_required': '每项II类知识产权1份PDF',
                'time_range': '授权日期建议近三年内',
                'format': 'PDF',
                'size_limit': '单个≤2MB',
                'naming_convention': 'IP{编号}_{知识产权名称}.pdf，例：IP05_一种XXX装置.pdf',
                'quality_requirements': '300dpi扫描，文字清晰可辨，无遮挡',
                'is_financial': False,
                'required': True,
                'check_field': ('ip', 'ii_class_certificates'),
                'check_type': 'list_min',
                'check_threshold': 1,
                'customer_action': '从国家知识产权局官网、中国版权保护中心官网或专利证书档案中，导出/扫描每项II类IP的证书扫描件'
            },
            {
                'name': '软件著作权附属材料（仅软著IP需提供）',
                'category': '知识产权',
                'content_requirements': [
                    '每项软著IP需提供3类附属材料：',
                    '1) 软件著作权申请表：版权局登记的原始申请表（含软件名称、版本号、著作权人、登记号）',
                    '2) 软件源程序文档：前30页+后30页源代码（共60页），含软件名称页眉、页码连续',
                    '3) 软件设计说明书或用户手册：图文并茂，体现软件功能描述、技术架构、操作说明',
                    '附属材料需与软著证书合并为单个PDF上传网报系统'
                ],
                'quantity_required': '每项软著IP提供3份附属材料（合并为1份PDF）',
                'time_range': '与软著证书对应',
                'format': 'PDF',
                'size_limit': '合并后单个≤5MB',
                'naming_convention': 'IP{编号}_软著附属材料.pdf',
                'quality_requirements': '源代码页眉含软件名称、页码连续；设计说明书图文清晰',
                'is_financial': False,
                'required': True,
                'check_field': ('ip', 'software_copyright_attachments'),
                'check_type': 'list_min',
                'check_threshold': 1,
                'customer_action': '从版权登记档案中提取申请表、源程序文档，编写设计说明书或用户手册，合并为PDF'
            },
            {
                'name': '专利年费缴费发票（广东省申报必须）',
                'category': '知识产权',
                'content_requirements': [
                    '发明专利和实用新型专利的最近一次年费缴费发票',
                    '发票需包含：专利号、缴费年度、缴费金额、缴费日期',
                    '广东省申报必须提供，深圳市申报建议提供',
                    '用于证明专利处于有效状态'
                ],
                'quantity_required': '每项发明+实用新型专利1份',
                'time_range': '最近一次年费缴纳',
                'format': 'PDF',
                'size_limit': '单个≤1MB',
                'naming_convention': 'IP{编号}_年费发票.pdf',
                'quality_requirements': '发票信息清晰可辨',
                'is_financial': False,
                'required': False,
                'check_field': ('ip', 'annual_fee_invoices'),
                'check_type': 'list_min',
                'check_threshold': 1,
                'customer_action': '从国家知识产权局官网或缴费记录中提取年费缴纳发票，按IP编号命名'
            },
            {
                'name': '知识产权转让合同和手续合格通知书（受让IP必须）',
                'category': '知识产权',
                'content_requirements': [
                    '受让的知识产权必须提供：',
                    '1) 知识产权转让合同/许可合同：确认转让人、受让人、转让日期、转让费用、权利范围',
                    '2) 知识产权局手续合格通知书：经知识产权局变更备案（仅合同无效，必须提供通知书）',
                    '3) 全球独占许可协议（II类IP授权日期不在近三年时）：许可期限≥5年、全球范围、独占性质'
                ],
                'quantity_required': '每项受让IP提供2份材料（合同+通知书）',
                'time_range': '转让/许可日期≤申报年份',
                'format': 'PDF',
                'size_limit': '单个≤5MB',
                'naming_convention': 'IP{编号}_转让合同.pdf、IP{编号}_手续合格通知书.pdf',
                'quality_requirements': '合同签字盖章清晰，通知书为知识产权局原件扫描',
                'is_financial': False,
                'required': False,
                'check_field': ('ip', 'transfer_documents'),
                'check_type': 'list_min',
                'check_threshold': 1,
                'customer_action': '从合同档案中提取转让合同，从知识产权局官网下载手续合格通知书，按IP编号命名'
            },
            {
                'name': '专利登记簿副本（建议提供）',
                'category': '知识产权',
                'content_requirements': [
                    '发明专利的专利登记簿副本',
                    '法律状态为"有效"',
                    '无质押、无效宣告、转让记录',
                    '近3个月内出具'
                ],
                'quantity_required': '每项发明专利1份（按需）',
                'time_range': '近3个月内出具',
                'format': 'PDF',
                'size_limit': '单个≤1MB',
                'naming_convention': 'IP{编号}_登记簿副本.pdf',
                'quality_requirements': '知识产权局出具，红章清晰',
                'is_financial': False,
                'required': False,
                'check_field': ('ip', 'register_copies'),
                'check_type': 'list_min',
                'check_threshold': 0,
                'customer_action': '从国家知识产权局官网申请登记簿副本，下载PDF'
            },
        ]
    },
    'gxtz-staff-materials': {
        'subdir': '05_科技人员材料',
        'items': [
            {
                'name': '上年12月社保缴费证明（带公章）',
                'category': '科技人员',
                'content_requirements': [
                    f'申报年份的上一年12月份社保缴费证明',
                    '由社保局出具（非企业自行打印）',
                    '必须带红色公章（社保局业务专用章）',
                    '包含字段：单位名称、人员姓名、身份证号、缴费起止时间、缴费基数',
                    '覆盖全部科技人员',
                    '用途：作为科技人员认定的基准依据'
                ],
                'quantity_required': '1份',
                'time_range': '上年12月份（如申报2026年则提供2025年12月）',
                'format': 'PDF',
                'size_limit': '≤5MB',
                'naming_convention': '{企业名称}_上年12月社保缴费证明.pdf',
                'quality_requirements': '公章清晰可辨，人员信息完整',
                'is_financial': False,
                'required': True,
                'check_field': ('staff', 'social_security'),
                'check_type': 'boolean',
                'customer_action': '前往参保所在地社保局大厅或官网申请上年12月社保缴费证明（带公章），保存为PDF'
            },
            {
                'name': '科技人员名册（参考派成铝业14列格式）',
                'category': '科技人员',
                'content_requirements': [
                    '科技人员名册Excel文件，按派成铝业参考格式14列结构：',
                    '列1：序号',
                    '列2：姓名',
                    '列3：入职时间（YYYY-MM-DD）',
                    '列4：身份证号码',
                    '列5：姓别（男/女）',
                    '列6：学历（大专/本科/硕士/博士）',
                    '列7：毕业院校',
                    '列8：专业',
                    '列9：部门（研发部门名称）',
                    '列10：岗位（研发工程师/技术员等）',
                    '列11：申报年份在职时间（天，累计≥183天）',
                    '列12：职称（如有，如二级建造师、工程师等）',
                    '列13：工资（月工资，元）',
                    '列14：日期（统计截止日期，如2025-12-31）',
                    'Sheet名：研发人员名单',
                    '筛选条件：必须在上年12月社保缴费记录中，累计工作时长≥183天，入职时间≤上年12月'
                ],
                'quantity_required': '1份（含全部科技人员）',
                'time_range': '统计截止日期为上年12月31日',
                'format': 'XLSX',
                'size_limit': '≤2MB',
                'naming_convention': '{企业名称}_科技人员名册_{上年}.xlsx',
                'quality_requirements': '14列完整，身份证号码准确，在职时间计算正确',
                'is_financial': False,
                'required': True,
                'check_field': ('staff', 'info_table'),
                'check_type': 'boolean',
                'customer_action': 'HR部门按14列格式整理科技人员名册，每人一行，确保与上年12月社保名单一致'
            },
            {
                'name': '科技人员学历证书扫描件',
                'category': '科技人员',
                'content_requirements': [
                    '每位科技人员的最高学历证书扫描件',
                    '毕业证书或学位证书',
                    '学历信息需与名册中的"学历"列一致',
                    '证书清晰可辨，包含姓名、专业、毕业院校、毕业日期'
                ],
                'quantity_required': '每位科技人员1份',
                'time_range': '不限',
                'format': 'PDF',
                'size_limit': '单个≤2MB',
                'naming_convention': '{姓名}_学历证书.pdf，例：张三_学历证书.pdf',
                'quality_requirements': '300dpi扫描，文字清晰可辨',
                'is_financial': False,
                'required': True,
                'check_field': ('staff', 'diplomas'),
                'check_type': 'list_min',
                'check_threshold': 1,
                'customer_action': '收集每位科技人员的学历证书，扫描为PDF，按姓名命名'
            },
            {
                'name': '科技人员职称证书扫描件（如有职称）',
                'category': '科技人员',
                'content_requirements': [
                    '科技人员的职称证书（工程师、高级工程师、二级建造师等）',
                    '人才证书（高层次人才、技能人才证书等）',
                    '如有职称必须提供，无职称可不提供'
                ],
                'quantity_required': '有职称的科技人员每人1份',
                'time_range': '不限',
                'format': 'PDF',
                'size_limit': '单个≤2MB',
                'naming_convention': '{姓名}_职称证书.pdf，例：张三_二级建造师.pdf',
                'quality_requirements': '300dpi扫描，文字清晰可辨',
                'is_financial': False,
                'required': False,
                'check_field': ('staff', 'professional_certificates'),
                'check_type': 'list_min',
                'check_threshold': 0,
                'customer_action': '收集有职称的科技人员的职称证书，扫描为PDF，按姓名命名'
            },
        ]
    },
    'gxtz-rd-report': {
        'subdir': '01_研发立项报告',
        'items': [
            {
                'name': '研发项目立项书（企业内部立项文件）',
                'category': '研发项目',
                'content_requirements': [
                    '企业内部研发项目立项文件（如有）',
                    '包含：项目名称、立项日期、项目负责人、项目预算、研发内容、预期目标',
                    '如企业未做过正式立项，可提供研发计划书或研发任务书'
                ],
                'quantity_required': '每个研发项目1份（如有）',
                'time_range': '近三年内立项',
                'format': 'DOCX/PDF',
                'size_limit': '单个≤5MB',
                'naming_convention': 'RD{编号}_{项目名称}_立项书.docx',
                'quality_requirements': '内容完整，包含项目预算和研发内容',
                'is_financial': False,
                'required': False,
                'check_field': ('rd', 'reports'),
                'check_type': 'list_min',
                'check_threshold': 1,
                'customer_action': '从企业研发档案中提取立项文件，按RD编号命名；若无正式立项文件，提供研发计划书'
            },
            {
                'name': '研发项目验收报告（已验收项目）',
                'category': '研发项目',
                'content_requirements': [
                    '已验收的研发项目验收报告',
                    '包含：项目完成情况、技术成果、验收结论、验收人员签字',
                    '仅已验收项目需提供'
                ],
                'quantity_required': '每个已验收项目1份（如有）',
                'time_range': '近三年内验收',
                'format': 'DOCX/PDF',
                'size_limit': '单个≤5MB',
                'naming_convention': 'RD{编号}_{项目名称}_验收报告.docx',
                'quality_requirements': '验收结论明确，验收人员签字完整',
                'is_financial': False,
                'required': False,
                'check_field': ('rd', 'acceptance_reports'),
                'check_type': 'list_min',
                'check_threshold': 0,
                'customer_action': '从企业研发档案中提取验收报告，按RD编号命名'
            },
        ]
    },
    'gxtz-achievement-materials': {
        'subdir': '03_成果转化证明',
        'items': [
            {
                'name': '高新产品销售合同',
                'category': '合同发票',
                'content_requirements': [
                    '近三年高新产品销售合同：',
                    '  - 2023年：10-12份',
                    '  - 2024年：10-12份',
                    '  - 2025年：18-20份',
                    '单份合同金额≥10万元',
                    '合同需包含：合同编号、签订日期、客户名称、产品名称、金额、签字盖章',
                    '客户数量≥5家，单一客户合同占比≤50%',
                    '合同时间需在近三年内'
                ],
                'quantity_required': '近三年合计40-50份',
                'time_range': '2023-2025年',
                'format': 'PDF',
                'size_limit': '单个≤10MB',
                'naming_convention': '{年份}_{客户名称}_{合同编号}.pdf',
                'quality_requirements': '签字盖章清晰，合同内容完整',
                'is_financial': False,
                'required': True,
                'check_field': ('contracts', 'sales_contracts'),
                'check_type': 'list_min',
                'check_threshold': 10,
                'customer_action': '从销售部门提取近三年高新产品销售合同，按年份_客户_编号命名，扫描为PDF'
            },
            {
                'name': '高新产品销售发票',
                'category': '合同发票',
                'content_requirements': [
                    '对应销售合同的发票',
                    '20位发票号码',
                    '发票金额、客户名称、产品名称需与合同一致',
                    '发票时间需在合同签订后合理时间内',
                    '每份合同对应1-2张发票'
                ],
                'quantity_required': '近三年合计40-100份',
                'time_range': '2023-2025年',
                'format': 'PDF',
                'size_limit': '单个≤2MB',
                'naming_convention': '{年份}_{客户名称}_发票_{发票号码后4位}.pdf',
                'quality_requirements': '发票信息清晰可辨',
                'is_financial': False,
                'required': True,
                'check_field': ('contracts', 'sales_invoices'),
                'check_type': 'list_min',
                'check_threshold': 10,
                'customer_action': '从开票系统中导出对应合同的发票，扫描或电子发票直接保存为PDF'
            },
            {
                'name': '高新产品检测报告',
                'category': '高新产品',
                'content_requirements': [
                    '第三方检测机构出具的产品检测报告',
                    '检测机构需具备CMA/CNAS资质',
                    '检测报告包含：产品名称、检测项目、检测结论、检测日期、报告编号',
                    '覆盖主要高新产品（PS表对应产品）'
                ],
                'quantity_required': '每个高新产品1份（按PS表）',
                'time_range': '近三年内',
                'format': 'PDF',
                'size_limit': '单个≤10MB',
                'naming_convention': 'PS{编号}_{产品名称}_检测报告.pdf',
                'quality_requirements': 'CMA/CNAS章清晰，检测结论明确',
                'is_financial': False,
                'required': True,
                'check_field': ('products', 'test_reports'),
                'check_type': 'list_min',
                'check_threshold': 1,
                'customer_action': '从检测机构获取产品检测报告，按PS编号命名，扫描为PDF'
            },
        ]
    },
    'gxtz-ps-materials': {
        'subdir': '04_高新产品证明',
        'items': [
            {
                'name': 'PS表对应产品销售合同',
                'category': '合同发票',
                'content_requirements': [
                    'PS表对应的高新产品销售合同',
                    '合同金额需与PS表收入数据一致',
                    '合同客户名称、产品名称需与PS表一致',
                    '每个PS产品至少3-5份销售合同'
                ],
                'quantity_required': '每个PS产品3-5份',
                'time_range': '近三年内',
                'format': 'PDF',
                'size_limit': '单个≤10MB',
                'naming_convention': 'PS{编号}_{客户名称}_{合同编号}.pdf',
                'quality_requirements': '签字盖章清晰，合同内容完整',
                'is_financial': False,
                'required': True,
                'check_field': ('ps', 'sales_contracts'),
                'check_type': 'list_min',
                'check_threshold': 1,
                'customer_action': '按PS表产品提取销售合同，确保客户名称、产品名称与PS表一致'
            },
            {
                'name': 'PS表对应产品销售发票',
                'category': '合同发票',
                'content_requirements': [
                    'PS表对应产品销售合同对应的发票',
                    '20位发票号码',
                    '发票金额、客户、产品需与合同一致',
                    '每个PS产品至少3-5张发票'
                ],
                'quantity_required': '每个PS产品3-5张',
                'time_range': '近三年内',
                'format': 'PDF',
                'size_limit': '单个≤2MB',
                'naming_convention': 'PS{编号}_{客户名称}_发票_{发票号码后4位}.pdf',
                'quality_requirements': '发票信息清晰可辨',
                'is_financial': False,
                'required': True,
                'check_field': ('ps', 'sales_invoices'),
                'check_type': 'list_min',
                'check_threshold': 1,
                'customer_action': '从开票系统提取PS产品对应发票，扫描或电子发票保存为PDF'
            },
            {
                'name': 'PS表产品第三方检测报告',
                'category': '高新产品',
                'content_requirements': [
                    '第三方检测机构出具的产品检测报告',
                    '检测机构需具备CMA/CNAS资质',
                    '检测报告覆盖PS表中的主要产品',
                    '包含：产品名称、检测项目、技术指标、检测结论、检测日期'
                ],
                'quantity_required': '每个PS产品1份',
                'time_range': '近三年内',
                'format': 'PDF',
                'size_limit': '单个≤10MB',
                'naming_convention': 'PS{编号}_{产品名称}_检测报告.pdf',
                'quality_requirements': 'CMA/CNAS章清晰，技术指标完整',
                'is_financial': False,
                'required': True,
                'check_field': ('products', 'test_reports'),
                'check_type': 'list_min',
                'check_threshold': 1,
                'customer_action': '从检测机构获取产品检测报告，按PS编号命名'
            },
            {
                'name': 'PS表产品照片（带铭牌）',
                'category': '照片资料',
                'content_requirements': [
                    '产品实物照片，需包含产品铭牌',
                    '铭牌信息：产品名称、型号、生产日期、生产企业名称',
                    '产品照片需体现产品全貌和技术特征',
                    '每个PS产品至少1-3张照片'
                ],
                'quantity_required': '每个PS产品1-3张',
                'time_range': '近三年内拍摄',
                'format': 'JPG/PNG',
                'size_limit': '单个≤5MB',
                'naming_convention': 'PS{编号}_{产品名称}_照片{序号}.jpg',
                'quality_requirements': '分辨率≥300dpi，铭牌信息清晰可辨',
                'is_financial': False,
                'required': True,
                'check_field': ('photos', 'product_photos'),
                'check_type': 'list_min',
                'check_threshold': 1,
                'customer_action': '拍摄产品实物照片，确保铭牌清晰可见，按PS编号命名'
            },
            {
                'name': 'PS表产品技术说明文档',
                'category': '高新产品',
                'content_requirements': [
                    '产品技术说明文档（如已有可提供）',
                    '包含：产品技术原理、关键技术指标、创新点、应用场景',
                    '文档需体现产品与知识产权的关联关系'
                ],
                'quantity_required': '每个PS产品1份',
                'time_range': '不限',
                'format': 'DOCX/PDF',
                'size_limit': '单个≤5MB',
                'naming_convention': 'PS{编号}_{产品名称}_技术说明.docx',
                'quality_requirements': '技术内容详实，体现关键技术',
                'is_financial': False,
                'required': False,
                'check_field': ('ps', 'tech_descriptions'),
                'check_type': 'list_min',
                'check_threshold': 0,
                'customer_action': '从研发部门或市场部门提取产品技术说明文档，按PS编号命名'
            },
        ]
    },
    'gxtz-management-materials': {
        'subdir': '06_管理制度材料',
        'items': [
            {
                'name': '研发组织管理制度文件',
                'category': '管理证明',
                'content_requirements': [
                    '研发组织管理制度文件（3份）：',
                    '1) 研发项目管理制度：项目立项、过程管理、验收、知识产权管理',
                    '2) 研发机构管理制度：研发部门组织架构、岗位职责、考核办法',
                    '3) 产学研合作制度：合作院校、合作项目、合作成果、合作协议',
                    '所有制度需企业正式发布（带文件编号、发布日期、签发人）'
                ],
                'quantity_required': '3份（每类制度1份）',
                'time_range': '近三年内发布',
                'format': 'DOCX/PDF',
                'size_limit': '单个≤5MB',
                'naming_convention': '研发管理制度_{制度类型}.docx',
                'quality_requirements': '内容完整，正式发布，有签发人和文件编号',
                'is_financial': False,
                'required': True,
                'check_field': ('management', 'rd_organization_documents'),
                'check_type': 'list_min',
                'check_threshold': 3,
                'customer_action': '从企业制度档案中提取研发管理制度文件，确保3类制度齐全'
            },
            {
                'name': '研发设备清单',
                'category': '管理证明',
                'content_requirements': [
                    '研发设备清单Excel文件，包含：',
                    '设备名称、型号、数量、单价、总价、采购日期、使用部门',
                    '要求：≥10台设备、总值≥50万元、80%以上设备研发部门使用',
                    '设备清单需与现场设备一致'
                ],
                'quantity_required': '1份',
                'time_range': '截至上年12月31日',
                'format': 'XLSX',
                'size_limit': '≤2MB',
                'naming_convention': '{企业名称}_研发设备清单.xlsx',
                'quality_requirements': '信息完整，符合≥10台、≥50万元要求',
                'is_financial': False,
                'required': True,
                'check_field': ('equipment', 'equipment_list'),
                'check_type': 'boolean',
                'customer_action': '从资产管理部门提取研发设备清单，确保≥10台、≥50万元、80%研发部门使用'
            },
            {
                'name': '研发人员绩效考核制度',
                'category': '管理证明',
                'content_requirements': [
                    '研发人员绩效考核制度文件',
                    '包含：考核指标、考核周期、考核办法、奖惩措施',
                    '需企业正式发布（带文件编号、发布日期）'
                ],
                'quantity_required': '1份',
                'time_range': '近三年内发布',
                'format': 'DOCX/PDF',
                'size_limit': '≤5MB',
                'naming_convention': '研发人员绩效考核制度.docx',
                'quality_requirements': '内容完整，正式发布',
                'is_financial': False,
                'required': True,
                'check_field': ('management', 'performance_evaluation'),
                'check_type': 'boolean',
                'customer_action': '从HR部门提取研发人员绩效考核制度，确保正式发布版本'
            },
            {
                'name': '研发人员奖励制度',
                'category': '管理证明',
                'content_requirements': [
                    '研发人员创新创业奖励制度文件',
                    '包含：奖励类型（创新奖、专利奖、论文奖等）、奖励标准、申请流程',
                    '需企业正式发布（带文件编号、发布日期）'
                ],
                'quantity_required': '1份',
                'time_range': '近三年内发布',
                'format': 'DOCX/PDF',
                'size_limit': '≤5MB',
                'naming_convention': '研发人员奖励制度.docx',
                'quality_requirements': '内容完整，正式发布',
                'is_financial': False,
                'required': True,
                'check_field': ('management', 'reward_system'),
                'check_type': 'boolean',
                'customer_action': '从HR部门提取研发人员奖励制度，确保正式发布版本'
            },
            {
                'name': '产学研合作协议',
                'category': '管理证明',
                'content_requirements': [
                    '与高校或科研院所签订的产学研合作协议',
                    '协议包含：合作内容、合作期限、双方权利义务、知识产权归属',
                    '建议至少1份产学研合作'
                ],
                'quantity_required': '1份以上',
                'time_range': '近三年内签订',
                'format': 'PDF',
                'size_limit': '≤5MB',
                'naming_convention': '产学研合作协议_{合作院校}.pdf',
                'quality_requirements': '签字盖章清晰，合作内容明确',
                'is_financial': False,
                'required': False,
                'check_field': ('management', 'industry_university_agreements'),
                'check_type': 'list_min',
                'check_threshold': 0,
                'customer_action': '从合作院校或研发部门提取产学研合作协议，扫描为PDF'
            },
        ]
    },
    'gxtz-core-tables': {
        'subdir': '00_核心表格',
        'items': [
            {
                'name': '已有知识产权清单（IP清单）',
                'category': '知识产权',
                'content_requirements': [
                    '企业已有的知识产权清单（如有）',
                    '包含：IP编号、知识产权名称、类型（发明/实用新型/外观/软著）、专利号/登记号、授权日期、权利人',
                    '如企业无现成清单，可不提供（技能将根据证书扫描件自动生成）'
                ],
                'quantity_required': '1份（如有）',
                'time_range': '不限',
                'format': 'XLSX',
                'size_limit': '≤2MB',
                'naming_convention': '{企业名称}_知识产权清单.xlsx',
                'quality_requirements': '信息完整准确',
                'is_financial': False,
                'required': False,
                'check_field': None,
                'check_type': 'boolean',
                'customer_action': '从知识产权管理部门提取已有IP清单；若无，技能将根据证书扫描件自动生成'
            },
            {
                'name': '已有研发项目清单（RD清单）',
                'category': '研发项目',
                'content_requirements': [
                    '企业已有的研发项目清单（如有）',
                    '包含：RD编号、项目名称、立项日期、项目负责人、项目预算、研发内容、验收状态',
                    '如企业无现成清单，可不提供（技能将根据立项报告自动生成）'
                ],
                'quantity_required': '1份（如有）',
                'time_range': '不限',
                'format': 'XLSX',
                'size_limit': '≤2MB',
                'naming_convention': '{企业名称}_研发项目清单.xlsx',
                'quality_requirements': '信息完整准确',
                'is_financial': False,
                'required': False,
                'check_field': None,
                'check_type': 'boolean',
                'customer_action': '从研发部门提取已有RD项目清单；若无，技能将根据立项报告自动生成'
            },
            {
                'name': '已有高新产品清单（PS清单）',
                'category': '高新产品',
                'content_requirements': [
                    '企业已有的高新产品清单（如有）',
                    '包含：PS编号、产品名称、产品型号、技术领域、技术指标、销售收入、知识产权支持',
                    '如企业无现成清单，可不提供（技能将根据销售合同和产品资料自动生成）'
                ],
                'quantity_required': '1份（如有）',
                'time_range': '不限',
                'format': 'XLSX',
                'size_limit': '≤2MB',
                'naming_convention': '{企业名称}_高新产品清单.xlsx',
                'quality_requirements': '信息完整准确',
                'is_financial': False,
                'required': False,
                'check_field': None,
                'check_type': 'boolean',
                'customer_action': '从市场或销售部门提取已有PS产品清单；若无，技能将根据销售合同自动生成'
            },
        ]
    }
}


def get_supplement_dir(enterprise_name, application_year, skill_name):
    """获取补充资料目录路径"""
    root = f"{enterprise_name}_高新认定材料_{application_year}"
    return os.path.join(root, '_补充资料', skill_name)


def check_item_exists(item, analysis_results):
    """检查资料项是否已存在（基于analysis_results判断）
    
    Args:
        item: 补充资料模板项
        analysis_results: 本地资料筛查结果
    
    Returns:
        bool: True表示已存在（不需要补充），False表示缺失（需要补充）
    """
    if not analysis_results:
        return False  # 无筛查结果时，默认需要补充
    
    check_field = item.get('check_field')
    if not check_field:
        return False  # 无判断字段时，默认需要补充
    
    category_key, field_name = check_field
    category_data = analysis_results.get(category_key, {})
    if not isinstance(category_data, dict):
        return False
    
    field_value = category_data.get(field_name)
    check_type = item.get('check_type', 'boolean')
    
    if check_type == 'boolean':
        return bool(field_value)
    elif check_type == 'list_count':
        return isinstance(field_value, list) and len(field_value) > 0
    elif check_type == 'list_min':
        threshold = item.get('check_threshold', 1)
        return isinstance(field_value, list) and len(field_value) >= threshold
    return False


def filter_missing_supplements(skill_name, analysis_results=None, exclude_financial=True):
    """过滤出缺失的补充资料项（核心函数）
    
    基于本地资料筛查结果，对比补充资料模板，只返回缺失的资料项。
    排除财务资料和已有资料。
    
    Args:
        skill_name: 技能名称
        analysis_results: 本地资料筛查结果（来自scan_local_project_materials）
        exclude_financial: 是否排除财务资料（默认True）
    
    Returns:
        list: 缺失的补充资料项列表（已排除财务资料和已有资料）
    """
    template = SUPPLEMENT_TEMPLATES.get(skill_name)
    if not template:
        return []
    
    missing_items = []
    for item in template['items']:
        # 排除财务资料
        if exclude_financial and item.get('is_financial', False):
            continue
        
        # 检查是否已存在
        if check_item_exists(item, analysis_results):
            continue
        
        missing_items.append(item)
    
    return missing_items


def generate_supplement_checklist(enterprise_name, application_year, skill_name, 
                                   analysis_results=None, region='shenzhen'):
    """生成补充资料清单文档（详细列出需要补充的资料）
    
    v1.2.0优化：基于本地资料筛查结果，只输出需要补充的资料项；
    每项详细列出内容要求、数量、时间范围、命名规范、客户操作指引；
    排除财务资料（财务类资料由财务技能单独处理）。
    
    Args:
        enterprise_name: 企业名称
        application_year: 申报年份
        skill_name: 技能名称
        analysis_results: 本地资料筛查结果（来自scan_local_project_materials）
        region: 地区（shenzhen/guangdong）
    
    Returns:
        dict: {'checklist_path': str, 'supplement_dir': str, 'missing_count': int, 'missing_items': list}
    """
    template = SUPPLEMENT_TEMPLATES.get(skill_name, {'subdir': '07_资料收集清单', 'items': []})
    supplement_dir = get_supplement_dir(enterprise_name, application_year, skill_name)
    os.makedirs(supplement_dir, exist_ok=True)
    
    # 过滤出缺失的补充资料项（排除财务资料）
    missing_items = filter_missing_supplements(
        skill_name, analysis_results, exclude_financial=True
    )
    
    # 生成补充资料清单文档
    checklist_path = os.path.join(supplement_dir, '补充资料清单.md')
    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    last_year = application_year - 1
    _F = '`' * 3  # markdown代码块围栏（避免与本文件的代码块围栏冲突）

    content = f"""# 补充资料清单 - {skill_name}

> 生成时间：{now}
> 企业：{enterprise_name}
> 申报年份：{application_year}年
> 地区：{region}
> 统计基准：上年12月（{last_year}年12月）

## 补充资料放置目录

请将以下补充资料文件放到此目录：

{_F}
{supplement_dir}/
{_F}

## 需要补充的资料（共{len(missing_items)}项）

"""
    
    if not missing_items:
        content += "**所有资料均已齐全，无需补充。**\n"
    else:
        for i, item in enumerate(missing_items, 1):
            required_text = '✅ 必须' if item.get('required', False) else '⭕ 选填'
            content += f"""### {i}. {item['name']} ({required_text})

**资料类别**：{item.get('category', '未分类')}

**详细内容要求**：
"""
            for req in item.get('content_requirements', []):
                content += f"- {req}\n"
            
            content += f"""
**数量要求**：{item.get('quantity_required', '按实际')}
**时间范围**：{item.get('time_range', '不限')}
**格式要求**：{item.get('format', 'PDF')}
**大小限制**：{item.get('size_limit', '不限')}
**命名规范**：`{item.get('naming_convention', '按资料名称命名')}`
**质量要求**：{item.get('quality_requirements', '清晰可辨')}
**客户操作指引**：{item.get('customer_action', '请按上述要求提供资料')}

"""
    
    content += f"""## 操作说明

1. 将上述资料文件放到 `{supplement_dir}/` 目录
2. 严格按命名规范命名文件，便于技能自动识别和归类
3. 放入文件后，重新运行 {skill_name} 技能
4. 技能会自动读取此目录中的新文件，进行整理和分析，并更新项目知识库

## 文件命名示例

{_F}
{supplement_dir}/
├── 营业执照.png
├── 企业承诺书.pdf
├── IP01_一种XXX方法.pdf
├── IP05_一种XXX装置.pdf
├── 张三_学历证书.pdf
├── {enterprise_name}_上年12月社保缴费证明.pdf
├── {enterprise_name}_科技人员名册_{last_year}.xlsx
└── ...
{_F}

## 注意事项

- **压缩文件会被自动解压**：zip/rar/7z 文件会被递归解压到底，无需手动解压
- **文件清晰度要求**：PDF文件清晰可辨，图片文件分辨率≥300dpi
- **财务资料不在本清单**：财务审计报告、研发费用专项审计、纳税申报表等财务资料由财务技能单独处理
- **已有资料不在本清单**：本清单仅列出本地筛查后缺失的资料，已有资料不再重复列出
- **公章要求**：所有需要公章的资料必须为红色印章（非复印章）
- **如资料较多**：可按资料名称创建子目录分类存放，技能会递归扫描所有子目录

## 已放入的文件

> 技能执行时会自动扫描此目录，将新文件纳入项目知识库的文件图谱。
> 已放入的文件会在下次生成清单时自动排除（基于本地筛查结果更新）。
"""
    
    with open(checklist_path, 'w', encoding='utf-8') as f:
        f.write(content)
    
    return {
        'checklist_path': checklist_path,
        'supplement_dir': supplement_dir,
        'missing_count': len(missing_items),
        'missing_items': missing_items
    }


def scan_supplement_dir(enterprise_name, application_year, skill_name, 
                        analysis_results=None, region='shenzhen'):
    """扫描补充资料目录，读取分析新文件

    技能执行时先调用此函数，检查补充资料目录中是否有新文件。
    如果有新文件，读取分析并整理。

    Args:
        enterprise_name: 企业名称
        application_year: 申报年份
        skill_name: 技能名称
        analysis_results: 本地资料筛查结果（来自scan_local_project_materials），
                          用于生成详细的缺失项清单（v1.2.0新增）
        region: 地区（shenzhen/guangdong）

    Returns:
        dict: {
            'new_files': list,  # 新发现的文件列表
            'analyzed': list,   # 已分析的文件信息
            'supplement_dir': str,
            'checklist_path': str,
            'missing_count': int,  # 缺失项数量
            'missing_items': list  # 缺失项详情
        }
    """
    # 先确保补充资料清单文档存在（基于analysis_results生成详细的缺失项清单）
    result = generate_supplement_checklist(
        enterprise_name, application_year, skill_name, 
        analysis_results=analysis_results, region=region
    )
    supplement_dir = result['supplement_dir']

    new_files = []
    analyzed = []

    if not os.path.exists(supplement_dir):
        return {
            'new_files': [],
            'analyzed': [],
            'supplement_dir': supplement_dir,
            'checklist_path': result['checklist_path']
        }

    # 扫描补充目录中的所有文件（支持压缩文件解压，使用顶部兼容导入的函数）
    all_files = scan_files_with_archive_support(supplement_dir)

    # 读取已有的文件图谱，判断哪些是新文件
    file_map = load_file_map()
    existing_files = set()
    if file_map:
        existing_files = set(file_map.get('files', {}).keys())

    for file_path in all_files:
        # 跳过清单文档本身
        if file_path.endswith('补充资料清单.md'):
            continue

        file_key = os.path.abspath(file_path)
        if file_key not in existing_files:
            new_files.append(file_path)

    # 分析每个新文件
    for file_path in new_files:
        file_info = analyze_supplement_file(file_path, skill_name)
        analyzed.append(file_info)

        # 添加到文件图谱
        add_file_to_map(
            file_path=file_path,
            category=file_info['category'],
            file_type=file_info['file_type'],
            related_id=file_info.get('related_id'),
            related_name=file_info.get('related_name'),
            content_summary=file_info['content_summary'],
            validity='pending_review',
            keywords=file_info.get('keywords', []),
            skill_name=skill_name
        )

    return {
        'new_files': new_files,
        'analyzed': analyzed,
        'supplement_dir': supplement_dir,
        'checklist_path': result['checklist_path'],
        'missing_count': result.get('missing_count', 0),
        'missing_items': result.get('missing_items', [])
    }


def analyze_supplement_file(file_path, skill_name):
    """分析单个补充资料文件，提取信息

    根据文件名和内容，自动识别文件类别、关联对象、关键词等。

    Args:
        file_path: 文件路径
        skill_name: 技能名称

    Returns:
        dict: 文件分析结果
    """
    filename = os.path.basename(file_path)
    ext = os.path.splitext(filename)[1].lower().lstrip('.')
    file_type = ext if ext else 'unknown'

    # 根据技能名确定默认类别
    skill_category_map = {
        'gxtz-info-collector': '01_基础资质',
        'gxtz-ip-materials': '02_知识产权',
        'gxtz-rd-report': '03_研发项目',
        'gxtz-achievement-materials': '08_合同发票',
        'gxtz-ps-materials': '04_高新产品',
        'gxtz-staff-materials': '05_科技人员',
        'gxtz-management-materials': '07_管理制度',
        'gxtz-core-tables': '10_其他资料'
    }
    category = skill_category_map.get(skill_name, '10_其他资料')

    # 从文件名提取关联ID
    related_id = None
    related_name = None
    keywords = []

    # 匹配IP编号
    ip_match = re.search(r'IP\d+', filename, re.IGNORECASE)
    if ip_match:
        related_id = ip_match.group().upper()
        category = '02_知识产权'
        keywords.append(related_id)

    # 匹配RD编号
    rd_match = re.search(r'RD\d+', filename, re.IGNORECASE)
    if rd_match:
        related_id = rd_match.group().upper()
        category = '03_研发项目'
        keywords.append(related_id)

    # 匹配PS编号
    ps_match = re.search(r'PS\d+', filename, re.IGNORECASE)
    if ps_match:
        related_id = ps_match.group().upper()
        category = '04_高新产品'
        keywords.append(related_id)

    # 匹配ACH编号
    ach_match = re.search(r'ACH\d+', filename, re.IGNORECASE)
    if ach_match:
        related_id = ach_match.group().upper()
        category = '08_合同发票'
        keywords.append(related_id)

    # 根据文件名关键词识别类别
    name_lower = filename.lower()

    if '社保' in filename or '社保' in name_lower:
        category = '05_科技人员'
        keywords.extend(['社保', '缴费'])
    elif '合同' in filename or 'contract' in name_lower:
        category = '08_合同发票'
        keywords.append('合同')
    elif '发票' in filename or 'invoice' in name_lower:
        category = '08_合同发票'
        keywords.append('发票')
    elif '检测' in filename or 'test' in name_lower or 'report' in name_lower:
        category = '04_高新产品'
        keywords.append('检测报告')
    elif '学历' in filename or '证书' in filename:
        category = '05_科技人员'
        keywords.append('学历证书')
    elif '专利' in filename or '软著' in filename:
        category = '02_知识产权'
        keywords.append('专利证书')
    elif '制度' in filename or '管理' in filename:
        category = '07_管理制度'
        keywords.append('管理制度')
    elif '审计' in filename:
        category = '06_财务资料'
        keywords.append('审计报告')
    elif '设备' in filename:
        category = '07_管理制度'
        keywords.append('研发设备')

    # 从文件名提取关联名称（去除扩展名和编号）
    clean_name = re.sub(r'^(IP|RD|PS|ACH)\d+_', '', os.path.splitext(filename)[0])
    clean_name = re.sub(r'[_-]', ' ', clean_name).strip()
    if clean_name and not related_name:
        related_name = clean_name

    # 生成内容摘要
    content_summary = f"{filename} - {category}"
    if related_id:
        content_summary += f" - 关联{related_id}"
    if related_name:
        content_summary += f" - {related_name}"

    return {
        'file_path': file_path,
        'filename': filename,
        'file_type': file_type,
        'category': category,
        'related_id': related_id,
        'related_name': related_name,
        'content_summary': content_summary,
        'keywords': keywords
    }


def organize_supplement_files(enterprise_name, application_year, skill_name, analyzed_files):
    """整理补充资料文件到统一输出目录

    技能分析完补充文件后，将文件整理到对应的统一输出子目录。

    Args:
        enterprise_name: 企业名称
        application_year: 申报年份
        skill_name: 技能名称
        analyzed_files: 已分析的文件信息列表

    Returns:
        list: 整理后的文件路径列表
    """
    root = f"{enterprise_name}_高新认定材料_{application_year}"
    template = SUPPLEMENT_TEMPLATES.get(skill_name, {'subdir': '07_资料收集清单'})
    target_subdir = template['subdir']
    target_dir = os.path.join(root, target_subdir)
    os.makedirs(target_dir, exist_ok=True)

    organized_files = []

    for file_info in analyzed_files:
        src_path = file_info['file_path']
        filename = file_info['filename']

        if not os.path.exists(src_path):
            continue

        dst_path = os.path.join(target_dir, filename)

        # 避免覆盖
        if os.path.exists(dst_path):
            name, ext = os.path.splitext(filename)
            counter = 1
            while os.path.exists(os.path.join(target_dir, f"{name}_{counter}{ext}")):
                counter += 1
            dst_path = os.path.join(target_dir, f"{name}_{counter}{ext}")

        try:
            shutil.copy2(src_path, dst_path)
            organized_files.append({
                'original_path': src_path,
                'organized_path': dst_path,
                'file_info': file_info
            })

            # 更新文件图谱中的路径
            add_file_to_map(
                file_path=dst_path,
                category=file_info['category'],
                file_type=file_info['file_type'],
                related_id=file_info.get('related_id'),
                related_name=file_info.get('related_name'),
                content_summary=file_info['content_summary'],
                validity='valid',
                keywords=file_info.get('keywords', []),
                skill_name=skill_name
            )
        except Exception as e:
            print(f"[整理失败] {filename}: {e}")

    return organized_files


def update_experience_from_supplement(skill_name, analyzed_files, issues=None):
    """根据补充资料分析结果更新经验库

    将补充资料中发现的问题、识别规则等沉淀到经验库。

    Args:
        skill_name: 技能名称
        analyzed_files: 已分析的文件信息列表
        issues: 发现的问题列表（可选）
    """
    # 沉淀识别规则
    if analyzed_files:
        rules = []
        for f in analyzed_files:
            if f.get('related_id'):
                rules.append(f"{f['filename']}: 识别为{f['category']}，关联{f['related_id']}")
            else:
                rules.append(f"{f['filename']}: 识别为{f['category']}")

        update_knowledge_after_skill(
            skill_name=skill_name,
            enterprise_name='',
            application_year=2026,
            experience_entry={
                'category': 'validation_rules',
                'title': f'{skill_name}补充资料识别规则',
                'content': '; '.join(rules)
            }
        )

    # 沉淀问题
    if issues:
        for issue in issues:
            update_knowledge_after_skill(
                skill_name=skill_name,
                enterprise_name='',
                application_year=2026,
                experience_entry={
                    'category': 'common_issues',
                    'title': f'{skill_name}补充资料问题',
                    'content': issue
                }
            )


def _derive_enterprise_info(project_root):
    """从项目根目录名推导企业名称和申报年份（CLI 内部辅助函数）
    
    项目根目录通常命名为 "{企业名称}_高新认定材料_{年份}" 格式。
    如果无法推导，返回空企业名和默认年份2026。
    
    Args:
        project_root: 项目根目录路径
        
    Returns:
        tuple: (enterprise_name, application_year)
    """
    dir_name = os.path.basename(os.path.abspath(project_root))
    # 尝试匹配 {企业名称}_高新认定材料_{年份}
    match = re.match(r'^(.+?)_高新认定材料_(\d{4})$', dir_name)
    if match:
        return match.group(1), int(match.group(2))
    return '', 2026


def main():
    """CLI 入口：支持 scan、organize、checklist 三个子命令
    
    返回 JSON 格式结果。
    """
    parser = argparse.ArgumentParser(
        description='补充资料机制工具 - 扫描/整理/生成补充资料清单'
    )
    subparsers = parser.add_subparsers(dest='command', help='子命令')

    # scan 子命令：扫描补充资料目录
    scan_parser = subparsers.add_parser('scan', help='扫描补充资料目录')
    scan_parser.add_argument('--project-root', required=True, help='项目根目录')
    scan_parser.add_argument('--skill', required=True, help='技能名')
    scan_parser.add_argument('--enterprise-name', default=None, help='企业名称（可选，默认从目录名推导）')
    scan_parser.add_argument('--application-year', type=int, default=None, help='申报年份（可选，默认从目录名推导）')

    # organize 子命令：整理补充资料
    organize_parser = subparsers.add_parser('organize', help='整理补充资料')
    organize_parser.add_argument('--project-root', required=True, help='项目根目录')
    organize_parser.add_argument('--skill', required=True, help='技能名')
    organize_parser.add_argument('--enterprise-name', default=None, help='企业名称（可选，默认从目录名推导）')
    organize_parser.add_argument('--application-year', type=int, default=None, help='申报年份（可选，默认从目录名推导）')

    # checklist 子命令：生成补充资料清单
    checklist_parser = subparsers.add_parser('checklist', help='生成补充资料清单')
    checklist_parser.add_argument('--project-root', required=True, help='项目根目录')
    checklist_parser.add_argument('--skill', required=True, help='技能名')
    checklist_parser.add_argument('--enterprise-name', default=None, help='企业名称（可选，默认从目录名推导）')
    checklist_parser.add_argument('--application-year', type=int, default=None, help='申报年份（可选，默认从目录名推导）')

    args = parser.parse_args()

    # 切换到项目根目录，使相对路径生效
    original_dir = os.getcwd()
    if args.project_root:
        os.chdir(args.project_root)

    try:
        # 推导企业名称和申报年份
        enterprise_name = args.enterprise_name
        application_year = args.application_year
        if not enterprise_name or not application_year:
            derived_name, derived_year = _derive_enterprise_info(args.project_root)
            if not enterprise_name:
                enterprise_name = derived_name
            if not application_year:
                application_year = derived_year

        if args.command == 'scan':
            # 扫描补充资料目录
            result = scan_supplement_dir(
                enterprise_name, application_year, args.skill
            )
            print(json.dumps(result, ensure_ascii=False, default=str))

        elif args.command == 'organize':
            # 整理补充资料：先扫描再整理
            scan_result = scan_supplement_dir(
                enterprise_name, application_year, args.skill
            )
            analyzed_files = scan_result.get('analyzed', [])
            organized = organize_supplement_files(
                enterprise_name, application_year, args.skill, analyzed_files
            )
            # 沉淀经验
            if analyzed_files:
                update_experience_from_supplement(args.skill, analyzed_files)
            print(json.dumps(
                {
                    'organized_count': len(organized),
                    'organized_files': organized,
                    'supplement_dir': scan_result.get('supplement_dir', ''),
                    'new_files_count': len(scan_result.get('new_files', []))
                },
                ensure_ascii=False, default=str
            ))

        elif args.command == 'checklist':
            # 生成补充资料清单
            result = generate_supplement_checklist(
                enterprise_name, application_year, args.skill
            )
            print(json.dumps(
                {
                    'checklist_path': result['checklist_path'],
                    'supplement_dir': result['supplement_dir'],
                    'missing_count': result['missing_count'],
                    'missing_items': [
                        {'name': item['name'], 'category': item.get('category', ''),
                         'required': item.get('required', False)}
                        for item in result['missing_items']
                    ]
                },
                ensure_ascii=False, default=str
            ))

        else:
            parser.print_help()
    finally:
        os.chdir(original_dir)


if __name__ == '__main__':
    main()
