"""批量添加"质疑与协同审查机制"章节到所有 gxtz-* 技能 SKILL.md（v1.0 - 2026-07-14）

本脚本功能：
  1. 读取 _questioning_review_mechanism.md 中定义的标准章节内容
  2. 自动发现 gxtz-* 技能目录（不写死列表）
  3. 对每个 SKILL.md：
     - 检查是否已包含 "## 质疑与协同审查机制" 标题，若已包含则跳过插入
     - 在 "## 执行顺序契约" 行之前插入新章节内容
     - 升级版本号：x.y.z → x.y.(z+1)（仅 patch+1）
  4. 输出更新汇总：每个技能的旧版本→新版本、是否成功

用法：
  python add_questioning_review.py --skills-dir "C:\\path\\to\\skills"
  python add_questioning_review.py --skills-dir "C:\\path\\to\\skills" --dry-run

依赖：
  - _questioning_review_mechanism.md 必须与本脚本同目录（_common/）
  - 该模板文件中必须包含以 ```markdown 开头的代码块，其中含有 "## 质疑与协同审查机制" 章节
"""
import os
import re
import argparse
from pathlib import Path


# ============== 常量定义 ==============

# 本脚本所在目录（_common/）
SCRIPT_DIR = Path(__file__).resolve().parent

# 标准章节模板文件路径
TEMPLATE_FILE = SCRIPT_DIR / '_questioning_review_mechanism.md'

# 章节标题（用于检测是否已存在）
SECTION_TITLE = '## 质疑与协同审查机制'

# 插入锚点：在该标题行之前插入新章节
INSERT_ANCHOR = '## 执行顺序契约'

# 版本号正则：匹配 `version: "1.2.3"` 或 `version: 1.2.3` 或 `version: '1.2.3'`
VERSION_PATTERN = re.compile(r'^(version:\s*)"?(\d+)\.(\d+)\.(\d+)"?', re.MULTILINE)


def load_section_template():
    """从 _questioning_review_mechanism.md 中提取标准章节内容。

    模板文件使用 HTML 注释标记 `<!-- SECTION_BEGIN -->` 和 `<!-- SECTION_END -->`
    来包裹章节正文（避免与章节内部的 ``` 代码块产生嵌套歧义）。本函数提取
    两个标记之间的内容。

    Returns:
        str: 章节正文（以 "## 质疑与协同审查机制" 开头，含末尾换行符）

    Raises:
        FileNotFoundError: 模板文件不存在
        ValueError: 模板文件格式错误，未找到章节标记
    """
    if not TEMPLATE_FILE.exists():
        raise FileNotFoundError(f'模板文件不存在：{TEMPLATE_FILE}')

    with open(TEMPLATE_FILE, 'r', encoding='utf-8') as f:
        content = f.read()

    # 使用 HTML 注释标记定位章节正文（避免与内部 ``` 代码块冲突）
    match = re.search(
        r'<!-- SECTION_BEGIN -->\n(.*?)<!-- SECTION_END -->',
        content,
        re.DOTALL,
    )
    if not match:
        raise ValueError(
            '模板文件格式错误：未找到 <!-- SECTION_BEGIN --> ... '
            '<!-- SECTION_END --> 标记。请确保模板文件使用 HTML 注释标记包裹章节正文。'
        )

    section = match.group(1)
    # 去掉末尾多余空行，保留章节正文
    return section.rstrip() + '\n'


def discover_skill_dirs(skills_dir):
    """自动发现 skills 目录下所有 gxtz-* 技能目录。

    Args:
        skills_dir (str): skills 目录绝对路径

    Returns:
        list[str]: 排序后的 gxtz-* 技能目录绝对路径列表
    """
    skills_path = Path(skills_dir)
    if not skills_path.is_dir():
        raise NotADirectoryError(f'skills 目录不存在：{skills_dir}')

    skill_dirs = []
    for entry in sorted(skills_path.iterdir()):
        if entry.is_dir() and entry.name.startswith('gxtz-'):
            # 确认目录内存在 SKILL.md
            if (entry / 'SKILL.md').exists():
                skill_dirs.append(str(entry))

    return skill_dirs


def detect_current_version(content):
    """从 SKILL.md 内容中检测当前版本号。

    Args:
        content (str): SKILL.md 文件内容

    Returns:
        str|None: 当前版本号（如 "1.18.0"），未找到则返回 None
    """
    match = VERSION_PATTERN.search(content)
    if match:
        return f'{match.group(2)}.{match.group(3)}.{match.group(4)}'
    return None


def bump_patch_version(version_str):
    """将版本号的 patch 部分 +1。

    Args:
        version_str (str): 形如 "1.18.0" 的版本号

    Returns:
        str: patch+1 后的新版本号（如 "1.18.1"）

    Raises:
        ValueError: 版本号格式不合法
    """
    parts = version_str.split('.')
    if len(parts) != 3:
        raise ValueError(f'版本号格式不合法：{version_str}（应为 x.y.z）')
    major, minor, patch = parts
    return f'{major}.{minor}.{int(patch) + 1}'


def upgrade_version_in_content(content, old_version, new_version):
    """在 SKILL.md 内容中升级版本号。

    优先精确匹配 `version: "old"`，未命中则用正则替换首个 version 字段。

    Args:
        content (str): 原始 SKILL.md 内容
        old_version (str): 旧版本号
        new_version (str): 新版本号

    Returns:
        str: 替换后的内容
    """
    # 1. 尝试精确匹配 `version: "old"`（双引号）
    old_pattern_dq = f'version: "{old_version}"'
    if old_pattern_dq in content:
        return content.replace(old_pattern_dq, f'version: "{new_version}"', 1)

    # 2. 尝试精确匹配 `version: 'old'`（单引号）
    old_pattern_sq = f"version: '{old_version}'"
    if old_pattern_sq in content:
        return content.replace(old_pattern_sq, f"version: '{new_version}'", 1)

    # 3. 尝试用正则替换首个 version 字段（兼容无引号写法）
    def _replace(match):
        prefix = match.group(1)
        return f'{prefix}"{new_version}"'

    new_content, count = VERSION_PATTERN.subn(_replace, content, count=1)
    if count > 0:
        return new_content

    # 4. 未匹配到，原样返回
    return content


def remove_existing_section(content):
    """移除已存在的"## 质疑与协同审查机制"章节（含可能的不完整内容）。

    定位策略：从 "## 质疑与协同审查机制" 标题行开始，到下一个 "## 执行顺序契约"
    标题行之前（不含该行）。如果找不到 "## 执行顺序契约"，则到下一个 "## "
    标题行之前。同时清理章节前后多余的空行。

    Args:
        content (str): 原始 SKILL.md 内容

    Returns:
        tuple[bool, str]: (是否移除成功, 新内容)
            - 若未找到目标章节，返回 (False, content)
            - 若移除成功，返回 (True, new_content)
    """
    if SECTION_TITLE not in content:
        return False, content

    # 定位 "## 质疑与协同审查机制" 标题行的起始位置
    section_pattern = re.compile(r'^## 质疑与协同审查机制[^\n]*\n', re.MULTILINE)
    section_match = section_pattern.search(content)
    if not section_match:
        return False, content

    section_start = section_match.start()

    # 定位下一个 "## 执行顺序契约" 标题行（首选）或其他 ## 标题
    after_section = content[section_match.end():]
    anchor_pattern = re.compile(r'^## 执行顺序契约[^\n]*\n', re.MULTILINE)
    anchor_match = anchor_pattern.search(after_section)

    if anchor_match:
        section_end = section_match.end() + anchor_match.start()
    else:
        # 回退：定位下一个 ## 标题（不含执行顺序契约）
        any_header_pattern = re.compile(r'^## [^\n]+\n', re.MULTILINE)
        any_match = any_header_pattern.search(after_section)
        if any_match:
            section_end = section_match.end() + any_match.start()
        else:
            # 没有后续标题，删除到文件末尾
            section_end = len(content)

    # 删除从 section_start 到 section_end 之间的内容
    # 同时清理前后多余空行
    new_content = content[:section_start].rstrip() + '\n\n' + content[section_end:].lstrip('\n')
    return True, new_content


def insert_section(content, section_text):
    """在 "## 执行顺序契约" 标题行之前插入新章节内容。

    Args:
        content (str): 原始 SKILL.md 内容
        section_text (str): 要插入的章节正文

    Returns:
        tuple[bool, str, str]: (是否插入成功, 新内容, 失败原因)
            - 若已包含目标章节，返回 (False, content, 'already_exists')
            - 若未找到插入锚点，返回 (False, content, 'anchor_not_found')
            - 若插入成功，返回 (True, new_content, '')
    """
    # 1. 检查是否已包含 "## 质疑与协同审查机制" 标题
    if SECTION_TITLE in content:
        return False, content, 'already_exists'

    # 2. 查找 "## 执行顺序契约" 锚点
    # 匹配整行（含可能的尾部说明文字），使用 MULTILINE 让 ^ 匹配行首
    anchor_pattern = re.compile(r'^## 执行顺序契约[^\n]*\n', re.MULTILINE)
    match = anchor_pattern.search(content)
    if not match:
        return False, content, 'anchor_not_found'

    # 在锚点行之前插入新章节（章节末尾已有换行符，再加一个空行分隔）
    insert_pos = match.start()
    new_content = content[:insert_pos] + section_text + '\n' + content[insert_pos:]
    return True, new_content, ''


def process_skill(skill_dir, section_text, dry_run=False, force=False):
    """处理单个技能 SKILL.md：插入章节 + 升级版本号。

    Args:
        skill_dir (str): 技能目录绝对路径
        section_text (str): 要插入的章节正文
        dry_run (bool): 试运行模式，不写入文件
        force (bool): 强制替换模式：若已存在章节，先移除再重新插入，
            不再升级版本号（用于修复历史不完整插入）

    Returns:
        dict: 处理结果，包含 skill/old_version/new_version/inserted/already_exists/
              version_updated/error 等字段
    """
    skill_name = os.path.basename(skill_dir)
    skill_md_path = os.path.join(skill_dir, 'SKILL.md')

    result = {
        'skill': skill_name,
        'skill_dir': skill_dir,
        'old_version': None,
        'new_version': None,
        'inserted': False,
        'already_exists': False,
        'version_updated': False,
        'force_replaced': False,
        'error': None,
    }

    if not os.path.exists(skill_md_path):
        result['error'] = f'SKILL.md 不存在：{skill_md_path}'
        return result

    with open(skill_md_path, 'r', encoding='utf-8') as f:
        content = f.read()

    # 1. 检测当前版本号
    current_version = detect_current_version(content)
    if current_version is None:
        result['error'] = '未检测到 version 字段'
        return result
    result['old_version'] = current_version

    # 2. 升级版本号 patch+1（force 模式下不升级，因为已经升过）
    if force:
        new_version = current_version
    else:
        try:
            new_version = bump_patch_version(current_version)
        except ValueError as e:
            result['error'] = f'版本号升级失败：{e}'
            return result
    result['new_version'] = new_version

    # 3. 处理章节插入/替换
    if force:
        # 强制替换模式：先移除已有章节（无论是否完整），再插入新章节
        removed, content_after_remove = remove_existing_section(content)
        if removed:
            result['force_replaced'] = True
        # 插入完整章节
        inserted, new_content, reason = insert_section(content_after_remove, section_text)
        if reason == 'anchor_not_found':
            result['error'] = '未找到插入锚点（## 执行顺序契约）'
            return result
        result['inserted'] = True
    else:
        # 默认模式：检查是否已存在，存在则跳过插入
        inserted, new_content, reason = insert_section(content, section_text)
        if reason == 'already_exists':
            result['already_exists'] = True
            # 即使已存在，也尝试升级版本号（保持版本同步）
        elif reason == 'anchor_not_found':
            result['error'] = '未找到插入锚点（## 执行顺序契约）'
            return result
        else:
            result['inserted'] = True

    # 4. 升级版本号（force 模式跳过，版本号保持不变）
    if not force:
        upgraded_content = upgrade_version_in_content(new_content, current_version, new_version)
        if upgraded_content != new_content:
            result['version_updated'] = True
            new_content = upgraded_content

    # 5. 写入文件（dry_run 模式跳过）
    if not dry_run:
        with open(skill_md_path, 'w', encoding='utf-8') as f:
            f.write(new_content)

    return result


def main():
    """主入口：解析参数，发现技能，批量处理，输出汇总。"""
    parser = argparse.ArgumentParser(
        description='批量添加"质疑与协同审查机制"章节到所有 gxtz-* 技能 SKILL.md',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""示例：
  python add_questioning_review.py --skills-dir "C:\\path\\to\\skills"
  python add_questioning_review.py --skills-dir "C:\\path\\to\\skills" --dry-run
  python add_questioning_review.py --skills-dir "C:\\path\\to\\skills" --force
""",
    )
    parser.add_argument(
        '--skills-dir',
        required=True,
        help='skills 目录的绝对路径（包含 gxtz-* 子目录）',
    )
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='试运行模式：只输出处理计划，不修改文件',
    )
    parser.add_argument(
        '--force',
        action='store_true',
        help='强制替换模式：若已存在章节，先移除再重新插入完整章节，'
        '不升级版本号（用于修复历史不完整插入）',
    )
    args = parser.parse_args()

    print('=' * 70)
    print('批量添加"质疑与协同审查机制"章节到 gxtz-* 技能')
    print(f'skills 目录：{args.skills_dir}')
    print(f'模板文件：{TEMPLATE_FILE}')
    print(f'试运行模式：{"是" if args.dry_run else "否"}')
    print(f'强制替换模式：{"是" if args.force else "否"}')
    print('=' * 70)

    # 1. 加载章节模板
    try:
        section_text = load_section_template()
        print(f'✅ 已加载标准章节模板（{len(section_text)} 字符）')
    except (FileNotFoundError, ValueError) as e:
        print(f'❌ 加载模板失败：{e}')
        return

    # 2. 发现技能目录
    try:
        skill_dirs = discover_skill_dirs(args.skills_dir)
    except (NotADirectoryError, FileNotFoundError) as e:
        print(f'❌ 发现技能目录失败：{e}')
        return

    if not skill_dirs:
        print(f'⚠️  在 {args.skills_dir} 下未发现任何 gxtz-* 技能目录')
        return

    print(f'✅ 发现 {len(skill_dirs)} 个 gxtz-* 技能目录：')
    for d in skill_dirs:
        print(f'   - {os.path.basename(d)}')

    # 3. 批量处理
    print('\n' + '-' * 70)
    print('开始处理...')
    print('-' * 70)

    results = []
    for skill_dir in skill_dirs:
        skill_name = os.path.basename(skill_dir)
        print(f'\n处理 {skill_name} ...')
        result = process_skill(
            skill_dir, section_text, dry_run=args.dry_run, force=args.force
        )
        results.append(result)

        if result['error']:
            print(f'  ❌ 错误：{result["error"]}')
        else:
            if result.get('force_replaced'):
                if args.dry_run:
                    print(f'  ✅ 已有章节将被替换为完整章节（试运行未写入）')
                else:
                    print(f'  ✅ 已有章节已替换为完整章节')
            elif result['already_exists']:
                print(f'  ⚠️  章节已存在（仅升级版本号）')
            elif result['inserted']:
                if args.dry_run:
                    print(f'  ✅ 章节将插入（试运行未写入）')
                else:
                    print(f'  ✅ 章节已插入')
            version_status = '✓' if result['version_updated'] else '-'
            if args.dry_run and result['version_updated']:
                version_status = '✓（试运行未写入）'
            if args.force:
                print(
                    f'  版本：{result["old_version"]}（保持不变，强制替换模式）'
                )
            else:
                print(
                    f'  版本：{result["old_version"]} → {result["new_version"]} '
                    f'(版本升级 {version_status})'
                )

    # 4. 汇总报告
    print('\n' + '=' * 70)
    print('汇总报告')
    print('=' * 70)
    if args.force:
        header = f'{"技能":<35} {"当前版本":>10} {"替换":>10}'
        print(header)
        print('-' * 60)
    else:
        header = f'{"技能":<35} {"旧版本":>10} {"新版本":>10} {"插入":>10} {"版本":>10}'
        print(header)
        print('-' * 80)
    success_count = 0
    skip_count = 0
    error_count = 0
    for r in results:
        if r['error']:
            error_count += 1
            if args.force:
                print(f'{r["skill"]:<35} {"-":>10} {"错误":>10}')
            else:
                print(f'{r["skill"]:<35} {"-":>10} {"-":>10} {"错误":>10} {"-":>10}')
            print(f'   错误详情：{r["error"]}')
            continue

        if args.force:
            if r.get('force_replaced'):
                success_count += 1
                insert_status = '✓' if not args.dry_run else '✓(dry)'
            else:
                insert_status = '✗'
            print(f'{r["skill"]:<35} {r["old_version"]:>10} {insert_status:>10}')
        else:
            if r['already_exists']:
                skip_count += 1
                insert_status = '已存在'
            elif r['inserted']:
                success_count += 1
                insert_status = '✓' if not args.dry_run else '✓(dry)'
            else:
                insert_status = '✗'
            version_status = '✓' if r['version_updated'] else '✗'
            print(
                f'{r["skill"]:<35} {r["old_version"]:>10} {r["new_version"]:>10} '
                f'{insert_status:>10} {version_status:>10}'
            )

    print('-' * (60 if args.force else 80))
    print(
        f'总计：{len(results)} 个技能  |  成功：{success_count}  |  '
        f'跳过：{skip_count}  |  错误：{error_count}'
    )
    if args.dry_run:
        print('（试运行模式，未实际写入文件）')
    if args.force:
        print('（强制替换模式，版本号未升级）')
    print()


if __name__ == '__main__':
    main()
