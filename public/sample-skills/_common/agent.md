# 高新认定项目 — Agent 默认工作规则

> **优先级**: 本文件为项目级 Agent 默认规则，在所有上下文（含技能未触发时）中生效。
> **生效范围**: 当前项目的所有 Agent 会话。
> **更新日期**: 2026-07-29

---

## 第〇步：理解项目全貌（强制执行，不可跳过）

**每次会话开始及接到新任务时，必须先理解项目全貌，再推进具体操作。**

### 必读文件清单（按顺序）

| 序号 | 文件 | 内容 | 时间 |
|------|------|------|------|
| 1 | `.trae/working_trace.md` | 项目工作留痕（最近3次） | 30秒 |
| 2 | `.trae/agent.md` | 本文件 — Agent工作规则 | 2分钟 |
| 3 | `.trae/project_workflow.md` | 11阶段流程 + 依赖关系 | 3分钟 |
| 4 | `.trae/skills/_common/agent_role.md` | 角色身份/能力边界/决策权限 | 2分钟 |
| 5 | `.trae/project_config.json` | 项目类型/经验分类/版本配置 | 30秒 |
| 6 | `.trae/project_progress.json` | 当前进度和各阶段完成状态 | 30秒 |

### 禁止行为

- ❌ 接到任务后直接动手操作，不先了解项目状态
- ❌ 跳过 working_trace.md 的继承检查
- ❌ 不确认当前进度就推进后续阶段
- ❌ 不查阅 workflow 就假设步骤间的依赖关系

---

## 通用工具定位表（技能未触发时也能使用）

> 即使技能未被触发，以下工具和脚本也可独立调用，处理项目相关的基本要求。

### 文档处理

| 需求 | 工具/命令 | 说明 |
|------|----------|------|
| 识别文件类型 | `python .trae/skills/_common/doc_toolkit.py info --file <路径>` | 返回推荐处理方案 |
| 读取文档内容 | `python .trae/skills/_common/doc_toolkit.py read --file <路径> --format <格式>` | 支持 xlsx/docx/pdf/txt/json |
| 转换文档格式 | `python .trae/skills/_common/doc_toolkit.py convert --input <路径> --to <格式>` | doc→docx等 |
| 扫描项目文件类型 | `python .trae/skills/_common/detect_file_types.py --dir "." --recommend` | 统计文件分布 |

### OCR与内容识别

| 需求 | 工具/命令 |
|------|----------|
| OCR识别PDF/图片 | `python .trae/skills/_common/ocr_engine.py --input <文件> --mode auto` |
| OCR批量处理 | `python .trae/skills/_common/ocr_engine.py --dir <目录> --mode auto --output <输出>` |

### PDF处理

| 需求 | 工具/命令 |
|------|----------|
| PDF拆分 | `python .trae/skills/_common/pdf_splitter.py split --input <文件> --pages <页码范围>` |
| PDF合并 | `python .trae/skills/_common/pdf_splitter.py merge --inputs <文件1> <文件2> --output <输出>` |
| PDF压缩 | `python .trae/skills/_common/file_compressor.py compress --input <文件> --level <1-5>` |

### 项目知识管理

| 需求 | 工具/命令 |
|------|----------|
| 初始化项目 | `python .trae/skills/_common/project_context_manager.py init --project-root "."` |
| 收工留痕 | `python .trae/skills/_common/project_context_manager.py finalize --skill <技能名>` |
| 提交经验 | `python .trae/skills/_common/project_context_manager.py capture --skill <技能名> --problem-type <类型> --problem-desc "<描述>" --solution "<方案>"` |
| 扫描文件 | `python .trae/skills/_common/project_context_manager.py scan` |
| 登记文件 | `python .trae/skills/_common/project_context_manager.py add-file --path <路径> --category <类别>` |

### 企业微信

| 需求 | 工具/命令 |
|------|----------|
| 诊断数据源 | `python .trae/skills/_common/wecom_query.py diagnose` |
| 按企业收集文件 | `python .trae/skills/_common/wecom_query.py collect-by-enterprise --enterprise "<企业名>" --out "<输出目录>"` |

### 项目进度

| 需求 | 工具/命令 |
|------|----------|
| 查看进度 | `python .trae/skills/_common/progress_sync.py status --project-root "."` |
| 更新阶段 | `python .trae/skills/_common/progress_sync.py update-stage --project-root "." --skill <技能名> --status completed` |
| 检查依赖 | `python .trae/skills/_common/progress_sync.py check-deps --project-root "." --skill <技能名>` |
| 扫描项目 | `python .trae/skills/_common/progress_scanner.py scan --project-root "."` |

### 环境检查

| 需求 | 工具/命令 |
|------|----------|
| 依赖检查 | `python .trae/skills/_common/check_dependencies.py` |
| 文件类型扫描 | `python .trae/skills/_common/detect_file_types.py --dir "." --recommend` |
| 沙箱授权诊断 | 见 `.trae/AGENTS.md` 沙箱自检规则 |

---

## 项目结构速览

```
{项目根目录}/
├── .trae/                          # ★ 项目元数据（Agent规则/技能/留痕/进度）
│   ├── agent.md                    # 本文件 — Agent默认工作规则
│   ├── AGENTS.md                   # 环境配置（OS/Shell/路径/沙箱）
│   ├── working_trace.md            # 工作留痕（自动继承）
│   ├── project_workflow.md         # 11阶段流程总览
│   ├── project_config.json         # 项目类型配置
│   ├── project_progress.json       # 各阶段完成状态
│   ├── skills/                     # ★ 技能体系
│   │   ├── _common/                # 共享脚本和规范
│   │   ├── gxtz-*/                 # 各技能包（SKILL.md + CHANGELOG.md + experience.json）
│   │   └── _staging/               # 同步脚本
│   ├── project_knowledge/          # 项目知识库
│   │   ├── file_map.json           # 文件图谱
│   │   ├── experience_base.json    # 项目级经验库
│   │   └── enterprise_info.json    # 企业信息
│   └── archive/                    # 留痕归档
├── {企业}_高新认定材料_{年份}/     # ★ 标准输出目录结构
│   ├── _补充资料/                  # 补充资料目录
│   ├── 01_营业执照/                # 19类材料目录
│   ├── 02_审计报告/
│   └── ... (共19类)
├── 00.项目主资料/                  # 原始输入资料
└── 99.其他资料/                    # 参考资料/模板
```

---

## 核心工作原则

### 原则一：先理解，再行动
- 接到新任务 → 先读取 working_trace.md 了解进度
- 不确认当前阶段 → 不推进后续步骤
- 不确定依赖关系 → 先查 project_workflow.md

### 原则二：OCR优先，禁止猜测
- 扫描件/图片 → 必须OCR确认内容后才能操作
- 不得通过文件标题猜测内容
- OCR慢也要等，这是强制性规则
- 详见：`.trae/skills/_common/SHARED_ocr_mandatory.md`

### 原则三：AI水印零容忍
- 所有输出内容不得包含AI生成水印字样
- 最终交付前必须检查
- 详见：`.trae/skills/_common/SHARED_no_ai_watermark.md`

### 原则四：技能优先，脚本兜底
- 有对应的gxtz-*技能 → 优先通过Skill工具调用
- 技能未触发 → 使用本文件中的通用工具定位表独立执行
- 脚本调用使用项目相对路径：`python .trae/skills/_common/xxx.py`

### 原则五：经验闭环
- 遇到问题 → 解决后 → capture提交经验
- 收工 → finalize汇聚经验到全局技能经验库
- 详见用户规则"跨模式经验流转规则"

---

## 技能体系入口

本项目的17个技能（含2个工具技能）覆盖高新认定全流程：

| 阶段 | 技能 | 触发词示例 |
|------|------|-----------|
| 工具 | gxtz-file-compressor | 压缩/PDF压缩/文件太大 |
| 工具 | gxtz-file-organizer | 整理文件/资料整理/归类 |
| 阶段0 | gxtz-contract-review | 技术合同审查/合同评估/合同合规 |
| 阶段1 | gxtz-info-collector | 资料清单/信息收集/企业信息 |
| 阶段2 | gxtz-staff-materials | 科技人员/人员材料/社保 |
| 阶段3 | gxtz-invoice-ps-matching | 发票匹配/PS匹配/全量发票 |
| 阶段3-7 | gxtz-core-tables | RD表/PS表/IP表/TOAI表/汇总表 |
| 阶段5 | gxtz-ip-materials | 知识产权/专利/软著/IP材料 |
| 阶段6 | gxtz-rd-report | RD立项/立项书/研发立项/立项报告 |
| 阶段7 | gxtz-ps-materials | 高新产品/PS材料/产品证明 |
| 阶段8 | gxtz-achievement-materials | 成果转化/科技成果/转化证明 |
| 阶段10 | gxtz-management-materials | 管理制度/研发制度/辅助账/产学研 |
| 阶段11 | gxtz-audit-verification | 专审报告/审计核对/报告核对 |
| 阶段3.0 | gxtz-wecom-collector | 企微/企业微信/企微附件 |
| 阶段12 | gxtz-submission-packager | 打包/申报打包/材料打包/上传准备 |
| 全局 | gxtz-progress-manager | 查看进度/生成进度看板/更新进度 |
| 全局 | gxtz-experience-sync | 经验积累/经验同步/提交经验 |

> 完整流程见：`.trae/project_workflow.md`
