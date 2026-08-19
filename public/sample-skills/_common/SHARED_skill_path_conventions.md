# SHARED: 技能路径规范 — 所有 gxtz-* 技能共享
# 来源: all 技能经验库 EXP-2026-07-25-002 (2026-07-25)
# 修改此文件即可同步所有技能的路径规范，禁止在各 SKILL.md 中直接硬编码路径

## 路径规范（agent 编写 SKILL.md / 脚本时必读）

> **核心原则**：三类路径严格区分，各司其职。混用将导致脚本找不到、文件读不到、跨项目行为不一致。

### 三类路径规范速查表

| 路径类型 | 使用场景 | 路径格式 | 示例 |
|---------|---------|---------|------|
| **C盘仓库路径** | SKILL.md中的python脚本调用 | `C:\Users\T203-15\.trae-cn\skills\enterprise_project_skills\_common\` | `python "C:\Users\T203-15\.trae-cn\skills\enterprise_project_skills\_common\generate_achievement_proofs.py" --project-root "项目路径"` |
| **C盘仓库路径** | SKILL.md中的共享文件引用（SHARED_*.md等） | `C:\Users\T203-15\.trae-cn\skills\enterprise_project_skills\_common\` | 文件引用: `C:\Users\T203-15\.trae-cn\skills\enterprise_project_skills\_common\SHARED_tech_stack.md` |
| **项目相对路径** | SKILL.md中引用项目内文件（模板/提示词/配置） | `.trae/skills/{skill_name}/...` | `.trae/skills/gxtz-achievement-materials/templates/成果转化情况汇总表.xlsx` |
| **项目相对路径** | SKILL.md中引用_common共享文件（文本引用） | `.trae/skills/_common/...` | `.trae/skills/_common/SHARED_tech_stack.md` |

### 决策流程图

```
SKILL.md中引用某个文件 → 问自己三个问题：

Q1: 是python脚本调用吗？
  → 是 → 必须使用C盘仓库路径
  → 示例: python "C:\Users\T203-15\.trae-cn\skills\enterprise_project_skills\_common\push_skills.py"

Q2: 是共享规范文档的内容引用（SHARED_*.md）吗？
  → 是（SKILL.md中文本引用） → 使用项目相对路径: .trae/skills/_common/SHARED_xxx.md
  → 是（脚本中file_path参数） → 使用C盘仓库路径

Q3: 是项目内文件（模板/模板/提示词/配置）吗？
  → 是 → 使用项目相对路径: .trae/skills/{skill_name}/templates/xxx.xlsx
```

### 禁止项

| 禁止行为 | 说明 | 正确做法 |
|---------|------|---------|
| 硬编码项目绝对路径 | `D:\OneDrive\文档\工作\【国高】xxx\...` | 使用项目相对路径 `.trae/skills/...` |
| SKILL.md中python调用使用相对路径 | `python .trae/skills/_common/xxx.py` | 使用C盘仓库路径 `python "C:\Users\T203-15\.trae-cn\skills\enterprise_project_skills\_common\xxx.py"` |
| 脚本中文件读写使用C盘仓库路径 | 引用项目内的模板/数据文件 | 使用项目相对路径或通过project_context_manager读取 |
| 跨技能引用_common脚本使用项目路径 | `python .trae/skills/_common/push_skills.py` | 使用C盘仓库路径 |

### 脚本调用模板

**SKILL.md中的python调用写法（标准模板）：**

```markdown
### 步骤X：执行XXX脚本

```bash
python "C:\Users\T203-15\.trae-cn\skills\enterprise_project_skills\_common\脚本名.py" --参数1 "值1" --参数2 "值2"
```

### 步骤Y：读取项目内文件

使用项目相对路径引用模板文件：
- 模板位置: `.trae/skills/{skill_name}/templates/模板名.xlsx`
- 输出位置: 由用户指定的项目目录
```

### 文件引用模板

**SKILL.md中引用共享规范（文本引用，非脚本）：**

```markdown
> 共享规范详见: [SHARED_tech_stack.md](.trae/skills/_common/SHARED_tech_stack.md)
> [SHARED_swarm_collaboration.md](.trae/skills/_common/SHARED_swarm_collaboration.md)
```

### 版本同步机制

| 操作 | 方向 | 命令 |
|------|------|------|
| 拉取C盘最新技能 | C盘 → 项目 | `.\run_sync.bat` |
| 推送项目技能到C盘 | 项目 → C盘 | `.\push_skills.bat` |
| 版本检测（启动时） | C盘 vs 项目 | `python "C:\Users\T203-15\.trae-cn\skills\enterprise_project_skills\_common\project_context_manager.py" version-check` |

### 检查清单（新建/升级技能后执行）

- [ ] SKILL.md中所有 `python` 调用均使用C盘仓库路径
- [ ] SKILL.md中所有项目内模板引用使用 `.trae/skills/` 相对路径
- [ ] 无残留硬编码项目绝对路径（`D:\OneDrive\...`、`D:\Projects\...`）
- [ ] 共享文件文本引用格式正确（`.trae/skills/_common/SHARED_xxx.md`）
- [ ] 已运行 `push_skills.bat` 推送到C盘仓库
