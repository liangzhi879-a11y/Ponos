---
name: "example-skill"
description: "示例技能：展示标准技能包格式。当用户提到示例技能、技能示例、skill example 时调用此技能。"
version: "1.0.0"
dependencies: []
---

# 示例技能

## 角色定位

本技能是一个标准技能包格式示例，展示 SKILL.md 的规范写法、附属脚本的组织方式、以及经验库的初始结构。

## SKILL.md 格式规范

技能包的核心文件是 `SKILL.md`，采用 Markdown 格式，文件开头必须包含 YAML 前置元数据（Front Matter）：

```yaml
---
name: "技能ID"           # 唯一标识，与目录名一致
description: "描述"      # 技能描述，含触发词
version: "x.y.z"         # 语义化版本号
dependencies: []         # 依赖的其他技能ID列表（可选）
---
```

### 必填字段
- `name`: 技能唯一标识
- `description`: 技能描述，应包含触发关键词
- `version`: 语义化版本（主版本.次版本.修订号）

### 可选字段
- `dependencies`: 依赖的其他技能 ID 列表

## 附属脚本

技能包中的 `_scripts/` 目录存放 Python 附属脚本，agent 可通过 `python _scripts/xxx.py` 调用。

脚本依赖通过 `_scripts/requirements.txt` 声明，安装时 Ponos 会提示用户安装。

## 经验库

`experience.json` 记录技能运行中积累的经验，格式如下：

```json
{
  "skill_name": "example-skill",
  "experiences": [],
  "execution_reference": {
    "auto_apply_rules": []
  }
}
```

安装时自动创建空模板。

## 模板文件

`_templates/` 目录存放可复用的模板文件（Excel、Word 等），agent 在工作流中根据需要引用。
