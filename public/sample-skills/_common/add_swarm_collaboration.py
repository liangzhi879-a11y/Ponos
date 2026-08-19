#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""add_swarm_collaboration.py - 蜂群协同技能升级脚本（v1.0）

功能：批量修订所有 gxtz-* 技能的 SKILL.md，新增蜂群协同章节并修订合规红线/执行顺序契约。

修订内容（每个 SKILL.md）：
    1. 合规红线第7条：允许蜂群编排层调用 _common 公共脚本做协调
    2. 执行顺序契约第3条：跨技能独立任务在蜂群编排下可并行
    3. 新增"蜂群协同"章节（位于"执行顺序契约"之前）
    4. 升级版本号：patch + 1

跳过条件：SKILL.md 已包含 "## 蜂群协同" 标题则跳过该文件。

用法：
    # 默认执行（实际写回文件）
    python add_swarm_collaboration.py --skills-dir "c:\\...\\skills"

    # 干跑预览（不写回文件，仅输出汇总）
    python add_swarm_collaboration.py --skills-dir "c:\\...\\skills" --dry-run

参数：
    --skills-dir: skills 根目录绝对路径（必填）
    --dry-run:    仅预览变更，不实际修改文件（可选）
"""
import argparse
import os
import re
import sys


# ============================================================
# 修订常量
# ============================================================

# 修改1：合规红线第7条 - 替换文本
COMPLIANCE_OLD_PATTERN = re.compile(
    r'(\d+\.\s*\*\*禁止跨技能污染\*\*[:：][^\n]*?仅读取当前项目留痕[^\n]*?)仅使用当前技能定义的脚本[^\n]*',
)
COMPLIANCE_NEW_TAIL = (
    '技能内步骤使用当前技能定义的脚本，蜂群编排层可调用_common公共脚本做协调'
)

# 修改2：执行顺序契约第3条 - 替换包含"不可并行"的行
# 匹配 "3. **不可并行**：步骤之间有数据依赖，不得并行执行" 或类似变体
SEQUENCE_OLD_PATTERN = re.compile(
    r'^(\d+\.\s*\*\*不可并行\*\*[:：])[^\n]*$',
    re.MULTILINE
)
SEQUENCE_NEW_LINE = (
    '3. **不可并行（有依赖时）**：技能内步骤有数据依赖时不得并行；'
    '跨技能独立任务在蜂群编排下可并行执行，参见蜂群编排规范（_swarm_orchestration.md）'
)

# 修改3：新增"蜂群协同"章节内容（插入在"## 执行顺序契约"之前）
SWARM_COLLABORATION_SECTION = """## 蜂群协同（可选并行执行，v1.0）

> 本技能支持蜂群编排下的跨技能并行执行。技能内步骤仍必须串行（见执行顺序契约），但与其他无数据依赖的技能可并行。

### 可并行阶段

本技能所属阶段及并行条件，参见 `_common/_swarm_orchestration.md` 的可并行阶段矩阵。

### subagent执行规范

当被主agent作为subagent派发时：
1. 读取本SKILL.md，遵守合规红线/自主确认/质疑审查/执行顺序契约
2. 所有产出写入统一输出目录
3. 读写project_knowledge时使用file_lock并发控制
4. 最终步必须运行审核脚本（validate_*.py）
5. 返回精简摘要：技能名、产出文件清单、审核结果、质疑事项

### 并发控制

读写 project_knowledge 的JSON文件时必须使用：
```python
import os
import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from file_lock import file_lock
with file_lock('file_map.json'):
    # 读写操作
```

> 注：上述 `sys.path.insert` 范式基于 `__file__` 推断，复制到任意位置均可工作。
> 完整路径解析逻辑参见 `_common/path_config.py`。

详细规范参见 `_common/_swarm_orchestration.md`。

"""

# 修改4：版本号升级 - 匹配 frontmatter 中的 version 字段
VERSION_PATTERN = re.compile(r'^(version:\s*)"?(\d+)\.(\d+)\.(\d+)"?\s*$', re.MULTILINE)


def discover_skill_dirs(skills_dir):
    """自动发现所有 gxtz-* 技能目录

    Args:
        skills_dir: skills 根目录绝对路径

    Returns:
        list: [(skill_name, skill_dir_abs_path), ...] 按名称升序
    """
    if not os.path.isdir(skills_dir):
        raise FileNotFoundError(f'skills 目录不存在: {skills_dir}')

    skills = []
    for entry in sorted(os.listdir(skills_dir)):
        full_path = os.path.join(skills_dir, entry)
        if entry.startswith('gxtz-') and os.path.isdir(full_path):
            skill_md = os.path.join(full_path, 'SKILL.md')
            if os.path.isfile(skill_md):
                skills.append((entry, full_path))

    return skills


def bump_version(content):
    """版本号 patch+1

    Args:
        content: SKILL.md 文本

    Returns:
        tuple: (new_content, old_version_str, new_version_str)
               若未匹配到 version 字段，返回 (content, None, None)
    """
    match = VERSION_PATTERN.search(content)
    if not match:
        return content, None, None

    prefix, major, minor, patch = match.group(1), match.group(2), match.group(3), match.group(4)
    old_ver = f'{major}.{minor}.{patch}'
    new_patch = int(patch) + 1
    new_ver = f'{major}.{minor}.{new_patch}'
    # 保持原有引号风格（若有引号则保留引号）
    old_line = match.group(0)
    has_quote = '"' in old_line
    quote = '"' if has_quote else ''
    new_line = f'{prefix}{quote}{new_ver}{quote}'
    new_content = content[:match.start()] + new_line + content[match.end():]
    return new_content, old_ver, new_ver


def apply_compliance_change(content):
    """修改1：合规红线第7条修订

    Returns:
        tuple: (new_content, changed: bool)
    """
    def _replacer(m):
        # 保留前缀部分（"7. **禁止跨技能污染**：仅读取当前项目留痕，不跨项目读取；"）
        prefix_part = m.group(1)
        return f'{prefix_part}{COMPLIANCE_NEW_TAIL}'

    new_content, n = COMPLIANCE_OLD_PATTERN.subn(_replacer, content)
    return new_content, n > 0


def apply_sequence_change(content):
    """修改2：执行顺序契约第3条修订

    Returns:
        tuple: (new_content, changed: bool)
    """
    # 先匹配带编号 3 的行；若失败，退化为匹配任何"不可并行"行
    new_content, n = SEQUENCE_OLD_PATTERN.subn(SEQUENCE_NEW_LINE, content)
    if n == 0:
        # 容错：匹配任意编号的"不可并行"行（兼容编号变体）
        fallback = re.compile(r'^(\d+\.\s*\*\*不可并行\*\*[:：])[^\n]*$', re.MULTILINE)
        new_content, n = fallback.subn(SEQUENCE_NEW_LINE, content)
    return new_content, n > 0


def apply_swarm_section(content):
    """修改3：在"## 执行顺序契约"行之前插入蜂群协同章节

    Returns:
        tuple: (new_content, inserted: bool, skipped: bool)
                skipped=True 表示文件已包含蜂群协同章节，跳过
    """
    if re.search(r'^##\s*蜂群协同', content, re.MULTILINE):
        return content, False, True

    # 在"## 执行顺序契约"之前插入
    # 注意：使用函数作为 replacement，避免 re.subn 把替换字符串中的反斜杠当转义符
    # （SWARM_COLLABORATION_SECTION 含 Windows 路径 c:\\Users，会被误认为 \U 转义）
    pattern = re.compile(r'^(##\s*执行顺序契约)', re.MULTILINE)
    new_content, n = pattern.subn(lambda m: SWARM_COLLABORATION_SECTION + m.group(1), content)
    if n == 0:
        # 容错：找不到锚点则追加到文件末尾
        new_content = content + '\n\n' + SWARM_COLLABORATION_SECTION
        return new_content, True, False
    return new_content, True, False


def process_skill_md(skill_name, skill_dir, dry_run=False):
    """处理单个技能的 SKILL.md

    Returns:
        dict: 处理结果 {
            'skill': str, 'old_version': str, 'new_version': str,
            'compliance_changed': bool, 'sequence_changed': bool,
            'swarm_inserted': bool, 'skipped': bool, 'file': str
        }
    """
    skill_md_path = os.path.join(skill_dir, 'SKILL.md')
    with open(skill_md_path, 'r', encoding='utf-8') as f:
        content = f.read()

    # 若已包含蜂群协同章节，跳过整个文件
    if re.search(r'^##\s*蜂群协同', content, re.MULTILINE):
        # 仍尝试解析版本号用于报告
        ver_match = VERSION_PATTERN.search(content)
        old_ver = ver_match.group(2) + '.' + ver_match.group(3) + '.' + ver_match.group(4) if ver_match else '?'
        return {
            'skill': skill_name,
            'old_version': old_ver,
            'new_version': old_ver,
            'compliance_changed': False,
            'sequence_changed': False,
            'swarm_inserted': False,
            'skipped': True,
            'file': skill_md_path,
        }

    # 修改1：合规红线第7条
    content, compliance_changed = apply_compliance_change(content)
    # 修改2：执行顺序契约第3条
    content, sequence_changed = apply_sequence_change(content)
    # 修改3：插入蜂群协同章节
    content, swarm_inserted, skipped = apply_swarm_section(content)
    # 修改4：版本号升级
    content, old_ver, new_ver = bump_version(content)

    if not dry_run and new_ver is not None:
        with open(skill_md_path, 'w', encoding='utf-8') as f:
            f.write(content)

    return {
        'skill': skill_name,
        'old_version': old_ver,
        'new_version': new_ver,
        'compliance_changed': compliance_changed,
        'sequence_changed': sequence_changed,
        'swarm_inserted': swarm_inserted,
        'skipped': skipped,
        'file': skill_md_path,
    }


def main():
    """CLI 入口"""
    parser = argparse.ArgumentParser(
        description='蜂群协同技能升级脚本：批量修订 gxtz-* 技能的 SKILL.md'
    )
    parser.add_argument(
        '--skills-dir',
        required=True,
        help='skills 根目录绝对路径'
    )
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='仅预览变更，不实际修改文件'
    )
    args = parser.parse_args()

    skills_dir = os.path.abspath(args.skills_dir)
    if not os.path.isdir(skills_dir):
        print(f'[错误] skills 目录不存在: {skills_dir}', file=sys.stderr)
        sys.exit(1)

    print(f'[信息] skills 目录: {skills_dir}')
    print(f'[信息] dry-run 模式: {args.dry_run}')
    print('=' * 70)

    skills = discover_skill_dirs(skills_dir)
    print(f'[信息] 发现 {len(skills)} 个 gxtz-* 技能目录:')
    for name, _ in skills:
        print(f'  - {name}')
    print('=' * 70)

    results = []
    for skill_name, skill_dir in skills:
        result = process_skill_md(skill_name, skill_dir, dry_run=args.dry_run)
        results.append(result)
        status_tag = '[跳过]' if result['skipped'] else ('[干跑]' if args.dry_run else '[已更新]')
        ver_str = f"{result['old_version']} → {result['new_version']}" if result['new_version'] else result['old_version']
        print(f'{status_tag} {skill_name}: 版本 {ver_str}')
        print(f'         合规红线修订: {result["compliance_changed"]}, '
              f'执行顺序修订: {result["sequence_changed"]}, '
              f'蜂群章节插入: {result["swarm_inserted"]}')

    print('=' * 70)
    print('[汇总] 升级结果:')
    for r in results:
        if r['new_version'] and r['old_version'] != r['new_version']:
            print(f'  {r["skill"]}: v{r["old_version"]} → v{r["new_version"]}')
        elif r['skipped']:
            print(f'  {r["skill"]}: 已包含蜂群协同章节，跳过')

    print('=' * 70)
    print(f'[完成] 共处理 {len(results)} 个技能，'
          f'其中 {sum(1 for r in results if not r["skipped"] and not args.dry_run)} 个已写入文件。')


if __name__ == '__main__':
    main()
