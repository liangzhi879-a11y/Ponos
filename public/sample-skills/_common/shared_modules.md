# 公共模块（所有gxtz技能共享）

> **v2.0 更新（2026-07-14）：本文件仅作为参考文档，记录各模块的设计逻辑和函数签名。**
> **SKILL.md 不再嵌入模块代码，而是通过 RunCommand 调用 _common/ 下的独立 .py 脚本。**
>
> ## 模块到脚本映射表
>
> | 模块 | 独立脚本路径 | CLI 用法 |
> |------|------------|---------|
> | 模块一：压缩文件解压遍历 | `_common/archive_extractor.py` | `python archive_extractor.py scan --path "目录"` |
> | 模块二：知识库共享 | `_common/knowledge_base.py` | `python knowledge_base.py load --project-root "项目根目录"` |
> | 模块三：统一资料整理 | `_common/project_context_manager.py` | `python project_context_manager.py finalize --enterprise "企业" --year 年份 --skill "技能名"` |
> | 模块四：有效资料文件梳理图谱 | `_common/project_context_manager.py` | （已整合到 project_context_manager.py） |
> | 模块五：补充资料机制 | `_common/supplement_materials.py` | `python supplement_materials.py checklist --project-root "项目根目录" --skill "技能名"` |
> | 模块六：PDF拆分与合并 | `_common/pdf_splitter.py` | `python pdf_splitter.py split --input "PDF" --output "目录" --mode page` |
> | 模块七：文件分类整理 | `_common/project_context_manager.py` | （已整合到 project_context_manager.py） |
> | 模块八：高新政策合规校验 | `_common/policy_compliance.py` | `python policy_compliance.py validate --project-root "项目根目录"` |
> | 模块九：企业基本信息联网搜索 | `_common/enterprise_info_search.py` | `python enterprise_info_search.py search --enterprise "企业名称"` |
> | 模块十：Dify工作流集成 | `_common/dify_workflow.py` | `python dify_workflow.py rd-report --enterprise "企业" --count N` |
> | 模块十一：RD-IP-PS自主匹配 | `_common/rd_ip_ps_matching.py` | `python rd_ip_ps_matching.py match --project-root "项目根目录"` |
> | 模块十二：内容识别分类 | `_common/file_content_classifier.py` | `python file_content_classifier.py scan --dir "目录" --output "结果.json"` |
> | 模块十三：命名合规引擎 | `_common/naming_compliance.py` | `python naming_compliance.py organize --source "源" --target "目标" --requirement "资料要求.xlsx"` |
> | 模块十四：备案结构映射 | `_common/filing_mapper.py` | `python filing_mapper.py map --source "源" --template "模板" --target "目标"` |
>
> ## 审核验证脚本映射表
>
> | 技能 | 审核脚本 | CLI 用法 |
> |------|---------|---------|
> | gxtz-core-tables | `_common/validate_tables.py` | `python validate_tables.py --dir "核心表格目录"` |
> | gxtz-ip-materials | `_common/validate_ip.py` | `python validate_ip.py --dir "IP材料目录" --project-root "项目根目录"` |
> | gxtz-achievement-materials | `_common/validate_achievement.py` | `python validate_achievement.py --dir "成果转化目录" --project-root "项目根目录"` |
> | gxtz-ps-materials | `_common/validate_ps.py` | `python validate_ps.py --dir "PS材料目录" --project-root "项目根目录"` |
> | gxtz-staff-materials | `_common/validate_staff.py` | `python validate_staff.py --dir "人员材料目录" --project-root "项目根目录"` |
> | gxtz-management-materials | `_common/validate_management.py` | `python validate_management.py --dir "管理制度目录" --project-root "项目根目录"` |
> | gxtz-rd-report | `_common/validate_rd_report.py` | `python validate_rd_report.py --dir "RD报告目录" --project-root "项目根目录"` |
> | gxtz-info-collector | `_common/validate_info_collector.py` | `python validate_info_collector.py --dir "资料清单目录" --project-root "项目根目录"` |
> | gxtz-invoice-ps-matching | `_common/validate_invoice_ps.py` | `python validate_invoice_ps.py --dir "输出目录" --project-root "项目根目录"` |
> | gxtz-audit-verification | `_common/validate_audit_verification.py` | `python validate_audit_verification.py --dir "输出目录" --project-root "项目根目录"` |
> | gxtz-file-organizer | `_common/validate_organizer.py` | `python validate_organizer.py validate --project-root "项目根目录" --year 年份 --enterprise "企业名称"` |
>
> ## SKILL.md 引用规范
>
> 1. SKILL.md 中的所有步骤必须使用 RunCommand 调用上述脚本，不得嵌入代码
> 2. 脚本路径必须使用绝对路径：`c:\Users\T203-15\Desktop\2023guogao\.trae\skills\_common\xxx.py`
> 3. 不得通过"调用 xxx() 函数"的形式执行（函数描述不是可执行命令）
> 4. 脚本报错时立即停止，不得"阅读脚本逻辑自行编写等效代码"
>
> ---

## 模块一：压缩文件解压遍历（archive_extractor）

**用途**：所有技能在搜索/遍历资料时，遇到.zip/.rar/.7z等压缩文件，必须**递归解压到底**，不得绕过、不得触壁返回。
**核心原则**：
1. 压缩文件内如果还有压缩文件，必须继续递归解压，直到所有文件都是非压缩文件
2. 解压失败时不直接返回，必须尝试多种方法（多种库、系统命令、常见密码）
3. 不使用"避免重复解压直接返回"的优化，每次都完整扫描确保不遗漏

```python
import os
import zipfile
import tempfile
import shutil
import hashlib

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
```

---

## 模块二：知识库共享（knowledge_base_shared）

**用途**：所有技能共享项目进度和项目专属知识图谱，实现经验沉淀和技能间数据共享。

```python
import os
import json
from datetime import datetime

KNOWLEDGE_BASE_DIR = os.path.join('.trae', 'project_knowledge')


def load_project_knowledge():
    """读取项目知识库（所有技能共用）
    
    返回包含 project_index、enterprise_info、experience_base 三个字典的复合对象。
    如果知识库不存在或为空模板，返回空结构。
    """
    result = {
        'project_index': {},
        'enterprise_info': {},
        'experience_base': {}
    }
    
    files = {
        'project_index': 'project_index.json',
        'enterprise_info': 'enterprise_info.json',
        'experience_base': 'experience_base.json'
    }
    
    for key, filename in files.items():
        filepath = os.path.join(KNOWLEDGE_BASE_DIR, filename)
        if os.path.exists(filepath):
            try:
                with open(filepath, 'r', encoding='utf-8') as f:
                    result[key] = json.load(f)
            except (json.JSONDecodeError, IOError):
                pass
    
    return result


def update_knowledge_after_skill(skill_name, enterprise_name, application_year,
                                  nodes=None, edges=None, progress_item=None,
                                  file_structure_entries=None, data_summary_updates=None,
                                  experience_entry=None):
    """技能执行后更新知识库（所有技能共用）
    
    在每个技能的最后一个步骤（审核验证通过后）自动调用此函数。
    
    Args:
        skill_name: 技能名称（如 'gxtz-ip-materials'）
        enterprise_name: 企业名称
        application_year: 申报年份
        nodes: 要添加到知识图谱的节点列表，每个节点为 dict:
               {'node_id': str, 'node_type': 'IP'|'RD'|'PS'|'ACH'|'STAFF'|'FIN'|'DOC',
                'node_data': dict}
        edges: 要添加到知识图谱的边列表，每条边为 dict:
               {'source': node_id, 'target': node_id, 'relation': str}
        progress_item: 进度更新项，dict:
               {'category': str, 'item_name': str, 'status': 'completed'|'in_progress'|'pending',
                'file_path': str}
        file_structure_entries: 文件结构更新项列表，每项为 dict:
               {'path': str, 'type': 'file'|'dir', 'status': str, 'related_id': str}
        data_summary_updates: 数据统计更新，dict:
               {'ip_count': int, 'rd_count': int, 'ps_count': int, ...}
        experience_entry: 经验沉淀项，dict:
               {'category': 'common_issues'|'validation_rules'|'format_requirements'|
                            'review_checkpoints'|'best_practices',
                'title': str, 'content': str}
    """
    os.makedirs(KNOWLEDGE_BASE_DIR, exist_ok=True)
    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    
    # 1. 更新 project_index.json
    index_path = os.path.join(KNOWLEDGE_BASE_DIR, 'project_index.json')
    index_data = {}
    if os.path.exists(index_path):
        try:
            with open(index_path, 'r', encoding='utf-8') as f:
                index_data = json.load(f)
        except (json.JSONDecodeError, IOError):
            pass
    
    # 确保基本结构存在
    index_data.setdefault('enterprise_name', enterprise_name)
    index_data.setdefault('application_year', application_year)
    index_data.setdefault('updated_at', now)
    
    # 更新文件结构图
    if file_structure_entries:
        index_data.setdefault('file_structure', {'description': '已识别文件结构图', 'tree': {}})
        tree = index_data['file_structure'].setdefault('tree', {})
        for entry in file_structure_entries:
            tree[entry['path']] = {
                'type': entry.get('type', 'file'),
                'status': entry.get('status', 'identified'),
                'related_id': entry.get('related_id', ''),
                'updated_by': skill_name,
                'updated_at': now
            }
    
    # 更新知识图谱（节点和边）
    if nodes or edges:
        index_data.setdefault('knowledge_graph', {
            'description': 'IP/RD/PS/成果/人员/财务关联图谱',
            'nodes': [],
            'edges': []
        })
        kg = index_data['knowledge_graph']
        existing_node_ids = {n.get('node_id') for n in kg.get('nodes', [])}
        
        if nodes:
            for node in nodes:
                if node['node_id'] not in existing_node_ids:
                    kg['nodes'].append({
                        'node_id': node['node_id'],
                        'node_type': node['node_type'],
                        'node_data': node.get('node_data', {}),
                        'added_by': skill_name,
                        'added_at': now
                    })
                    existing_node_ids.add(node['node_id'])
        
        if edges:
            for edge in edges:
                # 避免重复边
                edge_key = f"{edge['source']}->{edge['target']}->{edge['relation']}"
                existing_edges = {f"{e.get('source')}->{e.get('target')}->{e.get('relation')}" 
                                  for e in kg.get('edges', [])}
                if edge_key not in existing_edges:
                    kg['edges'].append({
                        'source': edge['source'],
                        'target': edge['target'],
                        'relation': edge['relation'],
                        'added_by': skill_name,
                        'added_at': now
                    })
    
    # 更新进度追踪
    if progress_item:
        index_data.setdefault('progress_tracking', {
            'description': '各类材料完成进度',
            'categories': {}
        })
        cat = progress_item['category']
        categories = index_data['progress_tracking'].setdefault('categories', {})
        if cat not in categories:
            categories[cat] = {}
        categories[cat][progress_item['item_name']] = {
            'status': progress_item.get('status', 'completed'),
            'file_path': progress_item.get('file_path', ''),
            'updated_by': skill_name,
            'updated_at': now
        }
    
    # 更新数据统计
    if data_summary_updates:
        index_data.setdefault('data_summary', {
            'description': '项目数据统计汇总',
            'ip_count': 0, 'rd_count': 0, 'ps_count': 0,
            'achievement_count': 0, 'staff_count': 0,
            'total_employees': 0, 'rd_expenses_total': 0, 'revenue_total': 0
        })
        for k, v in data_summary_updates.items():
            index_data['data_summary'][k] = v
    
    index_data['updated_at'] = now
    with open(index_path, 'w', encoding='utf-8') as f:
        json.dump(index_data, f, ensure_ascii=False, indent=2)
    
    # 2. 更新 enterprise_info.json（如果传入了企业信息更新）
    # 通常由 info-collector 负责更新，其他技能只读取
    
    # 3. 更新 experience_base.json（经验沉淀）
    if experience_entry:
        exp_path = os.path.join(KNOWLEDGE_BASE_DIR, 'experience_base.json')
        exp_data = {}
        if os.path.exists(exp_path):
            try:
                with open(exp_path, 'r', encoding='utf-8') as f:
                    exp_data = json.load(f)
            except (json.JSONDecodeError, IOError):
                pass
        
        exp_data.setdefault('common_issues', [])
        exp_data.setdefault('validation_rules', [])
        exp_data.setdefault('format_requirements', [])
        exp_data.setdefault('review_checkpoints', [])
        exp_data.setdefault('best_practices', [])
        
        cat = experience_entry['category']
        if cat in exp_data:
            exp_data[cat].append({
                'title': experience_entry.get('title', ''),
                'content': experience_entry.get('content', ''),
                'source_skill': skill_name,
                'added_at': now
            })
        
        exp_data['updated_at'] = now
        with open(exp_path, 'w', encoding='utf-8') as f:
            json.dump(exp_data, f, ensure_ascii=False, indent=2)
    
    print(f"[知识库] {skill_name} 已更新项目知识库（{now}）")


def init_project_knowledge_if_needed(enterprise_name='', application_year=2026):
    """如果知识库不存在，则初始化（所有技能可安全调用）"""
    os.makedirs(KNOWLEDGE_BASE_DIR, exist_ok=True)
    index_path = os.path.join(KNOWLEDGE_BASE_DIR, 'project_index.json')
    
    if not os.path.exists(index_path):
        now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        index_data = {
            'project_name': f"{enterprise_name}_高新认定_{application_year}",
            'enterprise_name': enterprise_name,
            'application_year': application_year,
            'recent_three_years': [application_year - 3, application_year - 2, application_year - 1],
            'last_year': application_year - 1,
            'created_at': now,
            'updated_at': now,
            'file_structure': {'description': '已识别文件结构图', 'tree': {}},
            'knowledge_graph': {'description': '关联图谱', 'nodes': [], 'edges': []},
            'progress_tracking': {'description': '完成进度', 'categories': {}},
            'data_summary': {
                'description': '数据统计',
                'ip_count': 0, 'rd_count': 0, 'ps_count': 0,
                'achievement_count': 0, 'staff_count': 0,
                'total_employees': 0, 'rd_expenses_total': 0, 'revenue_total': 0
            }
        }
        with open(index_path, 'w', encoding='utf-8') as f:
            json.dump(index_data, f, ensure_ascii=False, indent=2)
        
        # 初始化企业信息模板
        ent_path = os.path.join(KNOWLEDGE_BASE_DIR, 'enterprise_info.json')
        if not os.path.exists(ent_path):
            ent_data = {
                'enterprise_name': enterprise_name,
                'registered_address': '', 'establishment_date': '',
                'business_scope': '', 'main_business': '',
                'tech_field': '', 'tech_field_code': '',
                'total_employees': 0, 'rd_staff_count': 0, 'rd_staff_ratio': 0,
                'rd_site_area': 0, 'rd_equipment_total_value': 0, 'rd_equipment_count': 0,
                'contact_person': '', 'contact_phone': '', 'contact_email': '',
                'application_year': application_year,
                'recent_three_years': [application_year - 3, application_year - 2, application_year - 1],
                'last_year': application_year - 1,
                'updated_at': now
            }
            with open(ent_path, 'w', encoding='utf-8') as f:
                json.dump(ent_data, f, ensure_ascii=False, indent=2)
        
        # 初始化经验库模板
        exp_path = os.path.join(KNOWLEDGE_BASE_DIR, 'experience_base.json')
        if not os.path.exists(exp_path):
            exp_data = {
                'common_issues': [], 'validation_rules': [],
                'format_requirements': [], 'review_checkpoints': [],
                'best_practices': [], 'updated_at': now
            }
            with open(exp_path, 'w', encoding='utf-8') as f:
                json.dump(exp_data, f, ensure_ascii=False, indent=2)
        
        print(f"[知识库] 已初始化项目知识库（{enterprise_name}_{application_year}）")


# ============================================================
# 网报系统编号映射表（v1.3.0新增，基于量必达、安高模具、盛迪嘉支付项目分析）
# 实际项目中"00 合订本"目录按网报系统上传顺序编号01-25
# 此映射表用于：
#   1. 生成合订本时自动编号
#   2. 识别已上传文件对应的资料类别
#   3. 校验网报上传完整性
# ============================================================

NETWORK_REPORT_NUMBER_MAPPING = {
    # 编号: (资料类别, 文件描述, 对应技能, 是否必须)
    '01': ('申报书', '申报书封皮', 'gxtz-core-tables', True),
    '02': ('申报书', '企业承诺书', 'gxtz-core-tables', True),
    '03': ('申报书', '高新技术企业认定申请书', 'gxtz-core-tables', True),
    '04': ('基础资质', '营业执照', 'gxtz-info-collector', True),
    '05': ('基础资质', '法定代表人身份证', 'gxtz-info-collector', True),
    '06': ('财务资料', '{近三年第一年}财务审计报告', None, True),  # 外部资料
    '07': ('财务资料', '{近三年第二年}财务审计报告', None, True),
    '08': ('财务资料', '{近三年第三年}财务审计报告', None, True),
    '09': ('财务资料', '近三年研发费用专项审计报告', None, True),
    '10': ('财务资料', '上年度高新技术产品（服务）收入专项审计报告', None, True),
    '11': ('财务资料', '{近三年第一年}企业所得税纳税申报表', None, True),
    '12': ('财务资料', '{近三年第二年}企业所得税纳税申报表', None, True),
    '13': ('财务资料', '{近三年第三年}企业所得税纳税申报表', None, True),
    '14': ('管理制度', '企业研究开发组织管理制度+研发投入核算体系+研发费用辅助账证明材料', 'gxtz-management-materials', True),
    '15': ('管理制度', '设立内部研发机构+产学研合作证明材料', 'gxtz-management-materials', True),
    '16': ('管理制度', '科技成果转化组织实施与激励奖励制度+创新创业平台证明材料', 'gxtz-management-materials', True),
    '17': ('管理制度', '科技人员培养进修+人才引进+绩效评价奖励制度证明材料', 'gxtz-management-materials', True),
    '18': ('科技人员', '人力资源情况证明材料', 'gxtz-staff-materials', True),
    '19': ('知识产权', '知识产权汇总（IP.pdf合并件）', 'gxtz-ip-materials', True),
    '20': ('研发项目', '研发项目汇总（RD.pdf合并件）', 'gxtz-rd-report', True),
    '21': ('高新产品', '高新技术产品（服务）明细PS01', 'gxtz-ps-materials', True),
    '22': ('高新产品', '高新技术产品（服务）明细PS02+（如有多个PS依次编号）', 'gxtz-ps-materials', True),
    '23': ('合同发票', '上年度与高新技术产品相关的代表性销售合同与发票', 'gxtz-ps-materials', True),
    '24': ('成果转化', '科技成果转化情况汇总（成果转化.pdf合并件）', 'gxtz-achievement-materials', True),
    '25': ('申报书', '企业承诺书（结尾重复）', 'gxtz-core-tables', True),
}


def get_network_report_number(material_category, material_description=''):
    """根据资料类别获取网报编号（v1.3.0新增）
    
    Args:
        material_category: 资料类别（如'知识产权'、'研发项目'、'管理制度'等）
        material_description: 资料描述（可选，用于精确匹配）
        
    Returns:
        str: 网报编号（如'19'），未找到返回None
    """
    for number, (category, desc, _, _) in NETWORK_REPORT_NUMBER_MAPPING.items():
        if category == material_category:
            if not material_description or material_description in desc or desc in material_description:
                return number
    return None


def validate_network_report_completeness(project_root):
    """校验网报上传完整性（v1.3.0新增）
    
    检查"00 合订本"目录下的文件是否覆盖所有必须的网报编号（01-25）。
    基于实际项目分析，"00 合订本"目录的文件以"两位数字序号 + 描述.pdf"命名。
    
    Args:
        project_root: 项目根目录路径
        
    Returns:
        dict: {
            'found_numbers': [已找到的编号列表],
            'missing_numbers': [缺失的编号列表],
            'missing_descriptions': [缺失项的描述列表],
            'extra_files': [未识别编号的文件列表],
            'is_complete': bool
        }
    """
    import re
    
    # 查找"00 合订本"目录
    hedingben_dir = None
    for entry in os.listdir(project_root):
        full_path = os.path.join(project_root, entry)
        if os.path.isdir(full_path) and '合订本' in entry:
            hedingben_dir = full_path
            break
    
    if not hedingben_dir:
        return {
            'found_numbers': [],
            'missing_numbers': list(NETWORK_REPORT_NUMBER_MAPPING.keys()),
            'missing_descriptions': [v[1] for v in NETWORK_REPORT_NUMBER_MAPPING.values()],
            'extra_files': [],
            'is_complete': False,
            'error': '未找到"00 合订本"目录'
        }
    
    found_numbers = set()
    extra_files = []
    
    # 扫描合订本目录下的文件
    for entry in os.listdir(hedingben_dir):
        if os.path.isfile(os.path.join(hedingben_dir, entry)):
            # 提取文件名开头的两位数字
            match = re.match(r'^(\d{2})\s', entry)
            if match:
                number = match.group(1)
                if number in NETWORK_REPORT_NUMBER_MAPPING:
                    found_numbers.add(number)
                else:
                    extra_files.append(entry)
            else:
                # 非编号文件（如目录.docx、章节标题.docx等）
                if entry not in ['目录.docx', '目录.pdf', '章节标题.docx', '章节标题.pdf']:
                    extra_files.append(entry)
    
    # 计算缺失项
    missing_numbers = [n for n in NETWORK_REPORT_NUMBER_MAPPING.keys() if n not in found_numbers]
    missing_descriptions = [NETWORK_REPORT_NUMBER_MAPPING[n][1] for n in missing_numbers]
    
    return {
        'found_numbers': sorted(found_numbers),
        'missing_numbers': sorted(missing_numbers),
        'missing_descriptions': missing_descriptions,
        'extra_files': extra_files,
        'is_complete': len(missing_numbers) == 0
    }
```

---

## 模块三：统一资料整理（unified_finalize）

**用途**：所有技能执行完成后，自动根据统一逻辑整理资料，将生成的文件分类归档到统一目录结构。

```python
import os
import shutil
from datetime import datetime

# 统一输出目录结构
STANDARD_SUBDIRS = {
    '00_核心表格': ['ip_table', 'rd_table', 'ps_table', 'achievement_table', 'rd_ps_ip_summary'],
    '01_研发立项报告': ['rd_report', '立项报告'],
    '02_知识产权证明': ['ip_materials', '专利证书', '软著证书', '知识产权'],
    '03_成果转化证明': ['achievement_materials', '成果转化'],
    '04_高新产品证明': ['ps_materials', '高新产品', '产品证明'],
    '05_科技人员材料': ['staff_materials', '科技人员', '人员材料'],
    '06_管理制度材料': ['management_materials', '管理制度', '制度材料'],
    '07_资料收集清单': ['checklist', '收集清单', 'info_collector'],
    '_校验报告': ['audit', '校验', '审核', 'validation']
}


def unified_finalize_materials(enterprise_name, application_year, skill_name, 
                                output_files, skill_output_subdir=None):
    """统一资料整理函数 - 所有技能执行完成后自动调用
    
    功能：
    1. 确保统一输出目录结构存在
    2. 将本技能生成的文件归类到正确的子目录
    3. 生成/更新全局材料清单（manifest.json）
    4. 返回整理报告
    
    Args:
        enterprise_name: 企业名称
        application_year: 申报年份
        skill_name: 技能名称
        output_files: 本技能生成的文件列表，每项为 dict:
                      {'path': str, 'type': 'pdf'|'docx'|'xlsx'|'png'|...,
                       'category': str, 'description': str}
        skill_output_subdir: 本技能应归属的子目录名（如 '02_知识产权证明'）
    
    Returns:
        dict: 整理报告
    """
    root_dir = f"{enterprise_name}_高新认定材料_{application_year}"
    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    
    # 1. 确保统一目录结构存在
    for subdir in STANDARD_SUBDIRS:
        os.makedirs(os.path.join(root_dir, subdir), exist_ok=True)
    
    # 2. 确定本技能的目标子目录
    if skill_output_subdir is None:
        # 根据 skill_name 自动匹配
        skill_to_subdir = {
            'gxtz-core-tables': '00_核心表格',
            'gxtz-rd-report': '01_研发立项报告',
            'gxtz-ip-materials': '02_知识产权证明',
            'gxtz-achievement-materials': '03_成果转化证明',
            'gxtz-ps-materials': '04_高新产品证明',
            'gxtz-staff-materials': '05_科技人员材料',
            'gxtz-management-materials': '06_管理制度材料',
            'gxtz-info-collector': '07_资料收集清单'
        }
        skill_output_subdir = skill_to_subdir.get(skill_name, '07_资料收集清单')
    
    target_dir = os.path.join(root_dir, skill_output_subdir)
    os.makedirs(target_dir, exist_ok=True)
    
    # 3. 归类文件
    moved_files = []
    skipped_files = []
    
    for file_info in output_files:
        src_path = file_info.get('path', '')
        if not src_path or not os.path.exists(src_path):
            skipped_files.append({'path': src_path, 'reason': '文件不存在'})
            continue
        
        filename = os.path.basename(src_path)
        dst_path = os.path.join(target_dir, filename)
        
        # 如果文件已在目标目录，跳过
        if os.path.normpath(os.path.dirname(src_path)) == os.path.normpath(target_dir):
            moved_files.append({'path': dst_path, 'action': '已在目标目录', **file_info})
            continue
        
        # 移动文件（如果目标已存在同名文件，添加后缀）
        if os.path.exists(dst_path):
            name, ext = os.path.splitext(filename)
            counter = 1
            while os.path.exists(os.path.join(target_dir, f"{name}_{counter}{ext}")):
                counter += 1
            dst_path = os.path.join(target_dir, f"{name}_{counter}{ext}")
        
        try:
            shutil.copy2(src_path, dst_path)
            moved_files.append({'path': dst_path, 'action': '已复制', **file_info})
        except Exception as e:
            skipped_files.append({'path': src_path, 'reason': f'复制失败: {e}'})
    
    # 4. 生成/更新全局材料清单
    manifest_path = os.path.join(root_dir, 'manifest.json')
    manifest = {}
    if os.path.exists(manifest_path):
        try:
            with open(manifest_path, 'r', encoding='utf-8') as f:
                import json
                manifest = json.load(f)
        except (json.JSONDecodeError, IOError):
            manifest = {}
    
    manifest.setdefault('materials', {})
    manifest['materials'][skill_name] = {
        'subdir': skill_output_subdir,
        'file_count': len(moved_files),
        'files': moved_files,
        'updated_at': now
    }
    manifest['last_updated'] = now
    
    import json
    with open(manifest_path, 'w', encoding='utf-8') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    
    # 5. 生成整理报告
    report = {
        'skill_name': skill_name,
        'enterprise_name': enterprise_name,
        'application_year': application_year,
        'target_subdir': skill_output_subdir,
        'total_files': len(output_files),
        'moved_files': len(moved_files),
        'skipped_files': len(skipped_files),
        'skipped_details': skipped_files,
        'manifest_path': manifest_path,
        'finalized_at': now
    }
    
    print(f"[统一整理] {skill_name} 已完成资料整理：{len(moved_files)}个文件归档到 {skill_output_subdir}")
    return report


# ============================================================
# 多版本文件管理（v1.3.0新增，基于实际项目资料结构分析）
# 实际项目中同一文件存在多个版本：
#   - Word源文件（.docx）：用于编辑和网报录入
#   - PDF电子版：Word导出的PDF，用于盖章前
#   - PDF盖章版：盖章后扫描的PDF，带"_扫描版"后缀
#   - PDF合订版：多个文件合并的PDF
#   - PDF瘦身版：体积压缩后的PDF，带"(已瘦身)"或"(已优化)"后缀
# 例如量必达项目：
#   RD01_具有数据恢复功能的高性能智能卡研发.docx（Word源）
#   RD01_具有数据恢复功能的高性能智能卡研发.pdf（电子版）
#   RD01_具有数据恢复功能的高性能智能卡研发_扫描版.pdf（盖章扫描版）
# ============================================================

# 文件版本后缀标识
FILE_VERSION_SUFFIXES = {
    'source': ['.docx', '.doc'],  # Word源文件
    'electronic': ['.pdf'],  # PDF电子版（无特殊后缀）
    'scanned': ['_扫描版', '_盖章扫描', '_盖章版', '盖章V2', '_已盖章'],  # 盖章扫描版
    'merged': ['合并', '合订', '汇总'],  # 合并版
    'optimized': ['(已优化)', '(已瘦身)', '_优化', '_瘦身'],  # 瘦身版
    'template': ['模板', '模版', '【模版文件】', '【模板】'],  # 模板文件
    'temp': ['~$', ' - 副本', '(1)', '(2)'],  # 临时/重复文件
}


def identify_file_version(file_path):
    """识别文件版本类型（v1.3.0新增）
    
    根据文件名后缀和扩展名识别文件版本类型。
    
    Args:
        file_path: 文件路径
        
    Returns:
        dict: {
            'version_type': 'source'/'electronic'/'scanned'/'merged'/'optimized'/'template'/'temp'/'unknown',
            'is_final': bool,  # 是否为最终版本（扫描版或合订版）
            'should_clean': bool  # 是否建议清理（临时文件、重复文件）
        }
    """
    basename = os.path.basename(file_path)
    ext = os.path.splitext(basename)[1].lower()
    
    # 检查临时文件（最高优先级）
    for pattern in FILE_VERSION_SUFFIXES['temp']:
        if pattern in basename:
            return {'version_type': 'temp', 'is_final': False, 'should_clean': True}
    
    # 检查模板文件
    for pattern in FILE_VERSION_SUFFIXES['template']:
        if pattern in basename:
            return {'version_type': 'template', 'is_final': False, 'should_clean': False}
    
    # 检查瘦身版
    for pattern in FILE_VERSION_SUFFIXES['optimized']:
        if pattern in basename:
            return {'version_type': 'optimized', 'is_final': False, 'should_clean': False}
    
    # 检查合并版
    for pattern in FILE_VERSION_SUFFIXES['merged']:
        if pattern in basename:
            return {'version_type': 'merged', 'is_final': True, 'should_clean': False}
    
    # 检查盖章扫描版
    for pattern in FILE_VERSION_SUFFIXES['scanned']:
        if pattern in basename:
            return {'version_type': 'scanned', 'is_final': True, 'should_clean': False}
    
    # 检查Word源文件
    if ext in FILE_VERSION_SUFFIXES['source']:
        return {'version_type': 'source', 'is_final': False, 'should_clean': False}
    
    # 默认为电子版
    if ext == '.pdf':
        return {'version_type': 'electronic', 'is_final': False, 'should_clean': False}
    
    return {'version_type': 'unknown', 'is_final': False, 'should_clean': False}


def group_files_by_base_name(file_list):
    """按基础名称分组文件（v1.3.0新增）
    
    将同一资料的不同版本文件分组。例如：
    RD01_xxx.docx, RD01_xxx.pdf, RD01_xxx_扫描版.pdf 会被分到同一组。
    
    Args:
        file_list: 文件路径列表
        
    Returns:
        dict: {基础名称: {'source': path, 'electronic': path, 'scanned': path, ...}}
    """
    import re
    
    groups = {}
    
    for file_path in file_list:
        basename = os.path.basename(file_path)
        name_without_ext = os.path.splitext(basename)[0]
        
        # 提取基础名称（去除版本后缀）
        base_name = name_without_ext
        for patterns in [FILE_VERSION_SUFFIXES['scanned'], FILE_VERSION_SUFFIXES['merged'],
                        FILE_VERSION_SUFFIXES['optimized'], FILE_VERSION_SUFFIXES['temp']]:
            for pattern in patterns:
                if pattern in base_name:
                    base_name = base_name.replace(pattern, '').strip()
                    break
        
        # 清理多余空格和下划线
        base_name = re.sub(r'_+', '_', base_name).strip('_').strip()
        
        version_info = identify_file_version(file_path)
        version_type = version_info['version_type']
        
        if base_name not in groups:
            groups[base_name] = {}
        
        # 同一版本类型保留最新（按修改时间）
        if version_type not in groups[base_name]:
            groups[base_name][version_type] = file_path
        else:
            existing_mtime = os.path.getmtime(groups[base_name][version_type])
            current_mtime = os.path.getmtime(file_path)
            if current_mtime > existing_mtime:
                groups[base_name][version_type] = file_path
    
    return groups


def clean_temp_files(project_root, dry_run=True):
    """清理临时文件和重复文件（v1.3.0新增）
    
    基于实际项目分析，发现以下问题文件：
    - Word临时文件（~$开头）
    - 重复下载文件（带(1)、(2)后缀）
    - " - 副本"后缀文件
    
    Args:
        project_root: 项目根目录路径
        dry_run: True仅列出待清理文件，False实际删除
        
    Returns:
        dict: {
            'temp_files': [临时文件列表],
            'duplicate_files': [重复文件列表],
            'cleaned_count': int,  # 实际清理数量
            'dry_run': bool
        }
    """
    temp_files = []
    duplicate_files = []
    cleaned_count = 0
    
    for root, dirs, files in os.walk(project_root):
        # 跳过隐藏目录和缓存目录
        dirs[:] = [d for d in dirs if not d.startswith('.') and d not in ['__pycache__', 'node_modules']]
        
        for fname in files:
            file_path = os.path.join(root, fname)
            version_info = identify_file_version(file_path)
            
            if version_info['should_clean']:
                if version_info['version_type'] == 'temp':
                    # 区分临时文件和重复文件
                    if fname.startswith('~$'):
                        temp_files.append(file_path)
                    else:
                        duplicate_files.append(file_path)
                    
                    if not dry_run:
                        try:
                            os.remove(file_path)
                            cleaned_count += 1
                        except Exception as e:
                            print(f"[清理] 删除失败 {file_path}: {e}")
    
    return {
        'temp_files': temp_files,
        'duplicate_files': duplicate_files,
        'cleaned_count': cleaned_count,
        'dry_run': dry_run
    }
```

---

## 模块四：有效资料文件梳理图谱（file_map）

**用途**：在project_knowledge中维护一份有效资料文件的详细梳理图谱，agent执行时先读取图谱快速定位文件，不需要全面搜索。

```python
import os
import json
from datetime import datetime

KNOWLEDGE_BASE_DIR = os.path.join('.trae', 'project_knowledge')
FILE_MAP_PATH = os.path.join(KNOWLEDGE_BASE_DIR, 'file_map.json')


def init_file_map_if_needed(enterprise_name='', application_year=2026):
    """初始化文件梳理图谱（如果不存在）"""
    os.makedirs(KNOWLEDGE_BASE_DIR, exist_ok=True)
    if not os.path.exists(FILE_MAP_PATH):
        now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        file_map = {
            'description': '有效资料文件详细梳理图谱 - agent快速定位文件，避免全面搜索',
            'enterprise_name': enterprise_name,
            'application_year': application_year,
            'created_at': now,
            'updated_at': now,
            'files': {},
            'categories': {
                '01_基础资质': [],
                '02_知识产权': [],
                '03_研发项目': [],
                '04_高新产品': [],
                '05_科技人员': [],
                '06_财务资料': [],
                '07_管理制度': [],
                '08_合同发票': [],
                '09_照片资料': [],
                '10_其他资料': []
            },
            'quick_index': {
                'by_ip_id': {},
                'by_rd_id': {},
                'by_ps_id': {},
                'by_achievement_id': {},
                'by_staff_name': {},
                'by_keyword': {}
            }
        }
        with open(FILE_MAP_PATH, 'w', encoding='utf-8') as f:
            json.dump(file_map, f, ensure_ascii=False, indent=2)


def load_file_map():
    """读取文件梳理图谱"""
    if os.path.exists(FILE_MAP_PATH):
        try:
            with open(FILE_MAP_PATH, 'r', encoding='utf-8') as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError):
            pass
    return None


def add_file_to_map(file_path, category, file_type='unknown', related_id=None,
                     related_name=None, content_summary='', validity='valid',
                     keywords=None, skill_name=None):
    """向文件梳理图谱中添加一个文件

    Args:
        file_path: 文件绝对路径
        category: 文件类别（01_基础资质/02_知识产权/.../10_其他资料）
        file_type: 文件类型（pdf/docx/xlsx/png/jpg/zip等）
        related_id: 关联对象编号（如IP01、RD01、PS01）
        related_name: 关联对象名称
        content_summary: 内容摘要（简短描述文件内容）
        validity: 有效性状态（valid/invalid/pending_review）
        keywords: 关键词列表，用于快速检索
        skill_name: 添加此文件的技能名称
    """
    file_map = load_file_map()
    if not file_map:
        init_file_map_if_needed()
        file_map = load_file_map()

    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    filename = os.path.basename(file_path)
    file_key = os.path.abspath(file_path)

    # 添加到files字典
    file_map['files'][file_key] = {
        'filename': filename,
        'path': file_path,
        'category': category,
        'file_type': file_type,
        'related_id': related_id or '',
        'related_name': related_name or '',
        'content_summary': content_summary,
        'validity': validity,
        'keywords': keywords or [],
        'added_by': skill_name or 'unknown',
        'added_at': now,
        'last_verified': now
    }

    # 添加到类别索引
    if category not in file_map['categories']:
        file_map['categories'][category] = []
    if file_key not in file_map['categories'][category]:
        file_map['categories'][category].append(file_key)

    # 添加到快速索引
    if related_id:
        if related_id.startswith('IP'):
            file_map['quick_index']['by_ip_id'].setdefault(related_id, []).append(file_key)
        elif related_id.startswith('RD'):
            file_map['quick_index']['by_rd_id'].setdefault(related_id, []).append(file_key)
        elif related_id.startswith('PS'):
            file_map['quick_index']['by_ps_id'].setdefault(related_id, []).append(file_key)
        elif related_id.startswith('ACH'):
            file_map['quick_index']['by_achievement_id'].setdefault(related_id, []).append(file_key)

    if related_name:
        file_map['quick_index']['by_staff_name'].setdefault(related_name, []).append(file_key)

    if keywords:
        for kw in keywords:
            file_map['quick_index']['by_keyword'].setdefault(kw, []).append(file_key)

    file_map['updated_at'] = now
    with open(FILE_MAP_PATH, 'w', encoding='utf-8') as f:
        json.dump(file_map, f, ensure_ascii=False, indent=2)


def find_files_in_map(category=None, related_id=None, keyword=None, file_type=None):
    """从文件梳理图谱中快速查找文件（无需全面搜索文件系统）

    Args:
        category: 文件类别（可选）
        related_id: 关联对象编号（可选，如IP01）
        keyword: 关键词（可选）
        file_type: 文件类型（可选，如pdf）

    Returns:
        list: 匹配的文件路径列表
    """
    file_map = load_file_map()
    if not file_map:
        return []

    matched_files = []

    # 优先使用快速索引
    if related_id:
        quick = file_map.get('quick_index', {})
        if related_id.startswith('IP'):
            matched_files = quick.get('by_ip_id', {}).get(related_id, [])
        elif related_id.startswith('RD'):
            matched_files = quick.get('by_rd_id', {}).get(related_id, [])
        elif related_id.startswith('PS'):
            matched_files = quick.get('by_ps_id', {}).get(related_id, [])
        elif related_id.startswith('ACH'):
            matched_files = quick.get('by_achievement_id', {}).get(related_id, [])
        matched_files = list(matched_files)
    elif keyword:
        matched_files = list(file_map.get('quick_index', {}).get('by_keyword', {}).get(keyword, []))
    elif category:
        matched_files = list(file_map.get('categories', {}).get(category, []))
    else:
        # 返回所有文件
        matched_files = list(file_map.get('files', {}).keys())

    # 按文件类型过滤
    if file_type:
        filtered = []
        for fk in matched_files:
            f_info = file_map.get('files', {}).get(fk, {})
            if f_info.get('file_type') == file_type:
                filtered.append(fk)
        matched_files = filtered

    # 验证文件是否存在
    existing_files = [f for f in matched_files if os.path.exists(f)]

    return existing_files


def get_file_info_from_map(file_path):
    """从图谱中获取单个文件的详细信息"""
    file_map = load_file_map()
    if not file_map:
        return None
    file_key = os.path.abspath(file_path)
    return file_map.get('files', {}).get(file_key)


def update_file_validity(file_path, validity, content_summary=None):
    """更新文件的有效性状态和内容摘要"""
    file_map = load_file_map()
    if not file_map:
        return
    file_key = os.path.abspath(file_path)
    if file_key in file_map.get('files', {}):
        file_map['files'][file_key]['validity'] = validity
        file_map['files'][file_key]['last_verified'] = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        if content_summary:
            file_map['files'][file_key]['content_summary'] = content_summary
        file_map['updated_at'] = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        with open(FILE_MAP_PATH, 'w', encoding='utf-8') as f:
            json.dump(file_map, f, ensure_ascii=False, indent=2)


def generate_file_map_summary():
    """生成文件图谱摘要报告"""
    file_map = load_file_map()
    if not file_map:
        return "文件图谱不存在"

    summary = {
        'total_files': len(file_map.get('files', {})),
        'by_category': {},
        'by_validity': {'valid': 0, 'invalid': 0, 'pending_review': 0},
        'by_type': {}
    }

    for file_key, file_info in file_map.get('files', {}).items():
        cat = file_info.get('category', '未分类')
        summary['by_category'][cat] = summary['by_category'].get(cat, 0) + 1

        val = file_info.get('validity', 'pending_review')
        summary['by_validity'][val] = summary['by_validity'].get(val, 0) + 1

        ftype = file_info.get('file_type', 'unknown')
        summary['by_type'][ftype] = summary['by_type'].get(ftype, 0) + 1

    return summary


# ============================================================
# 文件管理强制校验与报告（v1.7.0新增，强制执行机制）
# 解决问题：技能执行时跳过知识库更新，导致file_map.json、
#           experience_base.json、project_index.json未生成
# 解决方案：新增强制校验函数和报告生成函数，技能执行完成后必须调用
# ============================================================

def validate_file_management_completion(project_dir=None):
    """校验文件管理模块是否完成（v1.7.0新增强制校验）
    
    技能执行完成后必须调用此函数，验证文件图谱、经验库、知识图谱3个文件已生成且非空。
    校验失败时自动重新生成。
    
    Args:
        project_dir: 项目根目录，默认为当前工作目录
    
    Returns:
        dict: {
            'all_passed': bool,  # 是否全部通过
            'checks': list,  # 每个文件的校验结果
            'regenerated': list,  # 重新生成的文件列表
            'report': str,  # 校验报告文本
        }
    """
    # 确定项目根目录与知识库目录（与模块四保持一致：.trae/project_knowledge/）
    if project_dir is None:
        project_dir = os.getcwd()
    kb_dir = os.path.join(project_dir, '.trae', 'project_knowledge')
    os.makedirs(kb_dir, exist_ok=True)

    # 需要校验的3个核心文件
    targets = [
        {
            'name': 'file_map.json',
            'path': os.path.join(kb_dir, 'file_map.json'),
            'kind': 'file_map',
        },
        {
            'name': 'experience_base.json',
            'path': os.path.join(kb_dir, 'experience_base.json'),
            'kind': 'experience_base',
        },
        {
            'name': 'project_index.json',
            'path': os.path.join(kb_dir, 'project_index.json'),
            'kind': 'project_index',
        },
    ]

    checks = []
    regenerated = []

    def _is_nonempty_json(path):
        """判断文件存在且为非空的有效JSON（且包含内容）"""
        if not os.path.exists(path):
            return False, '文件不存在'
        try:
            if os.path.getsize(path) == 0:
                return False, '文件为空'
            with open(path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            if not data:
                return False, 'JSON内容为空'
            return True, 'OK'
        except (json.JSONDecodeError, IOError) as e:
            return False, f'JSON解析失败: {e}'

    for target in targets:
        passed, msg = _is_nonempty_json(target['path'])
        checks.append({
            'file': target['name'],
            'path': target['path'],
            'passed': passed,
            'message': msg,
        })

        # 校验失败时自动重新生成
        if not passed:
            try:
                if target['kind'] == 'file_map':
                    # file_map.json不存在→调用init_file_map_if_needed重新生成
                    # 优先使用全局FILE_MAP_PATH，确保与现有函数一致
                    init_file_map_if_needed('', 2026)
                    # 重新校验
                    passed2, msg2 = _is_nonempty_json(FILE_MAP_PATH)
                    # 兼容：若全局FILE_MAP_PATH与项目目录不一致，则用项目目录
                    if not passed2:
                        fm_path = os.path.join(kb_dir, 'file_map.json')
                        if not os.path.exists(fm_path):
                            now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
                            empty_map = {
                                'description': '有效资料文件详细梳理图谱 - agent快速定位文件，避免全面搜索',
                                'enterprise_name': '',
                                'application_year': 2026,
                                'created_at': now,
                                'updated_at': now,
                                'files': {},
                                'categories': {
                                    '01_基础资质': [], '02_知识产权': [], '03_研发项目': [],
                                    '04_高新产品': [], '05_科技人员': [], '06_财务资料': [],
                                    '07_管理制度': [], '08_合同发票': [], '09_照片资料': [],
                                    '10_其他资料': []
                                },
                                'quick_index': {
                                    'by_ip_id': {}, 'by_rd_id': {}, 'by_ps_id': {},
                                    'by_achievement_id': {}, 'by_staff_name': {}, 'by_keyword': {}
                                }
                            }
                            with open(fm_path, 'w', encoding='utf-8') as f:
                                json.dump(empty_map, f, ensure_ascii=False, indent=2)
                        regenerated.append('file_map.json')

                elif target['kind'] == 'experience_base':
                    # experience_base.json不存在→创建空经验库
                    exp_path = target['path']
                    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
                    empty_exp = {
                        'common_issues': [],
                        'validation_rules': [],
                        'format_requirements': [],
                        'review_checkpoints': [],
                        'best_practices': [],
                        'updated_at': now
                    }
                    with open(exp_path, 'w', encoding='utf-8') as f:
                        json.dump(empty_exp, f, ensure_ascii=False, indent=2)
                    regenerated.append('experience_base.json')

                elif target['kind'] == 'project_index':
                    # project_index.json不存在→创建空知识图谱
                    idx_path = target['path']
                    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
                    empty_index = {
                        'project_name': '',
                        'enterprise_name': '',
                        'application_year': 2026,
                        'recent_three_years': [2023, 2024, 2025],
                        'last_year': 2025,
                        'created_at': now,
                        'updated_at': now,
                        'file_structure': {'description': '已识别文件结构图', 'tree': {}},
                        'knowledge_graph': {'description': '关联图谱', 'nodes': [], 'edges': []},
                        'progress_tracking': {'description': '完成进度', 'categories': {}},
                        'data_summary': {
                            'description': '数据统计',
                            'ip_count': 0, 'rd_count': 0, 'ps_count': 0,
                            'achievement_count': 0, 'staff_count': 0,
                            'total_employees': 0, 'rd_expenses_total': 0, 'revenue_total': 0
                        }
                    }
                    with open(idx_path, 'w', encoding='utf-8') as f:
                        json.dump(empty_index, f, ensure_ascii=False, indent=2)
                    regenerated.append('project_index.json')

            except Exception as e:
                checks[-1]['message'] = f"{msg}; 重新生成失败: {e}"

    all_passed = all(c['passed'] for c in checks)

    # 生成校验报告文本
    lines = ["# 文件管理校验报告（v1.7.0）", ""]
    lines.append(f"- 项目目录: {project_dir}")
    lines.append(f"- 知识库目录: {kb_dir}")
    lines.append(f"- 校验时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    lines.append(f"- 总体结果: {'✅ 全部通过' if all_passed else '❌ 存在失败项'}")
    lines.append("")
    lines.append("## 校验明细")
    for c in checks:
        status = '✅ 通过' if c['passed'] else '❌ 失败'
        lines.append(f"- {c['file']} [{status}] {c['message']}")
    if regenerated:
        lines.append("")
        lines.append("## 重新生成的文件")
        for r in regenerated:
            lines.append(f"- {r}")
    report = "\n".join(lines)

    return {
        'all_passed': all_passed,
        'checks': checks,
        'regenerated': regenerated,
        'report': report,
    }


def generate_file_management_report(project_dir=None, skill_name='', execution_summary=None):
    """生成文件管理报告（v1.7.0新增强制生成）
    
    技能执行完成后必须生成此报告，记录本次执行的文件管理成果。
    报告输出到 {企业材料目录}/_file_management_report.md。
    
    Args:
        project_dir: 项目根目录，默认为当前工作目录
        skill_name: 技能名称
        execution_summary: 执行摘要dict，可包含:
            - 'identified_files': 本次识别的文件列表
            - 'issues': 遇到的问题
            - 'rules': 校验规则
            - 'best_practices': 最佳实践
    
    Returns:
        str: 报告文件路径
    """
    if project_dir is None:
        project_dir = os.getcwd()
    if execution_summary is None:
        execution_summary = {}

    kb_dir = os.path.join(project_dir, '.trae', 'project_knowledge')

    # 1. 文件图谱摘要
    file_map_summary = generate_file_map_summary() or {}

    # 2. 经验库摘要
    exp_path = os.path.join(kb_dir, 'experience_base.json')
    exp_summary = {
        'common_issues': 0,
        'validation_rules': 0,
        'format_requirements': 0,
        'review_checkpoints': 0,
        'best_practices': 0,
    }
    if os.path.exists(exp_path):
        try:
            with open(exp_path, 'r', encoding='utf-8') as f:
                exp_data = json.load(f)
            for k in exp_summary:
                if isinstance(exp_data.get(k), list):
                    exp_summary[k] = len(exp_data[k])
        except (json.JSONDecodeError, IOError):
            pass

    # 3. 知识图谱摘要（节点和边数量）
    idx_path = os.path.join(kb_dir, 'project_index.json')
    kg_node_count = 0
    kg_edge_count = 0
    if os.path.exists(idx_path):
        try:
            with open(idx_path, 'r', encoding='utf-8') as f:
                idx_data = json.load(f)
            kg = idx_data.get('knowledge_graph', {})
            kg_node_count = len(kg.get('nodes', []))
            kg_edge_count = len(kg.get('edges', []))
        except (json.JSONDecodeError, IOError):
            pass

    # 4. 本次识别文件统计
    identified_files = execution_summary.get('identified_files', []) or []
    total_identified = len(identified_files)

    # 按类别分组
    files_by_category = {}
    for f_item in identified_files:
        if isinstance(f_item, dict):
            cat = f_item.get('category', '未分类')
        else:
            cat = '未分类'
        files_by_category.setdefault(cat, []).append(f_item)

    # 5. 调用强制校验函数
    validation = validate_file_management_completion(project_dir)

    # 6. 生成报告内容
    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    # 注意：使用 chr(96)*3 构造 markdown 代码围栏，避免在源码中出现字面量三连反引号
    # 否则 markdown 渲染时会提前关闭本代码块
    md_code_fence = chr(96) * 3
    lines = []
    lines.append("# 文件管理报告（v1.7.0强制生成）")
    lines.append("")
    lines.append(f"- 生成时间: {now}")
    lines.append(f"- 项目目录: {project_dir}")
    lines.append(f"- 执行技能: {skill_name or '(未指定)'}")
    lines.append("")
    lines.append("## 一、本次识别文件总数")
    lines.append("")
    lines.append(f"- 本次识别文件总数: **{total_identified}**")
    lines.append("")
    lines.append("## 二、按类别分组的文件清单")
    lines.append("")
    if files_by_category:
        for cat, files in files_by_category.items():
            lines.append(f"### {cat}（{len(files)} 个文件）")
            lines.append("")
            for f_item in files:
                if isinstance(f_item, dict):
                    fpath = f_item.get('file_path', '')
                    rid = f_item.get('related_id', '')
                    val = f_item.get('validity', '')
                    lines.append(f"- `{fpath}` | 关联ID: {rid} | 有效性: {val}")
                else:
                    lines.append(f"- `{f_item}`")
            lines.append("")
    else:
        lines.append("（本次未识别新文件）")
        lines.append("")

    lines.append("## 三、文件图谱摘要（file_map.json）")
    lines.append("")
    if file_map_summary and isinstance(file_map_summary, dict):
        lines.append(f"- 文件总数 total_files: **{file_map_summary.get('total_files', 0)}**")
        lines.append("")
        lines.append("### 按类别分布 by_category")
        lines.append("")
        by_cat = file_map_summary.get('by_category', {})
        if by_cat:
            for cat, cnt in by_cat.items():
                lines.append(f"- {cat}: {cnt}")
        else:
            lines.append("（暂无分类数据）")
        lines.append("")
        lines.append("### 按有效性分布 by_validity")
        lines.append("")
        by_val = file_map_summary.get('by_validity', {})
        if by_val:
            for val, cnt in by_val.items():
                lines.append(f"- {val}: {cnt}")
        lines.append("")
        lines.append("### 按文件类型分布 by_type")
        lines.append("")
        by_type = file_map_summary.get('by_type', {})
        if by_type:
            for ftype, cnt in by_type.items():
                lines.append(f"- {ftype}: {cnt}")
        else:
            lines.append("（暂无类型数据）")
    else:
        lines.append("- ⚠️ 文件图谱不存在或为空")
    lines.append("")

    lines.append("## 四、经验库摘要（experience_base.json）")
    lines.append("")
    lines.append(f"- common_issues（常见问题）: **{exp_summary.get('common_issues', 0)}** 条")
    lines.append(f"- validation_rules（校验规则）: **{exp_summary.get('validation_rules', 0)}** 条")
    lines.append(f"- format_requirements（格式要求）: **{exp_summary.get('format_requirements', 0)}** 条")
    lines.append(f"- review_checkpoints（审核检查点）: **{exp_summary.get('review_checkpoints', 0)}** 条")
    lines.append(f"- best_practices（最佳实践）: **{exp_summary.get('best_practices', 0)}** 条")
    lines.append("")

    lines.append("## 五、知识图谱节点和边数量（project_index.json）")
    lines.append("")
    lines.append(f"- 知识图谱节点数: **{kg_node_count}**")
    lines.append(f"- 知识图谱边数: **{kg_edge_count}**")
    lines.append("")

    lines.append("## 六、强制校验结果")
    lines.append("")
    lines.append(f"- 总体结果: {'✅ 全部通过' if validation.get('all_passed') else '❌ 存在失败项'}")
    lines.append("")
    lines.append("### 校验明细")
    lines.append("")
    for c in validation.get('checks', []):
        status = '✅ 通过' if c.get('passed') else '❌ 失败'
        lines.append(f"- {c.get('file')} [{status}] {c.get('message')}")
    if validation.get('regenerated'):
        lines.append("")
        lines.append("### 重新生成的文件")
        lines.append("")
        for r in validation.get('regenerated', []):
            lines.append(f"- {r}")
    lines.append("")

    lines.append("## 七、完整校验报告原文")
    lines.append("")
    lines.append(md_code_fence)
    lines.append(validation.get('report', ''))
    lines.append(md_code_fence)
    lines.append("")

    report_content = "\n".join(lines)

    # 7. 写入报告文件到企业材料目录
    # 寻找企业材料目录：优先使用项目根目录下的 *_高新认定材料_* 目录
    report_path = None
    if os.path.isdir(project_dir):
        # 查找企业材料目录
        candidate_dirs = []
        try:
            for name in os.listdir(project_dir):
                full = os.path.join(project_dir, name)
                if os.path.isdir(full) and '高新认定材料' in name:
                    candidate_dirs.append(full)
        except OSError:
            pass

        if candidate_dirs:
            # 取第一个匹配的企业材料目录
            enterprise_dir = candidate_dirs[0]
            report_path = os.path.join(enterprise_dir, '_file_management_report.md')
        else:
            # 找不到企业材料目录时，写入知识库目录
            report_path = os.path.join(kb_dir, '_file_management_report.md')

        try:
            os.makedirs(os.path.dirname(report_path), exist_ok=True)
            with open(report_path, 'w', encoding='utf-8') as f:
                f.write(report_content)
        except IOError as e:
            print(f"[文件管理报告] 写入失败: {e}")
            # 回退到知识库目录
            report_path = os.path.join(kb_dir, '_file_management_report.md')
            try:
                os.makedirs(kb_dir, exist_ok=True)
                with open(report_path, 'w', encoding='utf-8') as f:
                    f.write(report_content)
            except IOError as e2:
                print(f"[文件管理报告] 回退写入也失败: {e2}")
                return None

    return report_path


# ============================================================
# 命名规范校验（v1.3.0新增，基于实际项目资料结构分析）
# 实际项目中发现以下命名不规范问题：
#   1. 学历证书命名不统一（毕业证书/学历证书/毕业证/学历 4种）
#   2. 照片保留原始命名（DM_时间戳_序号、IMG_日期_时间、微信图片_xxx）
#   3. 发票保留电子发票原始命名（dzfp_编号_客户_时间）
#   4. 合同截图用hash值命名（05b10c1eb6daa6749ca5457a780ceac.png）
#   5. 多版本文件未清理（收入(2022)(已优化)(已优化)(已优化).pdf）
#   6. Word临时文件残留（~$开头）
#   7. 大小写扩展名混用（.PDF vs .pdf）
# ============================================================

# 规范命名模式（正则表达式）
NAMING_PATTERNS = {
    'IP': {
        'pattern': r'^IP\d{2}_.+\.pdf$',
        'description': 'IP{两位序号}_{知识产权名称}.pdf（如IP01_一种基于RFID的读写器.pdf）',
        'example': 'IP01_一种基于RFID读写器的微信控制标签打印机和方法.pdf',
    },
    'RD': {
        'pattern': r'^RD\d{2}_.+\.(pdf|docx|doc)$',
        'description': 'RD{两位序号}_{研发项目名称}.pdf/.docx（如RD01_具有数据恢复功能的智能卡研发.pdf）',
        'example': 'RD01_具有数据恢复功能的高性能智能卡研发.pdf',
    },
    'PS': {
        'pattern': r'^PS\d{2}_.+\.pdf$',
        'description': 'PS{两位序号}_{产品名称}.pdf（如PS01_微芯片智能卡.pdf）',
        'example': 'PS01_微芯片智能卡.pdf',
    },
    'achievement': {
        'pattern': r'^\d{1,2}_.+\.pdf$',
        'description': '{序号}_{成果名称}.pdf（如1_自动导向出料结构的高精度注塑模具.pdf）',
        'example': '1_自动导向出料结构的高精度注塑模具.pdf',
    },
    'financial_annual': {
        'pattern': r'^20\d{2}_.+\.pdf$',
        'description': '{年份}_{文件类型}.pdf（如2024_财务审计报告.pdf）',
        'example': '2024_财务审计报告.pdf',
    },
    'network_report': {
        'pattern': r'^\d{2}\s+.+\.pdf$',
        'description': '{两位序号} {文件描述}.pdf（如01 申报书封皮.pdf）',
        'example': '01 申报书封皮.pdf',
    },
    'staff_education': {
        'pattern': r'^.+学历证书\.pdf$',
        'description': '{姓名}学历证书.pdf（统一用"学历证书"，不用"毕业证"/"毕业证书"）',
        'example': '张三学历证书.pdf',
    },
    'staff_social_security': {
        'pattern': r'^.+社保缴费证明\.pdf$|^.+社保明细\.pdf$|^社会保险费缴费记录.+\.pdf$',
        'description': '{企业名称}上年12月社保缴费证明.pdf 或 社会保险费缴费记录{年月}.pdf',
        'example': 'XX公司-2024年12月社保缴费证明.pdf',
    },
}


def validate_file_naming(file_path, expected_type=None):
    """校验文件命名规范（v1.3.0新增）
    
    Args:
        file_path: 文件路径
        expected_type: 期望的命名类型（如'IP'、'RD'、'PS'等），None则自动推断
        
    Returns:
        dict: {
            'is_valid': bool,
            'actual_type': str,  # 实际匹配的类型
            'expected_type': str,  # 期望的类型
            'issue': str,  # 不规范原因（如有）
            'suggestion': str  # 建议的规范命名（如有）
        }
    """
    import re
    basename = os.path.basename(file_path)
    
    # 自动推断类型
    if not expected_type:
        if basename.startswith('IP'):
            expected_type = 'IP'
        elif basename.startswith('RD'):
            expected_type = 'RD'
        elif basename.startswith('PS'):
            expected_type = 'PS'
        elif re.match(r'^\d{1,2}_', basename):
            expected_type = 'achievement'
        elif re.match(r'^\d{2}\s', basename):
            expected_type = 'network_report'
        elif '学历' in basename or '毕业' in basename:
            expected_type = 'staff_education'
        elif '社保' in basename or '缴费' in basename:
            expected_type = 'staff_social_security'
    
    # 校验命名规范
    if expected_type and expected_type in NAMING_PATTERNS:
        pattern_info = NAMING_PATTERNS[expected_type]
        pattern = pattern_info['pattern']
        
        if re.match(pattern, basename):
            return {
                'is_valid': True,
                'actual_type': expected_type,
                'expected_type': expected_type,
                'issue': '',
                'suggestion': ''
            }
        else:
            return {
                'is_valid': False,
                'actual_type': 'unknown',
                'expected_type': expected_type,
                'issue': f'不符合{expected_type}命名规范：{pattern_info["description"]}',
                'suggestion': f'建议命名格式：{pattern_info["example"]}'
            }
    
    return {
        'is_valid': True,  # 未指定类型，默认通过
        'actual_type': 'unknown',
        'expected_type': expected_type or 'unknown',
        'issue': '',
        'suggestion': ''
    }


def batch_validate_naming(file_list):
    """批量校验文件命名规范（v1.3.0新增）
    
    Args:
        file_list: 文件路径列表
        
    Returns:
        dict: {
            'total_files': int,
            'valid_count': int,
            'invalid_count': int,
            'invalid_files': [{'file': path, 'issue': str, 'suggestion': str}, ...],
            'by_type': {类型: {'valid': int, 'invalid': int}}
        }
    """
    results = {
        'total_files': len(file_list),
        'valid_count': 0,
        'invalid_count': 0,
        'invalid_files': [],
        'by_type': {}
    }
    
    for file_path in file_list:
        result = validate_file_naming(file_path)
        file_type = result['expected_type']
        
        if file_type not in results['by_type']:
            results['by_type'][file_type] = {'valid': 0, 'invalid': 0}
        
        if result['is_valid']:
            results['valid_count'] += 1
            results['by_type'][file_type]['valid'] += 1
        else:
            results['invalid_count'] += 1
            results['by_type'][file_type]['invalid'] += 1
            results['invalid_files'].append({
                'file': file_path,
                'issue': result['issue'],
                'suggestion': result['suggestion']
            })
    
    return results


def detect_naming_issues(project_root):
    """检测项目中的命名问题（v1.3.0新增）
    
    基于实际项目分析，检测以下问题：
    1. 文件名含hash值（无业务含义）
    2. 文件名含"微信图片_"前缀（未重命名）
    3. 文件名含"DM_"前缀（扫描仪原始命名）
    4. 文件名含"IMG_"前缀（手机原始命名）
    5. 文件名含"WPS拼图"（WPS拼图导出未重命名）
    6. 文件名含多个"(已优化)"后缀（多次优化未清理）
    7. 文件名大小写扩展名不一致（.PDF vs .pdf）
    8. 学历证书命名不统一（毕业证书/学历证书/毕业证/学历）
    
    Args:
        project_root: 项目根目录路径
        
    Returns:
        dict: {
            'hash_named': [hash命名文件],
            'wechat_named': [微信图片命名文件],
            'scanner_named': [扫描仪命名文件],
            'phone_named': [手机命名文件],
            'wps_named': [WPS拼图命名文件],
            'multi_optimized': [多次优化文件],
            'case_inconsistent': [大小写不一致文件],
            'education_inconsistent': [学历证书命名不统一],
            'total_issues': int
        }
    """
    import re
    
    issues = {
        'hash_named': [],
        'wechat_named': [],
        'scanner_named': [],
        'phone_named': [],
        'wps_named': [],
        'multi_optimized': [],
        'case_inconsistent': [],
        'education_inconsistent': [],
    }
    
    hash_pattern = re.compile(r'^[a-f0-9]{32}\.', re.IGNORECASE)
    wechat_pattern = re.compile(r'^微信图片_')
    scanner_pattern = re.compile(r'^DM_\d{14}_\d{3}')
    phone_pattern = re.compile(r'^IMG_\d{8}_\d{6}')
    wps_pattern = re.compile(r'^WPS拼图\d+')
    multi_optimized_pattern = re.compile(r'\(已优化\)\(已优化\)')
    
    for root, dirs, files in os.walk(project_root):
        dirs[:] = [d for d in dirs if not d.startswith('.') and d not in ['__pycache__', 'node_modules']]
        
        for fname in files:
            file_path = os.path.join(root, fname)
            
            if hash_pattern.match(fname):
                issues['hash_named'].append(file_path)
            
            if wechat_pattern.match(fname):
                issues['wechat_named'].append(file_path)
            
            if scanner_pattern.match(fname):
                issues['scanner_named'].append(file_path)
            
            if phone_pattern.match(fname):
                issues['phone_named'].append(file_path)
            
            if wps_pattern.match(fname):
                issues['wps_named'].append(file_path)
            
            if multi_optimized_pattern.search(fname):
                issues['multi_optimized'].append(file_path)
            
            # 大小写扩展名不一致
            ext = os.path.splitext(fname)[1]
            if ext == '.PDF':
                issues['case_inconsistent'].append(file_path)
            
            # 学历证书命名不统一
            if any(kw in fname for kw in ['毕业证', '学历', '毕业证书']):
                if '学历证书' not in fname:
                    issues['education_inconsistent'].append(file_path)
    
    issues['total_issues'] = sum(len(v) for v in issues.values() if isinstance(v, list))
    
    return issues
```

---

## 模块五：补充资料机制（supplement_materials）

**用途**：所有技能给用户提供一个补充资料清单文档，告诉用户把补充资料放到指定目录；技能执行时先检查补充目录，读取分析新文件，整理后更新文件图谱和经验库。

**核心原则（v1.2.0优化）**：
1. **详细列出每项需补充的资料**：每项必须包含具体内容要求、数量、时间范围、命名规范、质量要求，禁止笼统说"已有部分"
2. **只输出需要补充的资料**：基于本地资料筛查结果（analysis_results）对比，已有资料不输出
3. **排除财务资料**：财务审计报告、研发费用专项审计、高新产品收入审计、纳税申报表、纳税证明等财务类资料不输出（由财务技能单独处理）
4. **明确告诉客户如何提供**：每项资料说明"客户需要做什么"、"提供什么格式"、"放在哪里"

```python
import os
import json
import shutil
from datetime import datetime

KNOWLEDGE_BASE_DIR = os.path.join('.trae', 'project_knowledge')
FILE_MAP_PATH = os.path.join(KNOWLEDGE_BASE_DIR, 'file_map.json')

# ============================================================
# 详细补充资料清单模板（v1.2.0 重构）
# 每项包含：
#   - name: 资料名称
#   - category: 资料类别（基础信息/知识产权/研发项目/高新产品/科技人员/管理证明/合同发票/照片资料）
#   - content_requirements: 详细内容要求（列出客户需要提供的具体内容）
#   - quantity_required: 数量要求（如"3份"、"按IP数量"、"≥10份"）
#   - time_range: 时间范围要求
#   - format: 格式要求
#   - size_limit: 大小限制
#   - naming_convention: 命名规范（具体示例）
#   - quality_requirements: 质量要求
#   - is_financial: 是否为财务资料（True则不输出，由财务技能处理）
#   - required: 是否必须
#   - check_field: 在analysis_results中对应的字段路径，用于判断是否已有
#                  格式：(category_key, field_name) 如 ('basic_info', 'business_license')
#   - check_type: 判断方式（'boolean'字段为True即存在 / 'list_count'列表数量 / 'list_min'列表至少N项）
#   - check_threshold: 配合check_type使用的阈值（仅list_min时使用）
#   - customer_action: 客户具体操作指引（从哪里获取、如何提供）
# ============================================================

SUPPLEMENT_TEMPLATES = {
    'gxtz-info-collector': {
        'subdir': '07_资料收集清单',
        'items': [
            # === 基础信息类 ===
            {
                'name': '营业执照扫描件',
                'category': '基础信息',
                'content_requirements': [
                    '最新版营业执照（三证合一或五证合一）',
                    '包含企业名称、统一社会信用代码、成立日期、注册资本、经营范围',
                    '在有效期内，无经营异常'
                ],
                'quantity_required': '1份',
                'time_range': '当前有效',
                'format': 'PNG/JPG',
                'size_limit': '≤500KB',
                'naming_convention': '营业执照.png',
                'quality_requirements': '分辨率≥300dpi，文字清晰可辨，四角完整',
                'is_financial': False,
                'required': True,
                'check_field': ('basic_info', 'business_license'),
                'check_type': 'boolean',
                'customer_action': '从工商档案中提取最新营业执照，扫描或拍照后保存为PNG格式'
            },
            {
                'name': '企业承诺书',
                'category': '基础信息',
                'content_requirements': [
                    '高新技术企业认定申请书中的企业承诺书页面',
                    '法定代表人签字（手写签字，非打印）',
                    '加盖企业公章（红色印章）',
                    '承诺内容完整，无修改痕迹'
                ],
                'quantity_required': '1份',
                'time_range': '申报当年',
                'format': 'PDF',
                'size_limit': '≤2MB',
                'naming_convention': '企业承诺书.pdf',
                'quality_requirements': '签字和公章清晰可辨，无遮挡',
                'is_financial': False,
                'required': True,
                'check_field': ('basic_info', 'commitment_letter'),
                'check_type': 'boolean',
                'customer_action': '从高新认定申请书导出承诺书页面，法人签字并加盖公章后扫描为PDF'
            },
            {
                'name': '法定代表人身份证扫描件',
                'category': '基础信息',
                'content_requirements': [
                    '身份证正反面（人像面+国徽面）',
                    '在有效期内',
                    '信息清晰可辨'
                ],
                'quantity_required': '1份（正反面合并）',
                'time_range': '当前有效',
                'format': 'PDF/JPG',
                'size_limit': '≤2MB',
                'naming_convention': '法人身份证.pdf',
                'quality_requirements': '分辨率≥300dpi，无遮挡，无反光',
                'is_financial': False,
                'required': False,
                'check_field': ('basic_info', 'legal_person_id'),
                'check_type': 'boolean',
                'customer_action': '法人身份证正反面扫描或拍照，合并为一个PDF文件'
            },
            # 财务资料项（is_financial=True，不输出）
            {
                'name': '财务审计报告',
                'category': '财务资料',
                'is_financial': True,
                'check_field': ('financial', 'audit_reports'),
                'check_type': 'list_min',
                'check_threshold': 3
            },
            {
                'name': '研发费用专项审计报告',
                'category': '财务资料',
                'is_financial': True,
                'check_field': ('financial', 'rd_audit_report'),
                'check_type': 'boolean'
            },
            {
                'name': '高新技术产品收入专项审计报告',
                'category': '财务资料',
                'is_financial': True,
                'check_field': ('financial', 'ps_audit_report'),
                'check_type': 'boolean'
            },
            {
                'name': '企业所得税年度纳税申报表',
                'category': '财务资料',
                'is_financial': True,
                'check_field': ('financial', 'tax_returns'),
                'check_type': 'list_min',
                'check_threshold': 3
            },
            {
                'name': '纳税证明',
                'category': '财务资料',
                'is_financial': True,
                'check_field': ('financial', 'tax_certificates'),
                'check_type': 'list_min',
                'check_threshold': 3
            },
            {
                'name': '研发费用辅助账',
                'category': '财务资料',
                'is_financial': True,
                'check_field': ('financial', 'rd_auxiliary_account'),
                'check_type': 'list_min',
                'check_threshold': 3
            },
        ]
    },
    'gxtz-ip-materials': {
        'subdir': '02_知识产权证明',
        'items': [
            {
                'name': 'I类知识产权证书扫描件（发明专利/集成电路布图设计）',
                'category': '知识产权',
                'content_requirements': [
                    '所有I类知识产权证书：发明专利证书、集成电路布图设计登记证书',
                    '证书首页（含专利号、授权日期）',
                    '权利要求书首页',
                    '说明书首页',
                    '权利人名称必须为申报企业全称',
                    '授权日期不限（I类无时间限制）'
                ],
                'quantity_required': '每项I类知识产权1份PDF',
                'time_range': '授权日期不限',
                'format': 'PDF',
                'size_limit': '单个≤2MB',
                'naming_convention': 'IP{编号}_{知识产权名称}.pdf，例：IP01_一种XXX方法.pdf',
                'quality_requirements': '300dpi扫描，文字清晰可辨，无遮挡',
                'is_financial': False,
                'required': True,
                'check_field': ('ip', 'i_class_certificates'),
                'check_type': 'list_min',
                'check_threshold': 1,
                'customer_action': '从国家知识产权局官网或专利证书档案中，导出/扫描每项I类IP的证书扫描件，按命名规范保存'
            },
            {
                'name': 'II类知识产权证书扫描件（实用新型/外观设计/软件著作权）',
                'category': '知识产权',
                'content_requirements': [
                    '所有II类知识产权证书：实用新型专利证书、外观设计专利证书、软件著作权登记证书',
                    '授权日期建议在近三年内（2023-2025）',
                    '证书首页（含专利号/登记号、授权日期）',
                    '权利人名称必须为申报企业全称'
                ],
                'quantity_required': '每项II类知识产权1份PDF',
                'time_range': '授权日期建议近三年内',
                'format': 'PDF',
                'size_limit': '单个≤2MB',
                'naming_convention': 'IP{编号}_{知识产权名称}.pdf，例：IP05_一种XXX装置.pdf',
                'quality_requirements': '300dpi扫描，文字清晰可辨，无遮挡',
                'is_financial': False,
                'required': True,
                'check_field': ('ip', 'ii_class_certificates'),
                'check_type': 'list_min',
                'check_threshold': 1,
                'customer_action': '从国家知识产权局官网、中国版权保护中心官网或专利证书档案中，导出/扫描每项II类IP的证书扫描件'
            },
            {
                'name': '软件著作权附属材料（仅软著IP需提供）',
                'category': '知识产权',
                'content_requirements': [
                    '每项软著IP需提供3类附属材料：',
                    '1) 软件著作权申请表：版权局登记的原始申请表（含软件名称、版本号、著作权人、登记号）',
                    '2) 软件源程序文档：前30页+后30页源代码（共60页），含软件名称页眉、页码连续',
                    '3) 软件设计说明书或用户手册：图文并茂，体现软件功能描述、技术架构、操作说明',
                    '附属材料需与软著证书合并为单个PDF上传网报系统'
                ],
                'quantity_required': '每项软著IP提供3份附属材料（合并为1份PDF）',
                'time_range': '与软著证书对应',
                'format': 'PDF',
                'size_limit': '合并后单个≤5MB',
                'naming_convention': 'IP{编号}_软著附属材料.pdf',
                'quality_requirements': '源代码页眉含软件名称、页码连续；设计说明书图文清晰',
                'is_financial': False,
                'required': True,
                'check_field': ('ip', 'software_copyright_attachments'),
                'check_type': 'list_min',
                'check_threshold': 1,
                'customer_action': '从版权登记档案中提取申请表、源程序文档，编写设计说明书或用户手册，合并为PDF'
            },
            {
                'name': '专利年费缴费发票（广东省申报必须）',
                'category': '知识产权',
                'content_requirements': [
                    '发明专利和实用新型专利的最近一次年费缴费发票',
                    '发票需包含：专利号、缴费年度、缴费金额、缴费日期',
                    '广东省申报必须提供，深圳市申报建议提供',
                    '用于证明专利处于有效状态'
                ],
                'quantity_required': '每项发明+实用新型专利1份',
                'time_range': '最近一次年费缴纳',
                'format': 'PDF',
                'size_limit': '单个≤1MB',
                'naming_convention': 'IP{编号}_年费发票.pdf',
                'quality_requirements': '发票信息清晰可辨',
                'is_financial': False,
                'required': False,
                'check_field': ('ip', 'annual_fee_invoices'),
                'check_type': 'list_min',
                'check_threshold': 1,
                'customer_action': '从国家知识产权局官网或缴费记录中提取年费缴纳发票，按IP编号命名'
            },
            {
                'name': '知识产权转让合同和手续合格通知书（受让IP必须）',
                'category': '知识产权',
                'content_requirements': [
                    '受让的知识产权必须提供：',
                    '1) 知识产权转让合同/许可合同：确认转让人、受让人、转让日期、转让费用、权利范围',
                    '2) 知识产权局手续合格通知书：经知识产权局变更备案（仅合同无效，必须提供通知书）',
                    '3) 全球独占许可协议（II类IP授权日期不在近三年时）：许可期限≥5年、全球范围、独占性质'
                ],
                'quantity_required': '每项受让IP提供2份材料（合同+通知书）',
                'time_range': '转让/许可日期≤申报年份',
                'format': 'PDF',
                'size_limit': '单个≤5MB',
                'naming_convention': 'IP{编号}_转让合同.pdf、IP{编号}_手续合格通知书.pdf',
                'quality_requirements': '合同签字盖章清晰，通知书为知识产权局原件扫描',
                'is_financial': False,
                'required': False,
                'check_field': ('ip', 'transfer_documents'),
                'check_type': 'list_min',
                'check_threshold': 1,
                'customer_action': '从合同档案中提取转让合同，从知识产权局官网下载手续合格通知书，按IP编号命名'
            },
            {
                'name': '专利登记簿副本（建议提供）',
                'category': '知识产权',
                'content_requirements': [
                    '发明专利的专利登记簿副本',
                    '法律状态为"有效"',
                    '无质押、无效宣告、转让记录',
                    '近3个月内出具'
                ],
                'quantity_required': '每项发明专利1份（按需）',
                'time_range': '近3个月内出具',
                'format': 'PDF',
                'size_limit': '单个≤1MB',
                'naming_convention': 'IP{编号}_登记簿副本.pdf',
                'quality_requirements': '知识产权局出具，红章清晰',
                'is_financial': False,
                'required': False,
                'check_field': ('ip', 'register_copies'),
                'check_type': 'list_min',
                'check_threshold': 0,
                'customer_action': '从国家知识产权局官网申请登记簿副本，下载PDF'
            },
        ]
    },
    'gxtz-staff-materials': {
        'subdir': '05_科技人员材料',
        'items': [
            {
                'name': '上年12月社保缴费证明（带公章）',
                'category': '科技人员',
                'content_requirements': [
                    f'申报年份的上一年12月份社保缴费证明',
                    '由社保局出具（非企业自行打印）',
                    '必须带红色公章（社保局业务专用章）',
                    '包含字段：单位名称、人员姓名、身份证号、缴费起止时间、缴费基数',
                    '覆盖全部科技人员',
                    '用途：作为科技人员认定的基准依据'
                ],
                'quantity_required': '1份',
                'time_range': '上年12月份（如申报2026年则提供2025年12月）',
                'format': 'PDF',
                'size_limit': '≤5MB',
                'naming_convention': '{企业名称}_上年12月社保缴费证明.pdf',
                'quality_requirements': '公章清晰可辨，人员信息完整',
                'is_financial': False,
                'required': True,
                'check_field': ('staff', 'social_security'),
                'check_type': 'boolean',
                'customer_action': '前往参保所在地社保局大厅或官网申请上年12月社保缴费证明（带公章），保存为PDF'
            },
            {
                'name': '科技人员名册（参考派成铝业14列格式）',
                'category': '科技人员',
                'content_requirements': [
                    '科技人员名册Excel文件，按派成铝业参考格式14列结构：',
                    '列1：序号',
                    '列2：姓名',
                    '列3：入职时间（YYYY-MM-DD）',
                    '列4：身份证号码',
                    '列5：姓别（男/女）',
                    '列6：学历（大专/本科/硕士/博士）',
                    '列7：毕业院校',
                    '列8：专业',
                    '列9：部门（研发部门名称）',
                    '列10：岗位（研发工程师/技术员等）',
                    '列11：申报年份在职时间（天，累计≥183天）',
                    '列12：职称（如有，如二级建造师、工程师等）',
                    '列13：工资（月工资，元）',
                    '列14：日期（统计截止日期，如2025-12-31）',
                    'Sheet名：研发人员名单',
                    '筛选条件：必须在上年12月社保缴费记录中，累计工作时长≥183天，入职时间≤上年12月'
                ],
                'quantity_required': '1份（含全部科技人员）',
                'time_range': '统计截止日期为上年12月31日',
                'format': 'XLSX',
                'size_limit': '≤2MB',
                'naming_convention': '{企业名称}_科技人员名册_{上年}.xlsx',
                'quality_requirements': '14列完整，身份证号码准确，在职时间计算正确',
                'is_financial': False,
                'required': True,
                'check_field': ('staff', 'info_table'),
                'check_type': 'boolean',
                'customer_action': 'HR部门按14列格式整理科技人员名册，每人一行，确保与上年12月社保名单一致'
            },
            {
                'name': '科技人员学历证书扫描件',
                'category': '科技人员',
                'content_requirements': [
                    '每位科技人员的最高学历证书扫描件',
                    '毕业证书或学位证书',
                    '学历信息需与名册中的"学历"列一致',
                    '证书清晰可辨，包含姓名、专业、毕业院校、毕业日期'
                ],
                'quantity_required': '每位科技人员1份',
                'time_range': '不限',
                'format': 'PDF',
                'size_limit': '单个≤2MB',
                'naming_convention': '{姓名}_学历证书.pdf，例：张三_学历证书.pdf',
                'quality_requirements': '300dpi扫描，文字清晰可辨',
                'is_financial': False,
                'required': True,
                'check_field': ('staff', 'diplomas'),
                'check_type': 'list_min',
                'check_threshold': 1,
                'customer_action': '收集每位科技人员的学历证书，扫描为PDF，按姓名命名'
            },
            {
                'name': '科技人员职称证书扫描件（如有职称）',
                'category': '科技人员',
                'content_requirements': [
                    '科技人员的职称证书（工程师、高级工程师、二级建造师等）',
                    '人才证书（高层次人才、技能人才证书等）',
                    '如有职称必须提供，无职称可不提供'
                ],
                'quantity_required': '有职称的科技人员每人1份',
                'time_range': '不限',
                'format': 'PDF',
                'size_limit': '单个≤2MB',
                'naming_convention': '{姓名}_职称证书.pdf，例：张三_二级建造师.pdf',
                'quality_requirements': '300dpi扫描，文字清晰可辨',
                'is_financial': False,
                'required': False,
                'check_field': ('staff', 'professional_certificates'),
                'check_type': 'list_min',
                'check_threshold': 0,
                'customer_action': '收集有职称的科技人员的职称证书，扫描为PDF，按姓名命名'
            },
        ]
    },
    'gxtz-rd-report': {
        'subdir': '01_研发立项报告',
        'items': [
            {
                'name': '研发项目立项书（企业内部立项文件）',
                'category': '研发项目',
                'content_requirements': [
                    '企业内部研发项目立项文件（如有）',
                    '包含：项目名称、立项日期、项目负责人、项目预算、研发内容、预期目标',
                    '如企业未做过正式立项，可提供研发计划书或研发任务书'
                ],
                'quantity_required': '每个研发项目1份（如有）',
                'time_range': '近三年内立项',
                'format': 'DOCX/PDF',
                'size_limit': '单个≤5MB',
                'naming_convention': 'RD{编号}_{项目名称}_立项书.docx',
                'quality_requirements': '内容完整，包含项目预算和研发内容',
                'is_financial': False,
                'required': False,
                'check_field': ('rd', 'reports'),
                'check_type': 'list_min',
                'check_threshold': 1,
                'customer_action': '从企业研发档案中提取立项文件，按RD编号命名；若无正式立项文件，提供研发计划书'
            },
            {
                'name': '研发项目验收报告（已验收项目）',
                'category': '研发项目',
                'content_requirements': [
                    '已验收的研发项目验收报告',
                    '包含：项目完成情况、技术成果、验收结论、验收人员签字',
                    '仅已验收项目需提供'
                ],
                'quantity_required': '每个已验收项目1份（如有）',
                'time_range': '近三年内验收',
                'format': 'DOCX/PDF',
                'size_limit': '单个≤5MB',
                'naming_convention': 'RD{编号}_{项目名称}_验收报告.docx',
                'quality_requirements': '验收结论明确，验收人员签字完整',
                'is_financial': False,
                'required': False,
                'check_field': ('rd', 'acceptance_reports'),
                'check_type': 'list_min',
                'check_threshold': 0,
                'customer_action': '从企业研发档案中提取验收报告，按RD编号命名'
            },
        ]
    },
    'gxtz-achievement-materials': {
        'subdir': '03_成果转化证明',
        'items': [
            {
                'name': '高新产品销售合同',
                'category': '合同发票',
                'content_requirements': [
                    '近三年高新产品销售合同：',
                    '  - 2023年：10-12份',
                    '  - 2024年：10-12份',
                    '  - 2025年：18-20份',
                    '单份合同金额≥10万元',
                    '合同需包含：合同编号、签订日期、客户名称、产品名称、金额、签字盖章',
                    '客户数量≥5家，单一客户合同占比≤50%',
                    '合同时间需在近三年内'
                ],
                'quantity_required': '近三年合计40-50份',
                'time_range': '2023-2025年',
                'format': 'PDF',
                'size_limit': '单个≤10MB',
                'naming_convention': '{年份}_{客户名称}_{合同编号}.pdf',
                'quality_requirements': '签字盖章清晰，合同内容完整',
                'is_financial': False,
                'required': True,
                'check_field': ('contracts', 'sales_contracts'),
                'check_type': 'list_min',
                'check_threshold': 10,
                'customer_action': '从销售部门提取近三年高新产品销售合同，按年份_客户_编号命名，扫描为PDF'
            },
            {
                'name': '高新产品销售发票',
                'category': '合同发票',
                'content_requirements': [
                    '对应销售合同的发票',
                    '20位发票号码',
                    '发票金额、客户名称、产品名称需与合同一致',
                    '发票时间需在合同签订后合理时间内',
                    '每份合同对应1-2张发票'
                ],
                'quantity_required': '近三年合计40-100份',
                'time_range': '2023-2025年',
                'format': 'PDF',
                'size_limit': '单个≤2MB',
                'naming_convention': '{年份}_{客户名称}_发票_{发票号码后4位}.pdf',
                'quality_requirements': '发票信息清晰可辨',
                'is_financial': False,
                'required': True,
                'check_field': ('contracts', 'sales_invoices'),
                'check_type': 'list_min',
                'check_threshold': 10,
                'customer_action': '从开票系统中导出对应合同的发票，扫描或电子发票直接保存为PDF'
            },
            {
                'name': '高新产品检测报告',
                'category': '高新产品',
                'content_requirements': [
                    '第三方检测机构出具的产品检测报告',
                    '检测机构需具备CMA/CNAS资质',
                    '检测报告包含：产品名称、检测项目、检测结论、检测日期、报告编号',
                    '覆盖主要高新产品（PS表对应产品）'
                ],
                'quantity_required': '每个高新产品1份（按PS表）',
                'time_range': '近三年内',
                'format': 'PDF',
                'size_limit': '单个≤10MB',
                'naming_convention': 'PS{编号}_{产品名称}_检测报告.pdf',
                'quality_requirements': 'CMA/CNAS章清晰，检测结论明确',
                'is_financial': False,
                'required': True,
                'check_field': ('products', 'test_reports'),
                'check_type': 'list_min',
                'check_threshold': 1,
                'customer_action': '从检测机构获取产品检测报告，按PS编号命名，扫描为PDF'
            },
        ]
    },
    'gxtz-ps-materials': {
        'subdir': '04_高新产品证明',
        'items': [
            {
                'name': 'PS表对应产品销售合同',
                'category': '合同发票',
                'content_requirements': [
                    'PS表对应的高新产品销售合同',
                    '合同金额需与PS表收入数据一致',
                    '合同客户名称、产品名称需与PS表一致',
                    '每个PS产品至少3-5份销售合同'
                ],
                'quantity_required': '每个PS产品3-5份',
                'time_range': '近三年内',
                'format': 'PDF',
                'size_limit': '单个≤10MB',
                'naming_convention': 'PS{编号}_{客户名称}_{合同编号}.pdf',
                'quality_requirements': '签字盖章清晰，合同内容完整',
                'is_financial': False,
                'required': True,
                'check_field': ('ps', 'sales_contracts'),
                'check_type': 'list_min',
                'check_threshold': 1,
                'customer_action': '按PS表产品提取销售合同，确保客户名称、产品名称与PS表一致'
            },
            {
                'name': 'PS表对应产品销售发票',
                'category': '合同发票',
                'content_requirements': [
                    'PS表对应产品销售合同对应的发票',
                    '20位发票号码',
                    '发票金额、客户、产品需与合同一致',
                    '每个PS产品至少3-5张发票'
                ],
                'quantity_required': '每个PS产品3-5张',
                'time_range': '近三年内',
                'format': 'PDF',
                'size_limit': '单个≤2MB',
                'naming_convention': 'PS{编号}_{客户名称}_发票_{发票号码后4位}.pdf',
                'quality_requirements': '发票信息清晰可辨',
                'is_financial': False,
                'required': True,
                'check_field': ('ps', 'sales_invoices'),
                'check_type': 'list_min',
                'check_threshold': 1,
                'customer_action': '从开票系统提取PS产品对应发票，扫描或电子发票保存为PDF'
            },
            {
                'name': 'PS表产品第三方检测报告',
                'category': '高新产品',
                'content_requirements': [
                    '第三方检测机构出具的产品检测报告',
                    '检测机构需具备CMA/CNAS资质',
                    '检测报告覆盖PS表中的主要产品',
                    '包含：产品名称、检测项目、技术指标、检测结论、检测日期'
                ],
                'quantity_required': '每个PS产品1份',
                'time_range': '近三年内',
                'format': 'PDF',
                'size_limit': '单个≤10MB',
                'naming_convention': 'PS{编号}_{产品名称}_检测报告.pdf',
                'quality_requirements': 'CMA/CNAS章清晰，技术指标完整',
                'is_financial': False,
                'required': True,
                'check_field': ('products', 'test_reports'),
                'check_type': 'list_min',
                'check_threshold': 1,
                'customer_action': '从检测机构获取产品检测报告，按PS编号命名'
            },
            {
                'name': 'PS表产品照片（带铭牌）',
                'category': '照片资料',
                'content_requirements': [
                    '产品实物照片，需包含产品铭牌',
                    '铭牌信息：产品名称、型号、生产日期、生产企业名称',
                    '产品照片需体现产品全貌和技术特征',
                    '每个PS产品至少1-3张照片'
                ],
                'quantity_required': '每个PS产品1-3张',
                'time_range': '近三年内拍摄',
                'format': 'JPG/PNG',
                'size_limit': '单个≤5MB',
                'naming_convention': 'PS{编号}_{产品名称}_照片{序号}.jpg',
                'quality_requirements': '分辨率≥300dpi，铭牌信息清晰可辨',
                'is_financial': False,
                'required': True,
                'check_field': ('photos', 'product_photos'),
                'check_type': 'list_min',
                'check_threshold': 1,
                'customer_action': '拍摄产品实物照片，确保铭牌清晰可见，按PS编号命名'
            },
            {
                'name': 'PS表产品技术说明文档',
                'category': '高新产品',
                'content_requirements': [
                    '产品技术说明文档（如已有可提供）',
                    '包含：产品技术原理、关键技术指标、创新点、应用场景',
                    '文档需体现产品与知识产权的关联关系'
                ],
                'quantity_required': '每个PS产品1份',
                'time_range': '不限',
                'format': 'DOCX/PDF',
                'size_limit': '单个≤5MB',
                'naming_convention': 'PS{编号}_{产品名称}_技术说明.docx',
                'quality_requirements': '技术内容详实，体现关键技术',
                'is_financial': False,
                'required': False,
                'check_field': ('ps', 'tech_descriptions'),
                'check_type': 'list_min',
                'check_threshold': 0,
                'customer_action': '从研发部门或市场部门提取产品技术说明文档，按PS编号命名'
            },
        ]
    },
    'gxtz-management-materials': {
        'subdir': '06_管理制度材料',
        'items': [
            {
                'name': '研发组织管理制度文件',
                'category': '管理证明',
                'content_requirements': [
                    '研发组织管理制度文件（3份）：',
                    '1) 研发项目管理制度：项目立项、过程管理、验收、知识产权管理',
                    '2) 研发机构管理制度：研发部门组织架构、岗位职责、考核办法',
                    '3) 产学研合作制度：合作院校、合作项目、合作成果、合作协议',
                    '所有制度需企业正式发布（带文件编号、发布日期、签发人）'
                ],
                'quantity_required': '3份（每类制度1份）',
                'time_range': '近三年内发布',
                'format': 'DOCX/PDF',
                'size_limit': '单个≤5MB',
                'naming_convention': '研发管理制度_{制度类型}.docx',
                'quality_requirements': '内容完整，正式发布，有签发人和文件编号',
                'is_financial': False,
                'required': True,
                'check_field': ('management', 'rd_organization_documents'),
                'check_type': 'list_min',
                'check_threshold': 3,
                'customer_action': '从企业制度档案中提取研发管理制度文件，确保3类制度齐全'
            },
            {
                'name': '研发设备清单',
                'category': '管理证明',
                'content_requirements': [
                    '研发设备清单Excel文件，包含：',
                    '设备名称、型号、数量、单价、总价、采购日期、使用部门',
                    '要求：≥10台设备、总值≥50万元、80%以上设备研发部门使用',
                    '设备清单需与现场设备一致'
                ],
                'quantity_required': '1份',
                'time_range': '截至上年12月31日',
                'format': 'XLSX',
                'size_limit': '≤2MB',
                'naming_convention': '{企业名称}_研发设备清单.xlsx',
                'quality_requirements': '信息完整，符合≥10台、≥50万元要求',
                'is_financial': False,
                'required': True,
                'check_field': ('equipment', 'equipment_list'),
                'check_type': 'boolean',
                'customer_action': '从资产管理部门提取研发设备清单，确保≥10台、≥50万元、80%研发部门使用'
            },
            {
                'name': '研发人员绩效考核制度',
                'category': '管理证明',
                'content_requirements': [
                    '研发人员绩效考核制度文件',
                    '包含：考核指标、考核周期、考核办法、奖惩措施',
                    '需企业正式发布（带文件编号、发布日期）'
                ],
                'quantity_required': '1份',
                'time_range': '近三年内发布',
                'format': 'DOCX/PDF',
                'size_limit': '≤5MB',
                'naming_convention': '研发人员绩效考核制度.docx',
                'quality_requirements': '内容完整，正式发布',
                'is_financial': False,
                'required': True,
                'check_field': ('management', 'performance_evaluation'),
                'check_type': 'boolean',
                'customer_action': '从HR部门提取研发人员绩效考核制度，确保正式发布版本'
            },
            {
                'name': '研发人员奖励制度',
                'category': '管理证明',
                'content_requirements': [
                    '研发人员创新创业奖励制度文件',
                    '包含：奖励类型（创新奖、专利奖、论文奖等）、奖励标准、申请流程',
                    '需企业正式发布（带文件编号、发布日期）'
                ],
                'quantity_required': '1份',
                'time_range': '近三年内发布',
                'format': 'DOCX/PDF',
                'size_limit': '≤5MB',
                'naming_convention': '研发人员奖励制度.docx',
                'quality_requirements': '内容完整，正式发布',
                'is_financial': False,
                'required': True,
                'check_field': ('management', 'reward_system'),
                'check_type': 'boolean',
                'customer_action': '从HR部门提取研发人员奖励制度，确保正式发布版本'
            },
            {
                'name': '产学研合作协议',
                'category': '管理证明',
                'content_requirements': [
                    '与高校或科研院所签订的产学研合作协议',
                    '协议包含：合作内容、合作期限、双方权利义务、知识产权归属',
                    '建议至少1份产学研合作'
                ],
                'quantity_required': '1份以上',
                'time_range': '近三年内签订',
                'format': 'PDF',
                'size_limit': '≤5MB',
                'naming_convention': '产学研合作协议_{合作院校}.pdf',
                'quality_requirements': '签字盖章清晰，合作内容明确',
                'is_financial': False,
                'required': False,
                'check_field': ('management', 'industry_university_agreements'),
                'check_type': 'list_min',
                'check_threshold': 0,
                'customer_action': '从合作院校或研发部门提取产学研合作协议，扫描为PDF'
            },
        ]
    },
    'gxtz-core-tables': {
        'subdir': '00_核心表格',
        'items': [
            {
                'name': '已有知识产权清单（IP清单）',
                'category': '知识产权',
                'content_requirements': [
                    '企业已有的知识产权清单（如有）',
                    '包含：IP编号、知识产权名称、类型（发明/实用新型/外观/软著）、专利号/登记号、授权日期、权利人',
                    '如企业无现成清单，可不提供（技能将根据证书扫描件自动生成）'
                ],
                'quantity_required': '1份（如有）',
                'time_range': '不限',
                'format': 'XLSX',
                'size_limit': '≤2MB',
                'naming_convention': '{企业名称}_知识产权清单.xlsx',
                'quality_requirements': '信息完整准确',
                'is_financial': False,
                'required': False,
                'check_field': None,
                'check_type': 'boolean',
                'customer_action': '从知识产权管理部门提取已有IP清单；若无，技能将根据证书扫描件自动生成'
            },
            {
                'name': '已有研发项目清单（RD清单）',
                'category': '研发项目',
                'content_requirements': [
                    '企业已有的研发项目清单（如有）',
                    '包含：RD编号、项目名称、立项日期、项目负责人、项目预算、研发内容、验收状态',
                    '如企业无现成清单，可不提供（技能将根据立项报告自动生成）'
                ],
                'quantity_required': '1份（如有）',
                'time_range': '不限',
                'format': 'XLSX',
                'size_limit': '≤2MB',
                'naming_convention': '{企业名称}_研发项目清单.xlsx',
                'quality_requirements': '信息完整准确',
                'is_financial': False,
                'required': False,
                'check_field': None,
                'check_type': 'boolean',
                'customer_action': '从研发部门提取已有RD项目清单；若无，技能将根据立项报告自动生成'
            },
            {
                'name': '已有高新产品清单（PS清单）',
                'category': '高新产品',
                'content_requirements': [
                    '企业已有的高新产品清单（如有）',
                    '包含：PS编号、产品名称、产品型号、技术领域、技术指标、销售收入、知识产权支持',
                    '如企业无现成清单，可不提供（技能将根据销售合同和产品资料自动生成）'
                ],
                'quantity_required': '1份（如有）',
                'time_range': '不限',
                'format': 'XLSX',
                'size_limit': '≤2MB',
                'naming_convention': '{企业名称}_高新产品清单.xlsx',
                'quality_requirements': '信息完整准确',
                'is_financial': False,
                'required': False,
                'check_field': None,
                'check_type': 'boolean',
                'customer_action': '从市场或销售部门提取已有PS产品清单；若无，技能将根据销售合同自动生成'
            },
        ]
    }
}


def get_supplement_dir(enterprise_name, application_year, skill_name):
    """获取补充资料目录路径"""
    root = f"{enterprise_name}_高新认定材料_{application_year}"
    return os.path.join(root, '_补充资料', skill_name)


def check_item_exists(item, analysis_results):
    """检查资料项是否已存在（基于analysis_results判断）
    
    Args:
        item: 补充资料模板项
        analysis_results: 本地资料筛查结果
    
    Returns:
        bool: True表示已存在（不需要补充），False表示缺失（需要补充）
    """
    if not analysis_results:
        return False  # 无筛查结果时，默认需要补充
    
    check_field = item.get('check_field')
    if not check_field:
        return False  # 无判断字段时，默认需要补充
    
    category_key, field_name = check_field
    category_data = analysis_results.get(category_key, {})
    if not isinstance(category_data, dict):
        return False
    
    field_value = category_data.get(field_name)
    check_type = item.get('check_type', 'boolean')
    
    if check_type == 'boolean':
        return bool(field_value)
    elif check_type == 'list_count':
        return isinstance(field_value, list) and len(field_value) > 0
    elif check_type == 'list_min':
        threshold = item.get('check_threshold', 1)
        return isinstance(field_value, list) and len(field_value) >= threshold
    return False


def filter_missing_supplements(skill_name, analysis_results=None, exclude_financial=True):
    """过滤出缺失的补充资料项（核心函数）
    
    基于本地资料筛查结果，对比补充资料模板，只返回缺失的资料项。
    排除财务资料和已有资料。
    
    Args:
        skill_name: 技能名称
        analysis_results: 本地资料筛查结果（来自scan_local_project_materials）
        exclude_financial: 是否排除财务资料（默认True）
    
    Returns:
        list: 缺失的补充资料项列表（已排除财务资料和已有资料）
    """
    template = SUPPLEMENT_TEMPLATES.get(skill_name)
    if not template:
        return []
    
    missing_items = []
    for item in template['items']:
        # 排除财务资料
        if exclude_financial and item.get('is_financial', False):
            continue
        
        # 检查是否已存在
        if check_item_exists(item, analysis_results):
            continue
        
        missing_items.append(item)
    
    return missing_items


def generate_supplement_checklist(enterprise_name, application_year, skill_name, 
                                   analysis_results=None, region='shenzhen'):
    """生成补充资料清单文档（详细列出需要补充的资料）
    
    v1.2.0优化：基于本地资料筛查结果，只输出需要补充的资料项；
    每项详细列出内容要求、数量、时间范围、命名规范、客户操作指引；
    排除财务资料（财务类资料由财务技能单独处理）。
    
    Args:
        enterprise_name: 企业名称
        application_year: 申报年份
        skill_name: 技能名称
        analysis_results: 本地资料筛查结果（来自scan_local_project_materials）
        region: 地区（shenzhen/guangdong）
    
    Returns:
        dict: {'checklist_path': str, 'supplement_dir': str, 'missing_count': int, 'missing_items': list}
    """
    template = SUPPLEMENT_TEMPLATES.get(skill_name, {'subdir': '07_资料收集清单', 'items': []})
    supplement_dir = get_supplement_dir(enterprise_name, application_year, skill_name)
    os.makedirs(supplement_dir, exist_ok=True)
    
    # 过滤出缺失的补充资料项（排除财务资料）
    missing_items = filter_missing_supplements(
        skill_name, analysis_results, exclude_financial=True
    )
    
    # 生成补充资料清单文档
    checklist_path = os.path.join(supplement_dir, '补充资料清单.md')
    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    last_year = application_year - 1
    _F = '`' * 3  # markdown代码块围栏（避免与本文件的代码块围栏冲突）

    content = f"""# 补充资料清单 - {skill_name}

> 生成时间：{now}
> 企业：{enterprise_name}
> 申报年份：{application_year}年
> 地区：{region}
> 统计基准：上年12月（{last_year}年12月）

## 补充资料放置目录

请将以下补充资料文件放到此目录：

{_F}
{supplement_dir}/
{_F}

## 需要补充的资料（共{len(missing_items)}项）

"""
    
    if not missing_items:
        content += "**所有资料均已齐全，无需补充。**\n"
    else:
        for i, item in enumerate(missing_items, 1):
            required_text = '✅ 必须' if item.get('required', False) else '⭕ 选填'
            content += f"""### {i}. {item['name']} ({required_text})

**资料类别**：{item.get('category', '未分类')}

**详细内容要求**：
"""
            for req in item.get('content_requirements', []):
                content += f"- {req}\n"
            
            content += f"""
**数量要求**：{item.get('quantity_required', '按实际')}
**时间范围**：{item.get('time_range', '不限')}
**格式要求**：{item.get('format', 'PDF')}
**大小限制**：{item.get('size_limit', '不限')}
**命名规范**：`{item.get('naming_convention', '按资料名称命名')}`
**质量要求**：{item.get('quality_requirements', '清晰可辨')}
**客户操作指引**：{item.get('customer_action', '请按上述要求提供资料')}

"""
    
    content += f"""## 操作说明

1. 将上述资料文件放到 `{supplement_dir}/` 目录
2. 严格按命名规范命名文件，便于技能自动识别和归类
3. 放入文件后，重新运行 {skill_name} 技能
4. 技能会自动读取此目录中的新文件，进行整理和分析，并更新项目知识库

## 文件命名示例

{_F}
{supplement_dir}/
├── 营业执照.png
├── 企业承诺书.pdf
├── IP01_一种XXX方法.pdf
├── IP05_一种XXX装置.pdf
├── 张三_学历证书.pdf
├── {enterprise_name}_上年12月社保缴费证明.pdf
├── {enterprise_name}_科技人员名册_{last_year}.xlsx
└── ...
{_F}

## 注意事项

- **压缩文件会被自动解压**：zip/rar/7z 文件会被递归解压到底，无需手动解压
- **文件清晰度要求**：PDF文件清晰可辨，图片文件分辨率≥300dpi
- **财务资料不在本清单**：财务审计报告、研发费用专项审计、纳税申报表等财务资料由财务技能单独处理
- **已有资料不在本清单**：本清单仅列出本地筛查后缺失的资料，已有资料不再重复列出
- **公章要求**：所有需要公章的资料必须为红色印章（非复印章）
- **如资料较多**：可按资料名称创建子目录分类存放，技能会递归扫描所有子目录

## 已放入的文件

> 技能执行时会自动扫描此目录，将新文件纳入项目知识库的文件图谱。
> 已放入的文件会在下次生成清单时自动排除（基于本地筛查结果更新）。
"""
    
    with open(checklist_path, 'w', encoding='utf-8') as f:
        f.write(content)
    
    return {
        'checklist_path': checklist_path,
        'supplement_dir': supplement_dir,
        'missing_count': len(missing_items),
        'missing_items': missing_items
    }


def scan_supplement_dir(enterprise_name, application_year, skill_name, 
                        analysis_results=None, region='shenzhen'):
    """扫描补充资料目录，读取分析新文件

    技能执行时先调用此函数，检查补充资料目录中是否有新文件。
    如果有新文件，读取分析并整理。

    Args:
        enterprise_name: 企业名称
        application_year: 申报年份
        skill_name: 技能名称
        analysis_results: 本地资料筛查结果（来自scan_local_project_materials），
                          用于生成详细的缺失项清单（v1.2.0新增）
        region: 地区（shenzhen/guangdong）

    Returns:
        dict: {
            'new_files': list,  # 新发现的文件列表
            'analyzed': list,   # 已分析的文件信息
            'supplement_dir': str,
            'checklist_path': str,
            'missing_count': int,  # 缺失项数量
            'missing_items': list  # 缺失项详情
        }
    """
    from scan_files_with_archive_support import scan_files_with_archive_support

    # 先确保补充资料清单文档存在（基于analysis_results生成详细的缺失项清单）
    result = generate_supplement_checklist(
        enterprise_name, application_year, skill_name, 
        analysis_results=analysis_results, region=region
    )
    supplement_dir = result['supplement_dir']

    new_files = []
    analyzed = []

    if not os.path.exists(supplement_dir):
        return {
            'new_files': [],
            'analyzed': [],
            'supplement_dir': supplement_dir,
            'checklist_path': result['checklist_path']
        }

    # 扫描补充目录中的所有文件（支持压缩文件解压）
    all_files = scan_files_with_archive_support(supplement_dir)

    # 读取已有的文件图谱，判断哪些是新文件
    file_map = load_file_map()
    existing_files = set()
    if file_map:
        existing_files = set(file_map.get('files', {}).keys())

    for file_path in all_files:
        # 跳过清单文档本身
        if file_path.endswith('补充资料清单.md'):
            continue

        file_key = os.path.abspath(file_path)
        if file_key not in existing_files:
            new_files.append(file_path)

    # 分析每个新文件
    for file_path in new_files:
        file_info = analyze_supplement_file(file_path, skill_name)
        analyzed.append(file_info)

        # 添加到文件图谱
        add_file_to_map(
            file_path=file_path,
            category=file_info['category'],
            file_type=file_info['file_type'],
            related_id=file_info.get('related_id'),
            related_name=file_info.get('related_name'),
            content_summary=file_info['content_summary'],
            validity='pending_review',
            keywords=file_info.get('keywords', []),
            skill_name=skill_name
        )

    return {
        'new_files': new_files,
        'analyzed': analyzed,
        'supplement_dir': supplement_dir,
        'checklist_path': result['checklist_path'],
        'missing_count': result.get('missing_count', 0),
        'missing_items': result.get('missing_items', [])
    }


def analyze_supplement_file(file_path, skill_name):
    """分析单个补充资料文件，提取信息

    根据文件名和内容，自动识别文件类别、关联对象、关键词等。

    Args:
        file_path: 文件路径
        skill_name: 技能名称

    Returns:
        dict: 文件分析结果
    """
    filename = os.path.basename(file_path)
    ext = os.path.splitext(filename)[1].lower().lstrip('.')
    file_type = ext if ext else 'unknown'

    # 根据技能名确定默认类别
    skill_category_map = {
        'gxtz-info-collector': '01_基础资质',
        'gxtz-ip-materials': '02_知识产权',
        'gxtz-rd-report': '03_研发项目',
        'gxtz-achievement-materials': '08_合同发票',
        'gxtz-ps-materials': '04_高新产品',
        'gxtz-staff-materials': '05_科技人员',
        'gxtz-management-materials': '07_管理制度',
        'gxtz-core-tables': '10_其他资料'
    }
    category = skill_category_map.get(skill_name, '10_其他资料')

    # 从文件名提取关联ID
    related_id = None
    related_name = None
    keywords = []

    import re

    # 匹配IP编号
    ip_match = re.search(r'IP\d+', filename, re.IGNORECASE)
    if ip_match:
        related_id = ip_match.group().upper()
        category = '02_知识产权'
        keywords.append(related_id)

    # 匹配RD编号
    rd_match = re.search(r'RD\d+', filename, re.IGNORECASE)
    if rd_match:
        related_id = rd_match.group().upper()
        category = '03_研发项目'
        keywords.append(related_id)

    # 匹配PS编号
    ps_match = re.search(r'PS\d+', filename, re.IGNORECASE)
    if ps_match:
        related_id = ps_match.group().upper()
        category = '04_高新产品'
        keywords.append(related_id)

    # 匹配ACH编号
    ach_match = re.search(r'ACH\d+', filename, re.IGNORECASE)
    if ach_match:
        related_id = ach_match.group().upper()
        category = '08_合同发票'
        keywords.append(related_id)

    # 根据文件名关键词识别类别
    name_lower = filename.lower()

    if '社保' in filename or '社保' in name_lower:
        category = '05_科技人员'
        keywords.extend(['社保', '缴费'])
    elif '合同' in filename or 'contract' in name_lower:
        category = '08_合同发票'
        keywords.append('合同')
    elif '发票' in filename or 'invoice' in name_lower:
        category = '08_合同发票'
        keywords.append('发票')
    elif '检测' in filename or 'test' in name_lower or 'report' in name_lower:
        category = '04_高新产品'
        keywords.append('检测报告')
    elif '学历' in filename or '证书' in filename:
        category = '05_科技人员'
        keywords.append('学历证书')
    elif '专利' in filename or '软著' in filename:
        category = '02_知识产权'
        keywords.append('专利证书')
    elif '制度' in filename or '管理' in filename:
        category = '07_管理制度'
        keywords.append('管理制度')
    elif '审计' in filename:
        category = '06_财务资料'
        keywords.append('审计报告')
    elif '设备' in filename:
        category = '07_管理制度'
        keywords.append('研发设备')

    # 从文件名提取关联名称（去除扩展名和编号）
    clean_name = re.sub(r'^(IP|RD|PS|ACH)\d+_', '', os.path.splitext(filename)[0])
    clean_name = re.sub(r'[_-]', ' ', clean_name).strip()
    if clean_name and not related_name:
        related_name = clean_name

    # 生成内容摘要
    content_summary = f"{filename} - {category}"
    if related_id:
        content_summary += f" - 关联{related_id}"
    if related_name:
        content_summary += f" - {related_name}"

    return {
        'file_path': file_path,
        'filename': filename,
        'file_type': file_type,
        'category': category,
        'related_id': related_id,
        'related_name': related_name,
        'content_summary': content_summary,
        'keywords': keywords
    }


def organize_supplement_files(enterprise_name, application_year, skill_name, analyzed_files):
    """整理补充资料文件到统一输出目录

    技能分析完补充文件后，将文件整理到对应的统一输出子目录。

    Args:
        enterprise_name: 企业名称
        application_year: 申报年份
        skill_name: 技能名称
        analyzed_files: 已分析的文件信息列表

    Returns:
        list: 整理后的文件路径列表
    """
    root = f"{enterprise_name}_高新认定材料_{application_year}"
    template = SUPPLEMENT_TEMPLATES.get(skill_name, {'subdir': '07_资料收集清单'})
    target_subdir = template['subdir']
    target_dir = os.path.join(root, target_subdir)
    os.makedirs(target_dir, exist_ok=True)

    organized_files = []

    for file_info in analyzed_files:
        src_path = file_info['file_path']
        filename = file_info['filename']

        if not os.path.exists(src_path):
            continue

        dst_path = os.path.join(target_dir, filename)

        # 避免覆盖
        if os.path.exists(dst_path):
            name, ext = os.path.splitext(filename)
            counter = 1
            while os.path.exists(os.path.join(target_dir, f"{name}_{counter}{ext}")):
                counter += 1
            dst_path = os.path.join(target_dir, f"{name}_{counter}{ext}")

        try:
            shutil.copy2(src_path, dst_path)
            organized_files.append({
                'original_path': src_path,
                'organized_path': dst_path,
                'file_info': file_info
            })

            # 更新文件图谱中的路径
            add_file_to_map(
                file_path=dst_path,
                category=file_info['category'],
                file_type=file_info['file_type'],
                related_id=file_info.get('related_id'),
                related_name=file_info.get('related_name'),
                content_summary=file_info['content_summary'],
                validity='valid',
                keywords=file_info.get('keywords', []),
                skill_name=skill_name
            )
        except Exception as e:
            print(f"[整理失败] {filename}: {e}")

    return organized_files


def update_experience_from_supplement(skill_name, analyzed_files, issues=None):
    """根据补充资料分析结果更新经验库

    将补充资料中发现的问题、识别规则等沉淀到经验库。

    Args:
        skill_name: 技能名称
        analyzed_files: 已分析的文件信息列表
        issues: 发现的问题列表（可选）
    """
    from update_knowledge_after_skill import update_knowledge_after_skill

    # 沉淀识别规则
    if analyzed_files:
        rules = []
        for f in analyzed_files:
            if f.get('related_id'):
                rules.append(f"{f['filename']}: 识别为{f['category']}，关联{f['related_id']}")
            else:
                rules.append(f"{f['filename']}: 识别为{f['category']}")

        update_knowledge_after_skill(
            skill_name=skill_name,
            enterprise_name='',
            application_year=2026,
            experience_entry={
                'category': 'validation_rules',
                'title': f'{skill_name}补充资料识别规则',
                'content': '; '.join(rules)
            }
        )

    # 沉淀问题
    if issues:
        for issue in issues:
            update_knowledge_after_skill(
                skill_name=skill_name,
                enterprise_name='',
                application_year=2026,
                experience_entry={
                    'category': 'common_issues',
                    'title': f'{skill_name}补充资料问题',
                    'content': issue
                }
            )
```

## 模块六：PDF拆分与合并资料整理（pdf_splitter）

**用途**：自动检测合并PDF（多文档合订），拆分前备份原件，支持按书签/按内容类型/按页三种拆分方式，并提取文本/表格/图片和对扫描页执行OCR识别。
**核心原则**：
1. 所有PDF资料在进入分析流程前，必须先调用 `detect_and_process_merged_pdf()` 检测是否为合并PDF
2. 拆分前必须备份原件到 `_backup/pdf_original/` 目录，保留原始文件不变
3. 拆分优先级：按书签 > 按内容类型 > 按页（智能选择最合适的拆分方式）
4. 扫描页（无文本层）自动触发OCR识别

```python
import os
import re
import shutil
from datetime import datetime

# PDF处理依赖
try:
    from PyPDF2 import PdfReader, PdfWriter
    import pdfplumber
    _PYPDF2_AVAILABLE = True
except ImportError:
    _PYPDF2_AVAILABLE = False

# OCR依赖（可选，按需启用）
try:
    import pytesseract
    from PIL import Image
    import pdf2image
    _OCR_AVAILABLE = True
except ImportError:
    _OCR_AVAILABLE = False


# ============================================================
# 配置
# ============================================================

# 合并PDF检测阈值
MERGED_PDF_PAGE_THRESHOLD = 15        # 超过15页疑似合并PDF
MERGED_PDF_BOOKMARK_THRESHOLD = 2     # 顶级书签≥2个判定为合并

# 内容类型识别关键词（按优先级）
CONTENT_TYPE_PATTERNS = [
    # (类型标识, 中文关键词列表, 英文/数字关键词列表)
    ('certificate', ['证书', '专利号', '授权', '授予', '登记'], ['CERTIFICATE', 'PATENT NO', 'ZL']),
    ('software_copyright', ['计算机软件著作权', '软著登记'], ['SOFTWARE COPYRIGHT']),
    ('notice', ['通知书', '受理通知书', '审查意见'], ['NOTICE', 'OFFICE ACTION']),
    ('specification', ['说明书', '权利要求书', '摘要'], ['SPECIFICATION', 'CLAIMS']),
    ('invoice', ['发票', '增值税', '专用发票', '年费缴费'], ['INVOICE', 'FAPIAO']),
    ('contract', ['合同', '协议', '转让合同', '许可协议'], ['CONTRACT', 'AGREEMENT']),
    ('report', ['报告', '审计报告', '检测报告', '验收报告'], ['REPORT']),
    ('social_security', ['社保', '社会保险', '缴费证明'], ['SOCIAL SECURITY']),
    ('id_card', ['身份证', '居民身份证'], ['ID CARD']),
    ('degree', ['毕业证', '学位证', '学历证书'], ['DIPLOMA', 'DEGREE']),
    ('seal', ['公章', '印章'], ['SEAL']),
    ('rd_report', ['立项报告', '研发项目', '可行性研究'], ['PROJECT REPORT']),
    ('ps_description', ['技术说明', '产品说明', '关键技术'], ['PRODUCT SPEC']),
    ('achievement', ['成果转化', '科技成果', '转化证明'], ['ACHIEVEMENT']),
    ('management', ['管理制度', '研发制度', '激励制度'], ['MANAGEMENT']),
]

# 文件命名前缀映射（用于拆分后命名）
CONTENT_TYPE_PREFIX = {
    'certificate': '证书',
    'software_copyright': '软著证书',
    'notice': '通知书',
    'specification': '说明书',
    'invoice': '发票',
    'contract': '合同',
    'report': '报告',
    'social_security': '社保',
    'id_card': '身份证',
    'degree': '学历证书',
    'seal': '公章材料',
    'rd_report': 'RD立项书',
    'ps_description': 'PS技术说明',
    'achievement': '成果转化',
    'management': '管理制度',
    'unknown': '其他',
}


# ============================================================
# 1. 备份原件
# ============================================================

def backup_pdf_before_split(pdf_path, backup_dir=None):
    """拆分前备份原件，保留原始文件不变
    
    Args:
        pdf_path: 原始PDF路径
        backup_dir: 备份目录，默认为 {企业材料目录}/_backup/pdf_original/
    
    Returns:
        str: 备份文件路径，失败返回None
    """
    if not os.path.exists(pdf_path):
        return None
    
    if backup_dir is None:
        # 默认备份到 {pdf所在目录}/_backup/pdf_original/
        parent = os.path.dirname(pdf_path)
        backup_dir = os.path.join(parent, '_backup', 'pdf_original')
    
    os.makedirs(backup_dir, exist_ok=True)
    
    base_name = os.path.basename(pdf_path)
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    backup_name = f"{timestamp}_{base_name}"
    backup_path = os.path.join(backup_dir, backup_name)
    
    try:
        shutil.copy2(pdf_path, backup_path)
        return backup_path
    except Exception:
        return None


# ============================================================
# 2. 合并PDF检测
# ============================================================

def detect_merged_pdf(pdf_path):
    """检测PDF是否为合并PDF（多文档合订）
    
    判定规则（满足任一即判定为合并PDF）：
    1. 顶级书签≥2个
    2. 内容类型在不同页码段明显不同（≥2个内容段）
    3. 页面尺寸/方向变化频繁
    4. 页数超过阈值且无书签
    
    Returns:
        dict: {
            'is_merged': bool,
            'reason': str,
            'page_count': int,
            'bookmarks': list,
            'page_sizes': list,
            'content_types': list,
            'suggested_split_method': str,  # 'bookmark' | 'content_type' | 'page'
            'split_points': list,
        }
    """
    result = {
        'is_merged': False,
        'reason': '',
        'page_count': 0,
        'bookmarks': [],
        'page_sizes': [],
        'content_types': [],
        'suggested_split_method': 'page',
        'split_points': [],
    }
    
    if not _PYPDF2_AVAILABLE:
        result['reason'] = 'PyPDF2未安装'
        return result
    
    try:
        reader = PdfReader(pdf_path)
    except Exception:
        result['reason'] = 'PDF读取失败'
        return result
    
    page_count = len(reader.pages)
    result['page_count'] = page_count
    
    # ---- 规则1：书签检测 ----
    try:
        outlines = reader.outline
        top_bookmarks = _extract_top_level_bookmarks(outlines, reader)
        result['bookmarks'] = top_bookmarks
        if len(top_bookmarks) >= MERGED_PDF_BOOKMARK_THRESHOLD:
            result['is_merged'] = True
            result['reason'] = f'检测到{len(top_bookmarks)}个顶级书签'
            result['suggested_split_method'] = 'bookmark'
            result['split_points'] = [bm['page'] for bm in top_bookmarks]
            return result
    except Exception:
        pass
    
    # ---- 规则2：页面尺寸/方向 ----
    page_sizes = []
    for page in reader.pages:
        try:
            box = page.mediabox
            w, h = float(box.width), float(box.height)
            page_sizes.append((round(w, 1), round(h, 1)))
        except Exception:
            page_sizes.append((0, 0))
    result['page_sizes'] = page_sizes
    
    # ---- 规则3：内容类型检测 ----
    content_types = []
    try:
        with pdfplumber.open(pdf_path) as pdf:
            for page in pdf.pages:
                text = page.extract_text() or ''
                content_types.append(_classify_page_content(text))
    except Exception:
        content_types = ['unknown'] * page_count
    result['content_types'] = content_types
    
    # 检测内容类型变化（连续相同类型视为一段，段数≥2为合并PDF）
    segments = _group_content_segments(content_types)
    if len(segments) >= 2:
        result['is_merged'] = True
        result['reason'] = f'检测到{len(segments)}个内容段（类型变化）'
        result['suggested_split_method'] = 'content_type'
        result['split_points'] = [seg['start_page'] for seg in segments[1:]]
        return result
    
    # ---- 规则4：页面尺寸变化频繁 ----
    unique_sizes = set(page_sizes)
    if len(unique_sizes) >= 3 and page_count >= 5:
        result['is_merged'] = True
        result['reason'] = f'检测到{len(unique_sizes)}种页面尺寸'
        result['suggested_split_method'] = 'content_type'
        return result
    
    # ---- 规则5：页数阈值 ----
    if page_count >= MERGED_PDF_PAGE_THRESHOLD:
        result['is_merged'] = True
        result['reason'] = f'页数过多({page_count}页)'
        result['suggested_split_method'] = 'page'
        return result
    
    result['reason'] = '未检测到合并特征'
    return result


def _extract_top_level_bookmarks(outlines, reader):
    """提取顶级书签（不递归子级）"""
    bookmarks = []
    if not outlines:
        return bookmarks
    for item in outlines:
        if isinstance(item, list):
            continue  # 子级书签，跳过
        try:
            page_num = reader.get_destination_page_number(item)
            title = str(item.title) if hasattr(item, 'title') else str(item)
            bookmarks.append({'title': title, 'page': page_num})
        except Exception:
            continue
    return bookmarks


def _classify_page_content(text):
    """根据页面文本分类内容类型"""
    if not text:
        return 'unknown'
    text_upper = text.upper()
    for ctype, cn_keywords, en_keywords in CONTENT_TYPE_PATTERNS:
        for kw in cn_keywords:
            if kw in text:
                return ctype
        for kw in en_keywords:
            if kw in text_upper:
                return ctype
    return 'unknown'


def _group_content_segments(content_types):
    """将连续相同类型的页分组为段"""
    if not content_types:
        return []
    segments = []
    current_type = content_types[0]
    start = 0
    for i, ct in enumerate(content_types[1:], start=1):
        if ct != current_type and ct != 'unknown':
            segments.append({'type': current_type, 'start_page': start, 'end_page': i - 1})
            current_type = ct
            start = i
    segments.append({'type': current_type, 'start_page': start, 'end_page': len(content_types) - 1})
    # 过滤掉纯unknown的段
    return [seg for seg in segments if seg['type'] != 'unknown']


# ============================================================
# 3. 三种拆分方式
# ============================================================

def split_pdf_by_bookmark(pdf_path, output_dir, bookmarks):
    """按书签拆分PDF
    
    Args:
        pdf_path: 原始PDF路径
        output_dir: 输出目录
        bookmarks: detect_merged_pdf返回的bookmarks列表
    
    Returns:
        list: 拆分后的文件信息列表 [{path, title, page_range, content_type}]
    """
    if not _PYPDF2_AVAILABLE or not bookmarks:
        return []
    
    os.makedirs(output_dir, exist_ok=True)
    reader = PdfReader(pdf_path)
    total_pages = len(reader.pages)
    
    sorted_bms = sorted(bookmarks, key=lambda x: x['page'])
    results = []
    
    for idx, bm in enumerate(sorted_bms):
        start = bm['page']
        end = sorted_bms[idx + 1]['page'] - 1 if idx + 1 < len(sorted_bms) else total_pages - 1
        if start > end:
            continue
        
        writer = PdfWriter()
        for i in range(start, end + 1):
            writer.add_page(reader.pages[i])
        
        # 命名：{序号}_{书签标题}.pdf（清理非法字符）
        safe_title = re.sub(r'[\\/:*?"<>|]', '_', bm['title'])[:50]
        out_name = f"{idx + 1:02d}_{safe_title}.pdf"
        out_path = os.path.join(output_dir, out_name)
        
        with open(out_path, 'wb') as f:
            writer.write(f)
        
        results.append({
            'path': out_path,
            'title': bm['title'],
            'page_range': (start, end),
            'content_type': 'unknown',
        })
    
    return results


def split_pdf_by_content_type(pdf_path, output_dir, content_types=None):
    """按内容类型拆分PDF
    
    Args:
        pdf_path: 原始PDF路径
        output_dir: 输出目录
        content_types: 各页内容类型列表（如未提供则现场提取）
    
    Returns:
        list: 拆分后的文件信息列表
    """
    if not _PYPDF2_AVAILABLE:
        return []
    
    os.makedirs(output_dir, exist_ok=True)
    reader = PdfReader(pdf_path)
    total_pages = len(reader.pages)
    
    if content_types is None or len(content_types) != total_pages:
        content_types = []
        try:
            with pdfplumber.open(pdf_path) as pdf:
                for page in pdf.pages:
                    text = page.extract_text() or ''
                    content_types.append(_classify_page_content(text))
        except Exception:
            content_types = ['unknown'] * total_pages
    
    segments = _group_content_segments(content_types)
    if not segments:
        return []
    
    results = []
    for idx, seg in enumerate(segments):
        start, end = seg['start_page'], seg['end_page']
        if start > end:
            continue
        
        writer = PdfWriter()
        for i in range(start, end + 1):
            writer.add_page(reader.pages[i])
        
        ctype = seg['type']
        prefix = CONTENT_TYPE_PREFIX.get(ctype, '其他')
        out_name = f"{idx + 1:02d}_{prefix}_p{start + 1}-{end + 1}.pdf"
        out_path = os.path.join(output_dir, out_name)
        
        with open(out_path, 'wb') as f:
            writer.write(f)
        
        results.append({
            'path': out_path,
            'content_type': ctype,
            'page_range': (start, end),
        })
    
    return results


def split_pdf_by_page(pdf_path, output_dir, pages_per_file=1, page_ranges=None):
    """按页拆分PDF
    
    Args:
        pdf_path: 原始PDF路径
        output_dir: 输出目录
        pages_per_file: 每个文件包含的页数（默认每页一个文件）
        page_ranges: 自定义页码范围列表 [(0,2), (3,5), ...]，提供时忽略pages_per_file
    
    Returns:
        list: 拆分后的文件信息列表
    """
    if not _PYPDF2_AVAILABLE:
        return []
    
    os.makedirs(output_dir, exist_ok=True)
    reader = PdfReader(pdf_path)
    total_pages = len(reader.pages)
    
    if page_ranges is None:
        page_ranges = []
        for start in range(0, total_pages, pages_per_file):
            end = min(start + pages_per_file - 1, total_pages - 1)
            page_ranges.append((start, end))
    
    results = []
    base_name = os.path.splitext(os.path.basename(pdf_path))[0]
    
    for idx, (start, end) in enumerate(page_ranges):
        if start > end or start >= total_pages:
            continue
        end = min(end, total_pages - 1)
        
        writer = PdfWriter()
        for i in range(start, end + 1):
            writer.add_page(reader.pages[i])
        
        out_name = f"{base_name}_p{start + 1}-{end + 1}.pdf"
        out_path = os.path.join(output_dir, out_name)
        
        with open(out_path, 'wb') as f:
            writer.write(f)
        
        results.append({
            'path': out_path,
            'page_range': (start, end),
        })
    
    return results


# ============================================================
# 4. 内容提取（文本/表格/图片）
# ============================================================

def extract_pdf_content(pdf_path, page_range=None):
    """提取PDF内容（文本/表格/图片）
    
    Args:
        pdf_path: PDF路径
        page_range: (start, end) 页码范围（0-based），None表示全部
    
    Returns:
        dict: {
            'text': str,
            'tables': list,
            'images': list,
            'page_count': int,
        }
    """
    result = {'text': '', 'tables': [], 'images': [], 'page_count': 0}
    
    if not _PYPDF2_AVAILABLE:
        return result
    
    try:
        with pdfplumber.open(pdf_path) as pdf:
            total = len(pdf.pages)
            result['page_count'] = total
            
            if page_range is None:
                start, end = 0, total - 1
            else:
                start, end = page_range
                end = min(end, total - 1)
            
            all_text = []
            for i in range(start, end + 1):
                page = pdf.pages[i]
                text = page.extract_text() or ''
                all_text.append(text)
                tables = page.extract_tables() or []
                result['tables'].extend(tables)
                try:
                    images = page.images or []
                    for img in images:
                        result['images'].append({
                            'page': i,
                            'bbox': img.get('bbox'),
                            'width': img.get('width'),
                            'height': img.get('height'),
                        })
                except Exception:
                    pass
            
            result['text'] = '\n'.join(all_text)
    except Exception:
        pass
    
    return result


def ocr_scanned_pdf(pdf_path, page_range=None, lang='chi_sim+eng'):
    """对扫描版PDF执行OCR识别
    
    Args:
        pdf_path: PDF路径
        page_range: (start, end) 页码范围，None表示全部
        lang: OCR语言，默认中英混合
    
    Returns:
        str: OCR识别的文本
    """
    if not _OCR_AVAILABLE:
        return ''
    
    try:
        reader = PdfReader(pdf_path)
        total = len(reader.pages)
        if page_range is None:
            start, end = 0, total - 1
        else:
            start, end = page_range
            end = min(end, total - 1)
        
        all_text = []
        pages = pdf2image.convert_from_path(
            pdf_path,
            first_page=start + 1,
            last_page=end + 1,
            dpi=200,
        )
        
        for page_img in pages:
            text = pytesseract.image_to_string(page_img, lang=lang)
            all_text.append(text)
        
        return '\n'.join(all_text)
    except Exception:
        return ''


# ============================================================
# 5. 主入口：自动检测并处理合并PDF
# ============================================================

def detect_and_process_merged_pdf(pdf_path, output_dir=None, enable_ocr=True):
    """自动检测并处理合并PDF的主入口
    
    工作流程：
    1. 检测是否为合并PDF（detect_merged_pdf）
    2. 如果是：备份原件 → 选择拆分方式 → 拆分 → 提取内容
    3. 如果否：直接提取内容
    
    Args:
        pdf_path: PDF路径
        output_dir: 拆分后文件输出目录，默认为 {pdf所在目录}/{pdf文件名}_拆分/
        enable_ocr: 是否对扫描页启用OCR（默认True）
    
    Returns:
        dict: {
            'is_merged': bool,
            'split_method': str,
            'backup_path': str,
            'split_files': list,
            'extracted_content': dict,
            'ocr_text': str,
            'detection_info': dict,
        }
    """
    if not os.path.exists(pdf_path):
        return {'is_merged': False, 'error': '文件不存在'}
    
    if output_dir is None:
        base = os.path.splitext(os.path.basename(pdf_path))[0]
        output_dir = os.path.join(os.path.dirname(pdf_path), f'{base}_拆分')
    
    # 1. 检测
    info = detect_merged_pdf(pdf_path)
    
    result = {
        'is_merged': info['is_merged'],
        'split_method': '',
        'backup_path': None,
        'split_files': [],
        'extracted_content': {},
        'ocr_text': '',
        'detection_info': info,
    }
    
    if not info['is_merged']:
        # 非合并PDF：直接提取内容
        result['extracted_content'] = extract_pdf_content(pdf_path)
        return result
    
    # 2. 备份原件
    backup_path = backup_pdf_before_split(pdf_path)
    result['backup_path'] = backup_path
    
    # 3. 选择拆分方式并执行
    method = info['suggested_split_method']
    result['split_method'] = method
    
    if method == 'bookmark' and info['bookmarks']:
        split_files = split_pdf_by_bookmark(pdf_path, output_dir, info['bookmarks'])
    elif method == 'content_type' and info['content_types']:
        split_files = split_pdf_by_content_type(pdf_path, output_dir, info['content_types'])
    else:
        # 按页拆分（每页一个文件）
        split_files = split_pdf_by_page(pdf_path, output_dir, pages_per_file=1)
    
    result['split_files'] = split_files
    
    # 4. 对每个拆分后文件提取内容
    for sf in split_files:
        content = extract_pdf_content(sf['path'])
        sf['content'] = content
        if 'content_type' not in sf or sf.get('content_type') == 'unknown':
            sf['content_type'] = _classify_page_content(content['text'][:500])
        
        # 5. 扫描页OCR
        if enable_ocr and not content['text'].strip():
            ocr_text = ocr_scanned_pdf(sf['path'])
            sf['ocr_text'] = ocr_text
            result['ocr_text'] += ocr_text + '\n'
    
    return result


def batch_process_merged_pdfs(data_dir, file_patterns=None, enable_ocr=True):
    """批量扫描目录下的PDF文件，自动检测并处理合并PDF
    
    Args:
        data_dir: 数据目录
        file_patterns: 文件名匹配模式列表，默认['.pdf']
        enable_ocr: 是否启用OCR
    
    Returns:
        dict: {
            'scanned': int,
            'merged_count': int,
            'processed': list,
            'skipped': list,
        }
    """
    if file_patterns is None:
        file_patterns = ['.pdf']
    
    results = {
        'scanned': 0,
        'merged_count': 0,
        'processed': [],
        'skipped': [],
    }
    
    # 收集所有PDF文件（含压缩文件内部）
    all_files = []
    for root, _, files in os.walk(data_dir):
        for f in files:
            if any(f.lower().endswith(ext) for ext in file_patterns):
                all_files.append(os.path.join(root, f))
    
    for pdf_path in all_files:
        results['scanned'] += 1
        try:
            proc = detect_and_process_merged_pdf(pdf_path, enable_ocr=enable_ocr)
            if proc['is_merged']:
                results['merged_count'] += 1
                results['processed'].append({
                    'path': pdf_path,
                    'result': proc,
                })
            else:
                results['skipped'].append({
                    'path': pdf_path,
                    'reason': '非合并PDF',
                })
        except Exception as e:
            results['skipped'].append({
                'path': pdf_path,
                'reason': str(e),
            })
    
    return results
```

---

## 模块七：文件分类整理（file_organizer）

本模块负责将识别到的所有资料文件按"19类统一目录结构"整理归档。每次整理先检查19_补充资料目录，将可归类的文件分类移动到匹配目录，无法归类的保留在19_补充资料，并生成整理报告。

### 19类统一目录结构定义

```python
import os
import shutil
import json
import re
from datetime import datetime

# 19类统一目录结构（严格按照用户给出的编号和命名）
FILE_ORGANIZER_CATEGORIES = {
    '1_IP证明材料': {
        'display_name': '1.IP证明材料（知识产权）',
        'keywords': ['专利', '证书', '软著', '著作权', '知识产权', 'IP', 'patent', '登记簿', '缴费', '受让', '许可', '转让'],
        'naming_prefix': 'IP',
        'file_types': ['.pdf', '.jpg', '.png'],
        'priority': 1,
    },
    '2_RD研发活动': {
        'display_name': '2.企业研究开发活动情况证明材料-立项报告任务书验收报告（RD）',
        'keywords': ['立项', '研发项目', '验收', 'RD', '任务书', '研发活动', '可行性', '结题'],
        'naming_prefix': 'RD',
        'file_types': ['.pdf', '.docx', '.doc'],
        'priority': 2,
    },
    '3_PS证明材料': {
        'display_name': '3.PS证明材料（高新技术产品）',
        'keywords': ['高新产品', '产品说明', '产品技术', 'PS', '关键技术', '产品规格', '产品认证'],
        'naming_prefix': 'PS',
        'file_types': ['.pdf', '.docx'],
        'priority': 3,
    },
    '4_科技成果转化': {
        'display_name': '4.科技成果转化',
        'keywords': ['成果转化', '科技成果', '转化证明', '应用证明', '产业化'],
        'naming_prefix': None,
        'file_types': ['.pdf', '.docx'],
        'priority': 4,
    },
    '5_标准资料': {
        'display_name': '5.标准资料（参与制定的各类标准文件）',
        'keywords': ['标准', '国标', '行标', '企标', '团体标准', '参与制定', 'GB', 'ISO'],
        'naming_prefix': None,
        'file_types': ['.pdf', '.docx'],
        'priority': 5,
    },
    '6_营业执照': {
        'display_name': '6.营业执照',
        'keywords': ['营业执照', '工商', '统一社会信用代码', '法人', '变更', '承诺书'],
        'naming_prefix': None,
        'file_types': ['.pdf', '.jpg', '.png'],
        'priority': 6,
    },
    # 编号7用户跳过，保留
    '8_财务审计报告': {
        'display_name': '8.前三年财务审计报告',
        'keywords': ['审计', '财审', '年度审计', '财务报表', '资产负债', '利润表', '现金流量'],
        'naming_prefix': None,
        'file_types': ['.pdf'],
        'priority': 8,
    },
    '9_企业所得税申报表': {
        'display_name': '9.前三年企业所得税纳税申报表',
        'keywords': ['所得税', '纳税申报', '企业所得税', '年度纳税', 'A类'],
        'naming_prefix': None,
        'file_types': ['.pdf', '.xlsx'],
        'priority': 9,
    },
    '10_研发费用专项审计': {
        'display_name': '10.前三年研发费用专项审计报告',
        'keywords': ['研发费用', '专项审计', '研发投入', '加计扣除', '辅助账'],
        'naming_prefix': None,
        'file_types': ['.pdf', '.xlsx'],
        'priority': 10,
    },
    '11_高新产品收入审计': {
        'display_name': '11.上年度高新产品（服务）收入专项审计报告',
        'keywords': ['高新产品收入', '产品收入', '专项审计', '高新收入'],
        'naming_prefix': None,
        'file_types': ['.pdf'],
        'priority': 11,
    },
    '12_组织管理制度': {
        'display_name': '12-15.组织管理制度',
        'keywords': ['管理制度', '研发制度', '组织管理', '研发机构', '产学研', '激励', '绩效', '人才培养', '科技人员'],
        'naming_prefix': None,
        'file_types': ['.pdf', '.docx'],
        'priority': 12,
    },
    '16_人力资源': {
        'display_name': '16.人力资源情况证明材料',
        'keywords': ['花名册', '科技人员', '人员名单', '社保', '学历', '职称', '身份证', '人员信息', '考勤', '劳动合同'],
        'naming_prefix': None,
        'file_types': ['.pdf', '.xlsx', '.jpg', '.png'],
        'priority': 16,
    },
    '17_合同发票': {
        'display_name': '17.上年度与高新技术产品（服务）相关的代表性的销售合同与发票',
        'keywords': ['合同', '发票', '订单', '销售', '客户', 'fapiao', 'invoice', 'contract'],
        'naming_prefix': None,
        'file_types': ['.pdf', '.xlsx', '.jpg', '.png'],
        'priority': 17,
    },
    '18_往期项目资料': {
        'display_name': '18.往期项目资料',
        'keywords': ['往期', '历史', '往年', 'archive', '历年', '之前', '原'],
        'naming_prefix': None,
        'file_types': ['.pdf', '.docx', '.xlsx', '.zip'],
        'priority': 18,
    },
    '19_补充资料': {
        'display_name': '19.补充资料（用户新增，待分类）',
        'keywords': [],  # 补充资料目录的关键词为空，作为默认收容目录
        'naming_prefix': None,
        'file_types': ['.pdf', '.docx', '.xlsx', '.jpg', '.png', '.zip', '.rar'],
        'priority': 19,
        'is_default': True,  # 标记为默认收容目录
    },
}
```

### 归类决策函数

```python
def classify_file_to_category(file_path, file_content_text=None):
    """归类决策函数 - 判断文件应归到哪个19类目录
    
    决策优先级：
    1. 文件名前缀匹配（IP/RD/PS开头优先归到1/2/3类）
    2. 文件名关键词匹配（按目录优先级顺序匹配）
    3. 文件内容文本匹配（如提供file_content_text）
    4. 无法归类→归到19_补充资料（默认收容目录）
    
    Args:
        file_path: 文件路径
        file_content_text: 文件内容文本（可选，用于内容匹配）
    
    Returns:
        dict: {
            'category': str,  # 目录键名（如'1_IP证明材料'）
            'display_name': str,  # 显示名称
            'match_method': str,  # 匹配方式（prefix/keyword/content/default）
            'matched_keywords': list,  # 匹配到的关键词
            'confidence': float,  # 置信度（0-1）
            'conflict_categories': list,  # 同时匹配到的其他目录
        }
    """
    # 实现：先按前缀匹配IP/RD/PS，再按关键词匹配，冲突时按priority排序
    file_name = os.path.basename(file_path)
    name_no_ext, ext = os.path.splitext(file_name)
    name_lower = file_name.lower()
    
    default_category = '19_补充资料'
    default_result = {
        'category': default_category,
        'display_name': FILE_ORGANIZER_CATEGORIES[default_category]['display_name'],
        'match_method': 'default',
        'matched_keywords': [],
        'confidence': 0.0,
        'conflict_categories': [],
    }
    
    # 决策树第1步：前缀匹配（IP/RD/PS开头优先）
    prefix_map = {
        'IP': '1_IP证明材料',
        'RD': '2_RD研发活动',
        'PS': '3_PS证明材料',
    }
    for prefix, cat_key in prefix_map.items():
        # 文件名以IP/RD/PS开头并紧跟数字或下划线（如IP001、RD_2023、PS-01）
        if re.match(rf'^{prefix}[\d_\-]', name_no_ext, re.IGNORECASE):
            return {
                'category': cat_key,
                'display_name': FILE_ORGANIZER_CATEGORIES[cat_key]['display_name'],
                'match_method': 'prefix',
                'matched_keywords': [prefix],
                'confidence': 0.95,
                'conflict_categories': [],
            }
    
    # 收集关键词匹配结果（按目录优先级排序）
    matched_list = []  # [(cat_key, matched_kw_list), ...]
    for cat_key, cat_info in sorted(
        FILE_ORGANIZER_CATEGORIES.items(),
        key=lambda x: x[1]['priority']
    ):
        if cat_info.get('is_default'):
            continue  # 跳过默认收容目录
        keywords = cat_info.get('keywords', [])
        if not keywords:
            continue
        # 文件名关键词匹配
        name_matched = [kw for kw in keywords if kw.lower() in name_lower]
        if name_matched:
            matched_list.append((cat_key, name_matched, 'keyword'))
            continue
        # 文件内容关键词匹配（如提供）
        if file_content_text:
            content_lower = file_content_text.lower()
            content_matched = [kw for kw in keywords if kw.lower() in content_lower]
            if content_matched:
                matched_list.append((cat_key, content_matched, 'content'))
    
    # 决策树第2步：无匹配→默认归到19_补充资料
    if not matched_list:
        return default_result
    
    # 决策树第3步：有匹配，按priority排序取最优
    # matched_list已按priority排序（第一个为最优）
    best_cat, best_kw, best_method = matched_list[0]
    confidence = 0.9 if best_method == 'keyword' else 0.7
    
    # 冲突检测：其他目录也匹配到关键词
    conflict_categories = [m[0] for m in matched_list[1:]] if len(matched_list) > 1 else []
    if conflict_categories:
        confidence = max(confidence - 0.15, 0.0)  # 存在冲突降低置信度
    
    return {
        'category': best_cat,
        'display_name': FILE_ORGANIZER_CATEGORIES[best_cat]['display_name'],
        'match_method': best_method,
        'matched_keywords': best_kw,
        'confidence': confidence,
        'conflict_categories': conflict_categories,
    }
```

### 主整理函数

```python
def organize_files_to_categories(source_dir, target_root_dir, check_supplement_first=True, update_file_map=True):
    """主整理函数 - 将源目录文件按19类目录结构整理
    
    工作流程：
    1. 如果check_supplement_first=True，先检查{target_root_dir}/19_补充资料/目录
       - 扫描补充资料目录中的所有文件
       - 对每个文件调用classify_file_to_category判断归类
       - 可归类的文件移动到对应目录，无法归类的保留在19_补充资料
    2. 扫描source_dir下所有文件
    3. 对每个文件调用classify_file_to_category判断归类
    4. 移动文件到目标目录（同名冲突添加后缀）
    5. 生成整理报告（已归类/未归类/归类冲突/命名不规范4类清单）
    6. 如果update_file_map=True，更新file_map.json中文件路径
    
    Args:
        source_dir: 源文件目录
        target_root_dir: 目标根目录（19类目录的父目录）
        check_supplement_first: 是否先检查补充资料目录
        update_file_map: 是否更新文件图谱
    
    Returns:
        dict: {
            'total_files': int,
            'organized_files': list,  # 已归类文件 [{path, category, match_method}]
            'unorganized_files': list,  # 未归类（保留在19_补充资料）
            'conflict_files': list,  # 归类冲突 [{path, categories}]
            'naming_issues': list,  # 命名不规范
            'report_path': str,  # 整理报告文件路径
            'moved_from_supplement': int,  # 从补充资料移出的文件数
        }
    """
    # 初始化19类目录
    for cat_key, cat_info in FILE_ORGANIZER_CATEGORIES.items():
        cat_dir = os.path.join(target_root_dir, cat_key)
        os.makedirs(cat_dir, exist_ok=True)
    
    result = {
        'total_files': 0,
        'organized_files': [],
        'unorganized_files': [],
        'conflict_files': [],
        'naming_issues': [],
        'report_path': '',
        'moved_from_supplement': 0,
    }
    
    def _move_file_with_conflict(src_path, target_cat_key):
        """移动文件到目标目录，同名冲突添加后缀"""
        target_dir = os.path.join(target_root_dir, target_cat_key)
        file_name = os.path.basename(src_path)
        target_path = os.path.join(target_dir, file_name)
        if os.path.exists(target_path) and os.path.abspath(src_path) != os.path.abspath(target_path):
            name_no_ext, ext = os.path.splitext(file_name)
            timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
            new_name = f"{name_no_ext}_{timestamp}{ext}"
            target_path = os.path.join(target_dir, new_name)
        if os.path.abspath(src_path) == os.path.abspath(target_path):
            return target_path  # 已在目标位置
        shutil.move(src_path, target_path)
        return target_path
    
    def _process_file(file_path, source_label):
        """处理单个文件的归类与移动"""
        if not os.path.isfile(file_path):
            return
        result['total_files'] += 1
        cls_result = classify_file_to_category(file_path)
        cat_key = cls_result['category']
        method = cls_result['match_method']
        
        # 命名规范检查（IP/RD/PS类应有前缀）
        file_name = os.path.basename(file_path)
        name_no_ext, _ = os.path.splitext(file_name)
        if cat_key in ('1_IP证明材料', '2_RD研发活动', '3_PS证明材料'):
            expected_prefix = FILE_ORGANIZER_CATEGORIES[cat_key]['naming_prefix']
            if not re.match(rf'^{expected_prefix}[\d_\-]', name_no_ext, re.IGNORECASE):
                result['naming_issues'].append({
                    'path': file_path,
                    'category': cat_key,
                    'suggestion': f'建议命名为 {expected_prefix}XXX_描述.{os.path.splitext(file_name)[1][1:]}',
                })
        
        # 冲突文件记录
        if cls_result['conflict_categories']:
            result['conflict_files'].append({
                'path': file_path,
                'categories': [cat_key] + cls_result['conflict_categories'],
            })
        
        # 已在目标目录（19_补充资料）中且分类结果也是19_补充资料→保留不动
        target_dir_for_cat = os.path.join(target_root_dir, cat_key)
        if os.path.abspath(os.path.dirname(file_path)) == os.path.abspath(target_dir_for_cat):
            if method == 'default':
                result['unorganized_files'].append({
                    'path': file_path,
                    'reason': '无法归类，保留在19_补充资料',
                })
            else:
                result['organized_files'].append({
                    'path': file_path,
                    'category': cat_key,
                    'match_method': method,
                })
            return
        
        # 移动文件
        new_path = _move_file_with_conflict(file_path, cat_key)
        if method == 'default':
            result['unorganized_files'].append({
                'path': new_path,
                'reason': '无法归类，移动到19_补充资料',
            })
        else:
            result['organized_files'].append({
                'path': new_path,
                'category': cat_key,
                'match_method': method,
            })
    
    # 步骤1：先检查19_补充资料目录
    if check_supplement_first:
        supplement_dir = os.path.join(target_root_dir, '19_补充资料')
        if os.path.isdir(supplement_dir):
            before_count = len(result['organized_files'])
            for item in os.listdir(supplement_dir):
                item_path = os.path.join(supplement_dir, item)
                if os.path.isfile(item_path):
                    cls_result = classify_file_to_category(item_path)
                    if cls_result['match_method'] != 'default':
                        # 可归类，移动到对应目录
                        _process_file(item_path, 'supplement')
            result['moved_from_supplement'] = len(result['organized_files']) - before_count
    
    # 步骤2-4：扫描源目录并整理
    if source_dir and os.path.isdir(source_dir):
        for root, dirs, files in os.walk(source_dir):
            # 跳过目标根目录下的19类子目录（避免重复处理）
            if os.path.abspath(root).startswith(os.path.abspath(target_root_dir)):
                continue
            for fname in files:
                fpath = os.path.join(root, fname)
                _process_file(fpath, 'source')
    
    # 步骤5：生成整理报告
    result['report_path'] = generate_organize_report(result, target_root_dir)
    
    # 步骤6：更新file_map.json
    if update_file_map:
        try:
            file_map_path = os.path.join(
                os.path.dirname(target_root_dir),
                '.trae', 'project_knowledge', 'file_map.json'
            )
            if os.path.exists(file_map_path):
                with open(file_map_path, 'r', encoding='utf-8') as f:
                    file_map = json.load(f)
                # 更新文件路径
                for item in result['organized_files']:
                    old_path = item.get('path', '')
                    # file_map中的路径同步为新路径（此处仅记录，实际路径已移动）
                    for fm_key, fm_val in file_map.get('files', {}).items():
                        if isinstance(fm_val, dict) and fm_val.get('path') == old_path:
                            fm_val['category'] = item.get('category')
                with open(file_map_path, 'w', encoding='utf-8') as f:
                    json.dump(file_map, f, ensure_ascii=False, indent=2)
        except Exception:
            pass  # 更新失败不影响整理流程
    
    return result
```

### 生成整理报告函数

```python
def generate_organize_report(organize_result, target_root_dir):
    """生成文件整理报告（_file_organize_report.md）
    
    包含5大章节：
    1. 整理概览（总数/已归类/未归类/冲突/命名问题）
    2. 已归类文件清单（按19类目录分组）
    3. 未归类文件清单（保留在19_补充资料，说明原因和建议归类）
    4. 归类冲突清单（同时匹配多个目录的文件，建议人工确认）
    5. 命名不规范清单（不符合NAMING_PATTERNS的文件，给出建议命名）
    """
    report_path = os.path.join(target_root_dir, '_file_organize_report.md')
    
    total = organize_result.get('total_files', 0)
    organized = organize_result.get('organized_files', [])
    unorganized = organize_result.get('unorganized_files', [])
    conflicts = organize_result.get('conflict_files', [])
    naming_issues = organize_result.get('naming_issues', [])
    moved_from_supplement = organize_result.get('moved_from_supplement', 0)
    
    # 按目录分组已归类文件
    grouped = {}
    for item in organized:
        cat = item.get('category', '未知')
        grouped.setdefault(cat, []).append(item)
    
    lines = []
    lines.append('# 文件分类整理报告')
    lines.append('')
    lines.append(f'生成时间：{datetime.now().strftime("%Y-%m-%d %H:%M:%S")}')
    lines.append('')
    lines.append('## 一、整理概览')
    lines.append('')
    lines.append(f'- 文件总数：**{total}**')
    lines.append(f'- 已归类文件：**{len(organized)}**')
    lines.append(f'- 未归类文件（保留在19_补充资料）：**{len(unorganized)}**')
    lines.append(f'- 归类冲突文件：**{len(conflicts)}**')
    lines.append(f'- 命名不规范文件：**{len(naming_issues)}**')
    lines.append(f'- 从19_补充资料移出的文件：**{moved_from_supplement}**')
    lines.append('')
    
    lines.append('## 二、已归类文件清单（按19类目录分组）')
    lines.append('')
    for cat_key in sorted(FILE_ORGANIZER_CATEGORIES.keys(), key=lambda k: FILE_ORGANIZER_CATEGORIES[k]['priority']):
        files_in_cat = grouped.get(cat_key, [])
        if not files_in_cat:
            continue
        display_name = FILE_ORGANIZER_CATEGORIES[cat_key]['display_name']
        lines.append(f'### {display_name}（{len(files_in_cat)}个文件）')
        lines.append('')
        lines.append('| 序号 | 文件路径 | 匹配方式 | 匹配关键词 |')
        lines.append('|------|---------|---------|-----------|')
        for idx, item in enumerate(files_in_cat, 1):
            path = os.path.relpath(item.get('path', ''), target_root_dir)
            method = item.get('match_method', '')
            lines.append(f'| {idx} | {path} | {method} | - |')
        lines.append('')
    
    lines.append('## 三、未归类文件清单（保留在19_补充资料）')
    lines.append('')
    if not unorganized:
        lines.append('无未归类文件。')
    else:
        lines.append('| 序号 | 文件路径 | 原因 |')
        lines.append('|------|---------|------|')
        for idx, item in enumerate(unorganized, 1):
            path = os.path.relpath(item.get('path', ''), target_root_dir)
            reason = item.get('reason', '')
            lines.append(f'| {idx} | {path} | {reason} |')
    lines.append('')
    
    lines.append('## 四、归类冲突清单（同时匹配多个目录，建议人工确认）')
    lines.append('')
    if not conflicts:
        lines.append('无归类冲突文件。')
    else:
        lines.append('| 序号 | 文件路径 | 候选目录 |')
        lines.append('|------|---------|---------|')
        for idx, item in enumerate(conflicts, 1):
            path = os.path.relpath(item.get('path', ''), target_root_dir)
            cats = '、'.join(item.get('categories', []))
            lines.append(f'| {idx} | {path} | {cats} |')
    lines.append('')
    
    lines.append('## 五、命名不规范清单（不符合命名规范，给出建议命名）')
    lines.append('')
    if not naming_issues:
        lines.append('所有文件命名规范。')
    else:
        lines.append('| 序号 | 文件路径 | 所属目录 | 建议命名 |')
        lines.append('|------|---------|---------|---------|')
        for idx, item in enumerate(naming_issues, 1):
            path = os.path.relpath(item.get('path', ''), target_root_dir)
            cat = item.get('category', '')
            suggestion = item.get('suggestion', '')
            lines.append(f'| {idx} | {path} | {cat} | {suggestion} |')
    lines.append('')
    
    with open(report_path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines))
    
    return report_path
```

---

## 模块八：高新政策要求与合规校验（policy_compliance）

**设计思路**：政策依据作为独立JSON配置文件（policy_shenzhen.json），技能执行时读取配置而非内嵌到SKILL.md中，防止上下文过长。

**配置文件路径**：`_common/policy_shenzhen.json`（深圳市版）

**政策依据**：
- 《高新技术企业认定管理办法》（国科发火〔2016〕32号）
- 《高新技术企业认定管理工作指引》（国科发火〔2016〕194号）
- 深圳市科技创新委员会地方政策

**八大认定条件**（均嵌入JSON配置）：
1. 企业注册成立满一年（一票否决）
2. 自主知识产权（I类≥1项 或 II类≥5项）（一票否决）
3. 核心技术属于国家支持的高新技术领域8大领域之一（一票否决）
4. 科技人员占比≥10%（一票否决）
5. 研发费用占比达标（按销售收入分档3%/4%/5%）（一票否决）
6. 高新技术产品收入占比≥60%（一票否决）
7. 企业创新能力评价≥70分（知识产权30+成果转化30+研发组织管理20+企业成长20）
8. 前一年内无重大安全/质量事故/严重环境违法/严重失信（一票否决）

```python
import os
import json
from datetime import datetime, timedelta

# 政策配置文件路径
POLICY_CONFIG_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), '_common', 'policy_shenzhen.json')


def load_policy_config(region='shenzhen'):
    """加载政策配置文件（v1.9.0新增）
    
    从独立JSON配置文件读取政策依据，避免内嵌到SKILL.md导致上下文过长。
    
    Args:
        region: 地区（默认shenzhen，当前只支持深圳）
    
    Returns:
        dict: 政策配置字典，包含eight_conditions/quantitative_thresholds/shenzhen_specific/tech_fields等
    """
    config_path = POLICY_CONFIG_PATH
    if not os.path.exists(config_path):
        # 回退查找：技能目录上级的_common目录
        current_dir = os.getcwd()
        for _ in range(5):
            candidate = os.path.join(current_dir, '.trae', 'skills', '_common', 'policy_shenzhen.json')
            if os.path.exists(candidate):
                config_path = candidate
                break
            current_dir = os.path.dirname(current_dir)
    
    with open(config_path, 'r', encoding='utf-8') as f:
        config = json.load(f)
    
    return config


def validate_policy_compliance(enterprise_data, analysis_results=None, policy_config=None):
    """政策合规统一校验函数（v1.9.0新增）
    
    校验8大认定条件，输出合规报告。每个条件含政策依据、定量阈值、校验结果。
    
    Args:
        enterprise_data: 企业数据dict，包含：
            - register_date: 注册日期（YYYY-MM-DD）
            - declaration_date: 申报日期（YYYY-MM-DD）
            - ip_list: 知识产权清单 [{ip_id, ip_class(I/II), ip_name, auth_date}]
            - tech_field: 技术领域（8大领域之一）
            - total_staff: 职工总数
            - rnd_staff: 科技人员数
            - staff_work_days: {员工ID: 累计工作天数}
            - annual_sales: 近三年销售收入列表 [year1, year2, year3]
            - rnd_expense_total: 近三年研发费用总额
            - rnd_expense_domestic: 境内研发费用
            - high_tech_revenue: 高新技术产品收入
            - total_revenue: 总收入
            - innovation_scores: {ip_score, transform_score, management_score, growth_score}
            - has_major_safety_accident: 是否有重大安全事故
            - has_major_quality_accident: 是否有重大质量事故
            - has_serious_environmental_violation: 是否有严重环境违法
            - has_serious_dishonesty: 是否有严重失信
        analysis_results: 资料分析结果（可选，用于补充校验数据）
        policy_config: 政策配置（可选，默认自动加载）
    
    Returns:
        dict: {
            'all_passed': bool,  # 是否全部通过（一票否决项全通过且总分≥70）
            'total_score': float,  # 创新能力总分
            'conditions': list,  # 8大条件校验结果
            'veto_failed': list,  # 一票否决未通过项
            'report': str,  # 合规报告文本
            'policy_basis': str,  # 政策依据
        }
    """
    if policy_config is None:
        policy_config = load_policy_config()
    
    conditions_result = []
    veto_failed = []
    
    for condition in policy_config.get('eight_conditions', []):
        cid = condition['condition_id']
        cname = condition['condition_name']
        is_veto = condition.get('is_veto', False)
        func_name = condition.get('validation_function', '')
        basis = condition.get('policy_basis', '')
        
        result = {
            'condition_id': cid,
            'condition_name': cname,
            'policy_basis': basis,
            'is_veto': is_veto,
            'passed': True,
            'detail': '',
            'actual_value': None,
            'required_value': None,
        }
        
        # 条件1：注册满一年
        if cid == 1:
            register_date = enterprise_data.get('register_date', '')
            decl_date = enterprise_data.get('declaration_date', datetime.now().strftime('%Y-%m-%d'))
            if register_date:
                try:
                    reg_dt = datetime.strptime(register_date, '%Y-%m-%d')
                    decl_dt = datetime.strptime(decl_date, '%Y-%m-%d')
                    days = (decl_dt - reg_dt).days
                    result['actual_value'] = days
                    result['required_value'] = 365
                    result['passed'] = days >= 365
                    result['detail'] = f'注册日期{register_date}，距申报日期{decl_date}共{days}天'
                except ValueError:
                    result['passed'] = False
                    result['detail'] = f'注册日期格式错误: {register_date}'
            else:
                result['passed'] = False
                result['detail'] = '缺少注册日期数据'
        
        # 条件2：知识产权
        elif cid == 2:
            ip_list = enterprise_data.get('ip_list', [])
            class1_count = sum(1 for ip in ip_list if ip.get('ip_class') == 'I')
            class2_count = sum(1 for ip in ip_list if ip.get('ip_class') == 'II')
            result['actual_value'] = {'I类': class1_count, 'II类': class2_count}
            result['required_value'] = 'I类≥1 或 II类≥5'
            result['passed'] = class1_count >= 1 or class2_count >= 5
            result['detail'] = f'I类{class1_count}项，II类{class2_count}项'
        
        # 条件3：技术领域
        elif cid == 3:
            tech_field = enterprise_data.get('tech_field', '')
            valid_fields = [f['name'] for f in policy_config.get('tech_fields', [])]
            result['actual_value'] = tech_field
            result['required_value'] = valid_fields
            result['passed'] = tech_field in valid_fields
            result['detail'] = f'技术领域: {tech_field}'
        
        # 条件4：科技人员占比
        elif cid == 4:
            total_staff = enterprise_data.get('total_staff', 0)
            rnd_staff = enterprise_data.get('rnd_staff', 0)
            ratio = rnd_staff / total_staff if total_staff > 0 else 0
            threshold = policy_config['quantitative_thresholds']['staff_ratio']['min']
            result['actual_value'] = f'{ratio:.2%}'
            result['required_value'] = f'{threshold:.0%}'
            result['passed'] = ratio >= threshold
            result['detail'] = f'科技人员{rnd_staff}人/职工总数{total_staff}人={ratio:.2%}'
        
        # 条件5：研发费用占比
        elif cid == 5:
            sales = enterprise_data.get('annual_sales', [0, 0, 0])
            total_sales = sum(sales) if sales else 0
            rnd_total = enterprise_data.get('rnd_expense_total', 0)
            ratio = rnd_total / total_sales if total_sales > 0 else 0
            
            thresholds = policy_config['quantitative_thresholds']['rnd_expense_ratio']
            if total_sales < 50000000:
                required = thresholds['below_50m']
                tier = '销售收入<5000万'
            elif total_sales < 200000000:
                required = thresholds['50m_to_200m']
                tier = '5000万≤销售收入<2亿'
            else:
                required = thresholds['above_200m']
                tier = '销售收入≥2亿'
            
            # 境内占比
            rnd_domestic = enterprise_data.get('rnd_expense_domestic', 0)
            domestic_ratio = rnd_domestic / rnd_total if rnd_total > 0 else 0
            domestic_required = policy_config['quantitative_thresholds']['rnd_expense_domestic_ratio']['min']
            
            result['actual_value'] = {'研发费用占比': f'{ratio:.2%}', '境内占比': f'{domestic_ratio:.2%}'}
            result['required_value'] = {'研发费用占比': f'{required:.0%}({tier})', '境内占比': f'{domestic_required:.0%}'}
            result['passed'] = ratio >= required and domestic_ratio >= domestic_required
            result['detail'] = f'{tier}，研发费用占比{ratio:.2%}(要求≥{required:.0%})，境内占比{domestic_ratio:.2%}(要求≥{domestic_required:.0%})'
        
        # 条件6：高新收入占比
        elif cid == 6:
            high_tech_rev = enterprise_data.get('high_tech_revenue', 0)
            total_rev = enterprise_data.get('total_revenue', 0)
            ratio = high_tech_rev / total_rev if total_rev > 0 else 0
            threshold = policy_config['quantitative_thresholds']['high_tech_revenue_ratio']['min']
            result['actual_value'] = f'{ratio:.2%}'
            result['required_value'] = f'{threshold:.0%}'
            result['passed'] = ratio >= threshold
            result['detail'] = f'高新收入{high_tech_rev}/总收入{total_rev}={ratio:.2%}'
        
        # 条件7：创新能力评价
        elif cid == 7:
            scores = enterprise_data.get('innovation_scores', {})
            ip_score = scores.get('ip_score', 0)
            transform_score = scores.get('transform_score', 0)
            mgmt_score = scores.get('management_score', 0)
            growth_score = scores.get('growth_score', 0)
            total_score = ip_score + transform_score + mgmt_score + growth_score
            threshold = policy_config['quantitative_thresholds']['innovation_score']['min']
            result['actual_value'] = f'{total_score}分(IP:{ip_score}+转化:{transform_score}+管理:{mgmt_score}+成长:{growth_score})'
            result['required_value'] = f'{threshold}分'
            result['passed'] = total_score >= threshold
            result['detail'] = result['actual_value']
        
        # 条件8：无重大违规
        elif cid == 8:
            has_safety = enterprise_data.get('has_major_safety_accident', False)
            has_quality = enterprise_data.get('has_major_quality_accident', False)
            has_env = enterprise_data.get('has_serious_environmental_violation', False)
            has_dishonesty = enterprise_data.get('has_serious_dishonesty', False)
            violations = []
            if has_safety: violations.append('重大安全事故')
            if has_quality: violations.append('重大质量事故')
            if has_env: violations.append('严重环境违法')
            if has_dishonesty: violations.append('严重违法失信')
            result['actual_value'] = '无' if not violations else '、'.join(violations)
            result['required_value'] = '无重大违规'
            result['passed'] = len(violations) == 0
            result['detail'] = result['actual_value']
        
        conditions_result.append(result)
        
        if is_veto and not result['passed']:
            veto_failed.append(result)
    
    # 创新能力总分
    innovation_scores = enterprise_data.get('innovation_scores', {})
    total_score = sum(innovation_scores.values()) if innovation_scores else 0
    
    all_passed = len(veto_failed) == 0 and total_score >= 70
    
    # 生成报告
    report_lines = [
        f'# 高新认定政策合规校验报告',
        f'',
        f'**政策依据**：{", ".join(policy_config.get("policy_sources", {}).get("national", [{}])[0].get("doc_id", ""))}',
        f'**地区**：{policy_config.get("region", "深圳市")}',
        f'**校验时间**：{datetime.now().strftime("%Y-%m-%d %H:%M:%S")}',
        f'',
        f'## 校验结果',
        f'',
        f'- 总体结论：{"✓ 通过" if all_passed else "✗ 未通过"}',
        f'- 一票否决项：{len(veto_failed)}项未通过',
        f'- 创新能力总分：{total_score}分（要求≥70分）',
        f'',
        f'## 八大认定条件明细',
        f'',
    ]
    
    for r in conditions_result:
        status = '✓ 通过' if r['passed'] else ('❌ 一票否决' if r['is_veto'] else '⚠ 未达标')
        report_lines.append(f'### 条件{r["condition_id"]}：{r["condition_name"]} {status}')
        report_lines.append(f'- 政策依据：{r["policy_basis"]}')
        report_lines.append(f'- 实际值：{r["actual_value"]}')
        report_lines.append(f'- 要求值：{r["required_value"]}')
        report_lines.append(f'- 说明：{r["detail"]}')
        report_lines.append('')
    
    report = '\n'.join(report_lines)
    
    return {
        'all_passed': all_passed,
        'total_score': total_score,
        'conditions': conditions_result,
        'veto_failed': veto_failed,
        'report': report,
        'policy_basis': '国科发火〔2016〕32号 + 国科发火〔2016〕194号',
    }


def get_shenzhen_specific_requirements():
    """获取深圳市地方政策差异（v1.9.0新增）
    
    返回深圳市与国家政策的差异点，供技能校验时参考。
    
    Returns:
        dict: 深圳市地方政策差异
    """
    config = load_policy_config()
    return config.get('shenzhen_specific', {})


def validate_shenzhen_ip_policy(ip_list):
    """深圳市知识产权政策校验（v1.9.0新增）
    
    深圳市特殊政策：
    - I类IP有1项即可
    - II类IP可5项以上但不超过15项计分
    - 无II类知识产权占比不超过50%的限制
    
    Args:
        ip_list: 知识产权清单
    
    Returns:
        dict: 校验结果
    """
    config = load_policy_config()
    shenzhen_ip = config.get('shenzhen_specific', {}).get('ip_policy', {})
    
    class1_count = sum(1 for ip in ip_list if ip.get('ip_class') == 'I')
    class2_count = sum(1 for ip in ip_list if ip.get('ip_class') == 'II')
    
    max_class2 = shenzhen_ip.get('class2_max_count_for_scoring', 15)
    
    passed = class1_count >= 1 or class2_count >= 5
    scoring_warning = class2_count > max_class2
    
    return {
        'passed': passed,
        'class1_count': class1_count,
        'class2_count': class2_count,
        'class2_max_for_scoring': max_class2,
        'scoring_warning': scoring_warning,
        'detail': f'I类{class1_count}项，II类{class2_count}项（计分上限{max_class2}项）',
        'local_policy': shenzhen_ip.get('note', '')
    }
```

---

## 模块九：企业基本信息联网搜索（enterprise_info_search）

**设计思路**：通过联网搜索补充企业基本信息（注册时间、经营范围、简介、官方网站等），减少客户手动填写工作量。

**搜索能力**：使用WebSearch和WebFetch工具搜索企业公开信息

**可补充的信息**：
- 企业全称、曾用名
- 注册时间、注册资本
- 法定代表人
- 经营范围
- 企业简介
- 官方网站
- 联系方式
- 所属行业
- 统一社会信用代码

**信息来源**：
- 企查查/天眼查公开信息
- 国家企业信用信息公示系统
- 企业官方网站
- 上市公司公告（如适用）

```python
import re
import json
from datetime import datetime


def search_enterprise_info(enterprise_name, search_keywords=None):
    """联网搜索企业基本信息（v1.9.0新增）
    
    通过WebSearch工具搜索企业公开信息，补充收资清单中需要客户手动填写的字段。
    
    ⚠️ 本函数需要agent调用WebSearch工具，函数本身只构造搜索查询和建议，
    实际搜索由agent在技能执行时完成。
    
    Args:
        enterprise_name: 企业全称
        search_keywords: 额外搜索关键词列表（可选）
    
    Returns:
        dict: {
            'search_queries': list,  # 建议的搜索查询列表
            'info_fields': list,  # 需要补充的字段列表
            'search_guide': str,  # 搜索指南文本
            'parse_guide': str,  # 解析指南
        }
    """
    # 构造搜索查询
    queries = [
        f'{enterprise_name} 企业信息 注册时间 经营范围',
        f'{enterprise_name} 统一社会信用代码 法定代表人',
        f'{enterprise_name} 官网 企业简介',
        f'{enterprise_name} 企查查',
        f'{enterprise_name} 天眼查',
    ]
    
    if search_keywords:
        for kw in search_keywords:
            queries.append(f'{enterprise_name} {kw}')
    
    # 需要补充的字段
    info_fields = [
        {'field': 'enterprise_full_name', 'label': '企业全称', 'source': '工商注册信息', 'required': True},
        {'field': 'former_name', 'label': '曾用名', 'source': '工商注册信息', 'required': False},
        {'field': 'register_date', 'label': '注册日期', 'source': '工商注册信息', 'required': True, 'policy_basis': '条件1：注册满一年'},
        {'field': 'register_capital', 'label': '注册资本', 'source': '工商注册信息', 'required': True},
        {'field': 'legal_representative', 'label': '法定代表人', 'source': '工商注册信息', 'required': True},
        {'field': 'business_scope', 'label': '经营范围', 'source': '工商注册信息', 'required': True},
        {'field': 'unified_social_credit_code', 'label': '统一社会信用代码', 'source': '工商注册信息', 'required': True},
        {'field': 'official_website', 'label': '官方网站', 'source': '搜索结果', 'required': False},
        {'field': 'enterprise_intro', 'label': '企业简介', 'source': '企业官网/公开资料', 'required': False},
        {'field': 'contact_info', 'label': '联系方式', 'source': '企业官网', 'required': False},
        {'field': 'industry', 'label': '所属行业', 'source': '工商注册信息', 'required': True},
        {'field': 'enterprise_type', 'label': '企业类型', 'source': '工商注册信息', 'required': True},
        {'field': 'address', 'label': '注册地址', 'source': '工商注册信息', 'required': True},
    ]
    
    search_guide = f"""# 企业信息联网搜索指南

## 搜索目标企业：{enterprise_name}

## 搜索查询（按顺序执行）
"""
    for i, q in enumerate(queries, 1):
        search_guide += f"{i}. {q}\n"
    
    search_guide += f"""
## 需要补充的字段（{len(info_fields)}项）
"""
    for f in info_fields:
        required_mark = '★必须' if f['required'] else '可选'
        basis = f.get('policy_basis', '')
        basis_str = f'（{basis}）' if basis else ''
        search_guide += f"- [{required_mark}] {f['label']}（{f['source']}）{basis_str}\n"
    
    parse_guide = """## 信息解析规则

1. **注册日期**：从工商信息提取，格式YYYY-MM-DD
2. **注册资本**：提取数字+单位（万元/元）
3. **经营范围**：完整提取，用于判断技术领域归属
4. **统一社会信用代码**：18位代码
5. **官方网站**：提取URL，验证可访问性
6. **企业简介**：提取前500字，用于申报书"企业简介"部分

## 搜索结果可信度判断
- 企查查/天眼查：高可信度（工商数据源）
- 国家企业信用信息公示系统：最高可信度（官方）
- 企业官网：中可信度（需交叉验证）
- 第三方报道：低可信度（需交叉验证）
"""
    
    return {
        'search_queries': queries,
        'info_fields': info_fields,
        'search_guide': search_guide,
        'parse_guide': parse_guide,
    }


def parse_enterprise_info_from_search(search_results, enterprise_name):
    """从搜索结果解析企业信息（v1.9.0新增）
    
    将WebSearch/WebFetch返回的搜索结果文本解析为结构化企业信息。
    
    Args:
        search_results: 搜索结果文本列表
        enterprise_name: 企业名称
    
    Returns:
        dict: 解析后的企业信息
    """
    parsed = {
        'enterprise_full_name': enterprise_name,
        'former_name': None,
        'register_date': None,
        'register_capital': None,
        'legal_representative': None,
        'business_scope': None,
        'unified_social_credit_code': None,
        'official_website': None,
        'enterprise_intro': None,
        'industry': None,
        'enterprise_type': None,
        'address': None,
        'parse_confidence': {},
    }
    
    all_text = '\n'.join(search_results) if isinstance(search_results, list) else str(search_results)
    
    # 解析统一社会信用代码（18位字母数字）
    code_match = re.search(r'统一社会信用代码[：:]\s*([0-9A-Z]{18})', all_text)
    if code_match:
        parsed['unified_social_credit_code'] = code_match.group(1)
        parsed['parse_confidence']['unified_social_credit_code'] = 'high'
    else:
        # 尝试匹配18位代码
        code_match2 = re.search(r'\b([0-9A-Z]{18})\b', all_text)
        if code_match2:
            parsed['unified_social_credit_code'] = code_match2.group(1)
            parsed['parse_confidence']['unified_social_credit_code'] = 'medium'
    
    # 解析注册日期
    date_match = re.search(r'成立日期[：:]\s*(\d{4}[-/年]\d{1,2}[-/月]\d{1,2})', all_text)
    if date_match:
        date_str = date_match.group(1).replace('年', '-').replace('月', '-').replace('/', '-')
        parsed['register_date'] = date_str
        parsed['parse_confidence']['register_date'] = 'high'
    else:
        date_match2 = re.search(r'(\d{4}[-/]\d{1,2}[-/]\d{1,2}).*成立', all_text)
        if date_match2:
            parsed['register_date'] = date_match2.group(1).replace('/', '-')
            parsed['parse_confidence']['register_date'] = 'medium'
    
    # 解析注册资本
    capital_match = re.search(r'注册资本[：:]\s*([\d,.]+)\s*(万?元)', all_text)
    if capital_match:
        parsed['register_capital'] = f'{capital_match.group(1)}{capital_match.group(2)}'
        parsed['parse_confidence']['register_capital'] = 'high'
    
    # 解析法定代表人
    legal_match = re.search(r'法定代表人[：:]\s*([\u4e00-\u9fa5]{2,4})', all_text)
    if legal_match:
        parsed['legal_representative'] = legal_match.group(1)
        parsed['parse_confidence']['legal_representative'] = 'high'
    
    # 解析经营范围
    scope_match = re.search(r'经营范围[：:]\s*(.+?)(?:\n|$)', all_text)
    if scope_match:
        parsed['business_scope'] = scope_match.group(1).strip()
        parsed['parse_confidence']['business_scope'] = 'high'
    
    # 解析官方网站
    url_match = re.search(r'(?:官网|官方网站|网站)[：:]\s*(https?://[^\s]+)', all_text, re.IGNORECASE)
    if url_match:
        parsed['official_website'] = url_match.group(1)
        parsed['parse_confidence']['official_website'] = 'high'
    else:
        url_match2 = re.search(r'(https?://(?:www\.)?' + re.escape(enterprise_name[:4]) + r'[^\s]+)', all_text, re.IGNORECASE)
        if url_match2:
            parsed['official_website'] = url_match2.group(1)
            parsed['parse_confidence']['official_website'] = 'medium'
    
    # 解析企业简介
    intro_match = re.search(r'(?:简介|企业简介|公司简介)[：:]\s*(.+?)(?:\n\n|\n##|\n#|$)', all_text, re.DOTALL)
    if intro_match:
        intro = intro_match.group(1).strip()
        parsed['enterprise_intro'] = intro[:500] if len(intro) > 500 else intro
        parsed['parse_confidence']['enterprise_intro'] = 'high'
    
    # 解析企业类型
    type_match = re.search(r'企业类型[：:]\s*(.+?)(?:\n|$)', all_text)
    if type_match:
        parsed['enterprise_type'] = type_match.group(1).strip()
        parsed['parse_confidence']['enterprise_type'] = 'high'
    
    return parsed


def supplement_enterprise_info_from_search(enterprise_name, existing_info=None):
    """通过联网搜索补充企业信息（v1.9.0新增，供agent调用）
    
    ⚠️ 本函数生成搜索指南，实际搜索由agent执行WebSearch工具完成。
    Agent调用流程：
    1. 调用本函数获取搜索指南
    2. 按指南执行WebSearch搜索
    3. 调用parse_enterprise_info_from_search解析结果
    4. 合并到existing_info中
    
    Args:
        enterprise_name: 企业名称
        existing_info: 已有企业信息（可选，用于标记缺失字段）
    
    Returns:
        dict: {
            'search_guide': str,  # 搜索指南
            'missing_fields': list,  # 缺失字段
            'agent_instruction': str,  # agent执行指令
        }
    """
    search_result = search_enterprise_info(enterprise_name)
    
    # 找出缺失字段
    missing_fields = []
    if existing_info:
        for field_info in search_result['info_fields']:
            field_name = field_info['field']
            if not existing_info.get(field_name):
                missing_fields.append(field_info)
    else:
        missing_fields = search_result['info_fields']
    
    agent_instruction = f"""# 企业信息联网搜索执行指令

## 搜索目标
企业名称：{enterprise_name}

## 缺失字段（{len(missing_fields)}项需补充）
"""
    for f in missing_fields:
        required_mark = '★必须' if f['required'] else '可选'
        basis = f.get('policy_basis', '')
        basis_str = f'（{basis}）' if basis else ''
        agent_instruction += f"- [{required_mark}] {f['label']}（来源：{f['source']}）{basis_str}\n"
    
    agent_instruction += f"""
## 执行步骤
1. 对以下查询依次执行WebSearch搜索：
"""
    for i, q in enumerate(search_result['search_queries'], 1):
        agent_instruction += f"   {i}. \"{q}\"\n"
    
    agent_instruction += """
2. 对搜索结果中包含企业工商信息的网页，使用WebFetch获取详细内容
3. 调用parse_enterprise_info_from_search解析搜索结果
4. 将解析结果合并到企业信息中
5. 标记信息来源和可信度

## 注意事项
- 优先采信国家企业信用信息公示系统、企查查、天眼查的数据
- 企业官网信息需交叉验证
- 注册日期、统一社会信用代码为高新认定条件1的校验依据，必须准确
"""
    
    return {
        'search_guide': search_result['search_guide'],
        'missing_fields': missing_fields,
        'agent_instruction': agent_instruction,
        'info_fields': search_result['info_fields'],
    }
```

---

## 模块十：Dify工作流集成（dify_workflow）

本模块为Dify工作流平台的集成适配层，支持通过Dify工作流生成RD立项书等文档。

### 核心设计原则：动态适配层

工作流应用可能随时更新（输入变量变化、参数调整），因此模块十必须实现**动态适配层**：
1. 每次执行前先调 `GET /parameters` 获取最新的输入变量定义
2. 根据映射规则（`match_by` label/variable/hint + `match_keywords`）将本地文件匹配到工作流变量
3. 动态获取失败时回退到 `dify_config.json` 中的 `static_variables`
4. 输出字段也通过 `auto_discover` 策略动态解析（`known_output_fields` 列出多个候选字段名）

### 配置文件

配置文件路径：`_common/dify_config.json`（已创建，包含API配置、variable_mapping映射规则、output_mapping输出解析规则、local_files本地文件查找规则、qc质量校验配置）。

工作流更新时只需更新 `dify_config.json` 中的映射规则，无需修改技能代码。

### 完整代码

```python
import os
import json
import time
import requests
from datetime import datetime

# 配置文件路径
DIFY_CONFIG_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), '_common', 'dify_config.json')


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
```

---

## 模块十一：RD-IP-PS 自主匹配与审核（rd_ip_ps_matching）

**设计原则（核心）**：绝不完全以工作流输出为准。技能内置**确定性规则算法作为主匹配器**，调用 Dify 工作流 `WF_RD_PS_IP_Matching_V2` 仅作交叉参考。实测该工作流的 IP 匹配节点存在 bug（对全部 RD 返回空 `ips:[]`），因此以自主算法为准，两者不一致时在审核报告标注差异。

**匹配规则（对应用户要求）**：
1. 一个RD可对应多个PS和IP（多对多映射）
2. RD时间不应晚于IP：非发明专利 RD.year ≤ IP申请年份为硬约束，且时间越接近得分越高
3. 发明专利豁免"时间相近"约束：允许RD关联较早年份的发明作为技术基础（IP.year可早于RD.year）
4. 所有IP必须匹配不能闲置：主匹配后扫描闲置IP，强制兜底分配到最相近RD并在报告标注

**配置文件**：`_common/rd_ip_ps_matching_config.json`（领域关键词/时间阈值/打分权重/工作流API）

**打分模型**：综合得分 = 领域匹配(40) + 关键词重叠(35) + 时间接近度(25) [+发明技术基础加分(10)]，低于阈值(20)不主动匹配，仅兜底可突破。

```python
import json
import os
import re
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
    if value is None:
        return None
    m = re.search(r'(19|20)\d{2}', str(value))
    return int(m.group(0)) if m else None


def _classify_domain(name, config):
    dom = config['domain_classification']
    scores = {'curtain_wall': 0, 'window_door': 0, 'general': 0}
    for key in scores:
        for kw in dom[key]['keywords']:
            if kw in name:
                scores[key] += 1
    best = max(scores, key=scores.get)
    return 'window_door' if scores[best] == 0 else best


def _tokenize(name):
    keywords = ['铝合金', '门窗', '推拉', '平开', '纱窗', '纱扇', '铰链', '中梃', '压条', '压线',
                '锁', '自锁', '排水', '密封', '隔热', '隔音', '保温', '断桥', '外开', '幕墙',
                '蜂窝', '立柱', '遮阳', '型材', '防雷', '护板', '护栏', '天窗', '防蚊', '呼吸',
                '垫块', '卡件', '防脱', '防撞', '复合', '木塑', '监测', '玻璃', '栏杆', '折叠',
                '提升', '转角', '拐角', '模块', '磁悬浮', '物联网', '单片机', '窗体', '门', '窗']
    return set(kw for kw in keywords if kw in name)


def _is_invention(ip_type, config):
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
```

---

## 模块十二：企业微信会话实时查询与附件收集（wecom_collector）

**用途**：从企业微信客户端实时解密数据库，查询会话消息并收集附件文件。适用于从企微缓存中按客户企业名称收集高新认定项目资料。

**核心安全约束（不可违反）**：
1. **实时解密**：所有查询从 `Data/` 目录原始加密 DB 实时解密，不读取已解密数据
2. **会话-文件-缓存三联动**：所有文件操作必须经 `conversation_id` 上下文，禁止无上下文扫描缓存目录（缓存目录按年月组织不按客户组织，无上下文扫描必然串客户）
3. **不依赖 wecom_exporter**：仅依赖同目录 `wecom_crypto.py` + `pycryptodome`

**企微客户端三重关联机制（已实测验证）**：
- 关联1：`message_table.message_id` ↔ `file_table4.message_id`（直接主键关联）
- 关联2：`file_table4.conversation_id`（直接记录文件所属会话，**file_table4 表第 10 列字段，v1.2.0 强化说明**）
- 关联3：`file_table4.name + size` → 缓存目录预筛 → `md5` 确认（实测命中率 82.35%）

**关联机制技术说明**（v1.2.0 新增，详见 gxtz-wecom-collector SKILL.md）：
- file_table4 表共 11 字段：origin/message_id/file_index/message_type/extension_type/name/size/receive_time/sender_id/**conversation_id**/md5
- file_table4 **无 file_path 字段**，企微通过 conversation_id + name + md5 + size + receive_time 五元组在缓存目录动态定位
- SQL 查询示例：`WHERE conversation_id IN ('R:xxx', 'S:xxx_yyy')`（wecom_query.py 第 406-410 行）
- 防串客户双重校验：前置（match_file_in_cache strict_conv_check）+ 后置（security_check violations=[]）
- v1.1.0 端到端实测（派成铝业）：total=158/matched=122/conv_check_failed=0/security_check.passed=true

**缓存目录分类规则（实测确认）**：
- `message_type=0`（普通文件）→ `Cache/File/{年月}/{原始文件名}`
- `message_type=1`（图片截图）→ `Cache/Image/{年月}/{原始文件名}`

**独立脚本路径**：
- `_common/wecom_crypto.py` - 企微数据库实时解密模块
- `_common/wecom_query.py` - WeCom CLI 工具（8 子命令）
- `_common/wecom_config.json` - 配置文件（v1.2.1+，path_vars 变量化）

**四层匹配策略**（v1.1.0 强化，防串客户）：

match_file_in_cache 函数按以下顺序匹配：

1. **强制 conversation_id 校验**（strict_conv_check=True）：file_meta.conversation_id 必须等于 expected_conversation_id
2. **download_file_point.file_path 直接路径优先**：若配置启用，直接使用断点续传路径并 MD5 验证
3. **按 receive_time 精准定位年月子目录**：推算 YYYY-MM，仅在对应子目录按 name 查找 + MD5 验证
4. **回退全量扫描**（带 conversation_id 上下文）：精准查找失败时回退，仍强制校验

**CLI 用法**：

```bash
# 诊断数据源可用性
python wecom_query.py diagnose

# 列出会话（按企业名称关键词筛选）
python wecom_query.py list-conversations --keyword "企业名称"

# 一键式按企业名称收集附件（推荐）
python wecom_query.py collect-by-enterprise --enterprise "企业名称" --out "输出目录" --keyword "专利,社保" --date-from 2025-01 --date-to 2026-12

# 列出指定会话的文件元数据
python wecom_query.py list-files --conv "R:会话ID"

# 导出指定会话的文件
python wecom_query.py export-files --conv "R:会话ID" --out "输出目录"

# 在指定会话中搜索消息
python wecom_query.py search --conv "R:会话ID" --keyword "关键词"

# 从指定会话提取项目信息
python wecom_query.py extract-info --conv "R:会话ID"

# 验证会话-文件-缓存三联动完整性（v1.1.0 新增）
python wecom_query.py verify-association --conv "R:会话ID"
```

**函数签名**（供技能参考调用）：

```python
WECOM_CONFIG_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), '_common', 'wecom_config.json')

def load_wecom_config():
    """加载 wecom_config.json 配置
    Returns: dict 配置字典
    """

def diagnose_wecom_source(config=None):
    """诊断数据源可用性
    Returns: dict {
        success: bool,
        decrypted_in_realtime: True,
        data_source: {db_dir, db_available, dbs: {message.db, file.db, user.db, session.db}},
        keys: {available, source, db_count},
        cache: {file_dir, image_dir, cache_file_count},
        wxwork_process: {running, pid_count},
        overall_ready: bool
    }
    """

def list_wecom_conversations(keyword=None, kind=None, limit=50, config=None):
    """列出会话（按企业名称关键词筛选）
    Args:
        keyword: 企业名称关键词
        kind: 会话类型筛选（group/single/other）
        limit: 最大返回数
    Returns: dict {success, decrypted_in_realtime, keyword, count, conversations: [{id, name, kind, match_strategy, message_count, last_time}]}
    """

def query_wecom_messages(keyword, conversation, date_from=None, date_to=None, content_type=None, limit=100, config=None):
    """在指定会话中搜索消息
    Args:
        keyword: 搜索关键词
        conversation: 会话ID（必填）
        date_from/date_to: 日期范围
        content_type: 消息类型筛选
        limit: 最大返回数
    Returns: dict {success, conversation_id, keyword, count, messages: [{message_id, sender_name, content_type, send_time, content_preview}]}
    """

def collect_wecom_files_by_enterprise(enterprise, output_dir, keyword=None, date_from=None, date_to=None, config=None):
    """一键式按企业名称收集附件（核心命令）
    Args:
        enterprise: 企业名称（必填）
        output_dir: 输出目录（必填）
        keyword: 文件名关键词筛选（逗号分隔）
        date_from/date_to: 日期范围
    Returns: dict {
        success, decrypted_in_realtime, enterprise,
        conversations: [{id, name, kind, match_strategy}],
        exported: [{name, dest_path, md5, size, conversation_id, conversation_name, sender_name, receive_time, message_id, match_strategy}],
        not_cached: [{name, md5, size, reason, message_id, conversation_id}],
        stats: {exported_count, not_cached_count, deduplicated_count, total_files_in_conversations, md5_match_rate},
        security_check: {passed, violations, note}
    }
    """

def list_wecom_files_by_conversation(conversation, keyword=None, date_from=None, date_to=None, config=None):
    """列出指定会话的文件元数据
    Args:
        conversation: 会话ID（必填）
        keyword: 文件名关键词筛选
        date_from/date_to: 日期范围
    Returns: dict {success, conversation_id, count, files: [{origin, message_id, file_index, message_type, extension_type, name, size, receive_time, sender_id, conversation_id, md5, cached, cache_path, match_strategy, sender_name, receive_time_str}]}
    """

def export_wecom_files_by_conversation(conversation, output_dir, keyword=None, date_from=None, date_to=None, config=None):
    """导出指定会话的文件
    Args:
        conversation: 会话ID（必填）
        output_dir: 输出目录（必填）
        keyword: 文件名关键词筛选
        date_from/date_to: 日期范围
    Returns: dict {success, conversation_id, exported, not_cached, stats: {exported_count, not_cached_count, deduplicated_count, total_files_in_conversations, md5_match_rate}}
    """

def extract_wecom_project_info(conversation, keywords=None, config=None):
    """从指定会话提取项目信息
    Args:
        conversation: 会话ID（必填）
        keywords: 关键词（逗号分隔，默认：研发,产品,专利,项目,技术,合同,发票,社保,审计,立项）
    Returns: dict {success, conversation_id, message_count, key_sentences, mentioned_files, names_mentioned, timeline}
    """

def validate_wecom_collection(collection_result, supplement_checklist=None, config=None):
    """校验收集结果
    Args:
        collection_result: collect-by-enterprise 的返回结果
        supplement_checklist: 补充资料清单（可选）
    Returns: dict {
        passed: bool,
        completeness: {14类资料覆盖度},
        conversation_consistency: {所有导出文件 conversation_id 是否属于目标企业},
        md5_match_rate_check: {md5_match_rate >= 0.5},
        issues: [问题列表]
    }
    """
```

**适用场景**：
- 高新认定收资阶段：从企微缓存按客户企业名称预收集营业执照、社保、专利、合同等资料
- 资料补充阶段：当本地缺失某些资料时，从企微会话中查找历史发送的文件
- 项目信息提取：从客户沟通会话中提取研发、产品、专利等关键信息

**数据获取流程**：
1. `diagnose` 确认数据源可用（缓存目录、加密DB、密钥、企微进程）
2. `collect-by-enterprise --enterprise "客户企业"` 一键式收集（内部完成：解密4库→多策略定位会话→file.db按conversation_id过滤→md5匹配缓存→导出）
3. 审查收集结果：not_cached 列表提示用户在企微客户端手动下载后重跑
4. 生成 `.wecom_meta.json` 元数据：含 conversation_id/message_id/md5/sender_name 等完整溯源信息

**调用方式示例**：

```bash
# 技能中调用 collect-by-enterprise
python <项目根目录>\.trae\skills\_common\wecom_query.py collect-by-enterprise --enterprise "派成铝业" --out "<项目根目录>\{企业}_高新认定材料_{年份}\_补充资料\gxtz-wecom-collector" --keyword "专利,软著,发明" --date-from 2025-01 --date-to 2026-12
```

---

## 集成指南（每个技能必须执行）

### 1. 在SKILL.md中添加"## 公共模块"章节

在"## 统一输出目录规范"章节之后，添加以下内容：

```markdown
## 公共模块（所有技能共享）

本技能集成了六个公共模块，确保与其他技能的协作和数据共享：

### 模块一：压缩文件解压遍历
所有文件搜索/遍历操作必须使用 `scan_files_with_archive_support()` 或 `find_files_with_archive_support()` 替代原有的 `glob.glob` 或 `os.walk`，确保遇到 .zip/.rar/.7z 等压缩文件时自动解压查看，不得绕过。

### 模块二：知识库共享（强制执行）
- **必须**：技能执行开始时调用 `load_project_knowledge()` 读取已沉淀的企业信息、文件索引、经验库
- **必须**：技能执行完成后调用 `update_knowledge_after_skill()` 更新进度追踪、知识图谱节点和边、文件结构图
- **必须**：遇到问题时调用经验库记录，实现项目经验沉淀

### 模块三：统一资料整理
技能执行完成（审核验证通过后），自动调用 `unified_finalize_materials()` 将生成的文件分类归档到统一目录结构，并更新全局材料清单。

### 模块四：有效资料文件梳理图谱（强制执行）
- **必须**：技能执行前调用 `load_file_map()` 读取已识别的有效资料文件图谱，通过 `find_files_in_map()` 快速定位文件，避免全面搜索文件系统
- **必须**：技能识别新文件后调用 `add_file_to_map()` 将文件添加到图谱（含路径、类别、关联ID、关键词、有效性状态）
- **必须**：技能执行完成后调用 `validate_file_management_completion()` 校验文件管理完成度
- **必须**：技能执行完成后调用 `generate_file_management_report()` 生成文件管理报告

### 模块五：补充资料机制
- 技能执行前调用 `generate_supplement_checklist()` 生成补充资料清单文档，告诉用户把补充资料放到 `{企业名称}_高新认定材料_{申报年份}/_补充资料/{技能名}/` 目录
- 技能执行前调用 `scan_supplement_dir()` 检查补充资料目录是否有新文件，自动读取分析（支持压缩文件解压）
- 分析完成后调用 `organize_supplement_files()` 将补充文件整理到统一输出目录
- 调用 `update_experience_from_supplement()` 将识别规则和问题沉淀到经验库

### 模块六：PDF拆分与合并资料整理
- 在文件分析/读取阶段调用 `detect_and_process_merged_pdf(pdf_path)` 自动检测合并PDF，检测到则按书签/内容类型/页拆分并提取文本/表格/图片
- 拆分前自动备份原件到 `_backup/pdf_original/` 目录，保留原始文件不变
- 批量场景调用 `batch_process_merged_pdfs(data_dir)` 一次性处理目录下所有合并PDF
- 扫描页（无文本层）自动触发 `ocr_scanned_pdf()` OCR识别

### 模块七：文件分类整理（强制执行）
- **必须**：技能执行完成后，运行 `python .trae/skills/_common/project_context_manager.py finalize --enterprise "{企业}" --year {年份} --skill "{技能}"`
- **可选**：agent可通过 `--experiences` 参数主动传递结构化经验，格式为JSON字符串：`--experiences '[{"problem_type":"common_issue","problem_desc":"...","solution":"...","prevention":"...","status":"pending"}]'`
- **整理逻辑（v3增强：从"搬运"升级为"筛选+归类"，支持2位年份/历史项目目录/版本后缀/衍生资料识别）**：
  1. **分类目录只保留有效资料**：分类前先调 `evaluate_file_validity()` 评估每个文件有效性
  2. **有效性分级（6类）**：
     - `valid` 有效资料 → 移入19类对应目录
     - `historical` 历史参考 → 移入 `98.历史参考资料/`
       - 文件名年份早于近三年最早年份（支持4位"2022"和2位"22财审"两种格式）
       - 文件名含"往期/历史/上次/旧版/前次/历年/往年"等关键词
       - 文件位于历史项目目录前缀下：`【专精特新】`/`【年度更新】`/`【技改】`/`【贷款贴息】`/`【工程技术中心】`/`【省工程中心】`/`【加计扣除】`
     - `misc` 有效但无19类匹配 → 移入 `99.其他资料/`
     - `duplicate` 重复文件 → 移入 `99.其他资料/重复文件/`
       - 同名同size跨目录（真实备份重复）
       - 版本后缀文件（`_backup`/`_fixed`/`_v2`/`_扫描版`/`_电子版`/`_OK`等，与主文件构成版本对）
     - `invalid` 草稿/临时/类型不合规 → 不移动，仅在file_map中标记
       - macOS 资源文件前缀（`._xxx.pdf`）
       - Office临时文件（`~$xxx.docx`、`~WRL0941.tmp`）
       - 系统文件（`Thumbs.db`、`.DS_Store`）
       - 下载重复标志（`(1)`、`(2)`、`(3)` 后缀）
       - 非资料扩展名（`.lnk`/`.dat`/`.exe`/`.psd`/`.xmind`）
  3. **衍生资料识别**：文件名含"提取自"/"页面提取自"等前缀的从其他文件抽取的页面/附件，归入 `99.其他资料/` 避免与原文件重复
  4. **关键约束**：分类目录中不允许存在重复文件；所有重复文件必须移到 `99.其他资料/重复文件/`，保持分类目录纯净
  5. **整理报告8章节**：整理概览 / 有效资料归入19类 / 历史参考资料 / 其他资料 / 无效文件 / 重复文件 / 各类别文件统计（含有效性分布） / 产出校验
- **独立脚本**：`_common/project_context_manager.py`（自包含，约500行）。脚本跑不通时agent可按设计逻辑自主实现等效Python代码
- 文件分类决策优先级：文件名前缀(IP/RD/PS) > 关键词匹配 > 默认归到19_补充资料
- 有效性判定优先级：扩展名 → macOS前缀 → 临时标志 → 版本后缀 → 衍生资料 → 年份时效 → 历史关键词 → 历史项目目录 → 类别判定

### 模块七扩展：经验流转闭环（v2.0新增，Work↔Code跨模式流转）

**核心机制**：Work模式项目工作完成后，finalize_project()自动执行3个步骤，实现经验沉淀→留痕→汇聚到全局技能经验库，Code模式通过全局经验库读取驱动技能升级。

**finalize_project()函数内置3个自动化步骤（无需额外调用）**：

1. **结构化经验沉淀**（`_collect_structured_experiences()`）
   - 来源1：agent通过`--experiences`参数传入的经验（写入pending_experiences.json后读取）
   - 来源2：从`_校验报告/`目录下的`*validation*.json`自动提取
     - 校验失败项 → common_issue经验
     - 警告项 → format_requirement经验
     - unassociated_rd/idle_ips → validation_rule经验
   - 沉淀到项目级`experience_base.json`的6个分类 + `skill_experience_index`索引

2. **working_trace.md留痕**（`_append_working_trace()`）
   - 自动生成会话留痕，插入到working_trace.md顶部
   - 包含：会话时间、核心任务、完成事项、产出文件、经验沉淀数量、未完成待办

3. **全局技能经验库汇聚**（`_sync_to_global_skill_experiences()`）
   - 汇聚到 `~/.trae-cn/memory/skill_experiences/{skill_name}.json`
   - 自动生成exp_id（格式：EXP-YYYY-MM-DD-NNN）
   - 标记source_project/source_session/skill_name/status=pending
   - 该路径在TRAE沙箱allowlist，Code模式可直接读取

**Code模式读取方式**：
- **主路径**：读取 `~/.trae-cn/memory/skill_experiences/{skill_name}.json`，过滤status=pending的经验作为技能升级参考
- **备用路径**：通过Read/Glob/Grep只读访问D盘项目的 `.trae/experience_base.json` 和 `.trae/working_trace.md`
- **/skill_loop指令**：扫描所有技能经验文件，输出待消费经验/待验证升级/验证失败三张清单

### 模块七扩展（续）：capture子命令——agent主动提交经验（无需技能跑完）

**核心场景**：不是所有技能工作都会跑通到`finalize_project()`。agent在技能执行中任何时候遇到值得记录的问题/方案，可主动调用`capture`子命令立即提交经验，不依赖技能跑完。

**与finalize_project的区别**：
| 维度 | finalize_project | capture |
|------|------------------|---------|
| 触发时机 | 技能最终步 | 技能执行中任何时候 |
| 文件整理 | 是（19类目录整理） | 否（不动文件） |
| 经验来源 | 校验报告自动提取 + --experiences参数 | agent字段化传入 |
| 经验数量 | 批量 | 单条 |

**用法**：
```bash
python .trae/skills/_common/project_context_manager.py capture \
  --project-root "D:\项目路径" \
  --skill "gxtz-core-tables" \
  --enterprise "企业名称" \
  --problem-type validation_rule \
  --problem-desc "RD04未关联IP" \
  --solution "补充RD-IP关联关系" \
  --prevention "RD-IP-PS匹配时确保所有RD都关联至少1个IP"
```

**参数说明**：
- `--project-root`（必填）：项目根目录，支持D盘路径
- `--skill`（必填）：技能名称（如gxtz-core-tables）
- `--enterprise`（必填）：企业名称，作为source_project溯源
- `--problem-type`（必填）：经验类型，枚举值：
  - `common_issue` 通用问题
  - `validation_rule` 校验规则
  - `format_requirement` 格式要求
  - `review_checkpoint` 审查检查点
  - `best_practice` 最佳实践
  - `upgrade_trigger` 技能升级触发
- `--problem-desc`（必填）：问题描述
- `--solution`（必填）：解决方案
- `--prevention`（可选）：预防/复用建议，默认通用提示

**执行效果**（复用finalize的3个函数，单条经验版）：
1. 写入项目级`experience_base.json`对应分类（根据problem_type映射到6个分类数组）
2. 写入`working_trace.md`（标记`(capture)`区分完整finalize留痕）
3. 汇聚到全局技能经验库`~/.trae-cn/memory/skill_experiences/{skill_name}.json`

**全局规则强制要求**：agent在技能工作中遇到以下情况必须立即调用capture提交经验：
- 校验发现问题但未跑完整个技能
- 手动修复了某个问题
- 发现格式要求或最佳实践
- 遇到异常并找到解决方案

### 模块八：高新政策要求与合规校验（强制执行）
- **必须**：技能执行审核步骤时，调用 `validate_policy_compliance()` 校验8大认定条件
- **必须**：调用 `load_policy_config()` 从独立JSON配置文件读取政策依据（不内嵌到SKILL.md）
- 政策配置文件路径：`_common/policy_shenzhen.json`（深圳市版）
- 一票否决项校验未通过时，在审核报告中明确标注

### 模块九：企业基本信息联网搜索（按需调用）
- **建议**：收资清单生成时，调用 `supplement_enterprise_info_from_search()` 生成搜索指南
- **建议**：agent按指南执行WebSearch搜索，调用 `parse_enterprise_info_from_search()` 解析结果
- 可补充字段：注册时间/经营范围/简介/官网/法定代表人/统一社会信用代码等13项
- 信息来源：国家企业信用信息公示系统/企查查/天眼查/企业官网

### 模块十：Dify工作流集成（按需调用，仅gxtz-rd-report使用）
- **适配机制**：每次执行前调 `fetch_workflow_parameters()` 动态获取工作流输入变量定义，适配应用更新
- **配置文件**：`_common/dify_config.json` 包含API配置+变量映射规则+输出解析规则+QC校验配置
- **主入口**：`generate_rd_report_via_dify(project_root, output_dir)` 完整执行工作流
- **诊断工具**：`test_dify_workflow_connection()` 测试连接+变量匹配情况
- 工作流更新时只需更新dify_config.json中的映射规则，无需修改技能代码

### 模块十一：RD-IP-PS自主匹配与审核（按需调用，gxtz-ip-materials/gxtz-achievement-materials/gxtz-core-tables使用）
- **主匹配器**：`match_rd_ip_ps_with_audit()` 内置确定性规则算法作为主匹配器（Dify工作流仅作交叉参考）
- **核心规则**：一个RD对应多个PS和IP，RD时间不晚于IP且时间相近，所有IP必须匹配不闲置
- **发明专利豁免**：可作为技术基础关联较早RD
- **审核校验**：`idle_ip_count=0`（所有知识产权不闲置）

### 模块十二：企业微信会话实时查询与附件收集（按需调用，gxtz-wecom-collector及所有gxtz-*技能可选集成）
- **核心安全约束**：实时解密 + 会话-文件-缓存三联动 + 不依赖wecom_exporter
- **主入口**：`collect-by-enterprise --enterprise "{企业}" --out "{输出目录}" --keyword "{关键词}"`
- **依赖模块**：`_common/wecom_crypto.py`（实时解密）+ `_common/wecom_query.py`（8子命令CLI）+ `_common/wecom_config.json`（配置驱动，path_vars 变量化）
- **实测验证**：md5匹配命中率82.35%、security_check.passed=true、临时清理0残留
- **v1.1.0 强化**：四层匹配策略 + 强制 conversation_id 校验 + verify-association 子命令
- **v1.2.0 强化**：新增关联机制技术说明章节（file_table4 表 11 字段结构 + SQL 查询示例 + 三层关联链路图 + 防串客户双重校验机制 + v1.1.0 端到端实测结果：派成铝业 total=158/matched=122/conv_check_failed=0）
- **集成模式**：gxtz-info-collector深度集成（第六步扩展）/ gxtz-ip-materials+gxtz-staff-materials中度集成 / 其他7个技能轻量集成（第零步提示）
```

### 2. 在工作流程中添加调用步骤

#### 在技能开头添加"第零步：读取项目知识库与补充资料检查"
```markdown
### 第零步：读取项目知识库与补充资料检查（强制执行，不可跳过）

**⚠️ 本步骤为强制性步骤，每次技能执行必须完成，不得跳过。未完成本步骤将导致后续无法生成项目资料整理经验和文件资料图谱。**

1. **必须执行**：调用 `load_project_knowledge()` 读取已沉淀的企业信息、文件索引、经验库。如果知识库不存在，自动初始化
2. **必须执行**：调用 `init_file_map_if_needed(enterprise_name, application_year)` 确保文件图谱存在。如果file_map.json不存在，自动创建并初始化
3. **必须执行**：调用 `load_file_map()` 读取有效资料文件梳理图谱，后续文件查找优先使用 `find_files_in_map()` 快速定位
4. **必须执行**：读取经验库（experience_base）中的常见问题、校验规则、格式要求，避免重复犯错
5. 补充资料检查（调用 `generate_supplement_checklist()` 生成补充资料清单文档）
6. 补充资料扫描（调用 `scan_supplement_dir()` 检查补充资料目录）
7. 补充资料分析（有新文件则调用 `organize_supplement_files()` 整理 + `update_experience_from_supplement()` 沉淀规则）
8. 将补充资料分析结果作为本技能执行的输入数据
9. **合并PDF自动检测与拆分**：调用 `batch_process_merged_pdfs(data_dir)` 自动检测并处理合并PDF
10. **必须执行**：调用 `load_policy_config()` 加载高新政策配置（深圳市版policy_shenzhen.json），后续审核步骤使用此配置校验8大认定条件
```

#### 在文件搜索函数中替换为压缩文件支持版本
```python
# 原代码：
# files = glob.glob(os.path.join(data_dir, f'**/*{keyword}*'), recursive=True)

# 替换为：
files = find_files_with_archive_support(data_dir, keyword=keyword, 
                                         file_patterns=['.pdf', '.docx', '.xlsx', '.jpg', '.png'])
```

#### 在审核步骤添加政策合规校验（v1.9.0新增，强制执行）

**政策合规校验（v1.9.0新增，强制执行）**：
- **必须调用** `validate_policy_compliance(enterprise_data, policy_config)` 校验8大认定条件
- 校验结果生成合规报告，输出到 `{企业材料目录}/_policy_compliance_report.md`
- 一票否决项未通过时，在审核报告中用❌明确标注，并给出政策依据
- 创新能力评分<70分时，用⚠标注并给出改进建议

#### 在审核验证步骤之后添加"最终步：统一整理与知识库更新"
```markdown
### 最终步：统一整理与知识库更新（强制执行，审核验证通过后必须执行）

**⚠️ 本步骤为强制性步骤，技能执行完成后必须完成以下所有操作，确保项目资料整理经验和文件资料图谱生成。未完成本步骤视为技能执行不完整。**

1. **必须执行**：调用 `unified_finalize_materials()` 将生成的文件分类归档到统一目录结构
2. **必须执行**：调用 `update_knowledge_after_skill()` 更新知识库（project_index.json、enterprise_info.json、experience_base.json）
3. **必须执行**：调用 `generate_file_map_summary()` 生成文件图谱摘要，确保file_map.json已更新
4. **必须执行**：将本次执行中识别的所有文件调用 `add_file_to_map()` 添加到文件图谱（含路径、类别、关联ID、关键词、有效性状态）
5. **必须执行**：将本次执行中遇到的问题、校验规则、最佳实践沉淀到经验库（experience_base.json）
6. **必须执行**：生成文件管理报告，输出到 `{企业材料目录}/_file_management_report.md`，包含：
   - 本次识别文件总数
   - 按类别分组的文件清单
   - 文件图谱摘要（total_files、categories分布）
   - 经验库摘要（common_issues、validation_rules、best_practices数量）
   - 知识图谱节点和边数量
7. **必须执行**：校验以下3个文件已生成且非空：
   - `{项目目录}/.trae/project_knowledge/file_map.json`
   - `{项目目录}/.trae/project_knowledge/experience_base.json`
   - `{项目目录}/.trae/project_knowledge/project_index.json`
   如果任一文件不存在或为空，输出警告并重新生成
8. **必须执行**：调用 `organize_files_to_categories()` 按19类目录整理所有文件（先检查19_补充资料目录）
9. **必须执行**：调用 `generate_organize_report()` 生成文件整理报告，输出到 `{企业材料目录}/_file_organize_report.md`

**文件管理校验机制（v1.7.0新增）**：
- 技能执行完成后，必须验证文件图谱、经验库、知识图谱3个文件已生成
- 校验失败时，自动调用对应函数重新生成
- 校验结果写入文件管理报告
```

### 3. 各技能的知识图谱节点和边更新内容

| 技能 | 节点类型 | 节点示例 | 边关系示例 |
|------|---------|---------|-----------|
| gxtz-core-tables | IP/RD/PS/ACH | IP001、RD001、PS001 | RD001→IP001(产出)、RD001→PS001(转化) |
| gxtz-rd-report | RD | RD001 | RD001→IP001(支持) |
| gxtz-ip-materials | IP | IP001 | IP001→RD001(支持)、IP001→ACH001(转化) |
| gxtz-achievement-materials | ACH | ACH001 | ACH001→IP001(来源)、ACH001→PS001(产出) |
| gxtz-ps-materials | PS | PS001 | PS001→IP001(支持)、PS001→FIN001(收入) |
| gxtz-staff-materials | STAFF | STAFF001 | STAFF001→RD001(参与) |
| gxtz-management-materials | DOC | DOC001(制度文件) | DOC001→RD001(规范) |
| gxtz-info-collector | FIN/DOC | FIN001 | - |
