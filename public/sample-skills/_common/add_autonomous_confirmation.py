"""批量添加自主确认机制到 8 个 gxtz-* 技能 SKILL.md（v1.0 - 2026-07-14）

在「合规红线」与「执行顺序契约」之间插入「自主确认机制」章节
升级版本号：core-tables/info-collector 1.17.0→1.18.0，其他 1.14.0→1.15.0

用法：
  python add_autonomous_confirmation.py --all
"""
import os
import re
import sys
import argparse
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from path_config import get_skills_dir_str

SKILLS_DIR = get_skills_dir_str()

# 版本升级映射
VERSION_UPGRADES = {
    'gxtz-core-tables': {'from': '1.17.0', 'to': '1.18.0'},
    'gxtz-info-collector': {'from': '1.17.0', 'to': '1.18.0'},
    'gxtz-ip-materials': {'from': '1.14.0', 'to': '1.15.0'},
    'gxtz-achievement-materials': {'from': '1.14.0', 'to': '1.15.0'},
    'gxtz-ps-materials': {'from': '1.14.0', 'to': '1.15.0'},
    'gxtz-staff-materials': {'from': '1.14.0', 'to': '1.15.0'},
    'gxtz-management-materials': {'from': '1.14.0', 'to': '1.15.0'},
    'gxtz-rd-report': {'from': '1.14.0', 'to': '1.15.0'},
}

# 自主确认机制章节内容
AUTONOMOUS_CONFIRMATION_SECTION = """## 自主确认机制（agent 自主分辨，遇异常主动暂停）

> **核心原则：agent 必须自主判断是否需要与用户确认，而非依赖预设问题清单。**
> **遇到任何不确定、冲突、缺失、异常，立即暂停并向用户确认，不得自行决定后继续。**

### 判断原则（agent 在每个步骤执行前后必须自问）

agent 在执行每个步骤时，必须对照以下 5 个原则自主判断：

1. **数据一致性原则**：同一数据是否来自多个来源？各来源内容是否一致？
   - 不一致 → 暂停，列出各来源数据，请用户指定以哪个为准
   - 一致 → 继续

2. **完整性原则**：本步骤所需的关键资料是否齐全？
   - 缺失 → 暂停，列出缺失资料清单，请用户补充或指定替代方案
   - 齐全 → 继续

3. **推断性原则**：本步骤是否需要做推断/假设才能继续？
   - 需要推断 → 暂停，说明推断依据和可能偏差，请用户确认是否接受
   - 基于事实 → 继续

4. **异常性原则**：数据格式/结构/内容是否与预期不符？
   - 异常 → 暂停，说明异常情况，请用户确认处理方式
   - 正常 → 继续

5. **质量保证原则**：如果继续执行，输出质量是否会有严重偏差？
   - 可能偏差 → 暂停，说明偏差原因和影响，请用户决定
   - 质量可控 → 继续

### 触发条件（4 类，agent 自主识别）

| 类型 | 触发场景 | 核心判别逻辑 | 示例 |
|------|---------|-------------|------|
| **A 类：数据源冲突** | 同一字段/数据存在多个来源，且内容不一致 | 对比多源数据，发现数值/名称/日期等不一致 | 辅助账 2023 年数据在两个文件中项目不同；RD 项目在立项书与辅助账中不一致 |
| **B 类：格式/结构异常** | 数据格式与预期不同，需转换或特殊处理才能使用 | 检查数据格式是否符合本步骤预期 | 2025 年辅助账是明细账格式（逐笔记录）而非项目级汇总；PDF 是扫描件需 OCR |
| **C 类：关键推断/假设** | 需要做实质性推断才能继续，推断结果可能影响输出质量 | 判断是否在"猜测"某个值或关系 | 按比例分配 2025 年费用到各项目；IP 与 RD 的关键词匹配推断 |
| **D 类：资料可能不完整** | 已有数据不足以支撑后续步骤，或关键资料缺失 | 检查关键资料是否齐全 | 缺少专利文献；发票未标注 PS；缺少上年 12 月社保缴费记录 |

### 每步自问速查（agent 必须执行）

agent 在每个步骤执行前后，必须自问以下 5 个问题。任一答案为"是"，立即暂停：

- [ ] 这一步的数据是否来自多个来源？各来源是否一致？（A 类）
- [ ] 这一步的数据格式是否与预期一致？（B 类）
- [ ] 这一步是否需要我做推断/假设？推断依据是什么？（C 类）
- [ ] 这一步的关键资料是否完整？是否有缺失？（D 类）
- [ ] 如果我继续执行，输出质量是否会有严重偏差？（质量保证）

### 确认对话格式规范（agent 暂停时必须按此格式输出）

当 agent 判断需要确认时，必须按以下格式输出，然后等待用户回复：

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
理由：[推荐理由]

⏸️ 请确认您选择的方案，或提供其他指示。确认前我不会继续执行。
```

### 禁止行为（5 条，违反即停止）

1. **禁止自行决定数据源**：多源数据冲突时，不得自行选择某个来源，必须暂停确认
2. **禁止自行做关键假设**：需要推断才能继续时，不得自行推断后继续，必须暂停确认
3. **禁止事后告知**：不得先执行再告知用户"我做了 XX 假设"，必须先确认再执行
4. **禁止模糊确认**：不得用"可能"、"大概"、"应该"等模糊表述，必须明确具体
5. **禁止假设同意**：不得假设用户会同意某方案，必须等待用户明确回复

### 自主分辨能力要点（区别于预设问题清单）

本机制不是预设问题清单，而是赋予 agent 自主分辨能力：

1. **场景无关**：无论遇到什么场景，agent 都用 5 个判断原则自主判断
2. **数据驱动**：基于实际数据判断，而非匹配预设问题
3. **主动识别**：agent 主动识别异常，而非等待预设问题触发
4. **动态适应**：适应任何新情况，而非仅处理已知问题
5. **质量导向**：以输出质量为保证目标，而非以完成步骤为目标

### 典型场景示例（参考，非穷举）

以下场景需主动暂停确认（agent 应自主识别类似场景，不限于以下列举）：

- **辅助账文件冲突**：同名辅助账在多个文件中内容不同 → A 类
- **费用分配方式**：某年度辅助账是明细账格式，需按比例分配到项目 → C 类
- **RD 项目来源不一致**：立项报告与辅助账的 RD 项目不同 → A 类
- **IP 与 RD 匹配推断**：基于关键词匹配推断 IP 与 RD 关联 → C 类
- **专利文献缺失**：IP 清单中某些专利缺少专利文献 → D 类
- **发票未标注 PS**：上年度全量发票未标注 PS 归属 → D 类
- **社保缴费记录不完整**：缺少上年 12 月带公章的社保记录 → D 类
- **技术领域多源不一致**：申请书与所得税申报表的技术领域不同 → A 类
- **研发费用占比异常**：某年度研发费用占比明显偏低/偏高 → B 类
- **人员在职天数临界**：某人员在职天数在 180-185 天临界 → C 类

"""


def add_autonomous_confirmation(skill_name):
    """为单个技能添加自主确认机制章节

    返回 {
        'skill': skill_name,
        'old_version': str,
        'new_version': str,
        'inserted': bool,
        'already_exists': bool,
        'version_updated': bool,
    }
    """
    skill_md_path = os.path.join(SKILLS_DIR, skill_name, 'SKILL.md')

    if not os.path.exists(skill_md_path):
        return {'skill': skill_name, 'error': f'SKILL.md 不存在'}

    with open(skill_md_path, 'r', encoding='utf-8') as f:
        content = f.read()

    versions = VERSION_UPGRADES[skill_name]
    old_version = versions['from']
    new_version = versions['to']

    result = {
        'skill': skill_name,
        'old_version': old_version,
        'new_version': new_version,
        'inserted': False,
        'already_exists': False,
        'version_updated': False,
    }

    # 1. 检查是否已存在自主确认机制章节
    if '## 自主确认机制' in content:
        result['already_exists'] = True
        # 即使已存在，也更新版本号
    else:
        # 2. 在「合规红线」与「执行顺序契约」之间插入
        # 匹配 "## 执行顺序契约" 标题行
        pattern = r'(## 执行顺序契约[^\n]*\n)'
        match = re.search(pattern, content)
        if match:
            # 在 "## 执行顺序契约" 前插入自主确认机制章节
            insert_pos = match.start()
            content = content[:insert_pos] + AUTONOMOUS_CONFIRMATION_SECTION + '\n' + content[insert_pos:]
            result['inserted'] = True
        else:
            # 如果没找到"## 执行顺序契约"，尝试在"## 合规红线"章节末尾后插入
            pattern2 = r'(## 合规红线[^\n]*\n.*?)(?=\n## |\Z)'
            match2 = re.search(pattern2, content, re.DOTALL)
            if match2:
                insert_pos = match2.end()
                content = content[:insert_pos] + '\n\n' + AUTONOMOUS_CONFIRMATION_SECTION + content[insert_pos:]
                result['inserted'] = True
            else:
                return {'skill': skill_name, 'error': '未找到插入位置（合规红线/执行顺序契约）'}

    # 3. 更新版本号
    old_version_pattern = f'version: "{old_version}"'
    new_version_pattern = f'version: "{new_version}"'

    # 先尝试精确匹配旧版本
    if old_version_pattern in content:
        content = content.replace(old_version_pattern, new_version_pattern)
        result['version_updated'] = True
    else:
        # 尝试自动检测当前版本号并替换
        version_match = re.search(r'version:\s*"(\d+\.\d+\.\d+)"', content)
        if version_match:
            current_version = version_match.group(1)
            content = content.replace(f'version: "{current_version}"', new_version_pattern)
            result['version_updated'] = True
            result['old_version'] = current_version
        else:
            result['version_updated'] = False

    # 4. 写入文件
    with open(skill_md_path, 'w', encoding='utf-8') as f:
        f.write(content)

    return result


def main():
    parser = argparse.ArgumentParser(description='批量添加自主确认机制到 8 个技能包')
    parser.add_argument('--all', action='store_true', help='处理所有 8 个技能')
    args = parser.parse_args()

    if not args.all:
        parser.print_help()
        return

    print('=' * 60)
    print('批量添加自主确认机制')
    print('=' * 60)

    results = []
    for skill_name in VERSION_UPGRADES.keys():
        print(f'\n处理 {skill_name} ...')
        result = add_autonomous_confirmation(skill_name)
        results.append(result)

        if 'error' in result:
            print(f'  ❌ {result["error"]}')
        else:
            if result['already_exists']:
                print(f'  ⚠️  自主确认机制已存在（仅更新版本号）')
            elif result['inserted']:
                print(f'  ✅ 自主确认机制已插入')
            print(f'  版本: {result["old_version"]} → {result["new_version"]} ({"✓" if result["version_updated"] else "✗"})')

    # 汇总
    print('\n' + '=' * 60)
    print('汇总报告')
    print('=' * 60)
    print(f'{"技能":<35} {"旧版本":>10} {"新版本":>10} {"插入":>6} {"版本":>6}')
    print('-' * 75)
    for r in results:
        if 'error' not in r:
            insert_status = '已存在' if r['already_exists'] else ('✓' if r['inserted'] else '✗')
            version_status = '✓' if r['version_updated'] else '✗'
            print(f'{r["skill"]:<35} {r["old_version"]:>10} {r["new_version"]:>10} {insert_status:>6} {version_status:>6}')

    print()


if __name__ == '__main__':
    main()
