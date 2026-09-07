import os

base = os.path.dirname(os.path.abspath(__file__))

NEW_LOAD_CONFIG = '''def load_types_config(project_root=None):
    """加载项目类型配置，统一从技能安装目录读取"""
    import json
    CONFIG_PATH = r"C:\\Users\\T203-15\\.trae-cn\\skills\\enterprise_project_skills\\_common\\config\\project_types_config.json"
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        return json.load(f)'''

# ---- progress_sync.py ----
fp_sync = os.path.join(base, "progress_sync.py")
with open(fp_sync, "r", encoding="utf-8") as f:
    content = f.read()

old_sync = """def load_types_config(project_root):
    \"\"\"加载项目类型配置，优先级：skills\\_common/config/ > 脚本自身 config/ > 项目 .trae/\"\"\"
    import json, os
    # Canonical source: C:\\Users\\T203-15\\.trae-cn\\skills\\enterprise_project_skills\\_common\\config\\project_types_config.json
    skills_common = r\"C:\\Users\\T203-15\\.trae-cn\\skills\\enterprise_project_skills\\_common\\config\\project_types_config.json\"
    if os.path.exists(skills_common):
        with open(skills_common, \"r\", encoding=\"utf-8\") as f:
            return json.load(f)
    # Fallback 1: script's own config/ subdirectory
    script_config = os.path.join(os.path.dirname(os.path.abspath(__file__)), \"config\", \"project_types_config.json\")
    if os.path.exists(script_config):
        with open(script_config, \"r\", encoding=\"utf-8\") as f:
            return json.load(f)
    # Fallback 2: project-local copy
    path = os.path.join(project_root, \".trae\", \"project_types_config.json\")
    if not os.path.exists(path):
        return {}
    with open(path, \"r\", encoding=\"utf-8\") as f:
        return json.load(f)"""

content = content.replace(old_sync, NEW_LOAD_CONFIG)
with open(fp_sync, "w", encoding="utf-8") as f:
    f.write(content)
print("progress_sync.py OK")

# ---- progress_scanner.py ----
fp_scan = os.path.join(base, "progress_scanner.py")
with open(fp_scan, "r", encoding="utf-8") as f:
    content = f.read()
content = content.replace(old_sync, NEW_LOAD_CONFIG)
with open(fp_scan, "w", encoding="utf-8") as f:
    f.write(content)
print("progress_scanner.py OK")

# ---- progress_dashboard.py ----
fp_dash = os.path.join(base, "progress_dashboard.py")
with open(fp_dash, "r", encoding="utf-8") as f:
    content = f.read()

old_dash = '''    progress = load_json(os.path.join(project_root, ".trae", "project_progress.json"))
    # Canonical: skills\\_common/config/ > script config/ > project .trae/
    skills_cfg = r"C:\\Users\\T203-15\\.trae-cn\\skills\\enterprise_project_skills\\_common\\config\\project_types_config.json"
    types_config = load_json(skills_cfg)
    if not types_config:
        common_cfg = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config", "project_types_config.json")
        types_config = load_json(common_cfg)
    if not types_config:
        types_config = load_json(os.path.join(project_root, ".trae", "project_types_config.json"))'''

new_dash = '''    progress = load_json(os.path.join(project_root, ".trae", "project_progress.json"))
    TYPES_CONFIG_PATH = r"C:\\Users\\T203-15\\.trae-cn\\skills\\enterprise_project_skills\\_common\\config\\project_types_config.json"
    types_config = load_json(TYPES_CONFIG_PATH)'''

content = content.replace(old_dash, new_dash)
with open(fp_dash, "w", encoding="utf-8") as f:
    f.write(content)
print("progress_dashboard.py OK")

print("\nAll done!")
