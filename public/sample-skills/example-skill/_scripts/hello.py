#!/usr/bin/env python3
"""示例附属脚本 — 验证技能包 _scripts/ 目录可正常运行。"""

import sys

def main():
    print("[example-skill] Hello from _scripts/hello.py")
    print(f"Python version: {sys.version}")
    return 0

if __name__ == "__main__":
    sys.exit(main())
