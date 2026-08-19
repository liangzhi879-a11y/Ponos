"""upgrade_interaction_v2.py
================================================================
批量升级 gxtz-* 技能 SKILL.md 的交互规范：
- 将"确认对话格式规范"替换为"确认交互规范（使用 AskUserQuestion 工具，减少对话打断）"
- 将"质疑对话格式规范"替换为"质疑交互规范（使用 AskUserQuestion 工具，减少对话打断）"
- 同步升级 SKILL.md frontmatter 的 version patch+1
- 已升级过的（包含"### 确认交互规范"标题）自动跳过

使用方式：
    python upgrade_interaction_v2.py --skills-dir <技能根目录> [--dry-run]

示例：
    python upgrade_interaction_v2.py --skills-dir "<项目根>/.trae/skills"
    python upgrade_interaction_v2.py --skills-dir ... --dry-run
================================================================
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from typing import Tuple


# ----------------------------------------------------------------
# 新章节内容定义
# ----------------------------------------------------------------

# 自主确认机制新章节：从"### 确认交互规范"到下一个"### "之前
NEW_CONFIRMATION_SECTION = """### 确认交互规范（使用 AskUserQuestion 工具，减少对话打断）

当 agent 判断需要确认时，按以下两步执行：

**第一步：输出问题描述**（文本格式，让用户了解完整背景）

```
⚠️【需要确认】[触发类型：A/B/C/D] - [步骤名称]

📋 问题描述：
[具体说明冲突/异常/缺失/推断的情况，包含数据细节]

📊 可选方案对比：
| 方案 | 内容 | 优点 | 缺点 | 影响 |
|------|------|------|------|------|
| 方案1 | [具体内容] | [优点] | [缺点] | [对后续步骤的影响] |
| 方案2 | [具体内容] | [优点] | [缺点] | [对后续步骤的影响] |

✅ 推荐方案：[方案X]
```

**第二步：调用 AskUserQuestion 工具**（让用户点击选择，无需手动输入）

agent 必须使用 AskUserQuestion 工具提供结构化选项，格式如下：
- questions数组包含1个question对象
- question: 简洁的问题描述（如"数据源冲突：2023年辅助账在两个文件中项目不同，请选择以哪个为准？"）
- header: 短标签，≤12字符（如"数据冲突"、"资料缺失"、"需推断"、"格式异常"）
- options: 每个方案一个选项（2-4个），推荐方案放第一个并标注"(推荐)"
  - label: 方案简称，1-5个字（如"用ZIP数据"、"(推荐)按比例分配"）
  - description: 方案详情+优缺点+影响（1-2句话）
- multiSelect: false（单选）

**示例：**
```json
{
  "questions": [{
    "question": "2023年辅助账在两个文件中项目不同：ZIP中6个项目 vs 直接目录中6个项目（实为2024数据）。请选择以哪个为准？",
    "header": "数据冲突",
    "options": [
      {"label": "(推荐)ZIP数据", "description": "使用ZIP中的2023年6个项目（软性线路板方向），真实可溯源，与立项报告方向一致"},
      {"label": "用目录数据", "description": "使用直接目录中的数据，但实际为2024年数据，会导致年度数据重复"},
      {"label": "两者合并", "description": "合并两个来源的项目，但可能引入2024年数据污染2023年"}
    ],
    "multiSelect": false
  }]
}
```

**关键规则：**
1. 必须先输出文本问题描述（让用户了解完整背景），再调用AskUserQuestion
2. 推荐方案必须放在options第一个，label前加"(推荐)"
3. 用户选择"Other"时表示要自定义方案，agent应按用户输入执行
4. 禁止只输出文本"请确认"而不调用AskUserQuestion工具
5. 禁止只调用AskUserQuestion而不输出文本背景（用户需要完整信息才能决策）"""

# 质疑审查机制新章节：从"### 质疑交互规范"到下一个"### "之前
NEW_QUESTIONING_SECTION = """### 质疑交互规范（使用 AskUserQuestion 工具，减少对话打断）

当 agent 发现不符时，按以下两步执行：

**第一步：输出质疑依据**（文本格式，必须包含具体数据支撑）

```
⚠️【质疑审查】[触发类型：E/F/G/H] - [步骤名称/产出物名称]

📋 质疑依据：

【原始资料】
- 来源：[文件完整路径]
- 位置：[Sheet名/段落/行号]
- 原文内容：[逐字引用]

【agent 产出或用户要求】
- 位置：[产出文件路径/表格行号]
- 内容：[逐字引用]

【差异说明】
- 原始资料显示：[X]
- 产出/要求显示：[Y]
- 差异性质：[实质性不符 / 数量超出支撑 / 描述不一致 / 计算错误]

⚠️ 影响评估：如不修正，将导致 [具体后果]

✅ 推荐方案：[方案X]
理由：[推荐理由，必须基于"严谨合规"原则]
```

**第二步：调用 AskUserQuestion 工具**（让用户点击选择，无需手动输入）

agent 必须使用 AskUserQuestion 工具提供结构化选项，格式如下：
- question: 质疑摘要+差异说明（如"RD名称撰写为'LCM测试软件'但辅助账中是'显示驱动板研发'，请选择以哪个为准？"）
- header: 短标签，≤12字符（如"内容不符"、"数量超限"、"跨表不一致"、"计算错误"）
- options: 每个方案一个选项（2-4个），推荐方案放第一个并标注"(推荐)"
  - label: 方案简称，1-5个字
  - description: 方案详情+影响评估
- multiSelect: false

**示例：**
```json
{
  "questions": [{
    "question": "RD名称撰写为'LCM测试软件'但辅助账中是'显示驱动板研发'。原始资料显示应为后者。请选择处理方案：",
    "header": "内容不符",
    "options": [
      {"label": "(推荐)用辅助账", "description": "以辅助账'显示驱动板研发'为准，真实可溯源，避免专审核对失败"},
      {"label": "用撰写内容", "description": "保持'LCM测试软件'，但与辅助账不符，专审核对会报错"},
      {"label": "合并调整", "description": "合并两个名称为'显示驱动板(LCM)研发'，兼顾两者但需确认辅助账方同意"}
    ],
    "multiSelect": false
  }]
}
```

**关键规则：**
1. 必须先输出文本质疑依据（含文件路径、位置、原文引用），再调用AskUserQuestion
2. 推荐方案必须放在options第一个，label前加"(推荐)"
3. 用户选择"Other"时表示要自定义方案，agent应按用户输入执行
4. 禁止只输出文本"请确认"而不调用AskUserQuestion工具
5. 禁止只调用AskUserQuestion而不输出文本质疑依据（用户需要完整数据支撑才能决策）"""


# ----------------------------------------------------------------
# 工具函数
# ----------------------------------------------------------------

def _replace_section(content: str, section_title_pattern: str, new_section: str) -> Tuple[str, bool]:
    """替换 markdown 中某个 ### 子章节的内容。

    匹配规则：从给定的 section_title_pattern 行开始，到下一个"### "标题前一行结束
    （若已是最后一个 ### 子章节，则到父级 ## 标题前结束）。

    Args:
        content: 原始 markdown 文本
        section_title_pattern: 章节标题的正则表达式（用于匹配起始行）
        new_section: 新章节完整内容（含标题行）

    Returns:
        (新内容, 是否发生替换)
    """
    lines = content.split("\n")
    start_idx = None
    for i, line in enumerate(lines):
        if re.match(section_title_pattern, line):
            start_idx = i
            break

    if start_idx is None:
        return content, False

    # 向下查找下一个 "### " 标题（排除自身）或父级 "## " 标题
    end_idx = len(lines)
    for j in range(start_idx + 1, len(lines)):
        line = lines[j]
        # 遇到下一个同级 ### 或父级 ## 即结束
        if line.startswith("### ") or line.startswith("## "):
            end_idx = j
            break

    # 回退末尾空行，保留章节间空行结构
    while end_idx > start_idx + 1 and lines[end_idx - 1].strip() == "":
        end_idx -= 1

    new_lines = lines[:start_idx] + new_section.split("\n") + [""] + lines[end_idx:]
    return "\n".join(new_lines), True


def _bump_patch_version(version: str) -> str:
    """版本号 patch+1，例如 '1.18.3' -> '1.18.4'。"""
    parts = version.split(".")
    if len(parts) != 3:
        raise ValueError(f"版本号格式异常: {version}")
    major, minor, patch = parts
    return f"{major}.{minor}.{int(patch) + 1}"


def _read_frontmatter_version(content: str) -> Tuple[str, str]:
    """从 SKILL.md frontmatter 中读取 version 字段，返回 (原始version字段行, 版本号)。"""
    match = re.search(r'^version:\s*"([^"]+)"', content, re.MULTILINE)
    if not match:
        match = re.search(r"^version:\s*([^\s]+)", content, re.MULTILINE)
    if not match:
        raise ValueError("无法在 frontmatter 中找到 version 字段")
    return match.group(0), match.group(1)


# ----------------------------------------------------------------
# 主流程
# ----------------------------------------------------------------

def discover_skill_dirs(skills_dir: Path) -> list:
    """自动发现所有 gxtz-* 技能目录（仅一级目录，忽略 _backup_* 和 _common/_versions）。"""
    if not skills_dir.is_dir():
        raise FileNotFoundError(f"skills 目录不存在: {skills_dir}")

    skill_dirs = []
    for item in sorted(skills_dir.iterdir()):
        if not item.is_dir():
            continue
        if not item.name.startswith("gxtz-"):
            continue
        if (item / "SKILL.md").exists():
            skill_dirs.append(item)
    return skill_dirs


def upgrade_skill_md(skill_md: Path, dry_run: bool) -> dict:
    """升级单个 SKILL.md，返回处理结果 dict。"""
    result = {
        "skill": skill_md.parent.name,
        "skill_md": str(skill_md),
        "old_version": None,
        "new_version": None,
        "confirmation_replaced": False,
        "questioning_replaced": False,
        "skipped": False,
        "skip_reason": "",
    }

    content = skill_md.read_text(encoding="utf-8")

    # 已升级过则跳过
    if "### 确认交互规范" in content and "### 质疑交互规范" in content:
        result["skipped"] = True
        result["skip_reason"] = "已包含新交互规范，跳过"
        return result

    # 读取旧版本
    try:
        _, old_ver = _read_frontmatter_version(content)
    except ValueError as e:
        result["skipped"] = True
        result["skip_reason"] = f"读取版本号失败: {e}"
        return result
    result["old_version"] = old_ver
    result["new_version"] = _bump_patch_version(old_ver)

    # 替换确认对话格式章节（兼容历史标题"### 确认对话格式规范"）
    content, conf_replaced = _replace_section(
        content,
        r"^###\s+确认对话格式规范",
        NEW_CONFIRMATION_SECTION,
    )
    result["confirmation_replaced"] = conf_replaced

    # 替换质疑对话格式章节（兼容历史标题"### 质疑对话格式规范"）
    content, ques_replaced = _replace_section(
        content,
        r"^###\s+质疑对话格式规范",
        NEW_QUESTIONING_SECTION,
    )
    result["questioning_replaced"] = ques_replaced

    # 升级 frontmatter version
    old_ver_line = f'version: "{old_ver}"'
    new_ver_line = f'version: "{result["new_version"]}"'
    if old_ver_line in content:
        content = content.replace(old_ver_line, new_ver_line, 1)
    else:
        # 兼容无引号写法
        old_ver_line_alt = f"version: {old_ver}"
        new_ver_line_alt = f"version: {result['new_version']}"
        if old_ver_line_alt in content:
            content = content.replace(old_ver_line_alt, new_ver_line_alt, 1)

    if not dry_run:
        skill_md.write_text(content, encoding="utf-8")

    return result


def main():
    parser = argparse.ArgumentParser(
        description="批量升级 gxtz-* 技能 SKILL.md 的确认/质疑交互规范为 AskUserQuestion 结构化选择项"
    )
    parser.add_argument(
        "--skills-dir",
        required=True,
        help="技能根目录（包含若干 gxtz-* 子目录）",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="只打印计划，不实际写文件",
    )
    args = parser.parse_args()

    skills_dir = Path(args.skills_dir)
    skill_dirs = discover_skill_dirs(skills_dir)

    if not skill_dirs:
        print(f"[警告] 未在 {skills_dir} 发现 gxtz-* 技能目录")
        return 1

    print("=" * 70)
    print(f"批量升级 SKILL.md 交互规范 (dry_run={args.dry_run})")
    print(f"技能根目录: {skills_dir}")
    print(f"发现技能数: {len(skill_dirs)}")
    print("=" * 70)

    success_count = 0
    skipped_count = 0
    failed_count = 0
    results = []

    for skill_dir in skill_dirs:
        skill_md = skill_dir / "SKILL.md"
        try:
            r = upgrade_skill_md(skill_md, args.dry_run)
            results.append(r)
            if r["skipped"]:
                print(f"[跳过] {r['skill']}: {r['skip_reason']}")
                skipped_count += 1
            else:
                status = "OK"
                if not r["confirmation_replaced"]:
                    status += " [未匹配确认章节]"
                if not r["questioning_replaced"]:
                    status += " [未匹配质疑章节]"
                print(
                    f"[{status}] {r['skill']}: "
                    f"v{r['old_version']} -> v{r['new_version']} | "
                    f"确认替换={r['confirmation_replaced']} 质疑替换={r['questioning_replaced']}"
                )
                success_count += 1
        except Exception as e:
            print(f"[失败] {skill_dir.name}: {e}")
            failed_count += 1

    print("=" * 70)
    print(f"汇总: 成功 {success_count} / 跳过 {skipped_count} / 失败 {failed_count} / 总计 {len(skill_dirs)}")
    print("=" * 70)
    return 0 if failed_count == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
