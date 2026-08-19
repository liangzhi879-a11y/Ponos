"""合并 _version_manifest.json 的 history 数组

将 .bak 文件中完整的 history 数组合并到新格式文件中。
保留新文件的所有结构（experience_integration, pending_upgrades, verified_upgrades）。
按版本号去重和降序排序。
"""
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from path_config import get_skills_dir

SKILLS_DIR = get_skills_dir()
NEW_FILE = SKILLS_DIR / '_version_manifest.json'
BAK_FILE = SKILLS_DIR / '_version_manifest.json.bak'


def parse_version(v):
    """将版本字符串解析为可比较的元组"""
    parts = str(v).split('.')
    return tuple(int(p) for p in parts)


def merge_history(new_history, bak_history):
    """合并两个history数组，按版本号去重，降序排序"""
    # 用字典按版本号去重（新文件优先）
    merged = {}
    for item in bak_history:
        merged[item['version']] = item
    for item in new_history:
        # 新文件覆盖.bak（新文件的内容更准确）
        merged[item['version']] = item

    # 按版本号降序排序
    result = sorted(merged.values(), key=lambda x: parse_version(x['version']), reverse=True)
    return result


def main():
    # 读取两个文件
    with open(NEW_FILE, 'r', encoding='utf-8') as f:
        new_data = json.load(f)
    with open(BAK_FILE, 'r', encoding='utf-8') as f:
        bak_data = json.load(f)

    print(f'新文件: {len(new_data["skills"])} 个技能')
    print(f'.bak文件: {len(bak_data["skills"])} 个技能')
    print()

    # 合并每个技能的history
    merge_stats = []
    for skill_name, skill_data in new_data['skills'].items():
        new_hist = skill_data.get('history', [])
        bak_hist = bak_data.get('skills', {}).get(skill_name, {}).get('history', [])

        merged = merge_history(new_hist, bak_hist)
        skill_data['history'] = merged

        old_count = len(new_hist)
        bak_count = len(bak_hist)
        new_count = len(merged)
        added = new_count - old_count
        merge_stats.append({
            'skill': skill_name,
            'old_count': old_count,
            'bak_count': bak_count,
            'merged_count': new_count,
            'added': added,
        })

    # 写入合并后的文件
    with open(NEW_FILE, 'w', encoding='utf-8') as f:
        json.dump(new_data, f, ensure_ascii=False, indent=2)

    # 输出统计
    print(f'{"技能":<35} {"原history":>10} {"bak":>6} {"合并后":>8} {"新增":>6}')
    print('-' * 70)
    total_added = 0
    for s in merge_stats:
        print(f'{s["skill"]:<35} {s["old_count"]:>10} {s["bak_count"]:>6} {s["merged_count"]:>8} {s["added"]:>+6}')
        total_added += s['added']
    print('-' * 70)
    print(f'总计新增history记录: {total_added}条')

    # 验证：展示每个技能的history版本号
    print()
    print('=== 合并后各技能history版本号 ===')
    for skill_name, skill_data in new_data['skills'].items():
        versions = [h['version'] for h in skill_data['history']]
        print(f'{skill_name}: {" → ".join(versions)}')

    print()
    print(f'✓ 合并完成，已写入: {NEW_FILE}')


if __name__ == '__main__':
    main()
