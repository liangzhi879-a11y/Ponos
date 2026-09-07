"""安全工作区上下文管理器 v1.0.0

当 Agent 需要在 OneDrive 管控区进行文件读写时，自动将操作重定向到
安全的非 OneDrive 目录，完成后再将产物同步回原始目录并钉选防脱水。

核心策略：
  1. 预检 -> 判断是否在 OneDrive 同步根下
  2. 镜像 -> 源材料只读拷贝到安全工作区
  3. 执行 -> 所有重 I/O 操作在安全工作区完成
  4. 同步 -> 产物拷贝回 OneDrive 目录 + attrib +p 钉选
  5. 验证 -> 对同步回的产物执行完整性检查
  6. 备份 -> 安全工作区保留 N 天作为恢复备份

使用方式：

方式1 - 上下文管理器（推荐，用于 Python 脚本集成）：
    from safe_workspace import SafeWorkspace

    with SafeWorkspace(original_dir=r'D:\OneDrive\...\03_成果转化证明',
                       enterprise='宏日嘉',
                       mode='rw') as ws:
        # ws.source_dir  -> 安全区内源材料路径
        # ws.output_dir  -> 安全区内输出路径（写入这里）
        generate_pdfs(output_dir=ws.output_dir)
        # __exit__ 时自动同步回 original_dir + pin + verify

方式2 - 纯检测/报告模式：
    from safe_workspace import check_and_report

    result = check_and_report(r'D:\OneDrive\...')
    if result['needs_safe_workspace']:
        print('⚠ 当前路径在 OneDrive 管控区，建议启用安全模式')

方式3 - 手动同步模式：
    from safe_workspace import sync_to_onedrive_with_protection

    sync_to_onedrive_with_protection(
        source_dir=r'd:\Projects\gxtz_safe\宏日嘉\output',
        target_dir=r'D:\OneDrive\...\03_成果转化证明\最终版本'
    )

环境变量快捷开关：
    GXTZ_FORCE_SAFE_WORKSPACE=1  -> 强制启用安全工作区
    GXTZ_SAFE_WORKSPACE_ROOT=path -> 自定义安全工作区根目录
"""

import os
import sys
import json
import stat
import shutil
import tempfile
from pathlib import Path
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from onedrive_utils import (
    is_under_onedrive_syncroot,
    generate_safety_report,
    pin_directory_recursive,
    verify_directory,
    SAFE_WORKSPACE_ROOT,
    OneDriveSafetyWarning,
)


# ============================================================
# 配置
# ============================================================

_BACKUP_RETENTION_DAYS = 7


def _get_workspace_root():
    return os.environ.get('GXTZ_SAFE_WORKSPACE_ROOT', SAFE_WORKSPACE_ROOT)


def _is_forced():
    return os.environ.get('GXTZ_FORCE_SAFE_WORKSPACE', '0') == '1'


# ============================================================
# 上下文管理器
# ============================================================

class SafeWorkspace:
    """OneDrive 安全工作区上下文管理器

    将文件操作从 OneDrive 管控区重定向到安全的非 OneDrive 目录。
    在 __exit__ 时自动将产物同步回原始目录 + 钉选 + 验证。

    Attributes:
        source_dir (str): 安全区内的源材料路径
        output_dir (str): 安全区内的输出路径（agent 的写入目标）
        original_dir (str): 原始 OneDrive 目录
        enterprise (str): 企业/项目标识
        is_active (bool): 是否实际启用了安全模式
    """

    def __init__(self, original_dir, enterprise='default', mode='rw',
                 backup_retention_days=_BACKUP_RETENTION_DAYS):
        """
        Args:
            original_dir: 原始工作目录（可能在 OneDrive 下）
            enterprise: 企业/项目标识，用于隔离不同项目
            mode: 'rw' 读写模式 | 'ro' 只读模式
            backup_retention_days: 安全区备份保留天数
        """
        self.original_dir = os.path.normpath(os.path.abspath(original_dir))
        self.enterprise = enterprise.replace(' ', '_').replace('/', '_').replace('\\', '_')
        self.mode = mode
        self.backup_retention_days = backup_retention_days

        self.is_active = False
        self.workspace_root = _get_workspace_root()
        self.workspace_dir = os.path.join(self.workspace_root, self.enterprise)
        self.source_dir = self.original_dir
        self.output_dir = self.original_dir
        self._synced_files = []
        self._created_dirs = []

    def __enter__(self):
        needs_workspace = (
            _is_forced()
            or is_under_onedrive_syncroot(self.original_dir)
        )

        if not needs_workspace:
            self.is_active = False
            self.source_dir = self.original_dir
            self.output_dir = self.original_dir
            return self

        self.is_active = True
        os.makedirs(self.workspace_dir, exist_ok=True)

        relative_path = self._relative_path(self.original_dir)
        if relative_path:
            self.source_dir = os.path.join(self.workspace_dir, 'source', relative_path)
            self.output_dir = os.path.join(self.workspace_dir, 'output', relative_path)
        else:
            self.source_dir = os.path.join(self.workspace_dir, 'source')
            self.output_dir = os.path.join(self.workspace_dir, 'output')

        if self.mode == 'rw':
            self._mirror_source()

        os.makedirs(self.output_dir, exist_ok=True)

        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        if not self.is_active:
            return False

        if exc_type is None and self.mode == 'rw':
            try:
                self._sync_back()
                self._cleanup_old_backups()
            except Exception as e:
                print(f'[SafeWorkspace] 同步回 OneDrive 失败: {e}', file=sys.stderr)
                print(f'[SafeWorkspace] 产物仍保留在: {self.output_dir}', file=sys.stderr)

        return False

    def _relative_path(self, full_path):
        common_roots = [
            r'D:\OneDrive\文档\工作',
            r'D:\OneDrive',
        ]
        full_lower = full_path.lower()
        for root in common_roots:
            root_lower = root.lower()
            if full_lower.startswith(root_lower):
                rel = full_path[len(root):].lstrip('\\').lstrip('/')
                return rel if rel else None

        drive = os.path.splitdrive(full_path)[0]
        if not drive:
            return None
        rel = full_path[len(drive) + 1:]
        return rel

    def _mirror_source(self):
        if not os.path.isdir(self.original_dir):
            return

        source_root = os.path.dirname(self.source_dir)
        os.makedirs(source_root, exist_ok=True)

        for root, dirs, files in os.walk(self.original_dir):
            rel_path = os.path.relpath(root, self.original_dir)
            if rel_path == '.':
                target_dir = self.source_dir
            else:
                target_dir = os.path.join(self.source_dir, rel_path)

            os.makedirs(target_dir, exist_ok=True)
            self._created_dirs.append(target_dir)

            for f in files:
                src = os.path.join(root, f)
                dst = os.path.join(target_dir, f)
                if os.path.exists(dst):
                    continue
                try:
                    _safe_copy2(src, dst)
                except Exception as e:
                    print(f'[SafeWorkspace] 镜像文件失败 {src}: {e}', file=sys.stderr)

    def _sync_back(self):
        if not os.path.isdir(self.output_dir):
            return

        for root, dirs, files in os.walk(self.output_dir):
            rel_path = os.path.relpath(root, self.output_dir)
            if rel_path == '.':
                target_dir = self.original_dir
            else:
                target_dir = os.path.join(self.original_dir, rel_path)

            os.makedirs(target_dir, exist_ok=True)

            for f in files:
                src = os.path.join(root, f)
                dst = os.path.join(target_dir, f)
                try:
                    shutil.copy2(src, dst)
                    self._synced_files.append(dst)
                except Exception as e:
                    print(f'[SafeWorkspace] 同步文件失败 {src} -> {dst}: {e}', file=sys.stderr)

        pinned_success, pinned_fail = pin_directory_recursive(self.original_dir)

        verify_result = verify_directory(self.original_dir)
        if verify_result['issues'] > 0:
            print(f'[SafeWorkspace] ⚠ 同步验证: {verify_result["total"]} 文件, '
                  f'{verify_result["issues"]} 异常', file=sys.stderr)
            for fp, issue in verify_result['details'][:10]:
                print(f'  - {fp}: {issue}', file=sys.stderr)
        else:
            print(f'[SafeWorkspace] ✓ 同步验证: {verify_result["total"]} 文件全部正常, '
                  f'钉选 {pinned_success}/{pinned_success + pinned_fail}', file=sys.stderr)

    def _cleanup_old_backups(self):
        if not os.path.isdir(self.workspace_root):
            return

        cutoff = datetime.now() - timedelta(days=self.backup_retention_days)
        for entry in os.listdir(self.workspace_root):
            entry_path = os.path.join(self.workspace_root, entry)
            if not os.path.isdir(entry_path):
                continue
            try:
                mtime = datetime.fromtimestamp(os.path.getmtime(entry_path))
                if mtime < cutoff:
                    shutil.rmtree(entry_path, ignore_errors=True)
            except Exception:
                pass


# ============================================================
# 便捷函数
# ============================================================

def _safe_copy2(src, dst, max_retries=3):
    for attempt in range(max_retries):
        try:
            shutil.copy2(src, dst)
            return
        except PermissionError:
            if attempt == max_retries - 1:
                raise
            import time
            time.sleep(0.5)


def check_and_report(dirpath):
    """检测路径是否需要安全工作区，返回详细报告

    Args:
        dirpath: 要检查的目录路径

    Returns:
        dict: {
            'needs_safe_workspace': bool,
            'safety_report': dict (来自 generate_safety_report),
            'recommendation': str (人类可读建议)
        }
    """
    report = generate_safety_report(dirpath)
    forced = _is_forced()

    result = {
        'needs_safe_workspace': forced or report['recommendation'] != 'safe',
        'force_enabled': forced,
        'safety_report': report,
    }

    if forced:
        result['recommendation'] = '环境变量 GXTZ_FORCE_SAFE_WORKSPACE=1，已强制启用安全工作区。'
        result['workspace_root'] = _get_workspace_root()
    elif report['is_onedrive_syncroot']:
        result['recommendation'] = (
            f'⚠ 当前路径在 OneDrive 同步根下 (CldFlt运行中={report["cldflt_running"]})。'
            f'文件写入可能被 CldFlt.sys 内核驱动拦截导致数据丢失。'
            f'强烈建议使用 SafeWorkspace 上下文管理器或手动在安全工作区操作。'
        )
        result['workspace_root'] = _get_workspace_root()
    else:
        result['recommendation'] = '当前路径不在 OneDrive 同步根下，文件操作安全。'

    return result


def sync_to_onedrive_with_protection(source_dir, target_dir):
    """将安全工作区产物同步到 OneDrive 目标目录，附带钉选和验证

    用于在 SafeWorkspace 外部手动同步场景。

    Args:
        source_dir: 安全工作区内的产物目录
        target_dir: OneDrive 目标目录

    Returns:
        dict: {
            'synced_count': int,
            'pinned': (int, int),
            'verify': verify_directory 结果
        }
    """
    synced = 0
    for root, dirs, files in os.walk(source_dir):
        rel_path = os.path.relpath(root, source_dir)
        if rel_path == '.':
            dest = target_dir
        else:
            dest = os.path.join(target_dir, rel_path)

        os.makedirs(dest, exist_ok=True)

        for f in files:
            src = os.path.join(root, f)
            dst = os.path.join(dest, f)
            shutil.copy2(src, dst)
            synced += 1

    pinned = pin_directory_recursive(target_dir)
    verify_result = verify_directory(target_dir)

    return {
        'synced_count': synced,
        'pinned': pinned,
        'verify': verify_result,
    }


# ============================================================
# 模块自检
# ============================================================

if __name__ == "__main__":
    test_dir = r'D:\OneDrive\文档\工作'

    print("=" * 60)
    print("safe_workspace.py v1.0.0 安全检查")
    print("=" * 60)

    result = check_and_report(test_dir)
    print(f"\n路径: {test_dir}")
    print(f"需要安全工作区: {result['needs_safe_workspace']}")
    print(f"强制启用: {result.get('force_enabled', False)}")
    print(f"\n建议: {result['recommendation']}")

    if result['needs_safe_workspace']:
        print(f"\n安全工作区根目录: {result['workspace_root']}")
        print("\n使用示例:")
        print(f"  with SafeWorkspace(r'{test_dir}\\[项目]', '企业名') as ws:")
        print(f"      generate_pdfs(output_dir=ws.output_dir)")
        print(f"      # __exit__ 自动同步 + 钉选 + 验证")
