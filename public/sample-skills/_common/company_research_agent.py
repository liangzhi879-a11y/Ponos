#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
企业深度研究 Agent 引擎

参考项目：https://github.com/guy-hartstein/company-research-agent (Apache 2.0)
设计思路：参考其多Agent流水线架构（CompanyAnalyzer → IndustryAnalyzer → FinancialAnalyst
  → NewsScanner → Collector → Curator → Briefing → Editor），使用本地方案替代外部API：
  - Tavily API → WebSearch + WebFetch（由 TRAE agent 执行）
  - Gemini → 本地 LLM / DeepSeek
  - OpenAI → 本地 LLM / DeepSeek

Agent 流水线：
  阶段1: 研究节点（生成搜索计划，由 agent 执行 WebSearch）
    - CompanyAnalyzer: 企业基本信息
    - IndustryAnalyzer: 行业定位与趋势
    - TechnologyLandscaper: 技术/专利布局
    - NewsScanner: 新闻动态与舆情
  阶段2: 处理节点（本地执行）
    - Collector: 聚合所有研究数据
    - Curator: 内容过滤与相关性评分
    - Briefing: 生成结构化摘要
    - Editor: 编译最终报告

CLI 用法：
  # 生成企业深度研究搜索计划
  python company_research_agent.py plan --enterprise "企业名称" [--province "省"] [--output-dir <dir>]

  # 解析搜索结果目录（agent执行WebSearch后保存的结果文件）
  python company_research_agent.py parse --results-dir <dir> --enterprise "企业名称" [--output-json <path>]

  # 从解析结果生成结构化企业研究报告
  python company_research_agent.py report --data <json_path> --enterprise "企业名称" [--output-dir <dir>]

  # 一键执行（plan → 输出搜索计划JSON，agent按计划搜索后调用 parse → report）
  python company_research_agent.py full --enterprise "企业名称" --research-dir <dir>
"""

import argparse
import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Optional


# ============================================================
# 配置
# ============================================================
DEFAULT_OUTPUT_DIR = None  # 由调用方指定

# 4个研究节点的搜索查询模板
RESEARCH_NODE_TEMPLATES = {
    "company_analyzer": {
        "name": "企业基本信息分析",
        "description": "研究企业核心业务、产品服务、市场定位",
        "search_queries": [
            "{enterprise} 企业简介 主营业务 产品",
            "{enterprise} 发展历程 里程碑 大事记",
            "{enterprise} 组织架构 子公司 分支机构",
            "{enterprise} 企业资质 荣誉 认证",
            "{enterprise} site:qichacha.com",
            "{enterprise} site:tianyancha.com",
        ],
        "fetch_urls": [],
        "output_fields": [
            "company_overview", "core_business", "products_services",
            "development_history", "org_structure", "qualifications",
        ],
    },
    "industry_analyzer": {
        "name": "行业定位与趋势分析",
        "description": "分析企业所在行业地位、竞争格局、发展趋势",
        "search_queries": [
            "{enterprise} 行业地位 市场份额 排名",
            "{enterprise} 竞争对手 竞品分析",
            "{industry_keywords} 行业发展趋势 市场规模",
            "{industry_keywords} 行业政策 法规 标准",
            "{enterprise} 产业链 上下游",
        ],
        "fetch_urls": [],
        "output_fields": [
            "industry_classification", "market_position", "competitors",
            "industry_trends", "policy_environment", "supply_chain",
        ],
    },
    "technology_landscaper": {
        "name": "技术布局与专利分析",
        "description": "研究企业技术方向、专利布局、研发重点",
        "search_queries": [
            "{enterprise} 核心技术 技术优势 研发方向",
            "{enterprise} 专利 知识产权 发明专利",
            "{enterprise} 技术创新 研发成果",
            "{enterprise} 产学研合作 技术引进",
            "{enterprise} 技术团队 研发人员",
        ],
        "fetch_urls": [],
        "output_fields": [
            "core_technologies", "tech_advantages", "patent_portfolio",
            "rd_direction", "collaborations", "tech_team",
        ],
    },
    "news_scanner": {
        "name": "新闻动态与舆情分析",
        "description": "收集企业近期新闻、重大事件、媒体报道",
        "search_queries": [
            "{enterprise} 新闻 最新动态",
            "{enterprise} 融资 投资 上市",
            "{enterprise} 合作 签约 战略",
            "{enterprise} 获奖 表彰 荣誉",
            "{enterprise} 公告 声明",
        ],
        "fetch_urls": [],
        "output_fields": [
            "recent_news", "major_events", "financing_events",
            "cooperation_news", "awards", "public_opinion",
        ],
    },
}


def generate_search_plan(enterprise_name, industry_keywords=None, province=None):
    """阶段1-研究节点：生成搜索计划

    对应 company-research-agent 的 Research Nodes (CompanyAnalyzer,
    IndustryAnalyzer, FinancialAnalyst, NewsScanner)。
    由 TRAE agent 调用 WebSearch 工具按计划执行搜索。

    Args:
        enterprise_name: 企业全称
        industry_keywords: 行业关键词（可选，用于行业搜索）
        province: 省份（可选，用于过滤本地信息）

    Returns:
        dict: 搜索计划
    """
    if industry_keywords is None:
        industry_keywords = enterprise_name

    plan = {
        "meta": {
            "generated_at": datetime.now().isoformat(),
            "enterprise_name": enterprise_name,
            "industry_keywords": industry_keywords,
            "province": province,
            "source_project": "company-research-agent (Apache 2.0)",
            "pipeline": "CompanyAnalyzer → IndustryAnalyzer → TechnologyLandscaper → NewsScanner",
            "total_nodes": 4,
        },
        "nodes": {},
    }

    for node_id, template in RESEARCH_NODE_TEMPLATES.items():
        queries = []
        for q in template["search_queries"]:
            query = q.format(
                enterprise=enterprise_name,
                industry_keywords=industry_keywords,
            )
            queries.append(query)

        plan["nodes"][node_id] = {
            "name": template["name"],
            "description": template["description"],
            "search_queries": queries,
            "output_fields": template["output_fields"],
            "status": "pending",
        }

    # 计算统计
    total_queries = sum(len(n["search_queries"]) for n in plan["nodes"].values())
    plan["meta"]["total_queries"] = total_queries

    return plan


def parse_search_results(results_dir, enterprise_name):
    """阶段2-处理节点：Collector + Curator

    聚合所有搜索结果，进行内容过滤和相关性评分。
    对应 company-research-agent 的 Collector → Curator 节点。

    Args:
        results_dir: 搜索结果文件目录（每个文件是 WebSearch 返回的文本）
        enterprise_name: 企业名称

    Returns:
        dict: 聚合后的研究数据
    """
    results_dir = Path(results_dir)
    if not results_dir.exists():
        return {"error": f"搜索结果目录不存在: {results_dir}", "collected_data": {}}

    collected = {
        "meta": {
            "parsed_at": datetime.now().isoformat(),
            "enterprise_name": enterprise_name,
            "results_dir": str(results_dir),
        },
        "collected_data": {},
        "curation": {},
    }

    # Collector: 聚合所有搜索结果的原始文本
    all_raw_texts = []
    for file_path in sorted(results_dir.glob("*")):
        if file_path.is_file() and file_path.suffix in (".txt", ".md", ".json"):
            try:
                content = file_path.read_text(encoding="utf-8", errors="replace")
                all_raw_texts.append({
                    "source_file": file_path.name,
                    "content": content,
                    "length": len(content),
                })
            except Exception as e:
                all_raw_texts.append({
                    "source_file": file_path.name,
                    "content": f"[读取错误: {e}]",
                    "length": 0,
                    "error": str(e),
                })

    collected["collected_data"]["raw_texts"] = all_raw_texts
    collected["collected_data"]["total_sources"] = len(all_raw_texts)
    collected["collected_data"]["total_chars"] = sum(t["length"] for t in all_raw_texts)

    # Curator: 内容过滤与相关性评分
    curation = _curate_content(all_raw_texts, enterprise_name)
    collected["curation"] = curation

    return collected


def _curate_content(raw_texts, enterprise_name):
    """Curator 节点：内容过滤与相关性评分

    对应 company-research-agent 的 curator.py：
    - 按企业名称出现频率评分
    - 按内容长度和质量过滤
    - URL去重和标准化

    Returns:
        dict: 评分和过滤结果
    """
    scored_items = []
    enterprise_pattern = re.compile(re.escape(enterprise_name), re.IGNORECASE)

    for item in raw_texts:
        content = item.get("content", "")
        if not content or len(content) < 50:
            continue

        # 相关性评分（基于企业名称出现次数和内容长度）
        name_occurrences = len(enterprise_pattern.findall(content))
        length_score = min(len(content) / 5000, 1.0)  # 最多5000字符满分
        relevance_score = min(name_occurrences / 10, 1.0) * 0.6 + length_score * 0.4

        scored_items.append({
            "source_file": item["source_file"],
            "relevance_score": round(relevance_score, 3),
            "name_occurrences": name_occurrences,
            "content_length": len(content),
            "content_preview": content[:200],
        })

    # 按相关性排序，过滤低分（<0.05）
    scored_items.sort(key=lambda x: x["relevance_score"], reverse=True)
    filtered = [s for s in scored_items if s["relevance_score"] >= 0.05]

    return {
        "total_scored": len(scored_items),
        "filtered_count": len(filtered),
        "relevance_threshold": 0.05,
        "scored_items": scored_items,
        "high_relevance": [s for s in filtered if s["relevance_score"] >= 0.4],
        "medium_relevance": [s for s in filtered if 0.15 <= s["relevance_score"] < 0.4],
        "low_relevance": [s for s in filtered if 0.05 <= s["relevance_score"] < 0.15],
    }


def generate_structured_report(collected_data, enterprise_name):
    """阶段2-处理节点：Briefing + Editor

    从聚合数据生成结构化企业研究报告。
    对应 company-research-agent 的 Briefing (Gemini) → Editor (GPT) 节点。
    使用本地 LLM 方案替代。

    Args:
        collected_data: parse_search_results 的输出
        enterprise_name: 企业名称

    Returns:
        dict: 结构化研究报告
    """
    report = {
        "meta": {
            "report_type": "enterprise_deep_research",
            "enterprise_name": enterprise_name,
            "generated_at": datetime.now().isoformat(),
            "pipeline": "Briefing → Editor (local LLM)",
            "source_reference": "company-research-agent (Apache 2.0)",
            "sections": [],
        },
        "executive_summary": "",
        "sections": {},
    }

    # Briefing: 汇总所有搜索文本（不仅限高相关度，避免遗漏信息）
    raw_texts = collected_data.get("collected_data", {}).get("raw_texts", [])
    summary_text = "\n\n".join(r.get("content", "") for r in raw_texts)

    # 构建各章节的提取数据
    sections = {
        "company_profile": {
            "title": "企业概况",
            "description": "企业基本信息、主营业务、产品服务",
            "extracted_info": _extract_section_info(summary_text, enterprise_name, "company"),
        },
        "industry_analysis": {
            "title": "行业分析",
            "description": "行业定位、竞争格局、发展趋势",
            "extracted_info": _extract_section_info(summary_text, enterprise_name, "industry"),
        },
        "technology_landscape": {
            "title": "技术布局",
            "description": "核心技术、专利情况、研发方向",
            "extracted_info": _extract_section_info(summary_text, enterprise_name, "technology"),
        },
        "news_digest": {
            "title": "新闻动态",
            "description": "近期新闻、重大事件、媒体报道",
            "extracted_info": _extract_section_info(summary_text, enterprise_name, "news"),
        },
    }

    report["sections"] = sections
    report["meta"]["sections"] = list(sections.keys())

    # Executive summary
    report["executive_summary"] = _generate_executive_summary(sections, enterprise_name)

    return report


def _extract_section_info(text, enterprise_name, section_type):
    """从搜索文本中提取特定维度的信息

    注意：这是启发式提取，实际精度依赖搜索质量。
    对应 Briefing 节点的摘要任务，使用规则+正则替代 Gemini。

    Args:
        text: 搜索文本
        enterprise_name: 企业名称
        section_type: 维度类型 (company/industry/technology/news)

    Returns:
        dict: 提取的信息
    """
    info = {
        "source_text_length": len(text),
        "enterprise_name_matches": len(re.findall(re.escape(enterprise_name), text, re.IGNORECASE)),
        "key_phrases": [],
        "potential_entities": [],
        "structured_data": {},
    }

    # 提取关键短语（基于常见模式）
    patterns = {
        "company": {
            "registered_capital": r"注册资本[：:]?\s*([\d,.]+)\s*(万?元)",
            "establish_date": r"成立日期[：:]?\s*(\d{4}[-/年]\d{1,2}[-/月]\d{1,2})",
            "legal_representative": r"法定代表人[：:]?\s*([\u4e00-\u9fa5]{2,4})",
            "business_scope": r"经营范围[：:]?\s*(.{10,200}?)(?:\n|；|。|$)",
            "unified_code": r"统一社会信用代码[：:]?\s*([0-9A-Z]{18})",
        },
        "industry": {
            "industry_type": r"(?:属于|所处|所在).{0,10}([\u4e00-\u9fa5]{2,6})(?:行业|领域|产业)",
            "market_share": r"市场(?:份额|占有率)[：:]?\s*([\d.%]+)",
            "competitors": r"(?:竞争|竞品).{0,5}(?:对手|企业|公司)[：:]?\s*([\u4e00-\u9fa5、，,]+)",
            "industry_rank": r"(排名|位列|位居.{0,5}第\s*[\d一二三四五])",
        },
        "technology": {
            "patent_count": r"(?:专利|发明专利|实用新型)\s*(\d+)\s*(?:项|件|个)",
            "tech_fields": r"(?:技术|研发)(?:方向|领域|重点)[：:]?\s*([\u4e00-\u9fa5、，,]{5,50})",
            "rd_team": r"(?:研发|技术)(?:团队|人员)[：:]?\s*(\d+)\s*(?:人|名|位)",
            "collaboration": r"(?:合作|联合|共建).{0,10}(?:大学|学院|研究院|实验室|中心)",
        },
        "news": {
            "recent_events": r"(?:近日|近期|日前|最近).{0,30}([\u4e00-\u9fa5，。；！？]{10,100})",
            "financing": r"(?:融资|投资|募资|估值)[：:]?\s*([\d,.]+)\s*(?:亿|万|美元|元)",
            "cooperation": r"(?:合作|签约|战略)(?:协议|伙伴|关系).{0,20}([\u4e00-\u9fa5]{3,30})",
        },
    }

    section_patterns = patterns.get(section_type, {})
    for field, pattern in section_patterns.items():
        match = re.search(pattern, text)
        if match:
            try:
                value = match.group(1).strip() if match.lastindex else match.group(0).strip()
                info["structured_data"][field] = value
            except (IndexError, AttributeError):
                info["structured_data"][field] = match.group(0).strip()

    # 提取关键短语（高频词汇）
    words = re.findall(r'[\u4e00-\u9fa5]{2,6}', text)
    word_freq = {}
    for w in words:
        if w not in (enterprise_name, "有限公司", "有限责任", "股份有限", "企业", "公司"):
            word_freq[w] = word_freq.get(w, 0) + 1

    top_phrases = sorted(word_freq.items(), key=lambda x: x[1], reverse=True)[:10]
    info["key_phrases"] = [{"phrase": p, "frequency": f} for p, f in top_phrases]

    return info


def _generate_executive_summary(sections, enterprise_name):
    """Editor 节点：生成执行摘要

    对应 company-research-agent 的 Editor (GPT) 节点。
    """
    lines = [f"# {enterprise_name} 企业深度研究报告"]
    lines.append(f"\n生成时间：{datetime.now().strftime('%Y-%m-%d %H:%M')}")
    lines.append(f"数据来源：联网公开信息搜索")
    lines.append("")

    for section_id, section in sections.items():
        data = section.get("extracted_info", {}).get("structured_data", {})
        if data:
            lines.append(f"## {section['title']}")
            for key, value in data.items():
                label = _field_label(key)
                lines.append(f"- {label}: {value}")
            lines.append("")

    total_matches = sum(
        s.get("extracted_info", {}).get("enterprise_name_matches", 0)
        for s in sections.values()
    )
    total_data = sum(
        len(s.get("extracted_info", {}).get("structured_data", {}))
        for s in sections.values()
    )

    lines.append("---")
    lines.append(f"*共搜索到 {total_matches} 处企业名称匹配，提取 {total_data} 个结构化字段。*")
    lines.append(f"*本报告由企业深度研究 Agent 自动生成，数据来源于互联网公开信息，仅供参考。*")

    return "\n".join(lines)


def _field_label(key):
    """字段英文名 → 中文标签"""
    labels = {
        "registered_capital": "注册资本",
        "establish_date": "成立日期",
        "legal_representative": "法定代表人",
        "business_scope": "经营范围",
        "unified_code": "统一社会信用代码",
        "industry_type": "行业类型",
        "market_share": "市场份额",
        "competitors": "竞争对手",
        "industry_rank": "行业排名",
        "patent_count": "专利数量",
        "tech_fields": "技术方向",
        "rd_team": "研发团队规模",
        "collaboration": "产学研合作",
        "recent_events": "近期动态",
        "financing": "融资情况",
        "cooperation": "合作动态",
    }
    return labels.get(key, key)


def save_search_plan(plan, output_dir, enterprise_name):
    """保存搜索计划为JSON文件"""
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    plan_path = output_dir / f"{enterprise_name}_search_plan.json"
    with open(plan_path, "w", encoding="utf-8") as f:
        json.dump(plan, f, ensure_ascii=False, indent=2)

    return str(plan_path)


def save_research_report(report, output_dir, enterprise_name):
    """保存研究报告为JSON和Markdown文件"""
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # JSON 格式
    json_path = output_dir / f"{enterprise_name}_research_report.json"
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    # Markdown 格式
    md_path = output_dir / f"{enterprise_name}_research_report.md"
    with open(md_path, "w", encoding="utf-8") as f:
        f.write(report.get("executive_summary", ""))

    return {"json_path": str(json_path), "md_path": str(md_path)}


def print_search_guide(plan):
    """打印人类可读的搜索指南"""
    meta = plan["meta"]
    print(f"\n{'='*60}")
    print(f"  企业深度研究 Agent - 搜索计划")
    print(f"{'='*60}")
    print(f"目标企业: {meta['enterprise_name']}")
    print(f"行业关键词: {meta['industry_keywords']}")
    print(f"研究阶段: {meta['total_nodes']} 个分析节点, 共 {meta['total_queries']} 个搜索查询")
    print(f"流水线: {meta['pipeline']}")
    print(f"{'='*60}")

    for node_id, node in plan["nodes"].items():
        print(f"\n--- [{node_id}] {node['name']} ---")
        print(f"  {node['description']}")
        print(f"  搜索查询 ({len(node['search_queries'])} 条):")
        for i, q in enumerate(node["search_queries"], 1):
            print(f"    {i}. {q}")


# ============================================================
# CLI
# ============================================================
def main():
    parser = argparse.ArgumentParser(
        description="企业深度研究 Agent 引擎",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  python company_research_agent.py plan --enterprise "深圳锐取电子有限公司" --output-dir ./research
  python company_research_agent.py parse --results-dir ./research/results --enterprise "深圳锐取电子有限公司"
  python company_research_agent.py report --data ./research/collected.json --enterprise "深圳锐取电子有限公司"
        """,
    )
    sub = parser.add_subparsers(dest="command", help="子命令")

    # plan 子命令
    plan_p = sub.add_parser("plan", help="生成搜索计划")
    plan_p.add_argument("--enterprise", required=True, help="企业全称")
    plan_p.add_argument("--industry-keywords", help="行业关键词（可选）")
    plan_p.add_argument("--province", help="省份（可选）")
    plan_p.add_argument("--output-dir", default=".", help="输出目录")

    # parse 子命令
    parse_p = sub.add_parser("parse", help="解析搜索结果")
    parse_p.add_argument("--results-dir", required=True, help="搜索结果目录")
    parse_p.add_argument("--enterprise", required=True, help="企业名称")
    parse_p.add_argument("--output-json", help="输出JSON路径（可选）")

    # report 子命令
    report_p = sub.add_parser("report", help="生成结构化报告")
    report_p.add_argument("--data", required=True, help="parse子命令输出的JSON文件")
    report_p.add_argument("--enterprise", required=True, help="企业名称")
    report_p.add_argument("--output-dir", default=".", help="输出目录")

    args = parser.parse_args()

    if args.command == "plan":
        plan = generate_search_plan(
            args.enterprise,
            industry_keywords=args.industry_keywords,
            province=args.province,
        )
        plan_path = save_search_plan(plan, args.output_dir, args.enterprise)
        print_search_guide(plan)
        print(f"\n[OK] 搜索计划已保存: {plan_path}")
        print(json.dumps(plan, ensure_ascii=False, indent=2))

    elif args.command == "parse":
        collected = parse_search_results(args.results_dir, args.enterprise)
        if args.output_json:
            output_path = Path(args.output_json)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            with open(output_path, "w", encoding="utf-8") as f:
                json.dump(collected, f, ensure_ascii=False, indent=2)
            print(f"[OK] 解析结果已保存: {output_path}")
        else:
            print(json.dumps(collected, ensure_ascii=False, indent=2))

    elif args.command == "report":
        with open(args.data, "r", encoding="utf-8") as f:
            collected = json.load(f)
        report = generate_structured_report(collected, args.enterprise)
        paths = save_research_report(report, args.output_dir, args.enterprise)
        print(f"[OK] 研究报告已保存:")
        print(f"  JSON: {paths['json_path']}")
        print(f"  MD:   {paths['md_path']}")

    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
