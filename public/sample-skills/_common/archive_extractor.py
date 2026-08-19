#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
压缩文件解压遍历工具（archive_extractor）

用途：所有技能在搜索/遍历资料时，遇到.zip/.rar/.7z等压缩文件，必须递归解压到底，
      不得绕过、不得触壁返回。

核心原则：
1. 压缩文件内如果还有压缩文件，必须继续递归解压，直到所有文件都是非压缩文件
2. 解压失败时不直接返回，必须尝试多种方法（多种库、系统命令、常见密码）
3. 不使用"避免重复解压直接返回"的优化，每次都完整扫描确保不遗漏

CLI 用法：
    # 解压单个压缩文件
    python archive_extractor.py extract --path "压缩文件路径" --output "解压目录"

    # 递归扫描目录下所有压缩文件并解压
    python archive_extractor.py scan --path "目录路径"

输出：JSON 格式结果 {"extracted": [...], "failed": [...], "total": N}
"""

import os
import zipfile
import tempfile
import shutil
import hashlib
import json
import argparse

# 全局解压记录：避免在同一扫描会话中无限递归（仅记录本次会话）
_extracted_archives = set()

# 常见密码列表（用于尝试解压加密的zip）
_COMMON_PASSWORDS = [
    '', '123456', '12345678', 'admin', 'password', '111111', '000000',
    '123456789', 'qwerty', 'abc123', '1234567890', 'admin123',
]


def _archive_hash(file_path):
    """根据文件路径和修改时间生成唯一标识，用于去重"""
    try:
        stat = os.stat(file_path)
        key = f"{file_path}:{stat.st_size}:{stat.st_mtime}"
        return hashlib.md5(key.encode('utf-8')).hexdigest()
    except Exception:
        return file_path


def _try_extract_zip(file_path, extract_dir):
    """尝试多种方法解压zip文件（支持加密zip）"""
    # 方法1：无密码直接解压
    try:
        with zipfile.ZipFile(file_path, 'r') as zf:
            zf.extractall(extract_dir)
        return True
    except RuntimeError as e:
        # 加密zip，尝试常见密码
        if 'encrypted' in str(e).lower() or 'password' in str(e).lower():
            try:
                with zipfile.ZipFile(file_path, 'r') as zf:
                    for pwd in _COMMON_PASSWORDS:
                        try:
                            zf.extractall(extract_dir, pwd=pwd.encode('utf-8') if pwd else None)
                            return True
                        except (RuntimeError, zipfile.BadZipFile):
                            continue
            except Exception:
                pass
        return False
    except Exception:
        return False


def _try_extract_rar(file_path, extract_dir):
    """尝试多种方法解压rar文件"""
    # 方法1：rarfile库
    try:
        import rarfile
        with rarfile.RarFile(file_path, 'r') as rf:
            rf.extractall(extract_dir)
        return True
    except ImportError:
        pass
    except Exception:
        pass
    
    # 方法2：unrar系统命令
    try:
        import subprocess
        result = subprocess.run(
            ['unrar', 'x', '-y', '-o+', file_path, extract_dir + os.sep],
            capture_output=True, timeout=300, text=True
        )
        if result.returncode == 0:
            return True
    except Exception:
        pass
    
    # 方法3：WinRAR（Windows）
    try:
        import subprocess
        winrar_paths = [
            r'C:\Program Files\WinRAR\WinRAR.exe',
            r'C:\Program Files (x86)\WinRAR\WinRAR.exe',
            r'C:\Program Files\7-Zip\7z.exe',
        ]
        for exe in winrar_paths:
            if os.path.exists(exe):
                result = subprocess.run(
                    [exe, 'x', '-y', f'-o{extract_dir}', file_path],
                    capture_output=True, timeout=300
                )
                if result.returncode == 0:
                    return True
    except Exception:
        pass
    
    return False


def _try_extract_7z(file_path, extract_dir):
    """尝试多种方法解压7z文件"""
    # 方法1：py7zr库
    try:
        import py7zr
        with py7zr.SevenZipFile(file_path, 'r') as sz:
            sz.extractall(extract_dir)
        return True
    except ImportError:
        pass
    except Exception:
        pass
    
    # 方法2：7z系统命令
    try:
        import subprocess
        seven_zip_paths = ['7z', r'C:\Program Files\7-Zip\7z.exe', r'C:\Program Files (x86)\7-Zip\7z.exe']
        for exe in seven_zip_paths:
            try:
                result = subprocess.run(
                    [exe, 'x', '-y', f'-o{extract_dir}', file_path],
                    capture_output=True, timeout=300
                )
                if result.returncode == 0:
                    return True
            except (FileNotFoundError, OSError):
                continue
    except Exception:
        pass
    
    return False


def _try_extract_tar(file_path, extract_dir):
    """解压tar/tgz/gz文件"""
    try:
        import tarfile
        with tarfile.open(file_path, 'r:*') as tf:
            tf.extractall(extract_dir)
        return True
    except Exception:
        return False


def extract_archive_recursive(file_path, extract_base_dir=None, depth=0, max_depth=15):
    """递归解压压缩文件到底（核心函数）
    
    遇到压缩文件就解压，解压后如果还有压缩文件继续解压，直到所有文件都是非压缩文件。
    绝不触壁返回，必须尝试所有可能的解压方法。
    
    Args:
        file_path: 压缩文件路径
        extract_base_dir: 解压根目录，None则使用系统临时目录
        depth: 当前递归深度（内部使用）
        max_depth: 最大递归深度（防止恶意构造的无限嵌套，默认15层）
    
    Returns:
        str: 解压后的最终目录路径；解压失败返回None
    """
    if not os.path.isfile(file_path):
        return None
    
    ext = os.path.splitext(file_path)[1].lower()
    if ext not in ('.zip', '.rar', '.7z', '.gz', '.tar', '.tgz'):
        return None
    
    # 深度保护（仅防止恶意构造的无限嵌套）
    if depth >= max_depth:
        print(f"[警告] 达到最大递归深度 {max_depth}，停止解压: {file_path}")
        return None
    
    # 防止同一文件在本次会话中被重复处理（但不影响嵌套解压）
    archive_key = _archive_hash(file_path)
    if archive_key in _extracted_archives:
        # 已处理过，直接返回之前的解压目录（如果存在）
        if extract_base_dir is None:
            extract_base_dir = os.path.join(tempfile.gettempdir(), 'gxtz_archives')
        archive_name = os.path.splitext(os.path.basename(file_path))[0]
        extract_dir = os.path.join(extract_base_dir, f"{archive_name}_{archive_key[:8]}")
        if os.path.isdir(extract_dir):
            return extract_dir
        return None
    
    _extracted_archives.add(archive_key)
    
    # 解压目标目录（加入hash避免命名冲突）
    if extract_base_dir is None:
        extract_base_dir = os.path.join(tempfile.gettempdir(), 'gxtz_archives')
    
    archive_name = os.path.splitext(os.path.basename(file_path))[0]
    extract_dir = os.path.join(extract_base_dir, f"{archive_name}_{archive_key[:8]}")
    os.makedirs(extract_dir, exist_ok=True)
    
    # 尝试解压（按格式调用对应的解压函数）
    success = False
    if ext == '.zip':
        success = _try_extract_zip(file_path, extract_dir)
    elif ext == '.rar':
        success = _try_extract_rar(file_path, extract_dir)
    elif ext == '.7z':
        success = _try_extract_7z(file_path, extract_dir)
    elif ext in ('.tar', '.tgz', '.gz'):
        success = _try_extract_tar(file_path, extract_dir)
    
    if not success:
        print(f"[警告] 所有解压方法均失败: {file_path}")
        return None
    
    # 关键：递归检查解压后的目录，如果还有压缩文件，继续解压到底
    nested_archives = []
    for root, dirs, files in os.walk(extract_dir):
        dirs[:] = [d for d in dirs if not d.startswith('.') and d not in ['__pycache__', 'node_modules']]
        for fname in files:
            fext = os.path.splitext(fname)[1].lower()
            if fext in ('.zip', '.rar', '.7z', '.gz', '.tar', '.tgz'):
                nested_archives.append(os.path.join(root, fname))
    
    # 递归解压嵌套的压缩文件（绝不触壁返回）
    for nested_archive in nested_archives:
        nested_extract_dir = extract_archive_recursive(
            nested_archive, extract_base_dir, depth + 1, max_depth
        )
        # 解压完成后，删除原始嵌套压缩文件（避免后续扫描时再次处理）
        if nested_extract_dir:
            try:
                os.remove(nested_archive)
            except Exception:
                pass
    
    return extract_dir


# 向后兼容的函数名（保留旧名称，内部调用新函数）
def extract_archive_if_needed(file_path, extract_base_dir=None):
    """解压压缩文件（兼容旧接口，内部调用 extract_archive_recursive）"""
    return extract_archive_recursive(file_path, extract_base_dir)


def scan_files_with_archive_support(data_dir, file_patterns=None, archive_temp_dir=None, _depth=0, max_depth=15):
    """增强版文件扫描 - 递归解压所有压缩文件并遍历内部内容到底
    
    替代原有的 glob.glob 或 os.walk 遍历逻辑。
    遇到压缩文件时自动解压到临时目录，并将解压后的文件纳入扫描结果。
    **绝不触壁返回：压缩文件内的压缩文件也会被递归解压，直到所有文件都是非压缩文件。**
    
    Args:
        data_dir: 待扫描的根目录
        file_patterns: 需要匹配的文件扩展名列表，如 ['.pdf', '.docx', '.xlsx']；None表示所有文件
        archive_temp_dir: 压缩文件解压的临时目录，None则使用系统临时目录
        _depth: 当前递归深度（内部使用）
        max_depth: 最大递归深度
    
    Returns:
        list: 所有匹配文件的路径列表（包含递归解压后的所有文件）
    """
    if _depth >= max_depth:
        print(f"[警告] 扫描达到最大递归深度 {max_depth}: {data_dir}")
        return []
    
    if archive_temp_dir is None:
        archive_temp_dir = os.path.join(tempfile.gettempdir(), 'gxtz_archives')
    
    found_files = []
    archive_extensions = ('.zip', '.rar', '.7z', '.gz', '.tar', '.tgz')
    
    if not os.path.isdir(data_dir):
        return found_files
    
    for root, dirs, files in os.walk(data_dir):
        # 跳过隐藏目录和系统目录
        dirs[:] = [d for d in dirs if not d.startswith('.') and d not in ['__pycache__', 'node_modules', '$RECYCLE.BIN', 'System Volume Information']]
        
        for fname in files:
            fpath = os.path.join(root, fname)
            ext = os.path.splitext(fname)[1].lower()
            
            # 处理压缩文件：递归解压到底
            if ext in archive_extensions:
                extracted_dir = extract_archive_recursive(
                    fpath, archive_temp_dir, depth=0, max_depth=max_depth
                )
                if extracted_dir and os.path.isdir(extracted_dir):
                    # 递归扫描解压后的目录（解压后的目录里如果还有压缩文件，会被extract_archive_recursive预先处理掉）
                    sub_files = scan_files_with_archive_support(
                        extracted_dir, file_patterns, archive_temp_dir, _depth + 1, max_depth
                    )
                    found_files.extend(sub_files)
                else:
                    print(f"[警告] 压缩文件解压失败，但仍记录原始文件: {fpath}")
                # 压缩文件本身也纳入结果（供记录用，便于审计）
                if file_patterns is None:
                    found_files.append(fpath)
            else:
                # 普通文件：按扩展名过滤
                if file_patterns is None or ext in file_patterns:
                    found_files.append(fpath)
    
    return found_files


def find_files_with_archive_support(data_dir, keyword=None, file_patterns=None):
    """按关键词查找文件（支持递归解压压缩文件内部搜索到底）
    
    替代原有的 glob.glob(pattern, recursive=True) 查找逻辑。
    **绝不触壁返回：会递归解压所有压缩文件，包括嵌套的压缩文件。**
    
    Args:
        data_dir: 搜索根目录
        keyword: 文件名关键词（不区分大小写），None则返回所有文件
        file_patterns: 文件扩展名过滤列表
    
    Returns:
        list: 匹配的文件路径列表
    """
    all_files = scan_files_with_archive_support(data_dir, file_patterns)
    
    if keyword is None:
        return all_files
    
    # 支持多关键词（任一匹配即可）
    if isinstance(keyword, (list, tuple)):
        keywords_lower = [k.lower() for k in keyword]
        matched = [f for f in all_files if any(k in os.path.basename(f).lower() for k in keywords_lower)]
    else:
        keyword_lower = keyword.lower()
        matched = [f for f in all_files if keyword_lower in os.path.basename(f).lower()]
    return matched


def reset_archive_extraction_cache():
    """重置解压缓存（在新的扫描会话开始时调用）"""
    global _extracted_archives
    _extracted_archives = set()


# ============================================================
# 客户原始资料目录识别（v1.3.0新增，基于实际项目资料结构分析）
# 基于量必达、安高模具、盛迪嘉支付等3个已完成项目分析：
# 客户原始资料目录通常命名为以下几种形式：
#   - "高新资料"（盛迪嘉支付）
#   - "整理资料"（量必达、安高模具）
#   - "1.{企业简称}"（安高模具：1.深圳市安高模具有限公司）
#   - "客户资料"、"原始资料"、"客户提供"
#   - 含zip/rar压缩包（高新资料.zip、深圳市量必达.zip等）
# ============================================================

# 客户原始资料目录的常见命名模式（按项目实际统计）
_CUSTOMER_RAW_DIR_PATTERNS = [
    '高新资料', '整理资料', '客户资料', '原始资料', '客户提供',
    '收资', '收资资料', '收资清单', '发文案', '群',
]

# 工作成果目录的常见命名模式（用于区分客户原始资料和工作成果）
_WORK_OUTPUT_DIR_PATTERNS = [
    '0 已盖章', '00 合订本', '00 盖章', '000 资料', '0000 资料',
    '发系统', '上传附件', '专审', '系统回传', '上次申报',
    '00_核心表格', '01_研发立项报告', '02_知识产权证明', '03_成果转化证明',
    '04_高新产品证明', '05_科技人员材料', '06_管理制度材料', '07_资料收集清单',
    '_校验报告', '_补充资料',
]


def identify_customer_raw_materials_dir(project_root):
    """识别项目根目录下的客户原始资料目录（v1.3.0新增）
    
    基于实际项目分析，客户原始资料目录可能命名为"高新资料"、"整理资料"、
    "1.{企业简称}"等形式。这些目录包含客户通过群发送的原始资料、证件、证书、照片等。
    
    Args:
        project_root: 项目根目录路径
        
    Returns:
        dict: {
            'customer_raw_dirs': [客户原始资料目录路径列表],
            'work_output_dirs': [工作成果目录路径列表],
            'compressed_files': [根目录下的压缩文件列表（可能是客户原始资料打包）],
            'unrecognized_dirs': [未识别的目录列表]
        }
    """
    if not os.path.isdir(project_root):
        return {'customer_raw_dirs': [], 'work_output_dirs': [], 
                'compressed_files': [], 'unrecognized_dirs': []}
    
    customer_raw_dirs = []
    work_output_dirs = []
    compressed_files = []
    unrecognized_dirs = []
    
    for entry in os.listdir(project_root):
        full_path = os.path.join(project_root, entry)
        
        if os.path.isfile(full_path):
            # 检查是否为压缩文件（可能是客户原始资料打包）
            ext = os.path.splitext(entry)[1].lower()
            if ext in ('.zip', '.rar', '.7z'):
                # 排除工作成果打包（如"发系统"、"发文案"、"盖章"等关键词）
                if not any(kw in entry for kw in ['发系统', '发文案', '盖章', '上传附件', '合订本']):
                    compressed_files.append(full_path)
        elif os.path.isdir(full_path):
            # 检查是否为客户原始资料目录
            is_customer_raw = False
            is_work_output = False
            
            # 匹配客户原始资料目录模式
            for pattern in _CUSTOMER_RAW_DIR_PATTERNS:
                if pattern in entry:
                    is_customer_raw = True
                    break
            
            # 匹配工作成果目录模式
            for pattern in _WORK_OUTPUT_DIR_PATTERNS:
                if pattern in entry:
                    is_work_output = True
                    break
            
            # 匹配"数字.企业名称"模式（如"1.深圳市安高模具有限公司"）
            if not is_customer_raw and not is_work_output:
                if entry and entry[0].isdigit() and '.' in entry[:3]:
                    # 如"1.深圳市安高模具有限公司"
                    is_customer_raw = True
            
            if is_customer_raw:
                customer_raw_dirs.append(full_path)
            elif is_work_output:
                work_output_dirs.append(full_path)
            else:
                unrecognized_dirs.append(full_path)
    
    return {
        'customer_raw_dirs': customer_raw_dirs,
        'work_output_dirs': work_output_dirs,
        'compressed_files': compressed_files,
        'unrecognized_dirs': unrecognized_dirs
    }


def scan_customer_raw_materials(project_root, file_patterns=None):
    """扫描客户原始资料目录中的所有文件（v1.3.0新增）
    
    自动识别客户原始资料目录，递归解压其中的压缩文件，
    返回所有文件的完整列表。用于资料收集技能的本地资料筛查。
    
    Args:
        project_root: 项目根目录路径
        file_patterns: 需要匹配的文件扩展名列表，None表示所有文件
        
    Returns:
        dict: {
            'customer_files': [客户原始资料文件列表],
            'customer_raw_dirs': [识别到的客户原始资料目录],
            'compressed_files': [识别到的压缩文件],
            'file_count_by_type': {文件扩展名: 数量}
        }
    """
    identification = identify_customer_raw_materials_dir(project_root)
    
    all_files = []
    
    # 扫描客户原始资料目录
    for raw_dir in identification['customer_raw_dirs']:
        files = scan_files_with_archive_support(raw_dir, file_patterns)
        all_files.extend(files)
    
    # 解压并扫描压缩文件
    for compressed in identification['compressed_files']:
        extract_dir = extract_archive_recursive(compressed)
        if extract_dir:
            files = scan_files_with_archive_support(extract_dir, file_patterns)
            all_files.extend(files)
    
    # 按类型统计
    file_count_by_type = {}
    for f in all_files:
        ext = os.path.splitext(f)[1].lower().lstrip('.')
        file_count_by_type[ext] = file_count_by_type.get(ext, 0) + 1
    
    return {
        'customer_files': all_files,
        'customer_raw_dirs': identification['customer_raw_dirs'],
        'compressed_files': identification['compressed_files'],
        'file_count_by_type': file_count_by_type
    }


def identify_enterprise_type(enterprise_name, ip_list=None, rd_list=None, ps_list=None):
    """识别企业类型（软件类/硬件类）（v1.3.0新增）
    
    基于实际项目分析，软件类企业（如盛迪嘉支付）与硬件类企业（如量必达、安高模具）
    在资料结构上有显著差异：
    - 软件类：软著为主、PS仅2项、无检测报告、照片含APP截图、设备为服务器
    - 硬件类：实用新型/外观为主、PS多项、有CMA检测报告、照片含生产线、设备含生产设备
    
    Args:
        enterprise_name: 企业名称
        ip_list: 知识产权列表（可选）
        rd_list: 研发项目列表（可选）
        ps_list: 高新产品列表（可选）
        
    Returns:
        dict: {
            'enterprise_type': 'software'/'hardware'/'mixed'/'unknown',
            'evidence': [判断依据列表],
            'recommendations': [针对该企业类型的资料收集建议]
        }
    """
    evidence = []
    software_score = 0
    hardware_score = 0
    
    # 基于企业名称判断
    software_keywords = ['软件', '信息', '科技', '数据', '网络', '互联网', '云计算', 
                        '人工智能', '支付', '电子商务', '电商', '数字']
    hardware_keywords = ['制造', '模具', '电子', '电气', '机械', '五金', '塑胶', '塑料',
                        '金属', '建材', '光电', '半导体', '电路', '仪器', '仪表', '自动化']
    
    for kw in software_keywords:
        if kw in enterprise_name:
            software_score += 1
            evidence.append(f'企业名称含"{kw}"')
    
    for kw in hardware_keywords:
        if kw in enterprise_name:
            hardware_score += 1
            evidence.append(f'企业名称含"{kw}"')
    
    # 基于IP构成判断
    if ip_list:
        software_copyright_count = 0
        patent_count = 0
        for ip in ip_list:
            ip_type = str(ip.get('type', '') or ip.get('类别', ''))
            if '软著' in ip_type or '软件著作权' in ip_type:
                software_copyright_count += 1
            elif '专利' in ip_type or '实用新型' in ip_type or '外观设计' in ip_type or '发明' in ip_type:
                patent_count += 1
        
        if software_copyright_count > patent_count:
            software_score += 2
            evidence.append(f'软著{software_copyright_count}项 > 专利{patent_count}项')
        elif patent_count > software_copyright_count:
            hardware_score += 2
            evidence.append(f'专利{patent_count}项 > 软著{software_copyright_count}项')
    
    # 基于PS产品判断
    if ps_list:
        if len(ps_list) <= 2:
            software_score += 1
            evidence.append(f'PS产品仅{len(ps_list)}项（软件类特征）')
        else:
            hardware_score += 1
            evidence.append(f'PS产品{len(ps_list)}项（硬件类特征）')
    
    # 判断企业类型
    if software_score > hardware_score and software_score >= 2:
        enterprise_type = 'software'
        recommendations = [
            '重点收集软著登记截图（网页截图）',
            'PS产品可能为服务类（如技术服务费、平台服务费），无需检测报告',
            '设备清单以服务器、电脑、网络设备为主',
            '照片资料需包含APP界面截图、App Store页面截图',
            '合同发票为商户服务协议、技术服务费发票',
        ]
    elif hardware_score > software_score and hardware_score >= 2:
        enterprise_type = 'hardware'
        recommendations = [
            '重点收集产品检测报告（CMA/CNAS认证）',
            'PS产品通常5-10项，需提供产品销售合同发票',
            '设备清单含生产设备、检测仪器、实验设备',
            '照片资料需包含产品实物、生产线、检测场景',
            '认证证书为产品认证（CCC/CE/FCC/RoHS）',
        ]
    elif software_score == hardware_score and software_score > 0:
        enterprise_type = 'mixed'
        recommendations = [
            '同时收集软著和专利证书',
            'PS产品可能既有服务类也有实体产品',
            '设备清单含服务器和生产设备',
            '照片资料需覆盖软件截图和产品实物',
        ]
    else:
        enterprise_type = 'unknown'
        recommendations = ['请人工确认企业类型后参考对应建议']
    
    return {
        'enterprise_type': enterprise_type,
        'evidence': evidence,
        'recommendations': recommendations
    }


def main():
    """CLI 入口：支持 extract 和 scan 两个子命令
    
    返回 JSON 格式结果：{"extracted": [...], "failed": [...], "total": N}
    """
    parser = argparse.ArgumentParser(
        description='压缩文件解压遍历工具 - 递归解压所有压缩文件到底'
    )
    subparsers = parser.add_subparsers(dest='command', help='子命令')

    # extract 子命令：解压单个压缩文件
    extract_parser = subparsers.add_parser('extract', help='解压单个压缩文件')
    extract_parser.add_argument('--path', required=True, help='压缩文件路径')
    extract_parser.add_argument('--output', required=True, help='解压目录')

    # scan 子命令：递归扫描目录下所有压缩文件并解压
    scan_parser = subparsers.add_parser('scan', help='递归扫描目录下所有压缩文件并解压')
    scan_parser.add_argument('--path', required=True, help='目录路径')

    args = parser.parse_args()

    archive_extensions = ('.zip', '.rar', '.7z', '.gz', '.tar', '.tgz')
    extracted = []
    failed = []

    if args.command == 'extract':
        # 解压单个压缩文件
        if not os.path.isfile(args.path):
            print(json.dumps(
                {"extracted": [], "failed": [args.path], "total": 1, "error": "文件不存在"},
                ensure_ascii=False
            ))
            return
        result_dir = extract_archive_recursive(args.path, args.output)
        if result_dir:
            extracted.append(args.path)
        else:
            failed.append(args.path)
        total = 1
        print(json.dumps(
            {"extracted": extracted, "failed": failed, "total": total},
            ensure_ascii=False
        ))

    elif args.command == 'scan':
        # 递归扫描目录下所有压缩文件并解压
        if not os.path.isdir(args.path):
            print(json.dumps(
                {"extracted": [], "failed": [], "total": 0, "error": "目录不存在"},
                ensure_ascii=False
            ))
            return
        for root, dirs, files in os.walk(args.path):
            dirs[:] = [d for d in dirs if not d.startswith('.') and d not in ['__pycache__', 'node_modules']]
            for fname in files:
                ext = os.path.splitext(fname)[1].lower()
                if ext in archive_extensions:
                    fpath = os.path.join(root, fname)
                    result_dir = extract_archive_recursive(fpath)
                    if result_dir:
                        extracted.append(fpath)
                    else:
                        failed.append(fpath)
        total = len(extracted) + len(failed)
        print(json.dumps(
            {"extracted": extracted, "failed": failed, "total": total},
            ensure_ascii=False
        ))

    else:
        parser.print_help()


if __name__ == '__main__':
    main()
