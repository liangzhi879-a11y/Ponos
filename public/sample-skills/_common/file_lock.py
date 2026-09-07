"""文件锁工具（v1.0）

为 project_knowledge 的 JSON 文件提供跨进程文件锁，支持蜂群协同下的并发读写控制。

使用 portalocker（跨平台）或 msvcrt（Windows fallback）实现文件锁。
锁文件位置：project_knowledge/.locks/{filename}.lock

用法：
    from file_lock import file_lock

    with file_lock('file_map.json'):
        # 读写 file_map.json
        ...

    # 超时设置
    with file_lock('file_map.json', timeout=10):
        ...

依赖：portalocker（优先）或 msvcrt（Windows内置）
"""
import os
import sys
import time
import tempfile
from contextlib import contextmanager
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from path_config import get_lock_dir


class LockTimeoutError(TimeoutError):
    """文件锁超时异常"""
    pass


# 锁文件目录
LOCK_DIR = get_lock_dir()

# 尝试导入锁实现
try:
    import portalocker

    def _acquire_lock(file_handle, timeout):
        """使用 portalocker 加锁"""
        portalocker.lock(file_handle, portalocker.LOCK_EX | portalocker.LOCK_NB)
    _HAS_PORTALOCKER = True
except ImportError:
    try:
        import msvcrt

        def _acquire_lock(file_handle, timeout):
            """使用 msvcrt 加锁（Windows）"""
            msvcrt.locking(file_handle.fileno(), msvcrt.LK_NBLCK, 1)
        _HAS_PORTALOCKER = False
    except ImportError:
        # 无可用锁库，降级为时间戳文件锁
        _HAS_PORTALOCKER = False


@contextmanager
def file_lock(filename, timeout=5, poll_interval=0.1):
    """文件锁上下文管理器

    Args:
        filename: 要锁定的文件名（如 'file_map.json'）
        timeout: 超时秒数，默认5秒
        poll_interval: 轮询间隔，默认0.1秒

    Raises:
        LockTimeoutError: 超时未获取到锁

    Example:
        with file_lock('file_map.json'):
            data = json.load(open('file_map.json'))
            data['key'] = 'value'
            json.dump(data, open('file_map.json', 'w'))
    """
    LOCK_DIR.mkdir(parents=True, exist_ok=True)
    lock_file_path = LOCK_DIR / f'{filename}.lock'

    start_time = time.time()
    lock_handle = None

    try:
        while True:
            try:
                if _HAS_PORTALOCKER or 'msvcrt' in dir():
                    # 使用 portalocker 或 msvcrt
                    lock_handle = open(lock_file_path, 'w')
                    _acquire_lock(lock_handle, timeout)
                    break
                else:
                    # 降级：原子创建锁文件
                    fd = os.open(str(lock_file_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                    lock_handle = os.fdopen(fd, 'w')
                    break
            except (IOError, OSError, PermissionError):
                if lock_handle:
                    lock_handle.close()
                    lock_handle = None
                if time.time() - start_time > timeout:
                    raise LockTimeoutError(
                        f'获取文件锁超时({timeout}秒): {filename}'
                    )
                time.sleep(poll_interval)

        # 获取锁成功，执行上下文代码
        yield

    finally:
        # 释放锁
        if lock_handle:
            try:
                if _HAS_PORTALOCKER:
                    portalocker.unlock(lock_handle)
                elif 'msvcrt' in dir():
                    try:
                        msvcrt.locking(lock_handle.fileno(), msvcrt.LK_UNLCK, 1)
                    except (IOError, OSError):
                        pass
                lock_handle.close()
            except (IOError, OSError):
                pass

            # 删除锁文件（降级模式下）
            if not _HAS_PORTALOCKER and 'msvcrt' not in dir():
                try:
                    os.remove(lock_file_path)
                except (IOError, OSError):
                    pass


def read_json_safe(filepath, encoding='utf-8'):
    """安全读取JSON文件（带文件锁）

    Args:
        filepath: JSON文件路径
        encoding: 编码，默认utf-8

    Returns:
        dict: JSON数据
    """
    import json
    filename = os.path.basename(filepath)
    with file_lock(filename):
        with open(filepath, 'r', encoding=encoding) as f:
            return json.load(f)


def write_json_safe(filepath, data, encoding='utf-8', indent=2):
    """安全写入JSON文件（带文件锁）

    Args:
        filepath: JSON文件路径
        data: 要写入的数据
        encoding: 编码，默认utf-8
        indent: JSON缩进，默认2
    """
    import json
    filename = os.path.basename(filepath)
    with file_lock(filename):
        with open(filepath, 'w', encoding=encoding) as f:
            json.dump(data, f, ensure_ascii=False, indent=indent)


if __name__ == '__main__':
    # 自测：获取锁、等待、释放
    print(f'锁目录: {LOCK_DIR}')
    print(f'锁库: {"portalocker" if _HAS_PORTALOCKER else ("msvcrt" if "msvcrt" in dir() else "降级模式")}')

    print('测试1: 获取锁...')
    with file_lock('test.json', timeout=2):
        print('  锁获取成功，持有2秒...')
        time.sleep(2)
    print('  锁已释放')

    print('测试2: 超时测试...')
    import multiprocessing
    import subprocess

    # 启动子进程持锁
    proc = subprocess.Popen([
        'python', '-c',
        f'import sys; sys.path.insert(0, r"{os.path.dirname(__file__)}"); '
        f'from file_lock import file_lock; import time; '
        f'lock = file_lock("test.json"); lock.__enter__(); time.sleep(10)'
    ])

    time.sleep(1)  # 等待子进程获取锁

    try:
        with file_lock('test.json', timeout=2):
            print('  锁获取成功（不应发生）')
    except LockTimeoutError as e:
        print(f'  超时异常（预期行为）: {e}')

    proc.terminate()
    proc.wait()

    print('测试完成')
