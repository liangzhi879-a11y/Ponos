# 注意力优化技能模板（Attention-Optimized SKILL Template）

> 本模板基于 LLM 注意力机制特性设计，用于重构 gxtz 系列技能，提升 agent 执行准确率和技能命中精度。
> 版本：v2.0 | 更新：2026-07-17

## 注意力机制优化原则

| 特性 | 优化手段 | 在模板中的体现 |
|------|---------|---------------|
| **首因效应** | 关键约束前置 | 合规红线置于文件顶部第2节 |
| **近因效应** | 关键检查点后置 | 审核验证、隐患自查置于步骤末尾 |
| **重复增强** | 核心规则多处重复 | 强制步骤在顶部契约 + 步骤中重复 + 结尾自查 |
| **结构锚点** | 一致的标题层级 | 统一 `##`/`###` 层级，加粗关键词 |
| **触发关键词** | description 含高频词 | frontmatter 含触发场景关键词 |
| **具体示例** | 抽象规则配示例 | 每个规则配 RunCommand 示例 |

## 标准 SKILL.md 结构（v2.0）

```markdown
---
name: "gxtz-xxx"
description: "【触发场景】用户说'整理XX/生成XX/校验XX'时使用。高新技术企业认定XX技能，含XX功能。vN.N.N"
version: "x.y.z"
---
# {技能中文名}

## 触发场景（agent 选择技能时参考）

> **何时使用本技能**：当用户请求涉及以下场景时，agent 应优先选择本技能。

| 用户可能的表述 | 匹配关键词 | 置信度 |
|--------------|-----------|--------|
| "帮我整理XX" | 整理、XX | 高 |
| "生成XX表" | 生成、XX表 | 高 |
| "校验XX" | 校验、XX | 中 |

**强触发词**：关键词1、关键词2、关键词3
**辅助触发词**：关键词4、关键词5

## 合规红线（agent 执行前必读，违反即停止）

> **核心原则**：本节规则违反任何一条，立即停止执行，输出错误日志。

### 禁止事项（7条，违反即停止）
1. 禁止未读取项目知识库就开始业务步骤
2. 禁止跳过审核验证步骤直接提交
3. 禁止将原始文件直接发送给外部模型（必须走证据包协议）
4. 禁止在交叉验证返回 `blocked` 时继续执行
5. 禁止以"函数描述"代替 RunCommand 调用
6. 禁止"阅读脚本逻辑自行编写等效代码"
7. 禁止忽略 Type A 争议（必须回源核实）

### 数据来源优先级
1. 原始文件（最高优先级）
2. 项目知识库（file_map.json / experience_base.json）
3. 技能经验库（experience.json）
4. 政策文件（policy_*.json）

### 脚本调用规范
所有脚本调用必须使用 RunCommand 工具：
```
python c:\Users\T203-15\Desktop\2023guogao\.trae\skills\_common\xxx.py <参数>
```
- 脚本路径必须使用绝对路径
- 参数必须按脚本定义的 CLI 接口传递
- 不得通过"调用 xxx() 函数"的形式执行

## 交叉验证协议（双模型校验，关键决策点强制执行）

<!-- 由 inject_cross_validation.py 自动注入，详见 _cross_validation_protocol.md -->

## 自主确认机制（agent 自主分辨，遇异常主动暂停）
<!-- 详见 _autonomous_confirmation.md -->

## 质疑与协同审查机制（agent 发现不符时必须质疑，禁止默认执行）
<!-- 详见 _questioning_review_mechanism.md -->

## 执行顺序契约（agent 必须严格遵守）

> **执行顺序约束**：以下步骤必须按序执行，不可跳过、不可调换。

| 步骤 | 名称 | 依赖 | 可并行 |
|------|------|------|--------|
| 第一步 | 项目初始化 | 无 | 否 |
| 第二步 | {业务步骤1} | 第一步 | 否 |
| 第N步 | 交叉验证校验点 | 第N-1步 | 否 |
| 第N+1步 | 审核验证 | 第N步 | 否 |
| 最终步 | finalize + 隐患自查 | 第N+1步 | 否 |

## 审核验证标准（agent 必须执行且通过）

```
python c:\Users\T203-15\Desktop\2023guogao\.trae\skills\_common\validate_xxx.py --dir "输出目录" --project-root "项目根目录"
```
- 审核通过（退出码 0）：进入提交流程
- 审核失败（退出码 1）：立即停止，输出 ERROR 清单，整改后重新审核

## 描述
{技能的简要描述}

## 输入输出
- **输入**：{输入文件/数据}
- **输出**：{输出文件/数据}

## 执行步骤

### 第一步：项目初始化（强制执行，不可跳过）

```
python c:\Users\T203-15\Desktop\2023guogao\.trae\skills\_common\project_context_manager.py init --enterprise "{企业名称}" --year {申报年份}
```

执行后检查：
- [ ] .trae/project_knowledge/ 目录存在
- [ ] file_map.json / experience_base.json / project_index.json 已创建/更新

### 第二步：{业务步骤名称}

{步骤描述}

```
python c:\Users\T203-15\Desktop\2023guogao\.trae\skills\_common\xxx.py --param value
```

执行后检查：
- [ ] {检查项1}
- [ ] {检查项2}

### 第N步：交叉验证（关键决策点，双模型校验）

> **本步骤在关键决策完成后、提交前执行**。详见"交叉验证协议"章节。

**1. 构建证据包**（将决策结果写入 checkpoint.json）

**2. 调用交叉验证器**
```
python c:\Users\T203-15\Desktop\2023guogao\.trae\skills\_common\skill_orchestrator.py checkpoint ^
    --skill {当前技能名} ^
    --checkpoint-id {校验点ID} ^
    --evidence-file checkpoint.json
```

**3. 根据退出码处置**
- 退出码 0（pass）：继续
- 退出码 2（blocked）：立即停止，等待人工仲裁
- 退出码 3（needs_human）：使用 AskUserQuestion 请求用户决策
- 退出码 4（needs_self_check）：补充证据后重新校验

### 第N+1步：审核验证（必须通过才能提交）

```
python c:\Users\T203-15\Desktop\2023guogao\.trae\skills\_common\validate_xxx.py --dir "输出目录" --project-root "项目根目录"
```

- 审核通过（退出码 0）：进入提交流程
- 审核失败（退出码 1）：立即停止，整改后重新审核

### 最终步：finalize + 隐患自查

```
python c:\Users\T203-15\Desktop\2023guogao\.trae\skills\_common\project_context_manager.py finalize ^
    --enterprise "{企业名称}" --year {申报年份} --skill "{技能名}"
```

## 输出隐患自查与汇报（强制执行，7维度）

| 维度 | 检查项 | 状态 |
|------|--------|------|
| ① 原始资料缺失 | 关键源文件是否齐全 | ✓/⚠ |
| ② 文本质量 | AI痕迹/空泛表述 | ✓/⚠ |
| ③ 逻辑关联 | RD-IP-PS完整性 | ✓/⚠ |
| ④ 字数问题 | 超标需优化非截断 | ✓/⚠ |
| ⑤ 文档格式 | 模板对齐/格式规范 | ✓/⚠ |
| ⑥ 政策符合性 | 占比/数量硬指标 | ✓/⚠ |
| ⑦ 数据可溯源性 | 关键字段可追溯 | ✓/⚠ |

## 格式规范
{日期/金额/编号/文本/表格格式规范}

## 附录：与其他技能的衔接关系
- **前置技能**：{前置}
- **后置技能**：{后置}
- **数据依赖**：{依赖说明}
```

## 重构检查清单

- [ ] frontmatter description 包含触发场景关键词
- [ ] 包含 `## 触发场景` 节（提升技能命中率）
- [ ] 合规红线为第2节（首因效应）
- [ ] 包含交叉验证协议（已注入）
- [ ] 步骤中包含交叉验证校验点步骤
- [ ] 审核验证步骤在末尾（近因效应）
- [ ] 隐患自查7维度完整
- [ ] 无内嵌 Python 代码块（除字段定义表）
- [ ] 所有脚本调用使用 RunCommand 格式
- [ ] 步骤编号连续（第一步、第二步...）
- [ ] 最终步为 finalize + 隐患自查
