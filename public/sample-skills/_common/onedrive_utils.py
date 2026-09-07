"""OneDrive 环境检测与安全工具 v1.0.0

提供 OneDrive 同步根检测、CldFlt 内核驱动状态查询、文件钉选防脱水、
写入后验证等功能。用于 Agent 在 Windows OneDrive 管控区进行文件操作前
的安全预检和防护。

背景：CldFlt.sys 内核驱动在 OneDrive.exe 未运行时仍会拦截文件写入，
导致 "写入成功但文件随后被清空" 的现象。本模块提供检测和规避方案。

用法：
    from onedrive_utils import (
        is_under_onedrive_syncroot,
        get_onedrive_syncroots,
        pin_file,
        pin_directory_recursive,
        verified_write,
        verify_file,
        detect_placeholder_file,
        OneDriveSafetyWarning,
        SAFE_WORKSPACE_ROOT,
    )
"""

import os
import sys
import json
import shutil
import struct
import ctypes
import subprocess
from pathlib import Path
from datetime import datetime

# ============================================================
# 常量
# ============================================================

SAFE_WORKSPACE_ROOT = r'd:\Projects\gxtz_safe'

# Windows 文件属性常量
FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS = 0x00400000
FILE_ATTRIBUTE_RECALL_ON_OPEN = 0x00040000
FILE_ATTRIBUTE_PINNED = 0x00080000
FILE_ATTRIBUTE_UNPINNED = 0x00100000
FILE_ATTRIBUTE_OFFLINE = 0x00001000
FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400

# OneDrive 注册表路径
_OD_REG_PERSONAL = r'Software\Microsoft\OneDrive\Accounts\Personal'
_OD_REG_BUSINESS = r'Software\Microsoft\OneDrive\Accounts\Business1'


class OneDriveSafetyWarning(RuntimeError):
    """OneDrive 环境不安全的异常"""


def _read_registry_key(key_path, value_name):
    try:
        import winreg
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path)
        value, _ = winreg.QueryValueEx(key, value_name)
        winreg.CloseKey(key)
        return value
    except Exception:
        return None


def get_onedrive_syncroots():
    """获取当前用户的所有 OneDrive 同步根路径

    Returns:
        list[str]: OneDrive 同步根目录的绝对路径列表。
                   如果未配置 OneDrive 则返回空列表。
    """
    roots = []
    for account_key in [_OD_REG_PERSONAL, _OD_REG_BUSINESS]:
        user_folder = _read_registry_key(account_key, 'UserFolder')
        if user_folder and os.path.isdir(user_folder):
            roots.append(os.path.normpath(user_folder))
    return roots


def is_under_onedrive_syncroot(path):
    """检测给定路径是否在 OneDrive 同步根下

    同时检查路径名中是否包含 "OneDrive" 作为兜底（无需注册表）。

    Args:
        path: 文件或目录路径

    Returns:
        bool: True 表示路径在 OneDrive 管控区内
    """
    norm_path = os.path.normpath(os.path.abspath(str(path)))

    roots = get_onedrive_syncroots()
    for root in roots:
        if norm_path.lower().startswith(root.lower()):
            return True

    parts = norm_path.lower().replace('\\', '/').split('/')
    for part in parts:
        if part == 'onedrive':
            return True

    return False


def _get_file_attributes(path):
    """获取 Windows 文件属性位掩码

    Returns:
        int: 文件属性值，失败返回 -1
    """
    try:
        return ctypes.windll.kernel32.GetFileAttributesW(str(path))
    except Exception:
        return -1


def is_placeholder_file(path):
    """检测文件是否为 OneDrive 脱水占位符

    占位符文件特征：st_size 很小（或为0）、文件属性包含
    FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS 或 OFFLINE 标记。

    Args:
        path: 文件路径

    Returns:
        bool: True 表示是占位符（可能已被脱水）
    """
    if not os.path.exists(path):
        return False

    stat = os.stat(path)
    if stat.st_size == 0:
        return True

    attrs = _get_file_attributes(path)
    if attrs < 0:
        return False

    if attrs & FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS:
        return True
    if attrs & FILE_ATTRIBUTE_OFFLINE:
        return True

    return False


def detect_cldflt_running():
    """检测 CldFlt.sys 内核驱动是否正在运行

    Returns:
        bool: True 表示 CldFlt 驱动已加载（即 OneDrive 文件过滤器活跃中）
    """
    try:
        result = subprocess.run(
            ['sc', 'query', 'CldFlt'],
            capture_output=True, text=True, timeout=5
        )
        return 'RUNNING' in result.stdout
    except Exception:
        return False


def pin_file(path):
    """钉选单个文件，防止 OneDrive 脱水

    通过 attrib +p 设置 FILE_ATTRIBUTE_PINNED，告诉 CldFlt 永不脱水此文件。
    仅 Windows 有效，非 Windows 平台静默跳过。

    Args:
        path: 文件路径

    Returns:
        bool: True 表示钉选成功
    """
    if not os.path.isfile(path):
        return False

    try:
        subprocess.run(
            ['attrib', '+p', str(path)],
            capture_output=True, check=True, timeout=10
        )
        return True
    except Exception:
        return False


def pin_directory_recursive(dirpath):
    """递归钉选目录下所有文件

    Args:
        dirpath: 目录路径

    Returns:
        tuple: (success_count, fail_count)
    """
    success, fail = 0, 0
    for root, dirs, files in os.walk(dirpath):
        for f in files:
            filepath = os.path.join(root, f)
            if pin_file(filepath):
                success += 1
            else:
                fail += 1
    return success, fail


def _force_sync_to_disk(file_obj):
    """强制将文件内容刷写到磁盘

    Args:
        file_obj: 已打开的文件对象 (mode='wb')
    """
    file_obj.flush()
    os.fsync(file_obj.fileno())


def verified_write(filepath, content):
    """写入文件并立即验证内容完整性

    写入流程：write → flush → fsync → 重新打开回读 → 验证大小

    如果验证失败（大小不匹配、0字节、不可读），抛出 OneDriveSafetyWarning。

    Args:
        filepath: 目标文件路径
        content: 要写入的内容 (str 或 bytes)

    Raises:
        OneDriveSafetyWarning: 写入验证失败
        OSError: 文件系统错误
    """
    if isinstance(content, str):
        content_bytes = content.encode('utf-8')
    else:
        content_bytes = content

    os.makedirs(os.path.dirname(os.path.abspath(filepath)) or '.', exist_ok=True)

    with open(filepath, 'wb') as f:
        f.write(content_bytes)
        _force_sync_to_disk(f)

    expected_size = len(content_bytes)
    actual_size = os.path.getsize(filepath)

    if actual_size == 0:
        raise OneDriveSafetyWarning(
            f'{filepath}: 写入后文件大小为零 (0 bytes)，'
            f'可能被 CldFlt 脱水为占位符空壳。'
            f'来源文件位于 OneDrive 同步根下，建议使用安全工作区。'
        )

    if actual_size != expected_size:
        raise OneDriveSafetyWarning(
            f'{filepath}: 写入验证失败 - '
            f'期望 {expected_size} bytes, 实际 {actual_size} bytes。'
            f'CldFlt 可能已修改或丢弃写入内容。'
        )

    with open(filepath, 'rb') as f:
        first_byte = f.read(1)
        if not first_byte:
            raise OneDriveSafetyWarning(
                f'{filepath}: 文件可打开但内容不可读 (空壳占位符)，'
                f'请检查 OneDrive Files On-Demand 状态。'
            )


def verify_file(filepath, expected_min_size=1):
    """验证已存在文件的完整性

    检查文件是否：存在、size > 0、非占位符、可读。

    Args:
        filepath: 文件路径
        expected_min_size: 最小期望字节数，默认 1

    Returns:
        tuple: (is_valid: bool, issue: str)
    """
    if not os.path.exists(filepath):
        return False, '文件不存在'

    try:
        size = os.path.getsize(filepath)
    except OSError as e:
        return False, f'无法获取文件大小: {e}'

    if size < expected_min_size:
        return False, f'文件大小为 {size} bytes (期望 >= {expected_min_size})'

    if is_placeholder_file(filepath):
        return False, '文件是 OneDrive 脱水占位符'

    try:
        with open(filepath, 'rb') as f:
            f.read(1)
    except Exception as e:
        return False, f'文件不可读: {e}'

    return True, 'OK'


def verify_directory(dirpath, expected_min_count=0):
    """扫描目录下所有文件的完整性

    Args:
        dirpath: 目录路径
        expected_min_count: 最小期望文件数

    Returns:
        dict: {
            'total': int,
            'valid': int,
            'issues': int,
            'details': [(filepath, issue_string), ...]
        }
    """
    result = {'total': 0, 'valid': 0, 'issues': 0, 'details': []}
    if not os.path.isdir(dirpath):
        result['details'].append((dirpath, '目录不存在'))
        result['issues'] = 1
        return result

    for root, dirs, files in os.walk(dirpath):
        for f in files:
            filepath = os.path.join(root, f)
            result['total'] += 1
            is_valid, issue = verify_file(filepath)
            if is_valid:
                result['valid'] += 1
            else:
                result['issues'] += 1
                result['details'].append((filepath, issue))

    return result


def generate_safety_report(dirpath):
    """生成 OneDrive 环境安全报告

    汇总同步根状态、CldFlt 状态、文件脱水率等信息，
    用于技能启动时的环境预检。

    Returns:
        dict: 安全报告
    """
    report = {
        'checked_at': datetime.now().isoformat(),
        'path': str(dirpath),
        'is_onedrive_syncroot': is_under_onedrive_syncroot(dirpath),
        'cldflt_running': detect_cldflt_running(),
        'syncroots': get_onedrive_syncroots(),
        'recommendation': 'safe',
    }

    if report['is_onedrive_syncroot']:
        if report['cldflt_running']:
            report['recommendation'] = 'use_safe_workspace'
            report['note'] = (
                '当前路径在 OneDrive 同步根下且 CldFlt 驱动运行中，'
                '文件写入存在被脱水的风险。建议启用安全工作区模式。'
            )
        else:
            report['recommendation'] = 'caution'
            report['note'] = (
                '当前路径在 OneDrive 同步根下，CldFlt 驱动状态未知。'
                '建议使用安全工作区以防文件丢失。'
            )

    return report


def ensure_safe_workspace_root():
    """确保安全工作区根目录存在

    Returns:
        str: 安全工作区根目录路径
    """
    os.makedirs(SAFE_WORKSPACE_ROOT, exist_ok=True)
    return SAFE_WORKSPACE_ROOT


def get_workspace_project_dir(project_name):
    """获取安全工作区内的项目子目录

    Args:
        project_name: 项目标识（如企业简称）

    Returns:
        str: 安全工作区项目目录路径
    """
    workspace_dir = os.path.join(
        SAFE_WORKSPACE_ROOT,
        project_name.replace(' ', '_').replace('/', '_').replace('\\', '_')
    )
    os.makedirs(workspace_dir, exist_ok=True)
    return workspace_dir


# ============================================================
# 模块自检
# ============================================================

if __name__ == "__main__":
    print("=" * 60)
    print("onedrive_utils.py v1.0.0 环境自检")
    print("=" * 60)

    print(f"\nCldFlt 驱动运行中: {detect_cldflt_running()}")

    roots = get_onedrive_syncroots()
    print(f"OneDrive 同步根: {roots}")

    test_paths = [
        r'D:\OneDrive\文档\工作',
        r'D:\Projects\工作',
        r'C:\Users\T203-15\Desktop',
    ]
    for tp in test_paths:
        print(f"\n路径: {tp}")
        print(f"  在 OneDrive 同步根下: {is_under_onedrive_syncroot(tp)}")

        if os.path.isdir(tp):
            files = []
            try:
                for f in os.listdir(tp)[:5]:
                    fp = os.path.join(tp, f)
                    if os.path.isfile(fp) and os.path.getsize(fp) == 0:
                        files.append(f)
            except Exception:
                pass
            if files:
                print(f"  零字节文件 (可疑占位符): {files}")

    print(f"\n安全工作区根目录: {SAFE_WORKSPACE_ROOT}")
    print("=" * 60)
