## 蜂群subagent任务描述模板（用于Task工具的query参数）

### 模板使用说明

主agent在派发subagent时，将本模板中的占位符替换为实际值，作为Task工具的query参数。

### 任务描述模板

```
你是高新认定项目的subagent，负责执行一个完整技能。请严格按照以下要求执行：

## 任务信息
- 执行技能：{技能名称} v{版本号}
- 技能定义文件：{SKILL.md绝对路径}
- 任务目标：{一句话描述任务目标}

## 输入资料
- 输入目录：{输入目录绝对路径}
- 关键文件：
  {文件清单，每行一个，含路径和说明}

## 输出要求
- 输出目录：{输出目录绝对路径}
- 产出文件命名规范：{命名规则}
- 完成后需更新：c:\Users\T203-15\Desktop\2023guogao\.trae\project_knowledge\file_map.json

## 执行规范（必须严格遵守）
1. 首先读取技能定义文件：{SKILL.md绝对路径}
2. 遵守"合规红线"章节的所有禁止事项
3. 遵守"自主确认机制"（A/B/C/D四类触发），发现问题暂停并在返回中说明
4. 遵守"质疑与协同审查机制"（E/F/G/H四类触发），发现不符暂停并说明
5. 按"执行顺序契约"顺序执行技能内步骤（技能内步骤不可并行）
6. 并发安全：读写project_knowledge的JSON文件时，使用以下方式：
   ```python
   import sys
   sys.path.insert(0, r'c:\Users\T203-15\Desktop\2023guogao\.trae\skills\_common')
   from file_lock import file_lock
   with file_lock('file_map.json'):
       # 读写操作
   ```
7. 最终步必须运行审核脚本：
   python c:\Users\T203-15\Desktop\2023guogao\.trae\skills\_common\{validate脚本名} --enterprise "{企业名}" --year {年份}

## 返回要求
返回精简摘要（非完整输出），格式：
- 技能名称：{技能名}
- 执行状态：成功/失败/暂停等待确认
- 产出文件清单：{文件路径列表}
- 审核结果：passed={True/False}, errors={数量}, warnings={数量}
- 质疑事项：{如有，列出E/F/G/H类型和问题描述}
- 需主agent协调的问题：{如有，说明}

## 禁止事项
- 禁止跳过审核脚本
- 禁止编造数据
- 禁止跨项目读取留痕
- 禁止写入其他技能的输出目录
```

### 示例：派发科技人员清单subagent

```
你是高新认定项目的subagent，负责执行科技人员清单技能。请严格按照以下要求执行：

## 任务信息
- 执行技能：gxtz-staff-materials v1.15.2
- 技能定义文件：c:\Users\T203-15\Desktop\2023guogao\.trae\skills\gxtz-staff-materials\SKILL.md
- 任务目标：生成科技人员清单（三方对比），基于花名册×社保×台账

## 输入资料
- 输入目录：c:\Users\T203-15\Desktop\2023guogao\{企业}_高新认定材料_2026\_补充资料\gxtz-staff-materials\
- 关键文件：
  - 附件-国高月报统计信息（员工花名册）.xlsx
  - 上年度社保单位缴费记录.pdf
  - 上年度研发台账/辅助账.xlsx

## 输出要求
- 输出目录：c:\Users\T203-15\Desktop\2023guogao\{企业}_高新认定材料_2026\02-科技人员清单\
- 产出文件：{企业名}-科技人员清单（三方对比）.xlsx
- 完成后需更新：c:\Users\T203-15\Desktop\2023guogao\.trae\project_knowledge\file_map.json

## 执行规范
（同上模板）

## 审核脚本
python c:\Users\T203-15\Desktop\2023guogao\.trae\skills\_common\validate_staff.py --enterprise "{企业名}" --year 2026
```
