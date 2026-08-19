"""SKILL.md 批量重写脚本（v1.0 - 2026-07-14）

自动处理 8 个 gxtz-* 技能 SKILL.md 的通用重写任务：
1. 备份原文件到 _backup_pre_rewrite/
2. 删除"## 公共模块代码"章节（从该标题到下一个 ## 一级标题或文件末尾）
3. 删除所有"自行编写等效Python代码"的放任兜底段落
4. 在 frontmatter 后插入合规红线、执行顺序契约、审核验证标准
5. 把"第零步"改为"第一步"
6. 统计重写前后的文件大小

用法：
  python rewrite_skill_md.py --all
  python rewrite_skill_md.py --skill gxtz-core-tables
  python rewrite_skill_md.py --skill gxtz-core-tables,gxtz-info-collector

依赖：无（纯标准库）
"""
import os
import re
import sys
import shutil
import argparse
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from path_config import get_skills_dir_str

# ============================================================
# 路径配置（基于 path_config 推断，v1.0.1 改造：移除硬编码个人路径）
# ============================================================
SKILLS_DIR = get_skills_dir_str()
BACKUP_DIR = os.path.join(SKILLS_DIR, '_backup_pre_rewrite')
COMMON_DIR = os.path.join(SKILLS_DIR, '_common')

# 8 个 gxtz-* 技能
SKILL_LIST = [
    'gxtz-core-tables',
    'gxtz-info-collector',
    'gxtz-ip-materials',
    'gxtz-achievement-materials',
    'gxtz-ps-materials',
    'gxtz-staff-materials',
    'gxtz-management-materials',
    'gxtz-rd-report',
]

# 审核脚本映射
VALIDATE_SCRIPT_MAP = {
    'gxtz-core-tables': 'validate_tables.py',
    'gxtz-info-collector': 'validate_info_collector.py',
    'gxtz-ip-materials': 'validate_ip.py',
    'gxtz-achievement-materials': 'validate_achievement.py',
    'gxtz-ps-materials': 'validate_ps.py',
    'gxtz-staff-materials': 'validate_staff.py',
    'gxtz-management-materials': 'validate_management.py',
    'gxtz-rd-report': 'validate_rd_report.py',
}


def get_role_section():
    """生成角色定位章节（v1.3.0 新增）"""
    return """## 角色定位（v1.3.0 新增）

> **你是"高新技术企业认定项目老师"**。服务于用户（项目人员），不直接面向客户企业。
> 完整角色定义（三角关系模型/专业领域/能力边界/决策权限/沟通准则）详见 `_common/agent_role.md`。

"""


def get_compliance_section(skill_name):
    """生成合规红线章节"""
    return """## 合规红线（agent 执行前必读，违反即停止）

> **第一要求：严谨合规。所有数据必须真实可溯源，禁止任何形式的编造。**

### 禁止事项（违反任何一条立即停止并告警）

1. **禁止编造内容**：所有字段数据必须来自真实文件（立项书、证书、合同、发票、社保记录等），不得凭空编造
2. **禁止推断关键数据**：技术领域、研发费用、人员占比、专利状态等关键字段，必须以官方文档（所得税申报表/申请书/证书）为准，不得从项目名称推断
3. **禁止跳过脚本执行**：所有 `python _common/xxx.py` 命令必须通过 RunCommand 真正执行，不得"阅读脚本逻辑自行编写等效代码"
4. **禁止跳过审核步骤**：审核验证步骤必须执行且通过，未通过时不得继续后续步骤
5. **禁止自行兜底**：脚本报错时不得自行编写兜底代码，必须停止并告警由用户决定
6. **禁止合并/简化字段名**：所有表格字段名必须与模板完全一致，不得简化（如"编号"不得代替"知识产权编号"）
7. **禁止跨技能污染**：仅读取当前项目留痕，不跨项目读取；仅使用当前技能定义的脚本

### 数据来源优先级（高 → 低）

- **官方文档**（所得税申报表 > 申请书 > 证书）：✅ 可直接采用
- **项目推断**（从 RD/IP 项目数据推断）：⚠️ 仅在官方文档缺失时使用，必须标注"推断"
- **联网搜索**（WebSearch 补充）：⚠️ 仅用于企业基本信息，不得用于技术数据
- **缺失**：❌ 不得编造，必须标注"待补充"

### 无法确认时的处理

- **关键字段无法确认**：填写"待补充（需提供 xxx 文件）"，不得编造
- **脚本报错**：立即停止，输出错误日志，由用户决定修复方案
- **审核不通过**：停止后续步骤，输出 ERROR 清单，由用户决定整改方案
"""


def get_execution_order_section():
    """生成执行顺序契约章节"""
    return """## 执行顺序契约（agent 必须严格遵守）

### 执行原则

1. **顺序执行**：必须按第一步 → 第二步 → ... → 最后一步顺序执行，严禁跳过任何步骤
2. **失败即停**：任何步骤失败（脚本报错、校验不通过、数据缺失）立即停止，输出错误信息，不得继续
3. **不可并行**：步骤之间有数据依赖，不得并行执行
4. **不可跳过审核**：审核验证步骤必须执行且通过，未通过时不得进入下一步

### 步骤编号规则

- **第一步**：项目初始化（强制执行，不可跳过）
- **第二步 ~ 倒数第二步**：核心业务步骤
- **最后一步**：审核验证（必须通过才能提交）

### 失败处理标准流程

当任何步骤失败时，agent 必须执行以下流程：

1. **立即停止**当前步骤及后续所有步骤
2. **输出错误信息**：包含失败步骤、错误原因、脚本日志（如有）
3. **输出已完成的步骤清单**：让用户了解当前进度
4. **等待用户决定**：由用户决定修复方案（修复脚本/补充资料/手工处理）
5. **禁止自行兜底**：不得"阅读脚本逻辑自行编写等效代码"

### 脚本调用规范

所有脚本调用必须使用 RunCommand 工具，**必须指定 cwd 参数为项目根目录的绝对路径**，格式：

```
python .trae/skills/_common/xxx.py <参数>
```

- 脚本路径使用相对于项目根目录的相对路径（项目根目录 = 包含 .trae/working_trace.md 的目录）
- 参数必须按脚本定义的 CLI 接口传递
- 不得通过"调用 xxx() 函数"的形式执行（函数描述不是可执行命令）
"""


def get_audit_section(skill_name):
    """生成审核验证标准章节"""
    validate_script = VALIDATE_SCRIPT_MAP.get(skill_name, 'validate_xxx.py')
    return f"""## 审核验证标准（agent 必须执行且通过）

### 审核脚本调用

最后一步必须执行对应的审核验证脚本，**必须指定 cwd 参数为项目根目录**：

```
python .trae/skills/_common/{validate_script} --dir "输出目录" --project-root "项目根目录"
```

### 审核通过条件

审核脚本返回 `passed: True` 且退出码为 0 时，方可进入提交流程。

### 审核失败处理

1. 审核脚本返回 `passed: False` 或退出码非 0 时，立即停止
2. 输出 ERROR 清单（包含每条错误的行号、字段、原因）
3. 根据 ERROR 清单逐一整改
4. 整改后重新执行审核脚本
5. 直到全部 PASS 方可提交

### 审核报告输出

审核脚本必须生成 JSON 格式的审核报告，包含：
- `passed`: bool（整体是否通过）
- `errors`: list（错误清单，每条含 file/row/col/field/reason）
- `warnings`: list（警告清单）
- `stats`: dict（统计信息）
"""


def remove_embedded_code(content):
    """删除"## 公共模块代码"章节（从该标题到下一个 ## 一级标题或文件末尾）

    同时删除其他内嵌的 Python 代码块（保留字段定义表中的代码块）
    """
    original_size = len(content)

    # 1. 删除"## 公共模块代码"章节
    # 匹配从"## 公共模块代码"到下一个"## "一级标题或文件末尾
    pattern_code_section = r'## 公共模块代码[^\n]*\n(.*?)(?=\n## |\Z)'
    content = re.sub(pattern_code_section, r'', content, flags=re.DOTALL)

    # 2. 删除"## 公共模块"章节（另一种标题形式）
    pattern_common = r'## 公共模块[^\n]*\n(.*?)(?=\n## |\Z)'
    content = re.sub(pattern_common, r'', content, flags=re.DOTALL)

    # 3. 删除"## 模块代码"章节
    pattern_module_code = r'## 模块代码[^\n]*\n(.*?)(?=\n## |\Z)'
    content = re.sub(pattern_module_code, r'', content, flags=re.DOTALL)

    after_size = len(content)
    return content, original_size - after_size


def remove_indulgent_fallback(content):
    """删除所有"自行编写等效Python代码"的放任兜底段落"""
    original_size = len(content)
    count = 0

    # 匹配各种放任兜底表述
    patterns = [
        # "如果脚本报错或不可用：阅读 xxx.py 中的设计逻辑，自行编写等效Python代码实现"
        r'[^\n]*如果脚本[报错或不可用]+[^\n]*自行编写等效[^\n]*\n?',
        # "如果脚本报错：阅读 xxx.py 中的设计逻辑，自行编写等效代码"
        r'[^\n]*如果脚本[报错]+[^\n]*自行编写[^\n]*\n?',
        # "如果不可用：阅读 xxx.py 中的设计逻辑，自行编写等效Python代码"
        r'[^\n]*如果[不可用]+[^\n]*自行编写[^\n]*\n?',
        # "脚本报错时：阅读 xxx.py 中的设计逻辑，自行编写等效代码"
        r'[^\n]*脚本[报错时]+[^\n]*自行编写[^\n]*\n?',
        # "如果 xxx.py 不可用或报错：阅读设计逻辑，自行编写等效Python代码"
        r'[^\n]*如果[^\n]*\.py[^\n]*[不可用或报错]+[^\n]*自行编写[^\n]*\n?',
    ]

    for pattern in patterns:
        matches = re.findall(pattern, content)
        count += len(matches)
        content = re.sub(pattern, '', content)

    # 删除空行（连续多个空行合并为1个）
    content = re.sub(r'\n{3,}', '\n\n', content)

    after_size = len(content)
    return content, count, original_size - after_size


def insert_compliance_sections(content, skill_name):
    """在 frontmatter 后插入角色定位、合规红线、执行顺序契约、审核验证标准"""
    # 匹配 frontmatter（--- ... ---）
    frontmatter_pattern = r'^(---\n.*?\n---\n)'
    match = re.match(frontmatter_pattern, content, re.DOTALL)
    if not match:
        return content, False

    frontmatter = match.group(1)
    rest_content = content[len(frontmatter):]

    # 检查是否已有合规红线章节（避免重复插入）
    if '## 合规红线' in rest_content:
        return content, False

    # 构建章节（角色定位 → 合规红线 → 执行顺序契约 → 审核验证）
    role = get_role_section()
    compliance = get_compliance_section(skill_name)
    execution_order = get_execution_order_section()
    audit = get_audit_section(skill_name)

    # 插入到 frontmatter 后
    new_content = frontmatter + '\n' + role + '\n' + compliance + '\n' + execution_order + '\n' + audit + '\n' + rest_content

    return new_content, True


def fix_step_numbering(content):
    """把"第零步"改为"第一步"，后续步骤递增"""
    original = content

    # 把"第零步"改为"第一步"
    content = content.replace('第零步', '第一步')

    # 注意：不自动重编号其他步骤，因为可能导致冲突
    # 后续步骤的编号调整需要手动处理

    changed = content != original
    return content, changed


def remove_module_insertion(content):
    """删除"模块七/八/九/十一"在"## 指令"和"第零步/第一步"之间的错位插入

    这些模块的内容已抽取为独立脚本，SKILL.md 中只保留引用
    """
    original_size = len(content)

    # 匹配"## 指令"后到"第零步/第一步"之间的模块描述
    # 这些通常是"### 模块七：..."等三级标题及其内容
    pattern = r'(## 指令[^\n]*\n)(.*?)(### 第[一二三四五六七八九十]步)'
    match = re.search(pattern, content, re.DOTALL)
    if match:
        prefix = match.group(1)
        middle = match.group(2)
        suffix = match.group(3)

        # 检查中间部分是否包含"模块七/八/九/十一"描述
        if any(kw in middle for kw in ['模块七', '模块八', '模块九', '模块十', '模块十一', '### 模块']):
            # 删除模块描述，只保留"## 指令"和"### 第一步"
            content = content[:match.start()] + prefix + '\n' + suffix + content[match.end():]

    after_size = len(content)
    return content, original_size - after_size


def rewrite_skill_md(skill_name):
    """重写单个技能的 SKILL.md

    返回 {
        'skill': skill_name,
        'original_size': int,
        'new_size': int,
        'reduction': int,
        'code_removed': int,
        'fallback_removed': int,
        'compliance_inserted': bool,
        'numbering_fixed': bool,
        'module_removed': int,
    }
    """
    skill_dir = os.path.join(SKILLS_DIR, skill_name)
    skill_md_path = os.path.join(skill_dir, 'SKILL.md')

    if not os.path.exists(skill_md_path):
        return {'skill': skill_name, 'error': f'SKILL.md 不存在: {skill_md_path}'}

    # 读取原文件
    with open(skill_md_path, 'r', encoding='utf-8') as f:
        original_content = f.read()
    original_size = len(original_content.encode('utf-8'))

    # 备份原文件
    os.makedirs(BACKUP_DIR, exist_ok=True)
    backup_subdir = os.path.join(BACKUP_DIR, skill_name)
    os.makedirs(backup_subdir, exist_ok=True)
    backup_path = os.path.join(backup_subdir, 'SKILL.md')
    if not os.path.exists(backup_path):
        shutil.copy2(skill_md_path, backup_path)

    # 开始重写
    content = original_content
    stats = {
        'skill': skill_name,
        'original_size': original_size,
        'code_removed': 0,
        'fallback_removed': 0,
        'compliance_inserted': False,
        'numbering_fixed': False,
        'module_removed': 0,
    }

    # 1. 删除内嵌代码
    content, code_removed = remove_embedded_code(content)
    stats['code_removed'] = code_removed

    # 2. 删除放任兜底
    content, fallback_count, fallback_bytes = remove_indulgent_fallback(content)
    stats['fallback_removed'] = fallback_count

    # 3. 插入合规章节
    content, compliance_inserted = insert_compliance_sections(content, skill_name)
    stats['compliance_inserted'] = compliance_inserted

    # 4. 修正步骤编号
    content, numbering_fixed = fix_step_numbering(content)
    stats['numbering_fixed'] = numbering_fixed

    # 5. 删除模块错位插入
    content, module_removed = remove_module_insertion(content)
    stats['module_removed'] = module_removed

    # 写入新文件
    new_size = len(content.encode('utf-8'))
    stats['new_size'] = new_size
    stats['reduction'] = original_size - new_size
    stats['reduction_pct'] = round((original_size - new_size) / original_size * 100, 1) if original_size > 0 else 0

    with open(skill_md_path, 'w', encoding='utf-8') as f:
        f.write(content)

    return stats


def main():
    parser = argparse.ArgumentParser(description='批量重写 gxtz-* 技能 SKILL.md')
    parser.add_argument('--all', action='store_true', help='重写所有 8 个技能')
    parser.add_argument('--skill', type=str, help='重写指定技能（逗号分隔）')
    args = parser.parse_args()

    if args.all:
        skills = SKILL_LIST
    elif args.skill:
        skills = [s.strip() for s in args.skill.split(',')]
    else:
        parser.print_help()
        return

    print(f'=' * 60)
    print(f'SKILL.md 批量重写脚本 v1.0')
    print(f'=' * 60)
    print(f'备份目录: {BACKUP_DIR}')
    print(f'处理技能: {len(skills)} 个')
    print()

    results = []
    for skill in skills:
        print(f'重写 {skill} ...')
        result = rewrite_skill_md(skill)
        results.append(result)

        if 'error' in result:
            print(f'  ❌ {result["error"]}')
        else:
            print(f'  ✅ 原大小: {result["original_size"]:,} bytes')
            print(f'     新大小: {result["new_size"]:,} bytes')
            print(f'     减少: {result["reduction"]:,} bytes ({result["reduction_pct"]}%)')
            print(f'     删除内嵌代码: {result["code_removed"]:,} bytes')
            print(f'     删除放任兜底: {result["fallback_removed"]} 处')
            print(f'     插入合规章节: {"是" if result["compliance_inserted"] else "否（已存在）"}')
            print(f'     修正步骤编号: {"是" if result["numbering_fixed"] else "否"}')
            print(f'     删除模块错位: {result["module_removed"]:,} bytes')
        print()

    # 汇总报告
    print('=' * 60)
    print('汇总报告')
    print('=' * 60)
    print(f'{"技能":<35} {"原大小":>10} {"新大小":>10} {"减少%":>8} {"兜底":>6}')
    print('-' * 75)
    for r in results:
        if 'error' not in r:
            print(f'{r["skill"]:<35} {r["original_size"]:>10,} {r["new_size"]:>10,} {r["reduction_pct"]:>7.1f}% {r["fallback_removed"]:>6}')
    print()


if __name__ == '__main__':
    main()
