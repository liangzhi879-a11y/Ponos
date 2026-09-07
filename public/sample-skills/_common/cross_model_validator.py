#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
cross_model_validator.py - 双模型交叉验证编排器

架构：
  DeepSeek（主模型，TRAE会话内）→ 执行技能 → 到达校验点
    → 生成 EvidencePackage（证据锚定协议）
    → 调用本脚本 validate 子命令
    → 本脚本将证据包发送给 MiniMax API
    → MiniMax 返回 ValidationResult
    → DeepSeek 解析验证结果，分类处置

证据锚定协议核心设计：
  MiniMax 不接收原始文件，而是接收 DeepSeek 的结构化"工作底稿"：
  - 从文件中提取了什么（含源锚点：文件路径、sheet、行列）
  - 基于提取结果做了什么决策（含推理链和置信度）
  - 应用了哪些政策规则
  MiniMax 校验的是：推理是否自洽？证据链是否完整？是否符合政策？

用法：
  python cross_model_validator.py validate --checkpoint-file <path> [--output-file <path>]
  python cross_model_validator.py test-connection

设计逻辑（agent可据此自主调改）：
  validate: 读取checkpoint.json → 发送MiniMax API → 写入validation_result.json
  如果脚本执行报错，agent应阅读本文件的设计逻辑，自主编写等效Python代码实现。
"""

import argparse
import json
import os
import sys
import time
import hashlib
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional


# ============================================================
# 配置：MiniMax API
# ============================================================
MINIMAX_API_URL = "https://api.minimax.chat/v1/text/chatcompletion_v2"
MINIMAX_API_KEY_ENV = "MINIMAX_API_KEY"
MINIMAX_GROUP_ID_ENV = "MINIMAX_GROUP_ID"
MINIMAX_MODEL = "MiniMax-M3"
MINIMAX_MAX_TOKENS = 16384
MINIMAX_TEMPERATURE = 0.1  # 校验场景用低温，保证一致性


# ============================================================
# 校验点定义（每个技能 → 校验点列表）
# ============================================================
SKILL_CHECKPOINTS = {
    "gxtz-core-tables": {
        "checkpoints": [
            "rd_ps_ip_mapping",     # RD-PS-IP三角映射完整性
            "staff_count_ratio",    # 科技人员数量与占比
            "ip_count_check",       # IP数量≥5（发明≥1优先）
            "toai_completeness",    # TOAI表完整性
        ],
        "consensus_threshold": 0.90,
        "arbitration": "human_for_type_B",
    },
    "gxtz-achievement-materials": {
        "checkpoints": [
            "achievement_ip_link",  # 成果→IP关联
            "ps_match_quality",     # PS匹配质量
            "conversion_chain",     # RD→IP→成果→PS完整链
        ],
        "consensus_threshold": 0.85,
        "arbitration": "human_for_type_B",
    },
    "gxtz-invoice-ps-matching": {
        "checkpoints": [
            "ps_name_extraction",       # PS名称提取准确性
            "invoice_match_accuracy",   # 发票匹配准确率
            "ps_coverage_check",        # PS覆盖度检查
        ],
        "consensus_threshold": 0.80,
        "arbitration": "human_for_type_B",
    },
    "gxtz-rd-report": {
        "checkpoints": [
            "format_compliance",    # 7项格式规范
            "content_logic",        # 内容逻辑自洽性
            "word_count",           # 字数合规
        ],
        "consensus_threshold": 0.90,
        "arbitration": "human_for_type_B",
    },
    "gxtz-ip-materials": {
        "checkpoints": [
            "ip_completeness",      # IP材料完整性
            "ip_rd_linkage",        # IP→RD关联
            "patent_status_valid",  # 专利状态有效性
        ],
        "consensus_threshold": 0.90,
        "arbitration": "human_for_type_B",
    },
    "gxtz-staff-materials": {
        "checkpoints": [
            "staff_headcount",      # 科技人员人数≥10%
            "work_duration_183",    # 累计工作时长≥183天
            "social_insurance",     # 社保缴纳记录
        ],
        "consensus_threshold": 0.90,
        "arbitration": "human_for_type_B",
    },
    "gxtz-ps-materials": {
        "checkpoints": [
            "ps_tech_description",  # PS技术说明完整性
            "ps_revenue_ratio",     # PS收入占比≥60%
            "contract_invoice_link", # 合同发票关联
        ],
        "consensus_threshold": 0.85,
        "arbitration": "human_for_type_B",
    },
    "gxtz-audit-verification": {
        "checkpoints": [
            "cross_report_consistency",  # 跨报告一致性
            "amount_diff_tolerance",     # 金额差异容忍度
            "rd_ip_ps_content_match",    # RD/IP/PS内容匹配
        ],
        "consensus_threshold": 0.95,
        "arbitration": "human_for_type_B",
    },
}

# ============================================================
# 验证系统提示词（MiniMax角色定义）
# ============================================================
VALIDATOR_SYSTEM_PROMPT = """你是高新技术企业认定（国高）申报材料的专业校验模型。
你的职责不是重新分析原始文件，而是审核分析师的"工作底稿"——

你的审核方式：
1. 【证据链完整性】分析师的每个结论是否有明确的源锚点？证据链是否完整？
2. 【推理自洽性】分析师的推理过程是否存在逻辑矛盾或不一致？
3. 【政策符合性】分析师的判断是否符合高新技术企业认定政策要求？
4. 【模式异常检测】是否存在统计异常、匹配模式异常等值得关注的信号？

你的输出格式（严格遵守JSON）：
{
  "consensus": [
    {
      "decision_id": "xxx",
      "agreement": true,
      "confidence": "high",
      "note": "推理自洽，证据链完整"
    }
  ],
  "disputes": [
    {
      "decision_id": "xxx",
      "dispute_type": "factual|judgment|format|policy",
      "severity": "critical|warning|info",
      "reasoning": "具体异议理由，必须引用证据包中的具体数据或推理步骤",
      "suggested_action": "建议的修正方案或需补充的证据",
      "confidence": "high|medium|low"
    }
  ],
  "risk_flags": [
    {
      "type": "pattern_anomaly|coverage_gap|consistency_breach|threshold_risk",
      "description": "具体风险描述",
      "affected_items": ["涉及的决策ID列表"],
      "priority": "high|medium|low"
    }
  ],
  "requests_for_clarification": [
    {
      "decision_id": "xxx或general",
      "question": "需要主模型补充说明的具体问题",
      "reason": "为什么需要这个信息才能做出判断"
    }
  ],
  "summary": {
    "total_decisions_reviewed": 0,
    "consensus_count": 0,
    "dispute_count": 0,
    "risk_flag_count": 0,
    "overall_assessment": "pass|pass_with_warnings|needs_review|blocked",
    "key_findings": "一句话总结最重要的发现"
  }
}

重要原则：
- 你的每个异议必须引用证据包中的具体数据，不能凭空质疑
- 如果证据包中的信息不足以做出判断，请在 requests_for_clarification 中明确提问
- 不要重复分析原始文件（你无法访问），只审核分析师的推理链
- factual类型（数据提取错误）的异议优先级最高
- judgment类型（判断分歧）需标注你的推理过程，供人工仲裁参考"""


# ============================================================
# 证据包协议（Evidence Package Protocol）
# ============================================================

def build_evidence_package(checkpoint_id, skill_name, files_processed,
                           extraction_results, decisions, policy_context,
                           primary_model="deepseek"):
    """构建标准化的证据包（Evidence Package）

    DeepSeek在到达校验点时调用此函数，将文件处理结果打包为结构化证据包。
    MiniMax不接收原始文件，而是接收此证据包——相当于审计工作底稿。

    参数：
        checkpoint_id: 校验点ID（如 "gxtz-invoice-ps-matching:matching_results"）
        skill_name: 技能名称
        files_processed: 已处理文件摘要列表 [{"file": "...", "type": "excel|word|pdf",
                         "summary": "包含xx行数据，涉及xx个字段", "rows_processed": 847}]
        extraction_results: 提取结果列表 [{"claim_id": "PS-001", "claim": "...",
                            "source_anchor": {"file": "...", "section": "...",
                            "extraction_method": "..."}, "confidence": "high|medium|low"}]
        decisions: 决策列表 [{"decision_id": "MATCH-001", "type": "...",
                   "input": {...}, "result": "...", "rationale": "...",
                   "confidence": "high|medium|low", "evidence_anchors": [...]}]
        policy_context: 政策上下文 {"rules_applied": [...], "thresholds": {...}}
        primary_model: 主模型名称

    返回：
        证据包字典
    """
    return {
        "protocol_version": "2.0",
        "checkpoint_id": checkpoint_id,
        "timestamp": datetime.now().isoformat(),
        "primary_model": primary_model,
        "skill": skill_name,
        "evidence_manifest": {
            "files_processed": files_processed,
            "total_files": len(files_processed),
        },
        "extraction_results": extraction_results,
        "decisions": decisions,
        "policy_context": policy_context,
        "meta": {
            "extraction_model": primary_model,
            "extraction_timestamp": datetime.now().isoformat(),
            "validator_model": "minimax",
        },
    }


# ============================================================
# MiniMax API 客户端
# ============================================================

def _get_minimax_credentials():
    """获取MiniMax API凭证，优先级：环境变量 > 配置文件"""
    api_key = os.environ.get(MINIMAX_API_KEY_ENV)
    group_id = os.environ.get(MINIMAX_GROUP_ID_ENV)

    if not api_key:
        # 尝试从配置文件读取
        config_path = Path(__file__).parent / "config" / "cross_model_config.json"
        if config_path.exists():
            try:
                config = json.loads(config_path.read_text(encoding='utf-8'))
                api_key = config.get("minimax", {}).get("api_key", "")
                group_id = config.get("minimax", {}).get("group_id", "")
            except Exception:
                pass

    return api_key, group_id


def call_minimax_api(user_message, system_prompt=None, temperature=None, max_tokens=None):
    """调用MiniMax API进行校验

    参数：
        user_message: 证据包序列化后的JSON字符串
        system_prompt: 系统提示词
        temperature: 温度参数
        max_tokens: 最大token数

    返回：
        (success, response_data_or_error)
    """
    api_key, group_id = _get_minimax_credentials()

    if not api_key:
        return False, f"MiniMax API Key未配置。请设置环境变量 {MINIMAX_API_KEY_ENV} 或配置文件"

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    payload = {
        "model": MINIMAX_MODEL,
        "messages": [
            {
                "role": "system",
                "content": system_prompt or VALIDATOR_SYSTEM_PROMPT,
            },
            {
                "role": "user",
                "content": user_message,
            },
        ],
        "temperature": temperature if temperature is not None else MINIMAX_TEMPERATURE,
        "max_tokens": max_tokens or MINIMAX_MAX_TOKENS,
        "reply_constraints": {"sender_type": "BOT", "sender_name": "校验模型"},
    }

    if group_id:
        payload["group_id"] = group_id

    try:
        import urllib.request
        import urllib.error

        data = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        req = urllib.request.Request(MINIMAX_API_URL, data=data, headers=headers)

        with urllib.request.urlopen(req, timeout=120) as resp:
            result = json.loads(resp.read().decode('utf-8'))

        if result.get("base_resp", {}).get("status_code") != 0:
            return False, f"MiniMax API错误: {result.get('base_resp', {}).get('status_msg', '未知错误')}"

        reply = result.get("reply", "")
        if not reply:
            choices = result.get("choices", [])
            if choices:
                reply = choices[0].get("message", {}).get("content", "")
            else:
                return False, "MiniMax返回空响应"

        # 尝试解析JSON
        try:
            parsed = json.loads(reply)
            return True, parsed
        except json.JSONDecodeError:
            # 尝试从回复中提取JSON
            import re
            json_match = re.search(r'\{[\s\S]*\}', reply)
            if json_match:
                try:
                    parsed = json.loads(json_match.group(0))
                    return True, parsed
                except json.JSONDecodeError:
                    pass
            return False, f"MiniMax返回非JSON格式: {reply[:500]}"

    except urllib.error.HTTPError as e:
        error_body = e.read().decode('utf-8', errors='replace')
        return False, f"HTTP {e.code}: {error_body[:500]}"
    except Exception as e:
        return False, f"调用MiniMax API异常: {str(e)}"


# ============================================================
# 差异分类器
# ============================================================

def classify_dispute(dispute):
    """将MiniMax的异议分类为A/B/C三类

    类型A（事实性差异）：数据提取、计算结果不准确 → 回溯源文件确认
    类型B（判断性差异）：匹配判定、关联逻辑的分歧 → 标记争议，等待人工仲裁
    类型C（格式/表述差异）：措辞、格式等非关键差异 → 记录但不阻塞
    """
    dispute_type = dispute.get("dispute_type", "judgment")
    severity = dispute.get("severity", "warning")

    if dispute_type == "factual":
        return "A", "回溯源文件核实数据"
    elif dispute_type == "judgment":
        return "B", "标记争议，等待人工仲裁"
    elif dispute_type == "format":
        return "C", "记录但不阻塞流程"
    elif dispute_type == "policy":
        if severity == "critical":
            return "B", "政策合规类严重分歧，需人工确认"
        return "B", "政策解读分歧，需人工确认"
    return "B", "未知类型，默认走人工仲裁"


def compare_and_classify(validation_result, evidence_package, consensus_threshold=0.85):
    """对比主模型和校验模型的输出，分类处置

    返回：
        {
            "consensus_items": [...],       # 共识项
            "disputes_by_type": {           # 按类型分组的争议
                "A": [...],  # 事实性 → 回溯源文件
                "B": [...],  # 判断性 → 人工仲裁
                "C": [...],  # 格式性 → 记录不阻塞
            },
            "risk_flags": [...],
            "queries": [...],               # 校验模型的追问
            "overall_status": "pass|needs_self_check|needs_human|blocked",
            "summary": validation_result.get("summary", {}),
        }
    """
    disputes = validation_result.get("disputes", [])
    consensus = validation_result.get("consensus", [])
    risk_flags = validation_result.get("risk_flags", [])
    queries = validation_result.get("requests_for_clarification", [])
    summary = validation_result.get("summary", {})

    total = summary.get("total_decisions_reviewed", 0)
    consensus_count = summary.get("consensus_count", len(consensus))
    dispute_count = summary.get("dispute_count", len(disputes))

    # 计算一致性比例
    if total > 0:
        consensus_ratio = consensus_count / total
    else:
        total_decisions = len(evidence_package.get("decisions", []))
        consensus_ratio = (total_decisions - dispute_count) / max(total_decisions, 1)

    # 分类争议
    disputes_by_type = {"A": [], "B": [], "C": []}
    for dispute in disputes:
        d_type, action = classify_dispute(dispute)
        dispute["_classification"] = d_type
        dispute["_action"] = action
        disputes_by_type[d_type].append(dispute)

    # 判定整体状态
    critical_disputes = [d for d in disputes_by_type["A"] + disputes_by_type["B"]
                         if d.get("severity") == "critical"]
    high_risk_flags = [r for r in risk_flags if r.get("priority") == "high"]

    if critical_disputes:
        overall_status = "blocked"
    elif disputes_by_type["A"]:
        overall_status = "needs_self_check"
    elif disputes_by_type["B"]:
        overall_status = "needs_human"
    elif consensus_ratio < consensus_threshold:
        overall_status = "needs_human"
    elif high_risk_flags:
        overall_status = "needs_human"
    elif queries:
        overall_status = "needs_self_check"
    else:
        overall_status = "pass"

    return {
        "consensus_items": consensus,
        "disputes_by_type": disputes_by_type,
        "risk_flags": risk_flags,
        "queries": queries,
        "overall_status": overall_status,
        "consensus_ratio": round(consensus_ratio, 4),
        "summary": summary,
        "processed_at": datetime.now().isoformat(),
    }


# ============================================================
# 经验交叉验证（capture时的交叉校验）
# ============================================================

def cross_validate_experience(problem_desc, solution, skill_name, prevention=None):
    """在capture提交经验前，让MiniMax校验这条经验是否成立

    防止单一模型的"错误经验"污染经验库。

    参数：
        problem_desc: 问题描述
        solution: 解决方案
        skill_name: 技能名称
        prevention: 预防建议

    返回：
        (status, result)
        status: "consensus" | "disputed" | "single_source" | "error"
    """
    prompt = f"""请审核以下由主模型（DeepSeek）在技能执行中发现的问题和解决方案，判断是否合理。

技能：{skill_name}
发现的问题：{problem_desc}
提出的解决方案：{solution}
预防建议：{prevention or "未提供"}

请判断：
1. 这个问题是真实的技能缺陷还是模型自身的限制？
2. 解决方案是否合理、可行？
3. 是否存在主模型未考虑到的边界情况？

返回JSON格式：
{{
  "valid": true/false,
  "confidence": "high|medium|low",
  "assessment": "对这条经验的评价",
  "improvements": ["如果有改进建议"],
  "boundary_cases": ["可能遗漏的边界情况"],
  "recommendation": "agree|agree_with_modifications|disagree|need_more_context"
}}"""

    success, result = call_minimax_api(prompt, system_prompt=VALIDATOR_SYSTEM_PROMPT)
    if not success:
        return "single_source", {"error": result, "note": "MiniMax不可用，经验标记为单模型提交"}

    recommendation = result.get("recommendation", "need_more_context")
    if recommendation == "agree":
        return "consensus", result
    elif recommendation == "agree_with_modifications":
        return "consensus", result
    elif recommendation == "disagree":
        return "disputed", result
    else:
        return "disputed", result


# ============================================================
# validate 子命令：执行交叉验证
# ============================================================

def validate_checkpoint(checkpoint_file, output_file=None, skill_name=None):
    """执行完整的交叉验证流程"""
    checkpoint_path = Path(checkpoint_file)
    if not checkpoint_path.exists():
        print(f'[validate] ERROR: 校验点文件不存在: {checkpoint_file}')
        return False

    print(f'[validate] 读取证据包: {checkpoint_file}')
    try:
        evidence_package = json.loads(checkpoint_path.read_text(encoding='utf-8'))
    except Exception as e:
        print(f'[validate] ERROR: 解析证据包失败: {e}')
        return False

    checkpoint_id = evidence_package.get("checkpoint_id", "unknown")
    skill_name = skill_name or evidence_package.get("skill", "unknown")
    print(f'[validate] 校验点: {checkpoint_id}')
    print(f'[validate] 技能: {skill_name}')
    print(f'[validate] 证据包包含 {len(evidence_package.get("decisions", []))} 个决策点')

    # 获取技能校验配置
    skill_config = SKILL_CHECKPOINTS.get(skill_name, {})
    consensus_threshold = skill_config.get("consensus_threshold", 0.85)

    # 序列化证据包为消息
    user_message = json.dumps(evidence_package, ensure_ascii=False)

    # 调用MiniMax API
    print(f'[validate] 发送证据包到MiniMax API（{len(user_message)} 字符）...')
    start_time = time.time()
    success, result = call_minimax_api(user_message)
    elapsed = time.time() - start_time

    if not success:
        print(f'[validate] ERROR: MiniMax API调用失败: {result}')
        return False

    print(f'[validate] MiniMax响应耗时: {elapsed:.1f}秒')

    # 解析和分类
    classified = compare_and_classify(result, evidence_package, consensus_threshold)
    print(f'[validate] 验证结果: {classified["overall_status"]}')
    print(f'[validate] 一致性比例: {classified["consensus_ratio"]}')
    print(f'[validate] 争议数: TypeA={len(classified["disputes_by_type"]["A"])} '
          f'TypeB={len(classified["disputes_by_type"]["B"])} '
          f'TypeC={len(classified["disputes_by_type"]["C"])}')
    print(f'[validate] 风险标记: {len(classified["risk_flags"])}')
    print(f'[validate] 追问: {len(classified["queries"])}')

    # 输出结果
    output_data = {
        "checkpoint_id": checkpoint_id,
        "skill": skill_name,
        "primary_model": evidence_package.get("primary_model", "deepseek"),
        "validator_model": "minimax",
        "consensus_threshold": consensus_threshold,
        "classified_result": classified,
        "raw_validation": result,
        "meta": {
            "validated_at": datetime.now().isoformat(),
            "api_elapsed_seconds": round(elapsed, 2),
        },
    }

    # 写入输出文件
    if output_file:
        output_path = Path(output_file)
    else:
        output_dir = checkpoint_path.parent
        output_path = output_dir / f"validation_result_{checkpoint_id.replace(':', '_')}.json"

    output_path.write_text(json.dumps(output_data, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'[validate] 验证结果已写入: {output_path}')

    return output_data


# ============================================================
# test-connection 子命令
# ============================================================

def test_connection():
    """测试MiniMax API连接"""
    api_key, group_id = _get_minimax_credentials()
    if not api_key:
        print("[test] FAIL: MiniMax API Key未配置")
        print(f"[test] 请设置环境变量 {MINIMAX_API_KEY_ENV}")
        if group_id:
            print(f"[test] Group ID已配置")
        else:
            print(f"[test] 可选设置环境变量 {MINIMAX_GROUP_ID_ENV}")
        return False

    print("[test] MiniMax API Key已配置")
    if group_id:
        print("[test] Group ID已配置")

    test_prompt = "请用JSON格式回复：{\"status\": \"ok\", \"model\": \"你的模型名称\"}"
    print("[test] 发送测试请求...")

    success, result = call_minimax_api(test_prompt, temperature=0.1, max_tokens=256)
    if success:
        print(f"[test] PASS: MiniMax API连接成功")
        print(f"[test] 响应: {json.dumps(result, ensure_ascii=False)[:200]}")
        return True
    else:
        print(f"[test] FAIL: {result}")
        return False


# ============================================================
# capture-with-validation 子命令：经验提交前交叉验证
# ============================================================

def capture_with_validation(project_root, skill, enterprise, problem_type,
                            problem_desc, solution, prevention=None):
    """经验提交前先经过MiniMax交叉验证，确认合理后才写入

    这是对现有 capture 命令的增强版：新增 --cross-validate 模式
    """
    print(f'[capture-cv] 经验交叉验证模式')
    print(f'[capture-cv] 技能: {skill}')

    # 1. MiniMax交叉验证经验
    print(f'[capture-cv] 发送经验到MiniMax进行交叉验证...')
    cv_status, cv_result = cross_validate_experience(problem_desc, solution, skill, prevention)

    if cv_status == "consensus":
        print(f'[capture-cv] ✓ MiniMax认可此经验: {cv_result.get("assessment", "")}')
        status = "pending"
    elif cv_status == "disputed":
        print(f'[capture-cv] ⚠ MiniMax对此经验有异议: {cv_result.get("assessment", "")}')
        status = "disputed"
    elif cv_status == "single_source":
        print(f'[capture-cv] ⚠ MiniMax不可用，经验标记为单模型提交')
        status = "single_source"
    else:
        print(f'[capture-cv] ✗ 交叉验证出错: {cv_result}')
        status = "single_source"

    # 2. 构建经验条目
    experience = {
        "problem_type": problem_type,
        "problem_desc": problem_desc,
        "solution": solution,
        "prevention": prevention or "技能执行时参考此经验避免重复犯错",
        "status": status,
        "cross_validation": {
            "status": cv_status,
            "result": cv_result if cv_status != "single_source" else cv_result.get("error", ""),
            "validated_at": datetime.now().isoformat(),
            "validator": "minimax",
        },
    }

    # 3. 写入输出文件（由project_context_manager.py capture读取后写入）
    output_path = Path(project_root) / ".trae" / "cross_validated_experience.json"
    output_path.write_text(json.dumps(experience, ensure_ascii=False, indent=2), encoding='utf-8')

    print(f'[capture-cv] 交叉验证经验已保存到: {output_path}')
    print(f'[capture-cv] 状态: {status}')
    print(f'[capture-cv] 请使用 project_context_manager.py capture 将结果写入experience_base')

    return True


# ============================================================
# 命令行入口
# ============================================================

def main():
    parser = argparse.ArgumentParser(
        description='双模型交叉验证编排器（DeepSeek主 + MiniMax校验）',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例：
  python cross_model_validator.py validate --checkpoint-file checkpoint.json --output-file result.json
  python cross_model_validator.py test-connection
  python cross_model_validator.py capture-cv --project-root "D:\\项目" --skill "gxtz-core-tables" --enterprise "企业" --problem-type common_issue --problem-desc "描述" --solution "方案"

环境变量：
  MINIMAX_API_KEY     MiniMax API密钥（必需）
  MINIMAX_GROUP_ID    MiniMax Group ID（可选）

配置文件（备选）：
  .trae/skills/_common/config/cross_model_config.json
        """,
    )
    subparsers = parser.add_subparsers(dest="command", help="子命令")

    # validate 子命令
    val_parser = subparsers.add_parser("validate", help="执行交叉验证")
    val_parser.add_argument("--checkpoint-file", required=True, help="证据包JSON文件路径")
    val_parser.add_argument("--output-file", default=None, help="验证结果输出路径（默认同目录下自动命名）")
    val_parser.add_argument("--skill", default=None, help="技能名称（默认从证据包中读取）")

    # test-connection 子命令
    subparsers.add_parser("test-connection", help="测试MiniMax API连接")

    # capture-cv 子命令：经验交叉验证后提交
    cv_parser = subparsers.add_parser("capture-cv", help="经验交叉验证后提交")
    cv_parser.add_argument("--project-root", required=True, help="项目根目录")
    cv_parser.add_argument("--skill", required=True, help="技能名称")
    cv_parser.add_argument("--enterprise", required=True, help="企业名称")
    cv_parser.add_argument("--problem-type", required=True,
                           choices=["common_issue", "validation_rule", "format_requirement",
                                    "review_checkpoint", "best_practice", "upgrade_trigger"],
                           help="经验类型")
    cv_parser.add_argument("--problem-desc", required=True, help="问题描述")
    cv_parser.add_argument("--solution", required=True, help="解决方案")
    cv_parser.add_argument("--prevention", default=None, help="预防建议")

    args = parser.parse_args()

    if args.command == "validate":
        result = validate_checkpoint(args.checkpoint_file, args.output_file, args.skill)
        if result:
            classified = result.get("classified_result", {})
            overall = classified.get("overall_status", "unknown")
            print(f"\n[validate] === 交叉验证完成 ===")
            print(f"[validate] 整体状态: {overall}")
            if overall == "blocked":
                print("[validate] ⛔ 存在关键争议，建议暂停流程等待人工仲裁")
                sys.exit(2)
            elif overall == "needs_human":
                print("[validate] ⚠ 需人工仲裁，已生成仲裁报告")
                sys.exit(3)
            elif overall == "needs_self_check":
                print("[validate] ⚡ 需主模型自查后再提交")
                sys.exit(4)
            else:
                print("[validate] ✓ 验证通过")
                sys.exit(0)
        else:
            sys.exit(1)

    elif args.command == "test-connection":
        success = test_connection()
        sys.exit(0 if success else 1)

    elif args.command == "capture-cv":
        success = capture_with_validation(
            args.project_root, args.skill, args.enterprise,
            args.problem_type, args.problem_desc, args.solution, args.prevention
        )
        sys.exit(0 if success else 1)

    else:
        parser.print_help()


if __name__ == "__main__":
    main()
