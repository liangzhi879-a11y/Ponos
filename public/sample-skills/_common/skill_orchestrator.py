#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
skill_orchestrator.py - 技能调度器（含双模型交叉验证挂钩）

职责：
  1. dispatch: 根据自然语言请求匹配最佳技能（提高技能命中率）
  2. checkpoint: 在技能执行的关键校验点调用 MiniMax 交叉验证
  3. route: 查询某个任务应由哪个技能处理
  4. index: 列出所有技能及其触发关键词

设计逻辑（agent可据此自主调改）：
  dispatch: 读取技能索引 → 关键词匹配 + 语义相似度 → 返回Top-3技能
  checkpoint: 构建证据包 → 调用cross_model_validator.py → 返回分类结果
  route: dispatch的别名，输出更详细的匹配理由

用法：
  python skill_orchestrator.py dispatch --query "整理发票匹配PS产品"
  python skill_orchestrator.py checkpoint --skill gxtz-invoice-ps-matching --checkpoint-id invoice_match_accuracy --evidence-file checkpoint.json
  python skill_orchestrator.py route --query "RD立项书怎么写"
  python skill_orchestrator.py index
  python skill_orchestrator.py build-index
"""

import argparse
import json
import os
import sys
import re
import subprocess
from datetime import datetime
from pathlib import Path


SKILLS_DIR = Path(__file__).parent.parent
COMMON_DIR = Path(__file__).parent
PROJECT_ROOT = SKILLS_DIR.parent.parent
INDEX_FILE = COMMON_DIR / "skill_index.json"
CROSS_VALIDATOR = COMMON_DIR / "cross_model_validator.py"


# ============================================================
# 技能触发关键词索引（注意力优化的核心）
# ============================================================
# 这些关键词是用户自然语言中的高频词，用于提升技能匹配命中率
# 每个技能的触发词分为3类：
#   - primary: 强触发词（命中即高置信度匹配）
#   - secondary: 辅助触发词（需要多个同时命中）
#   - context: 上下文词（缩小匹配范围）
SKILL_TRIGGERS = {
    "gxtz-core-tables": {
        "primary": ["RD表", "PS表", "IP表", "TOAI表", "核心表", "RDPS", "汇总表", "关联表", "RD-PS-IP", "科技人员表", "知识产权表"],
        "secondary": ["表格", "生成", "制作", "填写", "模板", "对齐", "映射"],
        "context": ["核心", "4张表", "认定", "申报"],
        "description": "生成高新技术企业认定的4张核心表格（RDPS汇总表、科技人员清单、IP表、TOAI表）",
    },
    "gxtz-info-collector": {
        "primary": ["资料清单", "信息收集", "企业信息", "调查", "资料收集", "清单生成", "收集资料"],
        "secondary": ["准备", "前期", "阶段1", "基础"],
        "context": ["开始", "启动", "新项目"],
        "description": "高新技术企业认定企业信息调查与资料收集清单生成",
    },
    "gxtz-rd-report": {
        "primary": ["RD立项", "立项书", "研发立项", "立项报告", "RD报告", "项目立项", "任务书"],
        "secondary": ["研发项目", "RD活动", "编写", "撰写", "生成报告"],
        "context": ["Dify", "工作流", "RD01", "RD02"],
        "description": "高新技术企业认定研发立项报告（RD报告）撰写，支持Dify工作流自动化生成",
    },
    "gxtz-ip-materials": {
        "primary": ["知识产权", "专利", "软著", "IP材料", "证书", "发明专利", "实用新型", "外观设计"],
        "secondary": ["证明材料", "IP表", "专利证书", "软件著作权"],
        "context": ["阶段5", "IP", "权利要求书"],
        "description": "高新技术企业认定知识产权证明材料整理，含专利证书、软著证书及附属材料",
    },
    "gxtz-achievement-materials": {
        "primary": ["成果转化", "科技成果", "转化证明", "转化材料", "转化报告", "日期合规", "年份校验", "HXS编码", "dzfp"],
        "secondary": ["RD-IP-PS", "转化链", "成果", "转化", "合同发票配对", "近三年"],
        "context": ["阶段8", "15项", "转化项数"],
        "description": "高新技术企业认定科技成果转化证明材料整理，确保RD→IP→PS完整链条，含日期合规5规则校验（依据EXP-2026-07-17-001）",
    },
    "gxtz-staff-materials": {
        "primary": ["科技人员", "人员材料", "人员比例", "社保", "人员清单", "花名册", "人员信息"],
        "secondary": ["183天", "10%", "科技人员占比", "学历", "职称"],
        "context": ["阶段2", "人员", "人力资源"],
        "description": "高新技术企业认定科技人员材料撰写，含人员比例说明、人员信息表",
    },
    "gxtz-ps-materials": {
        "primary": ["高新产品", "PS材料", "产品证明", "PS技术说明", "高新技术产品", "PS收入"],
        "secondary": ["合同发票", "技术说明", "PS", "产品服务"],
        "context": ["阶段7", "阶段9", "60%"],
        "description": "高新技术企业认定高新产品（服务）证明材料整理，含技术说明、合同发票",
    },
    "gxtz-management-materials": {
        "primary": ["管理制度", "研发制度", "辅助账", "产学研", "组织管理", "激励制度"],
        "secondary": ["研发机构", "成果转化激励", "管理材料", "制度材料"],
        "context": ["阶段10", "制度", "管理"],
        "description": "高新技术企业认定管理制度及证明材料撰写，含研发制度、辅助账、产学研合作",
    },
    "gxtz-invoice-ps-matching": {
        "primary": ["发票匹配", "发票筛选", "PS匹配", "发票", "全量发票", "发票PS"],
        "secondary": ["货物名称", "匹配", "筛选", "占比分析"],
        "context": ["阶段3.0", "发票", "PS产品"],
        "description": "全量发票PS筛选：从历史申报材料提取PS基线，读取全量发票Excel按货物名称匹配PS产品",
    },
    "gxtz-audit-verification": {
        "primary": ["专审报告", "审计核对", "报告核对", "专审", "审计报告", "5维度核对"],
        "secondary": ["研发费用专审", "高新收入专审", "核对", "一致性"],
        "context": ["阶段11", "事务所", "审计"],
        "description": "高新专审报告核对：核对事务所专审报告（研发费用+高新收入）与企业核心表格的一致性",
    },
    "gxtz-wecom-collector": {
        "primary": ["企微", "企业微信", "企微附件", "会话记录", "企微文件", "wecom"],
        "secondary": ["附件收集", "会话查询", "客户沟通", "解密"],
        "context": ["收集", "附件", "会话"],
        "description": "企业微信会话实时查询与附件收集，从企微数据库解密提取客户沟通记录和附件文件",
    },
    "gxtz-contract-review": {
        "primary": ["技术合同审查", "合同评估", "合同合规", "技术开发合同", "技术转让合同", "技术咨询合同", "技术服务合同", "合同认定登记", "合同预审"],
        "secondary": ["四技合同", "技术交易额", "知识产权归属", "合同条款", "技术标的", "签字盖章"],
        "context": ["认定登记", "审查", "评估", "合规", "预审"],
        "description": "技术合同认定登记前的合规评估审查，10维审查+5级问题分类+整改建议",
    },
}

# 阶段-技能映射（用于route命令的阶段过滤）
STAGE_SKILL_MAP = {
    "阶段0-合同预审": ["gxtz-contract-review"],
    "阶段1": ["gxtz-info-collector"],
    "阶段2": ["gxtz-staff-materials"],
    "阶段3": ["gxtz-core-tables", "gxtz-invoice-ps-matching"],
    "阶段4": ["gxtz-core-tables"],
    "阶段5": ["gxtz-ip-materials"],
    "阶段6": ["gxtz-rd-report"],
    "阶段7": ["gxtz-ps-materials"],
    "阶段8": ["gxtz-achievement-materials"],
    "阶段9": ["gxtz-ps-materials"],
    "阶段10": ["gxtz-management-materials"],
    "阶段11": ["gxtz-audit-verification"],
}


# ============================================================
# 索引构建
# ============================================================
def build_index():
    """构建技能索引文件（含触发关键词、frontmatter信息）"""
    print("[index] 构建技能索引...")
    skills = []
    for skill_name in SKILL_TRIGGERS:
        skill_dir = SKILLS_DIR / skill_name
        skill_md = skill_dir / "SKILL.md"
        if not skill_md.exists():
            print(f"[index] WARN: {skill_name} 的SKILL.md不存在，跳过")
            continue

        # 读取frontmatter
        fm = _parse_frontmatter(skill_md)

        # 读取CHANGELOG获取版本
        version = fm.get("version", "unknown")
        skill_info = {
            "name": skill_name,
            "version": version,
            "path": str(skill_dir),
            "skill_md": str(skill_md),
            "description": fm.get("description", SKILL_TRIGGERS[skill_name]["description"]),
            "triggers": SKILL_TRIGGERS[skill_name],
            "validator": f"validate_{skill_name.replace('gxtz-', '')}.py",
            "has_experience": (skill_dir / "experience.json").exists(),
            "indexed_at": datetime.now().isoformat(),
        }
        skills.append(skill_info)
        print(f"[index] + {skill_name} v{version}")

    index_data = {
        "schema_version": "2.0",
        "built_at": datetime.now().isoformat(),
        "total_skills": len(skills),
        "skills": skills,
        "stage_map": STAGE_SKILL_MAP,
    }
    INDEX_FILE.write_text(json.dumps(index_data, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f"[index] 索引已写入: {INDEX_FILE}")
    print(f"[index] 共 {len(skills)} 个技能")
    return index_data


def _parse_frontmatter(skill_md_path):
    """解析SKILL.md的YAML frontmatter"""
    try:
        content = skill_md_path.read_text(encoding='utf-8')
        if content.startswith('---'):
            end = content.find('---', 3)
            if end > 0:
                fm_text = content[3:end].strip()
                fm = {}
                for line in fm_text.split('\n'):
                    if ':' in line:
                        key, _, val = line.partition(':')
                        fm[key.strip()] = val.strip().strip('"').strip("'")
                return fm
    except Exception:
        pass
    return {}


# ============================================================
# 技能匹配（dispatch / route）
# ============================================================
def match_skill(query, top_n=3):
    """根据自然语言查询匹配最佳技能

    匹配算法：
      1. 精确匹配 primary 触发词 → 高分
      2. 包含 secondary 触发词 → 中分
      3. context 词命中 → 加分
      4. 返回Top-N

    返回：
        [{"skill": "gxtz-xxx", "score": 0.95, "matched_keywords": [...], "reason": "..."}]
    """
    query_lower = query.lower()
    results = []

    for skill_name, triggers in SKILL_TRIGGERS.items():
        primary = triggers.get("primary", [])
        secondary = triggers.get("secondary", [])
        context = triggers.get("context", [])

        matched_primary = [kw for kw in primary if kw.lower() in query_lower or kw in query]
        matched_secondary = [kw for kw in secondary if kw.lower() in query_lower or kw in query]
        matched_context = [kw for kw in context if kw.lower() in query_lower or kw in query]

        # 打分：primary权重3，secondary权重1，context权重0.5
        score = len(matched_primary) * 3.0 + len(matched_secondary) * 1.0 + len(matched_context) * 0.5

        # 归一化到0-1
        max_possible = len(primary) * 3.0 + len(secondary) * 1.0 + len(context) * 0.5
        normalized_score = score / max_possible if max_possible > 0 else 0

        # 精确匹配primary强力加权
        if matched_primary:
            normalized_score = min(1.0, normalized_score + 0.3)

        if score > 0:
            all_matched = matched_primary + matched_secondary + matched_context
            reason_parts = []
            if matched_primary:
                reason_parts.append(f"强匹配: {', '.join(matched_primary)}")
            if matched_secondary:
                reason_parts.append(f"辅助匹配: {', '.join(matched_secondary)}")
            if matched_context:
                reason_parts.append(f"上下文匹配: {', '.join(matched_context)}")

            results.append({
                "skill": skill_name,
                "score": round(normalized_score, 4),
                "matched_keywords": all_matched,
                "reason": "; ".join(reason_parts),
                "description": triggers.get("description", ""),
            })

    results.sort(key=lambda x: x["score"], reverse=True)
    return results[:top_n]


def dispatch(query, top_n=3, detailed=False):
    """调度：返回最佳匹配技能"""
    print(f"[dispatch] 查询: {query}")
    matches = match_skill(query, top_n)

    if not matches:
        print("[dispatch] 未找到匹配技能。建议：")
        print("  - 检查查询关键词是否准确")
        print("  - 使用 'python skill_orchestrator.py index' 查看所有技能")
        return []

    print(f"[dispatch] 匹配到 {len(matches)} 个技能：")
    for i, m in enumerate(matches, 1):
        print(f"  {i}. {m['skill']} (score={m['score']})")
        print(f"     {m['reason']}")
        if detailed:
            print(f"     描述: {m['description']}")

    if matches[0]["score"] >= 0.5:
        print(f"\n[dispatch] ✓ 推荐使用: {matches[0]['skill']}")
    else:
        print(f"\n[dispatch] ⚠ 匹配置信度较低，建议人工确认")

    return matches


# ============================================================
# 校验点交叉验证（checkpoint）
# ============================================================
def run_checkpoint(skill, checkpoint_id, evidence_file, output_file=None):
    """在技能执行的关键校验点调用MiniMax交叉验证

    这是技能内集成的核心入口。agent在执行到关键决策点时调用此命令，
    将证据包发送给MiniMax进行校验。

    参数：
        skill: 技能名称（如 gxtz-invoice-ps-matching）
        checkpoint_id: 校验点ID（如 invoice_match_accuracy）
        evidence_file: 证据包JSON文件路径
        output_file: 验证结果输出路径（可选）
    """
    print(f"[checkpoint] 技能: {skill}")
    print(f"[checkpoint] 校验点: {checkpoint_id}")
    print(f"[checkpoint] 证据包: {evidence_file}")

    # 校验证据包
    evidence_path = Path(evidence_file)
    if not evidence_path.exists():
        print(f"[checkpoint] ERROR: 证据包不存在: {evidence_file}")
        return False

    # 补充证据包元数据
    try:
        evidence = json.loads(evidence_path.read_text(encoding='utf-8'))
        if "checkpoint_id" not in evidence:
            evidence["checkpoint_id"] = f"{skill}:{checkpoint_id}"
        if "skill" not in evidence:
            evidence["skill"] = skill
        if "primary_model" not in evidence:
            evidence["primary_model"] = "deepseek"
        evidence_path.write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding='utf-8')
    except Exception as e:
        print(f"[checkpoint] WARN: 补充证据包元数据失败: {e}")

    # 调用 cross_model_validator.py validate
    cmd = [
        sys.executable, str(CROSS_VALIDATOR),
        "validate",
        "--checkpoint-file", str(evidence_path),
        "--skill", skill,
    ]
    if output_file:
        cmd.extend(["--output-file", output_file])

    print(f"[checkpoint] 调用交叉验证器: {CROSS_VALIDATOR.name}")
    print(f"[checkpoint] 命令: {' '.join(cmd)}")

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8')
        print(result.stdout)
        if result.stderr:
            print(f"[checkpoint] STDERR: {result.stderr}")

        # 退出码含义
        exit_code = result.returncode
        if exit_code == 0:
            print("[checkpoint] ✓ 交叉验证通过（共识）")
        elif exit_code == 2:
            print("[checkpoint] ⛔ 存在关键争议，建议暂停流程")
        elif exit_code == 3:
            print("[checkpoint] ⚠ 需人工仲裁")
        elif exit_code == 4:
            print("[checkpoint] ⚡ 需主模型自查")
        else:
            print(f"[checkpoint] ✗ 交叉验证失败 (exit={exit_code})")

        return exit_code == 0

    except Exception as e:
        print(f"[checkpoint] ERROR: 调用交叉验证器异常: {e}")
        return False


# ============================================================
# 索引展示
# ============================================================
def show_index():
    """展示所有技能及其触发关键词"""
    if not INDEX_FILE.exists():
        print("[index] 索引未构建，正在构建...")
        build_index()

    index_data = json.loads(INDEX_FILE.read_text(encoding='utf-8'))
    print(f"\n{'='*70}")
    print(f"  技能索引（共 {index_data['total_skills']} 个技能）")
    print(f"{'='*70}\n")

    for skill in index_data["skills"]:
        print(f"  ■ {skill['name']} v{skill['version']}")
        print(f"    描述: {skill['description']}")
        triggers = skill["triggers"]
        print(f"    强触发词: {', '.join(triggers['primary'])}")
        print(f"    辅助触发词: {', '.join(triggers['secondary'])}")
        print(f"    校验器: {skill['validator']}")
        print(f"    路径: {skill['skill_md']}")
        print()

    print(f"{'='*70}")
    print("  阶段-技能映射")
    print(f"{'='*70}\n")
    for stage, skills in index_data["stage_map"].items():
        print(f"  {stage}: {', '.join(skills)}")
    print()


# ============================================================
# 校验点清单查询
# ============================================================
def list_checkpoints(skill=None):
    """列出某技能的所有校验点（来自cross_model_validator.py配置）"""
    # 导入cross_model_validator的校验点配置
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location("cross_model_validator", CROSS_VALIDATOR)
        cvm = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cvm)
        checkpoints_config = cvm.SKILL_CHECKPOINTS
    except Exception as e:
        print(f"[checkpoints] ERROR: 无法加载校验点配置: {e}")
        return

    if skill:
        if skill not in checkpoints_config:
            print(f"[checkpoints] 技能 {skill} 无校验点配置")
            return
        config = checkpoints_config[skill]
        print(f"\n{skill} 校验点（阈值={config['consensus_threshold']}）：")
        for cp in config["checkpoints"]:
            print(f"  - {cp}")
    else:
        print(f"\n所有技能校验点：")
        for s, config in checkpoints_config.items():
            print(f"\n  {s} (阈值={config['consensus_threshold']})：")
            for cp in config["checkpoints"]:
                print(f"    - {cp}")


# ============================================================
# 命令行入口
# ============================================================
def main():
    parser = argparse.ArgumentParser(
        description='技能调度器（含双模型交叉验证挂钩）',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='''
示例：
  python skill_orchestrator.py dispatch --query "整理发票匹配PS产品"
  python skill_orchestrator.py route --query "RD立项书怎么写" --detailed
  python skill_orchestrator.py checkpoint --skill gxtz-invoice-ps-matching --checkpoint-id invoice_match_accuracy --evidence-file checkpoint.json
  python skill_orchestrator.py index
  python skill_orchestrator.py build-index
  python skill_orchestrator.py checkpoints --skill gxtz-core-tables
        ''',
    )
    subparsers = parser.add_subparsers(dest="command", help="子命令")

    # dispatch 子命令
    disp_parser = subparsers.add_parser("dispatch", help="根据自然语言匹配技能")
    disp_parser.add_argument("--query", required=True, help="自然语言查询")
    disp_parser.add_argument("--top-n", type=int, default=3, help="返回Top-N结果")
    disp_parser.add_argument("--detailed", action="store_true", help="显示详细描述")

    # route 子命令（dispatch的详细版）
    route_parser = subparsers.add_parser("route", help="查询任务应由哪个技能处理")
    route_parser.add_argument("--query", required=True, help="自然语言查询")
    route_parser.add_argument("--top-n", type=int, default=3, help="返回Top-N结果")
    route_parser.add_argument("--detailed", action="store_true", help="显示详细描述")

    # checkpoint 子命令
    cp_parser = subparsers.add_parser("checkpoint", help="在关键校验点调用交叉验证")
    cp_parser.add_argument("--skill", required=True, help="技能名称")
    cp_parser.add_argument("--checkpoint-id", required=True, help="校验点ID")
    cp_parser.add_argument("--evidence-file", required=True, help="证据包JSON路径")
    cp_parser.add_argument("--output-file", default=None, help="验证结果输出路径")

    # index 子命令
    subparsers.add_parser("index", help="展示所有技能索引")

    # build-index 子命令
    subparsers.add_parser("build-index", help="构建技能索引文件")

    # checkpoints 子命令
    cp_list_parser = subparsers.add_parser("checkpoints", help="列出技能的校验点")
    cp_list_parser.add_argument("--skill", default=None, help="技能名称（不指定则列出全部）")

    args = parser.parse_args()

    if args.command == "dispatch":
        matches = dispatch(args.query, args.top_n, args.detailed)
        sys.exit(0 if matches else 1)

    elif args.command == "route":
        matches = dispatch(args.query, args.top_n, args.detailed)
        if matches:
            print(f"\n[route] 建议: 使用 {matches[0]['skill']} 技能")
            print(f"[route] SKILL.md: {SKILLS_DIR / matches[0]['skill'] / 'SKILL.md'}")
        sys.exit(0 if matches else 1)

    elif args.command == "checkpoint":
        success = run_checkpoint(args.skill, args.checkpoint_id, args.evidence_file, args.output_file)
        sys.exit(0 if success else 1)

    elif args.command == "index":
        show_index()

    elif args.command == "build-index":
        build_index()

    elif args.command == "checkpoints":
        list_checkpoints(args.skill)

    else:
        parser.print_help()


if __name__ == "__main__":
    main()
