"""Dify工作流集成模块（模块十）

本模块为Dify工作流平台的集成适配层，支持通过Dify工作流生成RD立项书等文档。

核心设计原则：动态适配层
    工作流应用可能随时更新（输入变量变化、参数调整），因此本模块实现动态适配：
    1. 每次执行前先调 GET /parameters 获取最新的输入变量定义
    2. 根据映射规则（match_by label/variable/hint + match_keywords）将本地文件匹配到工作流变量
    3. 动态获取失败时回退到 dify_config.json 中的 static_variables
    4. 输出字段也通过 auto_discover 策略动态解析（known_output_fields 列出多个候选字段名）

配置文件：
    _common/dify_config.json（包含API配置、variable_mapping映射规则、
    output_mapping输出解析规则、local_files本地文件查找规则、qc质量校验配置）
    工作流更新时只需更新 dify_config.json 中的映射规则，无需修改本脚本。

CLI 用法：
    python dify_workflow.py test-connection --workflow "工作流名称"
        测试Dify工作流连接（API可达性、变量映射情况）

    python dify_workflow.py fetch-params --workflow "工作流名称"
        获取工作流输入参数定义

    python dify_workflow.py run --workflow "工作流名称" --inputs '{"key":"value"}'
        执行工作流（inputs为JSON字符串）

    python dify_workflow.py rd-report --enterprise "企业名称" --count N
        通过Dify工作流生成RD立项书（N为生成数量，用于定位项目根目录）

配置文件路径：
    _common/dify_config.json（基于 __file__ 推断，向上5级回退查找）
    _common/rd_ip_ps_matching_config.json（基于 __file__ 推断，向上6级回退查找）
"""

import os
import json
import time
import argparse
import requests
from datetime import datetime

# 配置文件路径（本脚本位于 _common 目录下，配置文件同目录）
DIFY_CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'dify_config.json')


def load_dify_config():
    """加载Dify工作流配置（v1.11.0新增）

    从独立JSON配置文件读取API配置和变量映射规则。
    配置文件可在不修改技能代码的情况下适配工作流更新。

    Returns:
        dict: Dify配置
    """
    config_path = DIFY_CONFIG_PATH
    if not os.path.exists(config_path):
        current_dir = os.getcwd()
        for _ in range(5):
            candidate = os.path.join(current_dir, '.trae', 'skills', '_common', 'dify_config.json')
            if os.path.exists(candidate):
                config_path = candidate
                break
            current_dir = os.path.dirname(current_dir)

    with open(config_path, 'r', encoding='utf-8') as f:
        return json.load(f)


def fetch_workflow_parameters(config=None):
    """动态获取工作流输入参数定义（v1.11.0新增，适配层核心）

    每次执行前调GET /parameters获取工作流实际的输入变量定义，
    用于动态适配工作流更新（变量增删改、类型变化等）。

    Args:
        config: Dify配置（可选，默认自动加载）

    Returns:
        dict: {
            'success': bool,
            'variables': list,  # 工作流输入变量列表
            'file_upload_config': dict,  # 文件上传配置
            'system_parameters': dict,  # 系统参数
            'app_info': dict,  # 应用基本信息
            'error': str,  # 失败原因
        }
    """
    if config is None:
        config = load_dify_config()

    api_config = config.get('api', {})
    base_url = api_config.get('base_url', '')
    api_key = api_config.get('api_key', '')
    timeout = api_config.get('timeout_seconds', 30)

    headers = {'Authorization': f'Bearer {api_key}'}

    result = {
        'success': False,
        'variables': [],
        'file_upload_config': {},
        'system_parameters': {},
        'app_info': {},
        'error': '',
    }

    try:
        # 并行获取应用信息+参数
        info_resp = requests.get(f'{base_url}/info', headers=headers, timeout=timeout)
        params_resp = requests.get(f'{base_url}/parameters', headers=headers, timeout=timeout)

        if info_resp.status_code == 200:
            result['app_info'] = info_resp.json()

        if params_resp.status_code == 200:
            params = params_resp.json()
            result['file_upload_config'] = params.get('file_upload', {})
            result['system_parameters'] = params.get('system_parameters', {})

            # 解析用户输入表单
            user_input_form = params.get('user_input_form', [])
            for item in user_input_form:
                for var_type, var_def in item.items():
                    var_def['type'] = var_type
                    result['variables'].append(var_def)

            result['success'] = True
        else:
            result['error'] = f'GET /parameters返回{params_resp.status_code}: {params_resp.text[:200]}'
    except Exception as e:
        result['error'] = f'获取参数失败: {str(e)}'

    return result


def match_local_files_to_variables(local_files, workflow_variables, config=None):
    """将本地文件匹配到工作流变量（v1.11.0新增，适配层核心）

    根据dify_config.json中的映射规则，将本地文件匹配到工作流输入变量。
    匹配规则：通过label/variable/hint字段的关键词匹配。

    Args:
        local_files: dict 本地文件 {local_file_key: file_path}
        workflow_variables: list 工作流变量定义（来自fetch_workflow_parameters）
        config: Dify配置

    Returns:
        dict: {
            'matched': dict,  # {variable_name: {upload_file_id, type, transfer_method}}
            'unmatched_local': list,  # 未匹配的本地文件
            'unmatched_remote': list,  # 未匹配的工作流变量
            'missing_required': list,  # 缺失的必填变量
        }
    """
    if config is None:
        config = load_dify_config()

    mapping_config = config.get('variable_mapping', {})
    match_rules = mapping_config.get('match_rules', [])

    # 构建match_rules索引
    rules_by_key = {rule['local_file_key']: rule for rule in match_rules}

    matched = {}
    unmatched_local = []

    for local_key, file_path in local_files.items():
        rule = rules_by_key.get(local_key)
        if not rule:
            unmatched_local.append({'local_key': local_key, 'file_path': file_path, 'reason': '无映射规则'})
            continue

        # 在工作流变量中查找匹配
        match_keywords = rule.get('match_keywords', [])
        match_by = rule.get('match_by', ['label', 'variable', 'hint'])

        found_match = None
        for var in workflow_variables:
            for field in match_by:
                field_value = str(var.get(field, '')).upper()
                for keyword in match_keywords:
                    if keyword.upper() in field_value:
                        found_match = var
                        break
                if found_match:
                    break
            if found_match:
                break

        if found_match:
            matched[found_match['variable']] = {
                'local_file_key': local_key,
                'file_path': file_path,
                'variable_name': found_match['variable'],
                'type': found_match.get('type', 'file-list'),
                'required': found_match.get('required', False),
                'matched_by': rule.get('match_by'),
                'matched_keyword': next((kw for kw in match_keywords if kw.upper() in str(found_match).upper()), ''),
            }
        else:
            unmatched_local.append({
                'local_key': local_key,
                'file_path': file_path,
                'reason': f'未找到匹配的工作流变量（关键词: {match_keywords}）'
            })

    # 检查必填变量是否都匹配
    unmatched_remote = []
    missing_required = []
    for var in workflow_variables:
        if var.get('variable') not in matched:
            unmatched_remote.append(var)
            if var.get('required', False):
                missing_required.append(var)

    return {
        'matched': matched,
        'unmatched_local': unmatched_local,
        'unmatched_remote': unmatched_remote,
        'missing_required': missing_required,
    }


def upload_file_to_dify(file_path, user_id, config=None):
    """上传文件到Dify工作流平台（v1.11.0新增）

    Args:
        file_path: 本地文件路径
        user_id: 用户标识
        config: Dify配置

    Returns:
        dict: {
            'success': bool,
            'upload_file_id': str,  # 上传后的文件ID
            'file_info': dict,  # 文件信息
            'error': str,
        }
    """
    if config is None:
        config = load_dify_config()

    api_config = config.get('api', {})
    base_url = api_config.get('base_url', '')
    api_key = api_config.get('api_key', '')
    timeout = api_config.get('timeout_seconds', 30)

    headers = {'Authorization': f'Bearer {api_key}'}

    if not os.path.exists(file_path):
        return {'success': False, 'upload_file_id': '', 'file_info': {}, 'error': f'文件不存在: {file_path}'}

    file_name = os.path.basename(file_path)
    file_ext = os.path.splitext(file_name)[1].lower()

    # 根据扩展名确定mime_type
    mime_map = {
        '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '.xls': 'application/vnd.ms-excel',
        '.pdf': 'application/pdf',
        '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.doc': 'application/msword',
        '.txt': 'text/plain',
        '.csv': 'text/csv',
        '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    }
    mime_type = mime_map.get(file_ext, 'application/octet-stream')

    try:
        with open(file_path, 'rb') as f:
            files = {'file': (file_name, f, mime_type)}
            data = {'user': user_id}
            resp = requests.post(f'{base_url}/files/upload', headers=headers, files=files, data=data, timeout=timeout)

        if resp.status_code in (200, 201):
            result = resp.json()
            return {
                'success': True,
                'upload_file_id': result.get('id', ''),
                'file_info': result,
                'error': '',
            }
        else:
            return {
                'success': False,
                'upload_file_id': '',
                'file_info': {},
                'error': f'上传失败{resp.status_code}: {resp.text[:200]}',
            }
    except Exception as e:
        return {
            'success': False,
            'upload_file_id': '',
            'file_info': {},
            'error': f'上传异常: {str(e)}',
        }


def run_dify_workflow(inputs, user_id, config=None, response_mode='streaming', on_text_chunk=None):
    """执行Dify工作流（v1.11.0新增，支持流式接收）

    Args:
        inputs: dict 工作流输入变量值
        user_id: 用户标识
        config: Dify配置
        response_mode: 响应模式（streaming/blocking）
        on_text_chunk: callback函数，每收到text_chunk事件调用 on_text_chunk(text)

    Returns:
        dict: {
            'success': bool,
            'workflow_run_id': str,
            'task_id': str,
            'status': str,  # succeeded/failed/stopped/paused
            'outputs': dict,  # 工作流输出
            'elapsed_time': float,
            'total_tokens': int,
            'output_text': str,  # 累积的text_chunk文本
            'doc_urls': list,  # 生成的文档下载URL列表
            'qc_passed': bool,  # QC是否通过
            'qc_summaries': list,  # QC详细
            'error': str,
        }
    """
    if config is None:
        config = load_dify_config()

    api_config = config.get('api', {})
    base_url = api_config.get('base_url', '')
    api_key = api_config.get('api_key', '')
    timeout = api_config.get('timeout_seconds', 600)

    headers = {
        'Authorization': f'Bearer {api_key}',
        'Content-Type': 'application/json',
    }

    payload = {
        'inputs': inputs,
        'response_mode': response_mode,
        'user': user_id,
    }

    result = {
        'success': False,
        'workflow_run_id': '',
        'task_id': '',
        'status': '',
        'outputs': {},
        'elapsed_time': 0,
        'total_tokens': 0,
        'output_text': '',
        'doc_urls': [],
        'qc_passed': False,
        'qc_summaries': [],
        'error': '',
    }

    try:
        if response_mode == 'streaming':
            resp = requests.post(f'{base_url}/workflows/run', headers=headers, json=payload, stream=True, timeout=timeout)

            if resp.status_code != 200:
                result['error'] = f'执行失败{resp.status_code}: {resp.text[:500]}'
                return result

            for line in resp.iter_lines(decode_unicode=True):
                if not line or not line.startswith('data: '):
                    continue

                try:
                    data = json.loads(line[6:])
                    event = data.get('event', '')

                    if event == 'workflow_started':
                        result['workflow_run_id'] = data.get('workflow_run_id', '')
                        result['task_id'] = data.get('task_id', '')

                    elif event == 'node_finished':
                        node_data = data.get('data', {})
                        if node_data.get('status') == 'failed':
                            result['error'] = f'节点{node_data.get("title")}失败: {node_data.get("error", "")}'

                    elif event == 'text_chunk':
                        text = data.get('data', {}).get('text', '')
                        result['output_text'] += text
                        if on_text_chunk:
                            on_text_chunk(text)

                    elif event == 'workflow_finished':
                        data2 = data.get('data', {})
                        result['status'] = data2.get('status', '')
                        result['outputs'] = data2.get('outputs', {}) or {}
                        result['elapsed_time'] = data2.get('elapsed_time', 0)
                        result['total_tokens'] = data2.get('total_tokens', 0)
                        result['success'] = result['status'] == 'succeeded'

                        # 动态解析输出字段
                        output_mapping = config.get('output_mapping', {})
                        known_fields = output_mapping.get('known_output_fields', {})

                        # 解析文档URL
                        doc_url_fields = known_fields.get('doc_urls_field', ['rd_doc_urls', 'doc_urls'])
                        for field in doc_url_fields:
                            if field in result['outputs']:
                                urls = result['outputs'][field]
                                if isinstance(urls, list):
                                    result['doc_urls'] = urls
                                elif isinstance(urls, str):
                                    result['doc_urls'] = [urls]
                                break

                        # 解析QC结果
                        qc_fields = known_fields.get('qc_field', ['qc_passed', 'rd_qc_summaries'])
                        for field in qc_fields:
                            if field in result['outputs']:
                                val = result['outputs'][field]
                                if isinstance(val, bool):
                                    result['qc_passed'] = val
                                elif isinstance(val, list):
                                    result['qc_summaries'] = val
                                elif isinstance(val, dict):
                                    result['qc_summaries'] = [val]
                                break

                        # 补充QC摘要
                        for field in qc_fields:
                            if field in result['outputs'] and isinstance(result['outputs'][field], (list, dict)):
                                if isinstance(result['outputs'][field], list):
                                    result['qc_summaries'] = result['outputs'][field]
                                else:
                                    result['qc_summaries'] = [result['outputs'][field]]
                                break

                    elif event == 'human_input_required':
                        result['status'] = 'paused'
                        result['error'] = '工作流暂停，等待人工输入'
                        result['outputs'] = data.get('data', {})
                        break

                    elif event == 'error':
                        result['error'] = f'工作流错误: {json.dumps(data, ensure_ascii=False)[:500]}'
                        break

                except json.JSONDecodeError:
                    continue

        else:  # blocking
            resp = requests.post(f'{base_url}/workflows/run', headers=headers, json=payload, timeout=timeout)
            if resp.status_code == 200:
                data = resp.json()
                result['workflow_run_id'] = data.get('workflow_run_id', '')
                result['task_id'] = data.get('task_id', '')
                data2 = data.get('data', {})
                result['status'] = data2.get('status', '')
                result['outputs'] = data2.get('outputs', {}) or {}
                result['success'] = result['status'] == 'succeeded'
            else:
                result['error'] = f'执行失败{resp.status_code}: {resp.text[:500]}'

    except Exception as e:
        result['error'] = f'执行异常: {str(e)}'

    return result


def download_generated_doc(doc_url_or_path, save_path, config=None):
    """下载工作流生成的文档（v1.11.0新增）

    Args:
        doc_url_or_path: 文档URL或路径（可以是完整URL或/api/v1/files/download?path=xxx）
        save_path: 本地保存路径
        config: Dify配置

    Returns:
        dict: {
            'success': bool,
            'save_path': str,
            'file_size': int,
            'error': str,
        }
    """
    if config is None:
        config = load_dify_config()

    api_config = config.get('api', {})
    base_url = api_config.get('base_url', '')
    download_base = config.get('output_mapping', {}).get('doc_download_url_prefix', base_url)
    api_key = api_config.get('api_key', '')
    timeout = api_config.get('timeout_seconds', 60)

    headers = {'Authorization': f'Bearer {api_key}'}

    # 构造完整URL
    if doc_url_or_path.startswith('http'):
        url = doc_url_or_path
    elif doc_url_or_path.startswith('/api/'):
        url = download_base + doc_url_or_path
    else:
        url = download_base + '/api/v1/files/download?path=' + doc_url_or_path

    try:
        resp = requests.get(url, headers=headers, timeout=timeout)
        if resp.status_code == 200:
            os.makedirs(os.path.dirname(save_path), exist_ok=True)
            with open(save_path, 'wb') as f:
                f.write(resp.content)
            return {
                'success': True,
                'save_path': save_path,
                'file_size': len(resp.content),
                'error': '',
            }
        else:
            return {
                'success': False,
                'save_path': '',
                'file_size': 0,
                'error': f'下载失败{resp.status_code}: {resp.text[:200]}',
            }
    except Exception as e:
        return {
            'success': False,
            'save_path': '',
            'file_size': 0,
            'error': f'下载异常: {str(e)}',
        }


def find_local_files_for_workflow(project_root, config=None):
    """根据配置文件中的候选模式查找本地文件（v1.11.0新增）

    Args:
        project_root: 项目根目录
        config: Dify配置

    Returns:
        dict: {local_file_key: file_path}
    """
    if config is None:
        config = load_dify_config()

    import glob

    local_files_config = config.get('local_files', {})
    found_files = {}

    for local_key, patterns in local_files_config.items():
        # local_key格式：{xxx}_candidates，提取xxx
        key = local_key.replace('_candidates', '')

        for pattern in patterns:
            # 在project_root下递归查找
            search_pattern = os.path.join(project_root, '**', pattern)
            matches = glob.glob(search_pattern, recursive=True)
            if matches:
                found_files[key] = matches[0]  # 取第一个匹配
                break

    return found_files


def validate_rd_doc_quality(doc_path, config=None):
    """校验生成的RD立项书文档质量（v1.11.0新增）

    Args:
        doc_path: 生成的docx文档路径
        config: Dify配置

    Returns:
        dict: {
            'passed': bool,
            'sections': dict,  # {section_name: {passed, length}}
            'error': str,
        }
    """
    if config is None:
        config = load_dify_config()

    qc_config = config.get('qc', {})
    min_lengths = qc_config.get('min_section_length', {'intro': 200, 'tech': 500, 'accept': 500})

    result = {
        'passed': True,
        'sections': {},
        'error': '',
    }

    try:
        from docx import Document
        doc = Document(doc_path)
        full_text = '\n'.join([p.text for p in doc.paragraphs if p.text.strip()])

        # 检查三段
        section_keywords = {
            'intro': ['一、项目简介', '项目简介', '一、项目概况'],
            'tech': ['二、主要研究内容', '主要研究内容', '二、研究内容', '二、技术方案'],
            'accept': ['三、项目验收总结', '项目验收总结', '三、验收总结'],
        }

        for section, keywords in section_keywords.items():
            found = False
            for kw in keywords:
                if kw in full_text:
                    # 估算该段长度（到下一个章节标题）
                    idx = full_text.find(kw)
                    next_idx = len(full_text)
                    for next_kw in ['一、', '二、', '三、', '四、', '五、']:
                        next_find = full_text.find(next_kw, idx + len(kw))
                        if next_find > 0 and next_find < next_idx:
                            next_idx = next_find
                    section_length = next_idx - idx
                    passed = section_length >= min_lengths.get(section, 200)
                    result['sections'][section] = {
                        'passed': passed,
                        'length': section_length,
                        'keyword_found': kw,
                    }
                    found = True
                    if not passed:
                        result['passed'] = False
                    break

            if not found:
                result['sections'][section] = {
                    'passed': False,
                    'length': 0,
                    'keyword_found': '',
                }
                result['passed'] = False

    except Exception as e:
        result['error'] = f'校验异常: {str(e)}'
        result['passed'] = False

    return result


def generate_rd_report_via_dify(project_root, output_dir=None, config=None, on_progress=None):
    """完整集成：通过Dify工作流生成RD立项书（v1.11.0新增，主入口函数）

    完整工作流：
    1. 加载配置
    2. 动态获取工作流参数（适配工作流更新）
    3. 查找本地文件（RD/PS汇总表+TO-AI表格）
    4. 匹配本地文件到工作流变量
    5. 上传文件到Dify
    6. 执行工作流（streaming模式）
    7. 下载生成的文档
    8. 校验文档质量

    Args:
        project_root: 项目根目录
        output_dir: 输出目录（默认：{project_root}/立项书输出docx）
        config: Dify配置（可选，默认自动加载）
        on_progress: 进度回调 on_progress(step, message, data)

    Returns:
        dict: {
            'success': bool,
            'workflow_result': dict,  # 工作流执行结果
            'downloaded_docs': list,  # 下载的文档列表
            'qc_result': dict,  # 质量校验结果
            'adaptation_report': dict,  # 适配报告（变量匹配情况）
            'error': str,
        }
    """
    if config is None:
        config = load_dify_config()

    if output_dir is None:
        output_dir = os.path.join(project_root, '立项书输出docx')
    os.makedirs(output_dir, exist_ok=True)

    def progress(step, msg, data=None):
        if on_progress:
            on_progress(step, msg, data)

    result = {
        'success': False,
        'workflow_result': {},
        'downloaded_docs': [],
        'qc_result': {},
        'adaptation_report': {},
        'error': '',
    }

    # 1. 动态获取工作流参数
    progress('fetch_params', '获取工作流参数定义...')
    params_result = fetch_workflow_parameters(config)
    result['adaptation_report']['params_fetch'] = {
        'success': params_result['success'],
        'variables_count': len(params_result['variables']),
        'error': params_result['error'],
    }

    if not params_result['success']:
        progress('fetch_params', f'⚠️ 获取参数失败，回退到static_variables: {params_result["error"]}')
        # 回退到static_variables
        static_vars = config.get('variable_mapping', {}).get('static_variables', {})
        workflow_variables = []
        for key, var_def in static_vars.items():
            var_def_copy = var_def.copy()
            workflow_variables.append(var_def_copy)
    else:
        workflow_variables = params_result['variables']

    # 2. 查找本地文件
    progress('find_files', '查找本地文件...')
    local_files = find_local_files_for_workflow(project_root, config)
    result['adaptation_report']['local_files'] = local_files

    if not local_files:
        result['error'] = '未找到本地RD/PS汇总表和TO-AI表格'
        return result

    # 3. 匹配本地文件到工作流变量
    progress('match_vars', '匹配本地文件到工作流变量...')
    match_result = match_local_files_to_variables(local_files, workflow_variables, config)
    result['adaptation_report']['match_result'] = {
        'matched': list(match_result['matched'].keys()),
        'unmatched_local': match_result['unmatched_local'],
        'unmatched_remote': [v.get('variable') for v in match_result['unmatched_remote']],
        'missing_required': [v.get('variable') for v in match_result['missing_required']],
    }

    if match_result['missing_required']:
        result['error'] = f'缺失必填变量: {[v.get("variable") for v in match_result["missing_required"]]}'
        return result

    # 4. 上传文件
    progress('upload_files', '上传文件到Dify...')
    user_id = config.get('api', {}).get('user_id', 'trae-agent')

    inputs = {}
    upload_results = []
    for var_name, match_info in match_result['matched'].items():
        file_path = match_info['file_path']
        progress('upload_files', f'上传: {os.path.basename(file_path)}')
        upload_result = upload_file_to_dify(file_path, user_id, config)
        upload_results.append({
            'variable': var_name,
            'file_path': file_path,
            'upload_result': upload_result,
        })

        if not upload_result['success']:
            result['error'] = f'上传失败({var_name}): {upload_result["error"]}'
            return result

        # 构造inputs值
        var_type = match_info.get('type', 'file-list')
        if var_type == 'file-list':
            inputs[var_name] = [{
                'transfer_method': 'local_file',
                'upload_file_id': upload_result['upload_file_id'],
                'type': 'document',
            }]
        else:
            inputs[var_name] = upload_result['upload_file_id']

    # 5. 添加可选变量默认值
    optional_vars = config.get('variable_mapping', {}).get('optional_variables', {})
    for var_key, var_def in optional_vars.items():
        var_name = var_def.get('variable_name', var_key)
        if var_name not in inputs and 'default' in var_def:
            inputs[var_name] = var_def['default']

    # 6. 执行工作流
    progress('run_workflow', f'执行工作流（{len(inputs)}个输入变量）...')
    start_time = time.time()

    def on_text_chunk(text):
        if on_progress:
            on_progress('text_chunk', text, {'length': len(text)})

    workflow_result = run_dify_workflow(inputs, user_id, config, response_mode='streaming', on_text_chunk=on_text_chunk)
    workflow_result['total_wall_time'] = time.time() - start_time
    result['workflow_result'] = workflow_result

    if not workflow_result['success']:
        result['error'] = f'工作流执行失败: {workflow_result["error"]}'
        return result

    progress('run_workflow', f'工作流完成（{workflow_result["elapsed_time"]:.1f}s, {workflow_result["total_tokens"]}tokens）')

    # 7. 下载生成的文档
    progress('download_docs', f'下载生成的文档（{len(workflow_result["doc_urls"])}份）...')
    for i, doc_url in enumerate(workflow_result['doc_urls']):
        # 从URL提取文件名或使用默认名
        timestamp = datetime.now().strftime('%Y%m%d%H%M%S')
        save_name = f'RD_dify_{timestamp}_{i+1}.docx'
        save_path = os.path.join(output_dir, save_name)

        download_result = download_generated_doc(doc_url, save_path, config)
        if download_result['success']:
            result['downloaded_docs'].append({
                'url': doc_url,
                'save_path': save_path,
                'file_size': download_result['file_size'],
            })
            progress('download_docs', f'已下载: {save_name} ({download_result["file_size"]} bytes)')
        else:
            progress('download_docs', f'⚠️ 下载失败: {download_result["error"]}')

    # 8. 校验文档质量
    if result['downloaded_docs']:
        progress('qc', '校验文档质量...')
        first_doc = result['downloaded_docs'][0]['save_path']
        result['qc_result'] = validate_rd_doc_quality(first_doc, config)
        progress('qc', f'QC: {"通过" if result["qc_result"]["passed"] else "未通过"}')

    result['success'] = len(result['downloaded_docs']) > 0
    return result


def test_dify_workflow_connection(config=None):
    """测试Dify工作流连接（v1.11.0新增，诊断用）

    Args:
        config: Dify配置

    Returns:
        dict: 诊断结果
    """
    if config is None:
        config = load_dify_config()

    result = {
        'config_loaded': True,
        'api_reachable': False,
        'app_info': {},
        'workflow_parameters': {},
        'variable_mapping': {},
        'errors': [],
    }

    # 测试连通性
    params_result = fetch_workflow_parameters(config)
    if params_result['success']:
        result['api_reachable'] = True
        result['app_info'] = params_result['app_info']
        result['workflow_parameters'] = {
            'variables': params_result['variables'],
            'file_upload_config': params_result['file_upload_config'],
        }
    else:
        result['errors'].append(f'API不可达: {params_result["error"]}')

    # 测试变量映射
    if result['api_reachable']:
        static_vars = config.get('variable_mapping', {}).get('static_variables', {})
        match_rules = config.get('variable_mapping', {}).get('match_rules', [])

        for local_key, var_def in static_vars.items():
            var_name = var_def.get('variable_name', '')
            found = any(v.get('variable') == var_name for v in params_result['variables'])
            result['variable_mapping'][local_key] = {
                'expected_variable': var_name,
                'found_in_workflow': found,
            }
            if not found:
                result['errors'].append(f'变量{var_name}在工作流中未找到（可能已更名）')

    return result


# ==================== CLI 入口 ====================

def _locate_project_root(enterprise, count=None):
    """根据企业名称定位项目根目录

    在当前工作目录及其上级目录中查找包含企业名称的目录作为项目根目录。

    Args:
        enterprise: 企业名称关键词
        count: 期望生成的RD数量（仅用于日志，不参与定位）

    Returns:
        str: 项目根目录绝对路径，未找到则返回当前工作目录
    """
    current_dir = os.getcwd()
    # 优先查找包含企业名称的目录
    for _ in range(6):
        dir_name = os.path.basename(current_dir)
        if enterprise and enterprise in dir_name:
            return current_dir
        parent = os.path.dirname(current_dir)
        if parent == current_dir:
            break
        current_dir = parent

    # 回退：在当前目录下查找包含企业名称的子目录
    current_dir = os.getcwd()
    if enterprise:
        for entry in os.listdir(current_dir):
            if os.path.isdir(os.path.join(current_dir, entry)) and enterprise in entry:
                return os.path.join(current_dir, entry)

    return os.getcwd()


def main():
    """CLI 主入口

    使用 argparse 解析命令行参数，支持以下子命令：
        test-connection : 测试Dify工作流连接
        fetch-params    : 获取工作流输入参数定义
        run             : 执行工作流
        rd-report       : 通过Dify工作流生成RD立项书

    所有命令均以 JSON 格式输出结果到 stdout。

    Returns:
        dict: 命令执行结果（JSON格式）
    """
    parser = argparse.ArgumentParser(
        prog='dify_workflow',
        description='Dify工作流集成模块（模块十）：测试连接、获取参数、执行工作流、生成RD立项书',
    )
    sub_parsers = parser.add_subparsers(dest='command', help='子命令')

    # test-connection 子命令
    p_test = sub_parsers.add_parser('test-connection', help='测试Dify工作流连接（API可达性、变量映射）')
    p_test.add_argument('--workflow', default='', help='工作流名称（仅用于日志标识，配置在 dify_config.json 中）')

    # fetch-params 子命令
    p_params = sub_parsers.add_parser('fetch-params', help='获取工作流输入参数定义')
    p_params.add_argument('--workflow', default='', help='工作流名称（仅用于日志标识）')

    # run 子命令
    p_run = sub_parsers.add_parser('run', help='执行工作流')
    p_run.add_argument('--workflow', default='', help='工作流名称（仅用于日志标识）')
    p_run.add_argument('--inputs', required=True, help='工作流输入变量JSON字符串，如 \'{"key":"value"}\'')
    p_run.add_argument('--response-mode', default='streaming', choices=['streaming', 'blocking'],
                       help='响应模式（默认streaming）')
    p_run.add_argument('--user', default='trae-agent', help='用户标识（默认trae-agent）')

    # rd-report 子命令
    p_rd = sub_parsers.add_parser('rd-report', help='通过Dify工作流生成RD立项书')
    p_rd.add_argument('--enterprise', required=True, help='企业名称（用于定位项目根目录）')
    p_rd.add_argument('--count', type=int, default=1, help='期望生成的RD立项书数量（默认1）')
    p_rd.add_argument('--project-root', default=None, help='项目根目录（默认根据企业名称自动定位）')
    p_rd.add_argument('--output-dir', default=None, help='输出目录（默认 {project_root}/立项书输出docx）')

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        return {'success': False, 'error': '未指定子命令'}

    output = {'success': False, 'command': args.command, 'error': ''}

    try:
        if args.command == 'test-connection':
            # 测试工作流连接
            output['workflow'] = args.workflow
            result = test_dify_workflow_connection()
            output.update(result)
            output['success'] = result.get('api_reachable', False)

        elif args.command == 'fetch-params':
            # 获取工作流参数定义
            output['workflow'] = args.workflow
            result = fetch_workflow_parameters()
            output['success'] = result['success']
            output['variables'] = result['variables']
            output['file_upload_config'] = result['file_upload_config']
            output['system_parameters'] = result['system_parameters']
            output['app_info'] = result['app_info']
            output['error'] = result['error']

        elif args.command == 'run':
            # 执行工作流
            output['workflow'] = args.workflow
            try:
                inputs = json.loads(args.inputs)
            except json.JSONDecodeError as e:
                output['error'] = f'inputs参数不是有效的JSON: {str(e)}'
                print(json.dumps(output, ensure_ascii=False, indent=2))
                return output

            result = run_dify_workflow(inputs, args.user, response_mode=args.response_mode)
            output.update(result)
            output['success'] = result['success']

        elif args.command == 'rd-report':
            # 生成RD立项书
            output['enterprise'] = args.enterprise
            output['count'] = args.count

            project_root = args.project_root
            if project_root is None:
                project_root = _locate_project_root(args.enterprise, args.count)
            output['project_root'] = os.path.abspath(project_root)

            result = generate_rd_report_via_dify(project_root, output_dir=args.output_dir)
            output.update(result)
            output['success'] = result['success']

    except Exception as e:
        output['error'] = f'执行异常: {str(e)}'

    # 输出JSON格式结果
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return output


if __name__ == '__main__':
    main()
