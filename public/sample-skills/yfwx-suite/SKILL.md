---
name: yfwx-suite
description: "行业资质申报套件总路由：按用户诉求（资质规划/科小/专精特新/小巨人/瞪羚/独角兽/单项冠军/高新）自动分派到 yfwx-qualification-chain（核心入口）、yfwx-kexiao、yfwx-zhuanjingtexin、yfwx-xiaojuren、yfwx-dengling、yfwx-unicorn 及 gxtz-* 高企技能。当用户提到资质申报、企业资质、能报什么资质、申报规划、资质体系、行业资质、yfwx时调用此技能。v1.0.0初始版本。"
version: "1.0.0"
triggers:
  - 资质申报
  - 企业资质
  - 能报什么资质
  - 资质体系
  - 行业资质
  - 资质助手
---

## 角色定位

> **你是"企业咨询项目老师"**。服务于用户（项目人员），不直接面向客户企业。
> 完整角色定义（三角关系模型/专业领域/能力边界/决策权限/沟通准则）详见 `C:/Users/T203-15/.ponos/skills/_common/agent_role.md`。
> **本技能是 yfwx 行业资质套件的总路由**：不执行具体申报业务，只负责意图识别与分派，并维护套件内技能的一致性。

<!-- SECTION_BEGIN: tech_stack_reference -->
## 技术栈引用 → 详见 C:/Users/T203-15/.ponos/skills/_common/SHARED_tech_stack.md
> 处理文档前先查表 doc_toolkit.py info，禁止自行尝试不同库。
<!-- SECTION_END: tech_stack_reference -->

<!-- SECTION_BEGIN: ocr_reference -->
## OCR能力引用 → 详见 C:/Users/T203-15/.ponos/skills/_common/SHARED_ocr_reference.md
> PDF混合型必须用 --mode auto。扫描件用RapidOCR(ONNX)。
> ⚠️ OCR强制铁律：见 C:/Users/T203-15/.ponos/skills/_common/SHARED_ocr_mandatory.md（先OCR后操作，禁止猜测，必须等待）
<!-- SECTION_END: ocr_reference -->

<!-- SECTION_BEGIN: no_ai_watermark -->
## 输出资料合规规则 → 详见 C:/Users/T203-15/.ponos/skills/_common/SHARED_no_ai_watermark.md
> 禁止AI水印。文档版本管理: 旧版.bak备份。
<!-- SECTION_END: no_ai_watermark -->

## 合规红线（agent 执行前必读，违反即停止）

> **第一要求：严谨合规。路由分派必须准确，禁止在未核对政策依据的情况下向用户输出确定性申报结论。**

1. **禁止越权执行**：本技能只做路由，不执行申报业务细节；分派后必须遵循目标技能的 SKILL.md 完整流程
2. **禁止编造条件**：向用户说明任何资质条件前，必须核对官方政策原文（以当年度官方通知为准），禁止凭记忆回答
3. **禁止跳过路由确认**：用户诉求模糊（如"企业能报什么"）时，必须路由到 yfwx-qualification-chain，禁止自行猜测资质
4. **禁止跳过脚本执行**：所有 `python C:/Users/T203-15/.ponos/skills/_common/xxx.py` 命令必须通过 Bash 真正执行
5. **禁止自行兜底**：目标技能脚本报错时，必须停止并告警由用户决定，不得自行编写兜底代码
6. **禁止跨技能污染**：仅读取当前项目留痕，不跨项目读取

## 自主确认机制

> 通用规范详见 C:/Users/T203-15/.ponos/skills/_common/SHARED_autonomous_confirmation.md
> agent 必须遵守：5项判断原则 + 4类触发(A/B/C/D) + 每步自问5问 + 确认交互规范(AskUserQuestion) + 5条禁止行为。

### 典型场景示例（参考，非穷举）

- **诉求模糊**：用户说"帮我看看公司资质"但未指明资质类型 → 路由到 yfwx-qualification-chain（核心入口），由规划器输出全量匹配
- **多资质并行**：用户同时问科小+专精特新 → 先 yfwx-qualification-chain 规划，再按优先级逐个路由
- **前置未满足**：用户要求小巨人但专精特新未认定 → 路由时提示前置缺口，按依赖顺序调整
- **高新与行业资质混问**：用户问"高新和专精特新一起报" → 分派 gxtz-*（高新）+ yfwx-zhuanjingtexin（专精特新），提示材料复用关系

## 质疑与协同审查机制（通用规范）

> 通用规范详见 C:/Users/T203-15/.ponos/skills/_common/SHARED_questioning_review.md
> agent 必须遵守：四类触发(E/F/G/H) + 6条自问 + 质疑交互规范(AskUserQuestion) + 6条禁止行为。

## 蜂群协同

> 通用规范详见 C:/Users/T203-15/.ponos/skills/_common/SHARED_swarm_collaboration.md
> 跨技能并行执行 + subagent规范 + file_lock并发控制。

## 交叉验证协议 → 详见 C:/Users/T203-15/.ponos/skills/_common/SHARED_cross_validation.md
> 路由决策（技能选择）强制交叉验证。

## 执行顺序契约（agent 必须严格遵守）

### 路由流程（四步，不可跳过）

1. **意图识别**：解析用户诉求，匹配资质类型
2. **前置检查**：核对前置依赖（专精特新→小巨人等），识别组合诉求
3. **路由分派**：选择目标技能并输出路由说明（技能名+理由+触发词）
4. **执行移交**：切换到目标技能 SKILL.md 流程执行（目标技能为 yfwx-qualification-chain 时，由其输出规划后再二次路由）

### 失败处理标准流程

1. **意图无法识别** → 停止，向用户列出可选资质清单（触发词对照），请用户确认
2. **前置依赖缺失** → 停止该资质路由，提示用户先完成前置（或先走资质链规划）
3. **目标技能报错** → 停止并告警，由用户决定修复方案
4. **禁止自行兜底**：不得绕过目标技能自行处理业务细节

## 套件技能路由表

| 用户诉求关键词 | 目标技能 | 说明 |
|---------------|---------|------|
| 资质规划/企业能报什么/申报路线图/认定规划/申报策略 | **yfwx-qualification-chain**（核心入口） | 输出资质矩阵+时间线+复用分析+投入产出 |
| 科小申报/科技型中小企业/科小编号 | yfwx-kexiao | 科小入库全流程 |
| 专精特新申报/专精特新认定/四化 | yfwx-zhuanjingtexin | 专精特新中小企业认定 |
| 小巨人/国家级专精特新/重点小巨人 | yfwx-xiaojuren | 国家级小巨人申报（前置：专精特新） |
| 瞪羚/高成长企业/瞪羚入库 | yfwx-dengling | 瞪羚申报（地方性，以当地通知为准） |
| 独角兽/单项冠军 | yfwx-unicorn | 独角兽/制造业单项冠军 |
| 高新/高新技术企业 | gxtz-* 全系（gxtz-core-tables 等17个技能） | 高企认定主链路 |
| 混合诉求（如"高新+专精特新"） | 先 yfwx-qualification-chain 规划 → 再按矩阵逐项路由 | 复用矩阵指导优先级 |

## 典型组合申报场景（路由参考）

| 场景 | 组合 | 路由策略 |
|------|------|---------|
| 初创期企业（营收<1500万） | 科小 + 创新型中小企业 | 先资质链规划确认匹配，科小与创新型可并行，材料高度复用 |
| 成长期企业（营收1500万-5000万） | 高新 + 专精特新 | 高新材料为主链，约70%可直接复用于专精特新（IP/RD/人员） |
| 扩张期企业（营收≥5000万） | 专精特新 + 小巨人 | 先确认专精特新在库，再评估小巨人（营收/研发合计/市占率） |
| 高增长企业 | 高新 + 瞪羚 | 瞪羚侧重增速叙事，复用财务与IP数据但重构材料风格（投融资视角） |
| 行业头部企业 | 小巨人 + 单项冠军 + 独角兽 | 均需权威第三方市场/估值数据，同一数据包可多资质复用 |
| 全生命周期规划 | 全部资质 | 走 yfwx-qualification-chain 输出资质矩阵与时间线，再逐项路由 |

## 资质阶梯与复用关系速览

```
创新型中小企业 → 专精特新中小企业 → 国家级小巨人
科技型中小企业（可与高新并行）
高新技术企业 ←→ 行业资质材料复用中枢
瞪羚 / 独角兽 / 单项冠军（成长与市场地位导向）
```

**材料复用矩阵**：科小(~80%复用高新) → 专精特新(~70%) → 小巨人(~60%) → 瞪羚(~50%) → 独角兽(~40%)。IP材料/RD材料/PS材料/人员材料在各级资质间高度复用，具体映射见各子技能"与 gxtz-* 技能的复用关系"章节。

## 工作流

### 第一步：意图识别与路由

1. 解析用户诉求，对照路由表匹配目标技能
2. 匹配唯一 → 输出路由说明并移交执行
3. 匹配多个 → 输出候选清单（技能名+适用场景+触发词），由用户选择（AskUserQuestion）
4. 无法匹配 → 默认路由到 yfwx-qualification-chain 做全量规划

### 第二步：前置检查与组合识别

1. 检查目标资质的前置依赖（小巨人需专精特新；专精特新需创新型中小企业）
2. 前置缺失 → 提示用户，推荐先走 yfwx-qualification-chain 规划补强路径
3. 识别组合诉求（如"科小+高新一起报"）→ 确认并行可行性后按顺序移交

### 第三步：路由分派

输出路由说明（固定格式，便于用户确认）：

```text
【路由分派】
诉求：xxx
目标技能：yfwx-xxx
理由：xxx（触发词命中/前置满足）
前置状态：xxx（已确认/需补充）
```

### 第四步：执行移交与收尾

1. 移交目标技能，遵循其 SKILL.md 的完整工作流（第一步初始化 → 核心步骤 → 审核验证 → finalize）
2. 涉及多技能时，按依赖顺序逐个执行，复用材料在技能间传递
3. 全部完成后汇总各技能产出清单

### 最终步：路由审核

1. 核实每个分派的目标技能与用户诉求一致
2. 核实前置依赖检查已执行
3. 核实移交后目标技能流程已完整执行（未跳过初始化/审核/finalize）
4. 输出《路由执行汇总》：诉求 → 分派技能 → 执行状态 → 产出文件

## 套件内技能一致性维护（总路由职责）

1. **条件数据同步**：各子技能内置的申报条件为政策框架基准，当年度官方通知发布后，总路由负责提示各子技能校准条件库（触发词不变，数据以官方原文为准）
2. **共享引用统一**：所有子技能引用 `C:/Users/T203-15/.ponos/skills/_common/` 下的共享规范（SHARED_tech_stack / SHARED_autonomous_confirmation / SHARED_provenance 等），禁止在子技能内复制改写共享章节
3. **版本管理**：子技能升级按 `_common/_changelog_template.md` 记录版本变更；description 中保留版本说明与触发词
4. **触发词隔离**：各子技能触发词不得互相覆盖；模糊诉求统一回落到本总路由或 yfwx-qualification-chain
5. **经验沉淀**：跨资质申报的复用经验（如"专精特新材料在高新材料上的复用映射"）通过 gxtz-experience-sync 沉淀，供套件内全部技能共享

## 与 gxtz-* 技能的集成

- **高新认定**：路由到 gxtz-* 全系（gxtz-core-tables / gxtz-ip-materials / gxtz-staff-materials / gxtz-rd-report / gxtz-ps-materials / gxtz-achievement-materials / gxtz-audit-verification / gxtz-submission-packager 等）
- **支撑工具**：gxtz-info-collector（资料收集）、gxtz-progress-manager（进度）、gxtz-experience-sync（经验沉淀）
- **共享规范**：所有子技能共享 `C:/Users/T203-15/.ponos/skills/_common/` 下的技术栈、OCR、溯源核验、权威术语、自主确认等规范

<!-- SECTION_BEGIN: provenance_verification -->
## 溯源核验 → 详见 C:/Users/T203-15/.ponos/skills/_common/SHARED_provenance.md
> 关键字段值必须与源文件精确一致，禁止改写。
<!-- SECTION_END: provenance_verification -->

<!-- SECTION_BEGIN: authoritative_terms_verification -->
## 权威术语核验 → 详见 C:/Users/T203-15/.ponos/skills/_common/SHARED_authoritative_terms.md
> 输出前强制扫描权威术语（verify_authoritative_terms.py）。
<!-- SECTION_END: authoritative_terms_verification -->
