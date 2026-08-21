#!/usr/bin/env python3
# SWE-bench 数据集转储：parquet → benchmark/data/swebench-verified.json
# ---------------------------------------------------------------------------
# 一次性脚本：从本地 parquet（swebench 包 + hf-mirror 下载）读取 Verified 全量
# 500 条实例，输出平台任务生成脚本（swebench-import.mjs）所需的精简 JSON。
# 用法：
#   python benchmark/scripts/swebench-dump.py <verified.parquet>
# 输出：benchmark/data/swebench-verified.json
# ---------------------------------------------------------------------------
import json
import os
import sys

def main():
    parquet = sys.argv[1] if len(sys.argv) > 1 else None
    if not parquet or not os.path.exists(parquet):
        print('用法: python benchmark/scripts/swebench-dump.py <verified.parquet>')
        sys.exit(1)
    from swebench.harness.utils import load_swebench_dataset
    tasks = load_swebench_dataset(parquet)
    out = []
    for t in tasks:
        ftp = json.loads(t['FAIL_TO_PASS']) if isinstance(t['FAIL_TO_PASS'], str) else (t['FAIL_TO_PASS'] or [])
        ptp = json.loads(t['PASS_TO_PASS']) if isinstance(t['PASS_TO_PASS'], str) else (t['PASS_TO_PASS'] or [])
        out.append({
            'instance_id': t['instance_id'],
            'repo': t['repo'],
            'base_commit': t['base_commit'],
            'problem_statement': t['problem_statement'],
            'test_patch': t['test_patch'],
            'patch': t['patch'],
            'FAIL_TO_PASS': ftp,
            'PASS_TO_PASS': ptp,
            'difficulty': t.get('difficulty', ''),
        })
    dest = os.path.join(os.path.dirname(__file__), '..', 'data', 'swebench-verified.json')
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print(f'dumped {len(out)} instances -> {os.path.abspath(dest)}')

if __name__ == '__main__':
    main()
