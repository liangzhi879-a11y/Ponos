"""RD-IP-PS 自主匹配与审核模块（模块十一）

设计原则（核心）：绝不完全以工作流输出为准。本模块内置**确定性规则算法作为主匹配器**，
调用 Dify 工作流 WF_RD_PS_IP_Matching_V2 仅作交叉参考。实测该工作流的 IP 匹配节点
存在 bug（对全部 RD 返回空 ips:[]），因此以自主算法为准，两者不一致时在审核报告标注差异。

匹配规则（对应用户要求）：
    1. 一个RD可对应多个PS和IP（多对多映射）
    2. RD时间不应晚于IP：非发明专利 RD.year ≤ IP申请年份为硬约束，且时间越接近得分越高
    3. 发明专利豁免"时间相近"约束：允许RD关联较早年份的发明作为技术基础（IP.year可早于RD.year）
    4. 所有IP必须匹配不能闲置：主匹配后扫描闲置IP，强制兜底分配到最相近RD并在报告标注

配置文件：
    _common/rd_ip_ps_matching_config.json（领域关键词/时间阈值/打分权重/工作流API）

打分模型：
    综合得分 = 领域匹配(40) + 关键词重叠(35) + 时间接近度(25) [+发明技术基础加分(10)]
    低于阈值(20)不主动匹配，仅兜底可突破。

CLI 用法：
    python rd_ip_ps_matching.py match --project-root "项目根目录"
        执行RD-IP-PS匹配（自主算法为主，工作流交叉参考）

    python rd_ip_ps_matching.py audit --project-root "项目根目录"
        审核匹配结果（生成审核报告到stdout）

    python rd_ip_ps_matching.py report --project-root "项目根目录" --output "报告路径"
        生成审核报告并保存到指定路径

配置文件路径：
    _common/rd_ip_ps_matching_config.json（基于 __file__ 推断，向上6级回退查找）

main 函数返回 JSON 格式结果：
    {"matched": N, "idle_ip": N, "passed": bool, "errors": [...]}
"""

import json
import os
import re
import argparse
import glob
from datetime import datetime


def _load_matching_config(config_path=None):
    """加载RD-IP-PS匹配配置（v1.12.0新增）"""
    if config_path is None:
        candidates = [
            os.path.join(os.path.dirname(os.path.abspath(__file__)), 'rd_ip_ps_matching_config.json'),
        ]
        cur = os.getcwd()
        for _ in range(6):
            candidates.append(os.path.join(cur, '.trae', 'skills', '_common', 'rd_ip_ps_matching_config.json'))
            cur = os.path.dirname(cur)
        for c in candidates:
            if os.path.exists(c):
                config_path = c
                break
    with open(config_path, 'r', encoding='utf-8') as f:
        return json.load(f)


def _extract_year(value):
    """从字符串中提取4位年份（如 2023）"""
    if value is None:
        return None
    m = re.search(r'(19|20)\d{2}', str(value))
    return int(m.group(0)) if m else None


def _classify_domain(name, config):
    """根据名称中包含的领域关键词分类（幕墙/门窗/通用）"""
    dom = config['domain_classification']
    scores = {'curtain_wall': 0, 'window_door': 0, 'general': 0}
    for key in scores:
        for kw in dom[key]['keywords']:
            if kw in name:
                scores[key] += 1
    best = max(scores, key=scores.get)
    return 'window_door' if scores[best] == 0 else best


def _tokenize(name):
    """从名称中提取关键词集合（用于关键词重叠度打分）"""
    keywords = ['铝合金', '门窗', '推拉', '平开', '纱窗', '纱扇', '铰链', '中梃', '压条', '压线',
                '锁', '自锁', '排水', '密封', '隔热', '隔音', '保温', '断桥', '外开', '幕墙',
                '蜂窝', '立柱', '遮阳', '型材', '防雷', '护板', '护栏', '天窗', '防蚊', '呼吸',
                '垫块', '卡件', '防脱', '防撞', '复合', '木塑', '监测', '玻璃', '栏杆', '折叠',
                '提升', '转角', '拐角', '模块', '磁悬浮', '物联网', '单片机', '窗体', '门', '窗']
    return set(kw for kw in keywords if kw in name)


def _is_invention(ip_type, config):
    """判断IP类型是否为发明专利（豁免时间相近约束）"""
    inv = config['matching_rules']['invention_exception']['invention_types']
    return any(t in str(ip_type) for t in inv)


def autonomous_match_rd_ip_ps(rd_list, ps_list, ip_list, config_path=None):
    """自主确定性RD-IP-PS匹配算法（v1.12.0新增，主匹配器）

    实现4条匹配规则，保证：所有IP必须匹配不闲置、非发明专利RD不晚于IP、发明专利豁免时间约束。

    Args:
        rd_list: [{'id','name','year'}]
        ps_list: [{'id','name','scope'}]
        ip_list: [{'id','name','application_date','type'}]
    Returns:
        dict: assignment(每RD的ips/ps/domain) + stats + ip_assign_log + idle_fallback + time_violations
    """
    config = _load_matching_config(config_path)
    weights = config['scoring_weights']
    rules = config['matching_rules']
    proximity_window = rules['time_constraint']['proximity_window_years']

    rd_enriched = [{
        'id': rd['id'], 'name': rd['name'], 'year': _extract_year(rd.get('year')),
        'domain': _classify_domain(rd['name'], config), 'tokens': _tokenize(rd['name']),
    } for rd in rd_list]

    ip_enriched = [{
        'id': ip['id'], 'name': ip['name'], 'year': _extract_year(ip.get('application_date')),
        'type': ip.get('type', ''), 'domain': _classify_domain(ip['name'], config),
        'tokens': _tokenize(ip['name']), 'is_invention': _is_invention(ip.get('type', ''), config),
    } for ip in ip_list]

    ps_by_domain = {}
    for ps in ps_list:
        scope = ps.get('scope', '')
        if '幕墙' in scope:
            ps_by_domain['curtain_wall'] = ps['id']
        elif '门窗' in scope or '门' in scope or '窗' in scope:
            ps_by_domain['window_door'] = ps['id']

    def score(rd, ip):
        s, detail = 0.0, {}
        if rd['domain'] == ip['domain']:
            s += weights['domain_match']; detail['domain'] = weights['domain_match']
        elif ip['domain'] == 'general':
            s += weights['domain_match'] * 0.5; detail['domain'] = weights['domain_match'] * 0.5
        overlap = len(rd['tokens'] & ip['tokens'])
        union = len(rd['tokens'] | ip['tokens']) or 1
        kw_score = weights['keyword_overlap'] * (overlap / union)
        s += kw_score; detail['keyword'] = round(kw_score, 1)
        time_ok = True
        if rd['year'] and ip['year']:
            if ip['is_invention']:
                s += weights['invention_tech_basis_bonus']
                detail['invention_bonus'] = weights['invention_tech_basis_bonus']
                gap = abs(rd['year'] - ip['year'])
                s += weights['time_proximity'] * max(0, 1 - gap / 10.0)
            else:
                if rd['year'] > ip['year']:
                    time_ok = False; detail['time_violation'] = f"RD{rd['year']}>IP{ip['year']}"
                else:
                    gap = ip['year'] - rd['year']
                    if gap <= proximity_window:
                        tp = weights['time_proximity'] * (1 - gap / (proximity_window + 1.0))
                    else:
                        tp = weights['time_proximity'] * 0.3 / (gap - proximity_window + 1)
                    s += tp; detail['time_proximity'] = round(tp, 1)
        return s, time_ok, detail

    assignment = {rd['id']: {'ips': [], 'ps': ps_by_domain.get(rd['domain'], ps_by_domain.get('window_door', '')),
                             'domain': rd['domain']} for rd in rd_enriched}
    ip_assign_log, idle_fallback, time_violations = [], [], []

    for ip in ip_enriched:
        candidates = []
        for rd in rd_enriched:
            sc, time_ok, detail = score(rd, ip)
            if not ip['is_invention'] and not time_ok:
                continue
            candidates.append((sc, rd['id'], detail))
        candidates.sort(reverse=True)
        assigned = False
        if candidates and candidates[0][0] >= weights['min_score_threshold']:
            best = candidates[0]
            assignment[best[1]]['ips'].append(ip['id'])
            ip_assign_log.append({'ip': ip['id'], 'rd': best[1], 'score': round(best[0], 1), 'method': 'primary'})
            assigned = True
        if not assigned:
            all_cands = []
            for rd in rd_enriched:
                sc, time_ok, detail = score(rd, ip)
                all_cands.append((sc + (0 if time_ok else -1000), rd['id'], time_ok))
            all_cands.sort(reverse=True)
            if all_cands:
                best = all_cands[0]
                assignment[best[1]]['ips'].append(ip['id'])
                idle_fallback.append({'ip': ip['id'], 'rd': best[1], 'reason': '未达主匹配阈值，兜底分配到最相近RD'})
                ip_assign_log.append({'ip': ip['id'], 'rd': best[1], 'method': 'fallback'})
                if not best[2]:
                    time_violations.append({'ip': ip['id'], 'rd': best[1], 'note': '兜底分配存在时间约束违规，需人工复核'})

    all_assigned = set()
    for a in assignment.values():
        all_assigned.update(a['ips'])
    idle_ips = [ip['id'] for ip in ip_enriched if ip['id'] not in all_assigned]
    rd_without_ip = [rid for rid, a in assignment.items() if not a['ips']]

    return {
        'assignment': assignment,
        'stats': {
            'total_rd': len(rd_list), 'total_ip': len(ip_list), 'total_ps': len(ps_list),
            'matched_rd': sum(1 for a in assignment.values() if a['ips']),
            'matched_ip': len(all_assigned), 'idle_ip_count': len(idle_ips), 'idle_ips': idle_ips,
            'rd_without_ip': rd_without_ip, 'fallback_count': len(idle_fallback),
            'time_violation_count': len(time_violations),
        },
        'ip_assign_log': ip_assign_log, 'idle_fallback': idle_fallback, 'time_violations': time_violations,
    }


def call_matching_workflow_cross_check(rd_list, ps_list, ip_list, config_path=None):
    """调用Dify匹配工作流做交叉参考（v1.12.0新增）

    仅用于与自主算法结果对比，不作为主匹配来源。
    Returns: dict {success, workflow_assignment, download_url, error}
    """
    import requests
    config = _load_matching_config(config_path)
    api = config['workflow_api']
    headers = {'Authorization': 'Bearer ' + api['api_key'], 'Content-Type': 'application/json'}
    input_data = {'RD_list': rd_list, 'PS_list': ps_list, 'IP_list': ip_list}
    payload = {'inputs': {api['input_variable']: json.dumps(input_data, ensure_ascii=False)},
               'response_mode': api.get('response_mode', 'streaming'), 'user': api.get('user_id', 'trae-agent')}
    result = {'success': False, 'workflow_assignment': {}, 'download_url': '', 'raw_report': '', 'error': ''}
    try:
        r = requests.post(api['base_url'] + '/workflows/run', headers=headers, json=payload,
                          stream=True, timeout=api.get('timeout_seconds', 900))
        if r.status_code != 200:
            result['error'] = f'工作流返回{r.status_code}: {r.text[:300]}'
            return result
        outputs = {}
        for line in r.iter_lines(decode_unicode=True):
            if line and line.startswith('data: '):
                try:
                    data = json.loads(line[6:])
                    if data.get('event') == 'workflow_finished':
                        outputs = data.get('data', {}).get('outputs', {}) or {}
                except json.JSONDecodeError:
                    pass
        result['download_url'] = outputs.get('download_url', '')
        result['raw_report'] = outputs.get('final_report', '')
        result['success'] = True
    except Exception as e:
        result['error'] = f'工作流调用异常: {str(e)}'
    return result


def generate_matching_audit_report(match_result, workflow_cross=None, config_path=None):
    """生成RD-IP-PS匹配审核报告（v1.12.0新增）

    包含：匹配概览/RD-IP-PS明细/闲置IP兜底记录/时间约束违规/工作流交叉参考差异/人工复核建议
    Returns: str markdown报告
    """
    config = _load_matching_config(config_path)
    stats = match_result['stats']
    lines = ['# RD-IP-PS 匹配审核报告', '',
             f"生成时间：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}", '',
             '## 一、匹配概览', '',
             f"- RD总数：{stats['total_rd']}　PS总数：{stats['total_ps']}　IP总数：{stats['total_ip']}",
             f"- 已匹配RD：{stats['matched_rd']}　已匹配IP：{stats['matched_ip']}/{stats['total_ip']}",
             f"- 闲置IP数：{stats['idle_ip_count']}（要求为0）",
             f"- 兜底分配数：{stats['fallback_count']}　时间约束违规数：{stats['time_violation_count']}", '',
             '## 二、RD-IP-PS 匹配明细', '']
    for rid, a in match_result['assignment'].items():
        ips = '、'.join(a['ips']) if a['ips'] else '（无）'
        lines.append(f"- {rid} [{a['domain']}] → PS: {a['ps']}　IP: {ips}")
    lines += ['', '## 三、闲置IP兜底记录', '']
    if match_result['idle_fallback']:
        for f in match_result['idle_fallback']:
            lines.append(f"- {f['ip']} → {f['rd']}：{f['reason']}")
    else:
        lines.append('- 无（所有IP均通过主匹配分配）')
    lines += ['', '## 四、时间约束违规', '']
    if match_result['time_violations']:
        for v in match_result['time_violations']:
            lines.append(f"- ⚠️ {v['ip']} → {v['rd']}：{v['note']}")
    else:
        lines.append('- 无')
    lines += ['', '## 五、工作流交叉参考差异', '']
    if workflow_cross and workflow_cross.get('success'):
        lines.append(f"- 工作流下载链接：{workflow_cross.get('download_url', '（无）')}")
        lines.append('- ⚠️ 注意：实测工作流IP匹配节点可能返回空结果，以本报告的自主匹配为准')
    else:
        err = workflow_cross.get('error', '未调用') if workflow_cross else '未调用'
        lines.append(f"- 工作流交叉参考未生效：{err}（不影响自主匹配结果）")
    lines += ['', '## 六、人工复核建议', '']
    if stats['idle_ip_count'] > 0:
        lines.append(f"- ❌ 存在{stats['idle_ip_count']}个闲置IP，违反'所有IP必须匹配'规则，需人工分配")
    if stats['rd_without_ip']:
        lines.append(f"- ⚠️ 以下RD未关联IP，请复核是否需补充：{('、'.join(stats['rd_without_ip']))}")
    if stats['fallback_count'] > 0:
        lines.append(f"- ⚠️ {stats['fallback_count']}个IP为兜底分配（技术相关性较弱），建议人工确认合理性")
    if stats['idle_ip_count'] == 0 and not stats['time_violations']:
        lines.append('- ✅ 硬性规则全部通过：无闲置IP、无时间约束违规')
    return '\n'.join(lines)


def match_rd_ip_ps_with_audit(rd_list, ps_list, ip_list, use_workflow_cross_check=True, config_path=None):
    """RD-IP-PS匹配主入口（v1.12.0新增）

    自主算法为主 + 工作流交叉参考 + 审核报告。
    Returns: dict {match_result, workflow_cross, audit_report}
    """
    match_result = autonomous_match_rd_ip_ps(rd_list, ps_list, ip_list, config_path)
    workflow_cross = None
    if use_workflow_cross_check:
        try:
            workflow_cross = call_matching_workflow_cross_check(rd_list, ps_list, ip_list, config_path)
        except Exception as e:
            workflow_cross = {'success': False, 'error': str(e)}
    audit_report = generate_matching_audit_report(match_result, workflow_cross, config_path)
    return {'match_result': match_result, 'workflow_cross': workflow_cross, 'audit_report': audit_report}


# ==================== CLI 辅助函数 ====================

def _load_rd_ps_ip_data(project_root):
    """从项目根目录加载RD/PS/IP数据

    按以下优先级查找数据文件：
        1. {project_root}/.trae/project_knowledge/rd_ps_ip_data.json （标准化数据文件）
        2. {project_root}/**/TO-AI*.json （TO-AI汇总表格JSON）
        3. {project_root}/**/RD-PS-IP*.json （RD-PS-IP关联汇总表JSON）
        4. {project_root}/**/rd_ps_ip*.json （小写命名）

    数据文件JSON结构（参考 rd_ip_ps_matching_config.json 的 input_schema）：
        {
            "RD_list": [{"id","name","year"}, ...],
            "PS_list": [{"id","name","scope"}, ...],
            "IP_list": [{"id","name","application_date","type"}, ...]
        }

    Args:
        project_root: 项目根目录

    Returns:
        dict: {'success': bool, 'rd_list': list, 'ps_list': list, 'ip_list': list,
               'data_source': str, 'error': str}
    """
    result = {'success': False, 'rd_list': [], 'ps_list': [], 'ip_list': [],
              'data_source': '', 'error': ''}

    # 候选数据文件模式（按优先级）
    candidate_patterns = [
        os.path.join(project_root, '.trae', 'project_knowledge', 'rd_ps_ip_data.json'),
        os.path.join(project_root, '.trae', 'project_knowledge', 'to_ai_summary.json'),
    ]
    # 递归查找的glob模式
    glob_patterns = [
        os.path.join(project_root, '**', 'TO-AI*.json'),
        os.path.join(project_root, '**', 'RD-PS-IP*.json'),
        os.path.join(project_root, '**', 'rd_ps_ip*.json'),
        os.path.join(project_root, '**', 'to-ai*.json'),
    ]

    data_path = None
    # 1. 检查固定路径候选
    for candidate in candidate_patterns:
        if os.path.exists(candidate):
            data_path = candidate
            break

    # 2. 递归glob查找
    if data_path is None:
        for pattern in glob_patterns:
            matches = glob.glob(pattern, recursive=True)
            if matches:
                # 排除明显非数据文件（如配置文件）
                for m in matches:
                    if 'config' not in os.path.basename(m).lower():
                        data_path = m
                        break
                if data_path:
                    break

    if data_path is None:
        result['error'] = (f'在项目根目录 {project_root} 下未找到RD/PS/IP数据文件。'
                           f'请先准备包含 RD_list/PS_list/IP_list 字段的JSON数据文件，'
                           f'推荐路径：{os.path.join(project_root, ".trae", "project_knowledge", "rd_ps_ip_data.json")}')
        return result

    try:
        with open(data_path, 'r', encoding='utf-8') as f:
            data = json.load(f)

        # 兼容多种字段命名
        rd_list = data.get('RD_list') or data.get('rd_list') or data.get('RDs') or []
        ps_list = data.get('PS_list') or data.get('ps_list') or data.get('PSs') or []
        ip_list = data.get('IP_list') or data.get('ip_list') or data.get('IPs') or []

        # 兼容IP字段命名（application_date / apply_date）
        for ip in ip_list:
            if 'application_date' not in ip and 'apply_date' in ip:
                ip['application_date'] = ip['apply_date']

        result['rd_list'] = rd_list
        result['ps_list'] = ps_list
        result['ip_list'] = ip_list
        result['data_source'] = data_path
        result['success'] = True

        if not rd_list and not ip_list:
            result['success'] = False
            result['error'] = f'数据文件 {data_path} 中 RD_list/IP_list 均为空'

    except Exception as e:
        result['error'] = f'读取数据文件失败 {data_path}: {str(e)}'

    return result


# ==================== CLI 入口 ====================

def main():
    """CLI 主入口

    使用 argparse 解析命令行参数，支持以下子命令：
        match  : 执行RD-IP-PS匹配（自主算法为主，工作流交叉参考）
        audit  : 审核匹配结果（生成审核报告到stdout）
        report : 生成审核报告并保存到指定路径

    所有命令均以 JSON 格式输出结果到 stdout，格式：
        {"matched": N, "idle_ip": N, "passed": bool, "errors": [...]}

    Returns:
        dict: 命令执行结果（JSON格式）
    """
    parser = argparse.ArgumentParser(
        prog='rd_ip_ps_matching',
        description='RD-IP-PS 自主匹配与审核模块（模块十一）：自主确定性匹配算法为主+工作流交叉参考+审核报告',
    )
    sub_parsers = parser.add_subparsers(dest='command', help='子命令')

    # match 子命令
    p_match = sub_parsers.add_parser('match', help='执行RD-IP-PS匹配（自主算法为主，工作流交叉参考）')
    p_match.add_argument('--project-root', required=True, help='项目根目录（包含RD/PS/IP数据文件）')
    p_match.add_argument('--config', default=None, help='匹配配置文件路径（默认自动查找 rd_ip_ps_matching_config.json）')
    p_match.add_argument('--no-workflow', action='store_true', help='禁用工作流交叉参考（仅运行自主算法）')

    # audit 子命令
    p_audit = sub_parsers.add_parser('audit', help='审核匹配结果（输出审核报告）')
    p_audit.add_argument('--project-root', required=True, help='项目根目录')
    p_audit.add_argument('--config', default=None, help='匹配配置文件路径')
    p_audit.add_argument('--no-workflow', action='store_true', help='禁用工作流交叉参考')

    # report 子命令
    p_report = sub_parsers.add_parser('report', help='生成审核报告并保存到指定路径')
    p_report.add_argument('--project-root', required=True, help='项目根目录')
    p_report.add_argument('--output', required=True, help='报告输出路径（如 /path/to/audit_report.md）')
    p_report.add_argument('--config', default=None, help='匹配配置文件路径')
    p_report.add_argument('--no-workflow', action='store_true', help='禁用工作流交叉参考')

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        return {'matched': 0, 'idle_ip': 0, 'passed': False, 'errors': ['未指定子命令']}

    output = {'matched': 0, 'idle_ip': 0, 'passed': False, 'errors': [], 'command': args.command}

    try:
        # 加载RD/PS/IP数据
        data_result = _load_rd_ps_ip_data(args.project_root)
        if not data_result['success']:
            output['errors'].append(data_result['error'])
            print(json.dumps(output, ensure_ascii=False, indent=2))
            return output

        rd_list = data_result['rd_list']
        ps_list = data_result['ps_list']
        ip_list = data_result['ip_list']
        output['data_source'] = data_result['data_source']
        output['total_rd'] = len(rd_list)
        output['total_ps'] = len(ps_list)
        output['total_ip'] = len(ip_list)

        use_workflow = not args.no_workflow

        if args.command == 'match':
            # 执行匹配
            match_result = autonomous_match_rd_ip_ps(rd_list, ps_list, ip_list, args.config)
            stats = match_result['stats']
            output['matched'] = stats['matched_ip']
            output['idle_ip'] = stats['idle_ip_count']
            output['matched_rd'] = stats['matched_rd']
            output['fallback_count'] = stats['fallback_count']
            output['time_violation_count'] = stats['time_violation_count']
            output['assignment'] = match_result['assignment']
            output['idle_ips'] = stats['idle_ips']
            output['rd_without_ip'] = stats['rd_without_ip']
            # 通过条件：无闲置IP且无时间违规
            output['passed'] = (stats['idle_ip_count'] == 0 and stats['time_violation_count'] == 0)

        elif args.command == 'audit':
            # 执行匹配+审核
            full_result = match_rd_ip_ps_with_audit(rd_list, ps_list, ip_list,
                                                    use_workflow_cross_check=use_workflow,
                                                    config_path=args.config)
            match_result = full_result['match_result']
            stats = match_result['stats']
            output['matched'] = stats['matched_ip']
            output['idle_ip'] = stats['idle_ip_count']
            output['matched_rd'] = stats['matched_rd']
            output['fallback_count'] = stats['fallback_count']
            output['time_violation_count'] = stats['time_violation_count']
            output['assignment'] = match_result['assignment']
            output['idle_ips'] = stats['idle_ips']
            output['rd_without_ip'] = stats['rd_without_ip']
            output['audit_report'] = full_result['audit_report']
            output['workflow_cross'] = {
                'success': full_result['workflow_cross'].get('success', False) if full_result.get('workflow_cross') else False,
                'error': full_result['workflow_cross'].get('error', '') if full_result.get('workflow_cross') else '未调用',
            }
            # 通过条件：无闲置IP且无时间违规
            output['passed'] = (stats['idle_ip_count'] == 0 and stats['time_violation_count'] == 0)

        elif args.command == 'report':
            # 生成报告并保存
            full_result = match_rd_ip_ps_with_audit(rd_list, ps_list, ip_list,
                                                    use_workflow_cross_check=use_workflow,
                                                    config_path=args.config)
            match_result = full_result['match_result']
            stats = match_result['stats']
            output['matched'] = stats['matched_ip']
            output['idle_ip'] = stats['idle_ip_count']
            output['matched_rd'] = stats['matched_rd']
            output['fallback_count'] = stats['fallback_count']
            output['time_violation_count'] = stats['time_violation_count']
            output['idle_ips'] = stats['idle_ips']
            output['rd_without_ip'] = stats['rd_without_ip']
            output['audit_report'] = full_result['audit_report']
            output['workflow_cross'] = {
                'success': full_result['workflow_cross'].get('success', False) if full_result.get('workflow_cross') else False,
                'error': full_result['workflow_cross'].get('error', '') if full_result.get('workflow_cross') else '未调用',
            }
            output['passed'] = (stats['idle_ip_count'] == 0 and stats['time_violation_count'] == 0)

            # 写入报告文件
            report_path = os.path.abspath(args.output)
            try:
                os.makedirs(os.path.dirname(report_path), exist_ok=True) if os.path.dirname(report_path) else None
                with open(report_path, 'w', encoding='utf-8') as f:
                    f.write(full_result['audit_report'])
                output['report_path'] = report_path
            except Exception as e:
                output['errors'].append(f'写入报告文件失败: {str(e)}')

    except Exception as e:
        output['errors'].append(f'执行异常: {str(e)}')

    # 输出JSON格式结果
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return output


if __name__ == '__main__':
    main()
