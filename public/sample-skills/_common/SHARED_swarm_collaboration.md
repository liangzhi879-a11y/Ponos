# 蜂群协同规范（通用）

> 本技能支持蜂群编排下的跨技能并行执行。技能内步骤仍必须串行（见执行顺序契约），但与其他无数据依赖的技能可并行。

## 可并行阶段

本技能所属阶段及并行条件，参见 `.trae/skills/_common/_swarm_orchestration.md` 的可并行阶段矩阵。

## subagent执行规范

当被主agent作为subagent派发时：
1. 读取本SKILL.md，遵守合规红线/自主确认/质疑审查/执行顺序契约
2. 所有产出写入统一输出目录
3. 读写project_knowledge时使用file_lock并发控制
4. 最终步必须运行审核脚本（validate_*.py）
5. 返回精简摘要：技能名、产出文件清单、审核结果、质疑事项

## 并发控制

读写 project_knowledge 的JSON文件时必须使用：
```python
import sys
sys.path.insert(0, r'c:\Users\T203-15\Desktop\2023guogao\.trae\skills\_common')
from file_lock import file_lock
with file_lock('file_map.json'):
    # 读写操作
```

详细规范参见 `.trae/skills/_common/_swarm_orchestration.md`。
