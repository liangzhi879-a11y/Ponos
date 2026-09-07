# 技能包内经验库模板 (experience.json)

> 本文件放置于每个技能包根目录，作为技能的"记忆"。
> Code模式开发/升级技能时，从全局技能经验库读取待消费经验，回应后沉淀到本文件。
> 技能执行时读取本文件，参考历史经验避免重复犯错。

## 模板文件

每个技能包根目录创建 `experience.json`，内容如下（以 gxtz-core-tables 为例）：

```json
{
  "skill_name": "gxtz-core-tables",
  "current_version": "1.18.2",
  "description": "技能包内经验库 - Code模式沉淀，技能执行时参考",
  "experiences": [
    {
      "exp_id": "EXP-2026-07-13-001",
      "source_project": "2023guogao",
      "problem_type": "upgrade_trigger",
      "problem_desc": "IP表软著摘要字段为空（应为'无'）",
      "solution": "软件著作权摘要必须填'无'",
      "prevention": "validate_tables.py校验+预处理自动填'无'",
      "integrated_in_version": "1.18.2",
      "integration_method": "SKILL.md规则+validate_tables.py校验+预处理自动填'无'",
      "applicable_scenarios": ["软著摘要字段填写", "IP表生成"]
    }
  ],
  "execution_reference": {
    "description": "技能执行时读取本字段，参考历史经验避免重复犯错",
    "auto_apply_rules": [
      "软著摘要字段：自动填'无'，无需agent干预",
      "专利摘要：严格从专利说明书原文提取，不做字数校验",
      "核心表格：从固定模板复制填充，禁止手动创建Excel"
    ]
  },
  "updated_at": "2026-07-16",
  "last_synced_from_global": "2026-07-16"
}
```

## 字段说明

| 字段 | 说明 |
|------|------|
| `skill_name` | 技能名 |
| `current_version` | 当前技能版本 |
| `experiences` | 已沉淀的经验列表 |
| `experiences[].exp_id` | 经验ID（与全局经验库对应） |
| `experiences[].source_project` | 来源项目 |
| `experiences[].integrated_in_version` | 沉淀到技能包的版本号 |
| `experiences[].integration_method` | 沉淀方式 |
| `experiences[].applicable_scenarios` | 适用场景列表 |
| `execution_reference` | 技能执行时参考的规则 |
| `execution_reference.auto_apply_rules` | 可自动应用的规则列表 |
| `last_synced_from_global` | 最后从全局经验库同步的时间 |

## 维护规则

1. **Code模式升级技能时**：从全局经验库读取pending经验，回应后写入本文件
2. **技能执行时**：读取本文件，参考`execution_reference.auto_apply_rules`
3. **新增经验**：技能执行中发现新问题→记录到项目级经验库→收工时汇聚到全局→下次升级消费→沉淀到本文件
4. **禁止**：手动编辑本文件，必须通过Code模式升级流程同步
