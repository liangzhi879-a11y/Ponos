"""统一路径配置模块 v2.0.0（C盘统一架构）

为 _common 目录下所有脚本提供统一的路径获取函数。
v2.0.0 架构变更：_common 位于 C盘统一目录，不再从 __file__ 推断项目根。

优先级：环境变量 > CLI参数 > 内置默认值

用法：
    import sys
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from path_config import get_skills_root, get_builtin_template_dir, get_project_root

    SKILLS_ROOT = str(get_skills_root())
    BUILTIN_TEMPLATES = str(get_builtin_template_dir())
    PROJECT_ROOT = get_project_root()  # 可能返回 None

环境变量：
    GXTZ_PROJECT_ROOT        - 项目根目录（必须设置，无默认推断）
    GXTZ_TEMPLATE_DIR        - 核心表格模板目录（默认 {项目根}/00 高新模板（全））
    GXTZ_SKILLS_DIR          - 技能包目录（默认 {项目根}/.trae/skills）
    GXTZ_LOCK_DIR            - 文件锁目录（默认 {项目根}/.trae/project_knowledge/.locks）
    GXTZ_ENTERPRISE_DATA_DIR - 企业数据根目录（默认 None）

v2.0.0 变更（C盘统一架构）：
- _common 位置: C:/Users/.../enterprise_project_skills/_common/
- 技能根目录: C:/Users/.../enterprise_project_skills/
- get_project_root() 不再从 __file__ 推断，必须通过 GXTZ_PROJECT_ROOT 环境变量设置
- 新增 get_skills_root() 获取技能包根目录
- 新增 get_builtin_template_dir() 获取内置模板目录
"""
import os
from pathlib import Path

_COMMON_DIR = Path(__file__).resolve().parent
_SKILLS_ROOT = _COMMON_DIR.parent


def get_skills_root():
    """获取技能包根目录（C盘统一位置）
    
    Returns: Path to enterprise_project_skills/
    """
    return _SKILLS_ROOT


def get_skills_root_str():
    return str(_SKILLS_ROOT)


def get_builtin_template_dir():
    """获取内置模板目录（兜底用）
    
    Returns: _common/templates/
    """
    return _COMMON_DIR / "templates"


def get_builtin_template_dir_str():
    return str(get_builtin_template_dir())


def get_project_root():
    """获取当前工作项目根目录
    
    必须通过 GXTZ_PROJECT_ROOT 环境变量设置，无默认推断。
    未设置时返回 None，调用方应报错或要求设置环境变量。
    """
    env_val = os.environ.get("GXTZ_PROJECT_ROOT")
    if env_val:
        return Path(env_val)
    return None


def get_project_root_str():
    result = get_project_root()
    return str(result) if result is not None else ""


def get_template_dir():
    """获取核心表格模板目录
    
    优先级：
    1. 环境变量 GXTZ_TEMPLATE_DIR
    2. {项目根}/00 高新模板（全）
    3. 内置 _common/templates/
    """
    env_val = os.environ.get("GXTZ_TEMPLATE_DIR")
    if env_val:
        return Path(env_val)
    project_root = get_project_root()
    if project_root:
        return project_root / "00 高新模板（全）"
    return get_builtin_template_dir()


def get_template_dir_str():
    return str(get_template_dir())


def get_skills_dir():
    """获取技能包目录（项目视角）
    
    优先级：
    1. 环境变量 GXTZ_SKILLS_DIR
    2. {项目根}/.trae/skills
    """
    env_val = os.environ.get("GXTZ_SKILLS_DIR")
    if env_val:
        return Path(env_val)
    project_root = get_project_root()
    if project_root:
        return project_root / ".trae" / "skills"
    return None


def get_skills_dir_str():
    result = get_skills_dir()
    return str(result) if result is not None else ""


def get_lock_dir():
    """获取文件锁目录
    
    优先级：
    1. 环境变量 GXTZ_LOCK_DIR
    2. {项目根}/.trae/project_knowledge/.locks
    """
    env_val = os.environ.get("GXTZ_LOCK_DIR")
    if env_val:
        return Path(env_val)
    project_root = get_project_root()
    if project_root:
        return project_root / ".trae" / "project_knowledge" / ".locks"
    return None


def get_lock_dir_str():
    result = get_lock_dir()
    return str(result) if result is not None else ""


def get_enterprise_data_dir():
    """获取企业数据根目录
    
    优先级：
    1. 环境变量 GXTZ_ENTERPRISE_DATA_DIR
    2. 默认 None
    """
    env_val = os.environ.get("GXTZ_ENTERPRISE_DATA_DIR")
    if env_val:
        return Path(env_val)
    return None


def get_enterprise_data_dir_str():
    result = get_enterprise_data_dir()
    return str(result) if result is not None else ""


def get_common_dir():
    """获取 _common 目录"""
    return _COMMON_DIR


def get_config_path(filename):
    """获取 _common 目录下的配置文件路径"""
    return _COMMON_DIR / filename


if __name__ == "__main__":
    print("=" * 60)
    print("path_config.py v2.0.0 路径配置自检")
    print("=" * 60)
    print(f"_COMMON_DIR:        {_COMMON_DIR}")
    print(f"_SKILLS_ROOT:       {_SKILLS_ROOT}")
    print(f"skills_root:        {get_skills_root()}")
    print(f"builtin_templates:  {get_builtin_template_dir()}")
    print(f"  exists:           {get_builtin_template_dir().exists()}")
    print(f"project_root:       {get_project_root()}")
    print(f"template_dir:       {get_template_dir()}")
    print(f"  exists:           {get_template_dir().exists()}")
    print(f"skills_dir:         {get_skills_dir()}")
    print(f"lock_dir:           {get_lock_dir()}")
    print(f"common_dir:         {get_common_dir()}")
    print(f"enterprise_data_dir:{get_enterprise_data_dir()}")
    print("=" * 60)
    print("环境变量覆盖：")
    for var in ["GXTZ_PROJECT_ROOT", "GXTZ_TEMPLATE_DIR", "GXTZ_SKILLS_DIR",
                "GXTZ_LOCK_DIR", "GXTZ_ENTERPRISE_DATA_DIR"]:
        val = os.environ.get(var)
        if val:
            print(f"  {var} = {val}")
        else:
            print(f"  {var} = (未设置)")
