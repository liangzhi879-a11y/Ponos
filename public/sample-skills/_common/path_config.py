"""统一路径配置模块（v1.1.0）

为 _common 目录下所有脚本提供统一的路径获取函数，
消除硬编码绝对路径，支持跨用户/跨项目根目录迁移。

优先级：环境变量 > 项目根目录推断 > 默认值

用法：
    import sys
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from path_config import get_template_dir, get_skills_dir, get_lock_dir, get_enterprise_data_dir

    TEMPLATE_DIR = str(get_template_dir())
    SKILLS_DIR = str(get_skills_dir())
    LOCK_DIR = str(get_lock_dir())
    ENTERPRISE_DATA_DIR = get_enterprise_data_dir()  # 可能返回 None

环境变量（可选覆盖）：
    GXTZ_PROJECT_ROOT        - 项目根目录（默认基于 __file__ 推断）
    GXTZ_TEMPLATE_DIR        - 核心表格模板目录（默认 {项目根}/00 高新模板（全））
    GXTZ_SKILLS_DIR          - 技能包目录（默认 {项目根}/.trae/skills）
    GXTZ_LOCK_DIR            - 文件锁目录（默认 {项目根}/.trae/project_knowledge/.locks）
    GXTZ_ENTERPRISE_DATA_DIR - 企业数据根目录（默认 None，未设置时调用方应要求 --dir 显式指定）

v1.1.0 变更：
- 新增 get_enterprise_data_dir() 和 get_enterprise_data_dir_str()
- 用于替代 validate_tables.py 中硬编码的 D:\\OneDrive\\文档\\工作\\ 跨盘符路径
- 默认返回 None，未设置环境变量时调用方应降级为要求 --dir 参数
"""
import os
from pathlib import Path

# ═══════════════════════════════════════════════════════════════════
# 基础路径推断（基于 __file__ 定位）
# ═══════════════════════════════════════════════════════════════════

# _common 目录：本文件所在目录
_COMMON_DIR = Path(__file__).resolve().parent

# 项目根目录推断：_common 的上两级即为项目根
# .trae/skills/_common -> .trae/skills -> .trae -> 项目根
# 实际结构：项目根/.trae/skills/_common/path_config.py
# 所以 _COMMON_DIR.parent.parent.parent = 项目根
_PROJECT_ROOT = _COMMON_DIR.parent.parent.parent  # 上溯三级到项目根


# ═══════════════════════════════════════════════════════════════════
# 路径获取函数（环境变量优先）
# ═══════════════════════════════════════════════════════════════════

def get_project_root():
    """获取项目根目录

    优先级：
    1. 环境变量 GXTZ_PROJECT_ROOT
    2. 基于 __file__ 推断（.trae/skills/_common 的上三级）
    """
    env_val = os.environ.get("GXTZ_PROJECT_ROOT")
    if env_val:
        return Path(env_val)
    return _PROJECT_ROOT


def get_template_dir():
    """获取核心表格模板目录

    优先级：
    1. 环境变量 GXTZ_TEMPLATE_DIR
    2. {项目根}/00 高新模板（全）
    """
    env_val = os.environ.get("GXTZ_TEMPLATE_DIR")
    if env_val:
        return Path(env_val)
    return get_project_root() / "00 高新模板（全）"


def get_skills_dir():
    """获取技能包目录

    优先级：
    1. 环境变量 GXTZ_SKILLS_DIR
    2. {项目根}/.trae/skills
    """
    env_val = os.environ.get("GXTZ_SKILLS_DIR")
    if env_val:
        return Path(env_val)
    return get_project_root() / ".trae" / "skills"


def get_lock_dir():
    """获取文件锁目录

    优先级：
    1. 环境变量 GXTZ_LOCK_DIR
    2. {项目根}/.trae/project_knowledge/.locks
    """
    env_val = os.environ.get("GXTZ_LOCK_DIR")
    if env_val:
        return Path(env_val)
    return get_project_root() / ".trae" / "project_knowledge" / ".locks"


def get_enterprise_data_dir():
    """获取企业数据根目录（v1.1.0 新增）

    用于替代 validate_tables.py 等脚本中硬编码的 D:\\OneDrive\\文档\\工作\\ 跨盘符路径。

    优先级：
    1. 环境变量 GXTZ_ENTERPRISE_DATA_DIR
    2. 默认 None（未设置时调用方应要求 --dir 参数显式指定）

    Returns:
        Path 对象或 None。返回 None 时调用方应降级为要求 --dir 参数。
    """
    env_val = os.environ.get("GXTZ_ENTERPRISE_DATA_DIR")
    if env_val:
        return Path(env_val)
    return None


def get_common_dir():
    """获取 _common 目录（配置文件所在）

    返回本文件所在目录，无需环境变量覆盖
    """
    return _COMMON_DIR


def get_config_path(filename):
    """获取 _common 目录下的配置文件路径

    Args:
        filename: 配置文件名（如 wecom_config.json, dify_config.json）

    Returns: Path 对象
    """
    return _COMMON_DIR / filename


# ═══════════════════════════════════════════════════════════════════
# 便捷函数（返回字符串，兼容旧代码）
# ═══════════════════════════════════════════════════════════════════

def get_project_root_str():
    """获取项目根目录（字符串形式）"""
    return str(get_project_root())


def get_template_dir_str():
    """获取核心表格模板目录（字符串形式）"""
    return str(get_template_dir())


def get_skills_dir_str():
    """获取技能包目录（字符串形式）"""
    return str(get_skills_dir())


def get_lock_dir_str():
    """获取文件锁目录（字符串形式）"""
    return str(get_lock_dir())


def get_enterprise_data_dir_str():
    """获取企业数据根目录（字符串形式，v1.1.0 新增）

    Returns:
        字符串路径，或空字符串（未设置环境变量时）
    """
    result = get_enterprise_data_dir()
    return str(result) if result is not None else ""


# ═══════════════════════════════════════════════════════════════════
# 模块自检（直接运行时输出路径信息）
# ═══════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    print("=" * 60)
    print("path_config.py v1.1.0 路径配置自检")
    print("=" * 60)
    print(f"_COMMON_DIR:    {_COMMON_DIR}")
    print(f"_PROJECT_ROOT:  {_PROJECT_ROOT}")
    print(f"project_root:   {get_project_root()}")
    print(f"template_dir:   {get_template_dir()}")
    print(f"  exists:       {get_template_dir().exists()}")
    print(f"skills_dir:     {get_skills_dir()}")
    print(f"  exists:       {get_skills_dir().exists()}")
    print(f"lock_dir:       {get_lock_dir()}")
    print(f"common_dir:     {get_common_dir()}")
    print(f"config_path:    {get_config_path('wecom_config.json')}")
    print(f"enterprise_data_dir: {get_enterprise_data_dir()}")
    print("=" * 60)
    print("环境变量覆盖（如已设置）：")
    for var in ["GXTZ_PROJECT_ROOT", "GXTZ_TEMPLATE_DIR", "GXTZ_SKILLS_DIR",
                "GXTZ_LOCK_DIR", "GXTZ_ENTERPRISE_DATA_DIR"]:
        val = os.environ.get(var)
        if val:
            print(f"  {var} = {val}")
        else:
            print(f"  {var} = (未设置)")
