"""
WeCom CLI 工具 - 企业微信会话实时查询与附件收集

核心安全约束（不可违反）：
1. 实时解密：所有查询从 Data/ 原始加密 DB 实时解密，不读取已解密数据
2. 会话-文件-缓存三联动：所有文件操作必须经 conversation_id 上下文，禁止无上下文扫描缓存目录
   - 缓存目录按年月组织不按客户组织，无上下文扫描必然串客户
   - 所有文件操作（list-files、export-files、extract-info）的 --conv 参数为必填
3. 不依赖 wecom_exporter：仅依赖同目录 wecom_crypto.py + pycryptodome

子命令：
  diagnose              诊断数据源可用性
  list-conversations    列出会话（按企业名称关键词筛选）
  search                在指定会话中搜索消息
  list-files            列出指定会话的文件元数据
  export-files          导出指定会话的文件
  collect-by-enterprise 一键式按企业名称收集（推荐）
  extract-info          从指定会话提取项目信息

退出码：
  0 = 成功
  1 = 参数错误/数据源不可用
  2 = 部分文件未缓存（export-files/collect-by-enterprise 场景）
"""
import argparse
import datetime
import glob
import hashlib
import json
import os
import re
import shutil
import sqlite3
import struct
import sys
import time

# 添加同目录到 path 以导入 wecom_crypto
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wecom_crypto


# ═══════════════════════════════════════════════════════════════════
# 配置加载
# ═══════════════════════════════════════════════════════════════════

DEFAULT_CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "wecom_config.json")


def load_config(config_path=None):
    """加载 wecom_config.json 配置（自动展开 path_vars 变量，向下兼容）

    本函数返回已展开变量的 config 对象。如需获取 path_vars 字典，
    请调用 load_config_with_vars()。
    """
    config, _ = load_config_with_vars(config_path)
    return config


def load_config_with_vars(config_path=None):
    """加载 wecom_config.json 配置，展开 path_vars 变量

    环境变量优先级高于配置文件中的 path_vars 定义。
    所有 ${VAR} 引用会被递归展开。

    Returns: (config, path_vars) 元组
        config: 已展开变量的配置字典
        path_vars: 实际使用的 path_vars 字典（含环境变量覆盖后的值）
    """
    path = config_path or DEFAULT_CONFIG_PATH
    if not os.path.isfile(path):
        raise FileNotFoundError(f"配置文件不存在: {path}")
    with open(path, "r", encoding="utf-8") as f:
        config = json.load(f)

    # 构建 path_vars（环境变量优先级高于配置文件）
    path_vars = dict(config.get("path_vars", {}))
    # 空字符串视为未设置，从环境变量动态获取（v1.2.1+）
    if not path_vars.get("USERPROFILE"):
        path_vars["USERPROFILE"] = os.environ.get("USERPROFILE", "")
    if not path_vars.get("WXWORK_ROOT"):
        path_vars["WXWORK_ROOT"] = os.path.join(
            path_vars.get("USERPROFILE", ""), "Documents", "WXWork")
    # 环境变量覆盖配置文件中的 path_vars
    for k in list(path_vars.keys()):
        if k in os.environ:
            path_vars[k] = os.environ[k]

    # 先展开 path_vars 字典本身（处理变量之间的引用，如 ${WXWORK_ROOT} 引用 ${USERPROFILE}）
    # 迭代直到无变化或达到最大迭代次数
    for _ in range(10):
        changed = False
        for k, v in list(path_vars.items()):
            if isinstance(v, str) and "${" in v:
                new_v = v
                for var_name, var_val in path_vars.items():
                    if var_name != k:
                        new_v = new_v.replace(f"${{{var_name}}}", var_val)
                if new_v != v:
                    path_vars[k] = new_v
                    changed = True
        if not changed:
            break

    # 递归展开所有 ${VAR} 引用
    def expand_vars(obj):
        if isinstance(obj, str):
            for var_name, var_val in path_vars.items():
                obj = obj.replace(f"${{{var_name}}}", var_val)
            return obj
        elif isinstance(obj, dict):
            return {k: expand_vars(v) for k, v in obj.items()}
        elif isinstance(obj, list):
            return [expand_vars(item) for item in obj]
        return obj

    return expand_vars(config), path_vars


# ═══════════════════════════════════════════════════════════════════
# 统一解密流程管理器
# ═══════════════════════════════════════════════════════════════════

class DecryptedDatabases:
    """临时解密数据库上下文管理器：自动解密、自动清理"""

    def __init__(self, db_names, config, keys=None):
        self.db_names = db_names
        self.config = config
        self.keys = keys
        self.decrypted_paths = {}
        self.temp_dir = None

    def __enter__(self):
        # 实时解密
        self.decrypted_paths = wecom_crypto.decrypt_databases(
            self.db_names, keys=self.keys
        )
        # 记录临时目录（用于清理）
        if self.decrypted_paths:
            self.temp_dir = os.path.dirname(next(iter(self.decrypted_paths.values())))
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        # 清理临时文件和整个临时目录（包括 SQLite WAL 附属文件 .db-shm/.db-wal）
        if self.config.get("decrypt", {}).get("cleanup_after_query", True):
            if self.temp_dir and os.path.isdir(self.temp_dir):
                try:
                    # 使用 shutil.rmtree 清理整个临时目录（包括 .db-shm/.db-wal 附属文件）
                    shutil.rmtree(self.temp_dir, ignore_errors=True)
                except OSError:
                    # 回退到逐个文件清理
                    wecom_crypto.cleanup_temp_db(self.decrypted_paths)
            else:
                wecom_crypto.cleanup_temp_db(self.decrypted_paths)
        return False

    def get(self, db_name):
        return self.decrypted_paths.get(db_name)


# ═══════════════════════════════════════════════════════════════════
# 消息内容解码（轻量 protobuf 文本提取）
# ═══════════════════════════════════════════════════════════════════

def extract_text_from_protobuf(content_bytes):
    """从 protobuf 编码的消息内容中提取文本
    策略：UTF-8 → GBK fallback → 正则提取可读文本
    """
    if not content_bytes:
        return ""

    # 尝试 UTF-8
    text = None
    try:
        text = content_bytes.decode("utf-8", errors="ignore")
    except Exception:
        pass

    # 如果 UTF-8 结果中可读字符太少，尝试 GBK
    if text:
        readable = sum(1 for c in text if c.isprintable() or c in "\n\r\t ")
        if readable < len(text) * 0.3:
            try:
                gbk_text = content_bytes.decode("gbk", errors="ignore")
                gbk_readable = sum(1 for c in gbk_text if c.isprintable() or c in "\n\r\t ")
                if gbk_readable > readable:
                    text = gbk_text
            except Exception:
                pass

    if not text:
        return ""

    # 提取连续的可读文本片段（中文+英文+数字+常见标点）
    # 匹配：中文字符、英文字母、数字、常见标点
    pattern = re.compile(r"[\u4e00-\u9fa5a-zA-Z0-9\s\.\,\;\:\!\?\-\_\(\)\[\]\{\}\/\\\@\#\$\%\^\&\*\+\=\|\~\`\"\'\<\>]{2,}")
    matches = pattern.findall(text)
    # 过滤过短的片段
    meaningful = [m.strip() for m in matches if len(m.strip()) >= 2]
    return " ".join(meaningful)[:500]  # 限制长度


# ═══════════════════════════════════════════════════════════════════
# 时间转换
# ═══════════════════════════════════════════════════════════════════

def timestamp_to_str(ts, time_format="%Y-%m-%d %H:%M:%S"):
    """Unix 时间戳转字符串"""
    if not ts or ts <= 0:
        return ""
    try:
        return datetime.datetime.fromtimestamp(ts).strftime(time_format)
    except (OSError, ValueError):
        return ""


def parse_date_to_timestamp(date_str):
    """日期字符串（YYYY-MM 或 YYYY-MM-DD）转时间戳"""
    if not date_str:
        return None
    try:
        if len(date_str) == 7:  # YYYY-MM
            dt = datetime.datetime.strptime(date_str, "%Y-%m")
            return int(dt.timestamp())
        elif len(date_str) == 10:  # YYYY-MM-DD
            dt = datetime.datetime.strptime(date_str, "%Y-%m-%d")
            return int(dt.timestamp())
        else:
            return int(date_str)
    except (ValueError, OSError):
        return None


# ═══════════════════════════════════════════════════════════════════
# 用户表查询
# ═══════════════════════════════════════════════════════════════════

def load_user_map(user_db_path):
    """加载用户表：{user_id: {name, real_name, external_corp_name, corp_id}}"""
    user_map = {}
    if not user_db_path or not os.path.isfile(user_db_path):
        return user_map
    conn = sqlite3.connect(f"file:{user_db_path}?mode=ro", uri=True)
    try:
        cursor = conn.execute(
            "SELECT id, name, real_name, external_corp_name, corp_id FROM user_table"
        )
        for row in cursor:
            user_id, name, real_name, external_corp_name, corp_id = row
            user_map[user_id] = {
                "name": name or "",
                "real_name": real_name or "",
                "external_corp_name": external_corp_name or "",
                "corp_id": corp_id or 0,
                "display_name": real_name or name or f"user_{user_id}",
            }
    except sqlite3.Error:
        pass
    finally:
        conn.close()
    return user_map


def get_user_display_name(user_id, user_map):
    """获取用户显示名"""
    if not user_id:
        return ""
    info = user_map.get(user_id, {})
    return info.get("display_name") or f"user_{user_id}"


# ═══════════════════════════════════════════════════════════════════
# 会话定位（多策略合并）
# ═══════════════════════════════════════════════════════════════════

def locate_conversations_by_enterprise(enterprise_keyword, session_db_path,
                                        user_db_path, message_db_path, limit=50):
    """多策略定位目标客户会话
    策略 A: session.db conversation_table 按 name/roomname_remark LIKE 查询
    策略 B: user.db user_table 按 external_corp_name LIKE 查询用户ID，
            然后在 session.db 按 S:{uid1}_{uid2} 格式反查单聊会话
    策略 C: message.db message_table 按消息内容 LIKE 查询，提取 conversation_id
    合并去重 → target_convs
    """
    target_convs = {}  # {conv_id: {"id":, "name":, "kind":, "match_strategy":}}

    # 策略 A: session name 匹配
    if session_db_path and os.path.isfile(session_db_path):
        conn = sqlite3.connect(f"file:{session_db_path}?mode=ro", uri=True)
        try:
            cursor = conn.execute(
                "SELECT id, name, roomname_remark FROM conversation_table "
                "WHERE name LIKE ? OR roomname_remark LIKE ? LIMIT ?",
                (f"%{enterprise_keyword}%", f"%{enterprise_keyword}%", limit)
            )
            for row in cursor:
                conv_id, name, roomname_remark = row
                if conv_id and conv_id not in target_convs:
                    display_name = roomname_remark or name or conv_id
                    kind = "group" if conv_id.startswith("R:") else ("single" if conv_id.startswith("S:") else "other")
                    target_convs[conv_id] = {
                        "id": conv_id,
                        "name": display_name,
                        "kind": kind,
                        "match_strategy": "session_name",
                    }
        except sqlite3.Error:
            pass
        finally:
            conn.close()

    # 策略 B: user external_corp_name 匹配 → 反查单聊会话
    if user_db_path and os.path.isfile(user_db_path) and session_db_path and os.path.isfile(session_db_path):
        matched_user_ids = []
        conn_user = sqlite3.connect(f"file:{user_db_path}?mode=ro", uri=True)
        try:
            cursor = conn_user.execute(
                "SELECT id, name, real_name, external_corp_name FROM user_table "
                "WHERE external_corp_name LIKE ? LIMIT ?",
                (f"%{enterprise_keyword}%", limit)
            )
            for row in cursor:
                matched_user_ids.append((row[0], row[2] or row[1] or f"user_{row[0]}", row[3]))
        except sqlite3.Error:
            pass
        finally:
            conn_user.close()

        # 在 session.db 查找 S:{uid1}_{uid2} 格式的单聊会话
        if matched_user_ids:
            conn_sess = sqlite3.connect(f"file:{session_db_path}?mode=ro", uri=True)
            try:
                for uid, uname, ext_corp in matched_user_ids:
                    # 单聊会话ID格式: S:uid1_uid2，需要匹配包含该uid的所有单聊
                    cursor = conn_sess.execute(
                        "SELECT id, name FROM conversation_table "
                        "WHERE id LIKE ? LIMIT ?",
                        (f"S:%{uid}%", 10)
                    )
                    for row in cursor:
                        conv_id, name = row
                        if conv_id and conv_id not in target_convs:
                            target_convs[conv_id] = {
                                "id": conv_id,
                                "name": name or f"{uname}({ext_corp})",
                                "kind": "single",
                                "match_strategy": "user_external_corp",
                            }
            except sqlite3.Error:
                pass
            finally:
                conn_sess.close()

    # 策略 C: message 内容匹配（性能考虑，限制扫描行数）
    if message_db_path and os.path.isfile(message_db_path):
        conn_msg = sqlite3.connect(f"file:{message_db_path}?mode=ro", uri=True)
        try:
            # 用 LIKE 匹配 content 字段（虽然是 protobuf，但企业名通常是明文）
            cursor = conn_msg.execute(
                "SELECT DISTINCT conversation_id FROM message_table "
                "WHERE conversation_id != '' AND content LIKE ? LIMIT ?",
                (f"%{enterprise_keyword}%", limit)
            )
            for row in cursor:
                conv_id = row[0]
                if conv_id and conv_id not in target_convs:
                    kind = "group" if conv_id.startswith("R:") else ("single" if conv_id.startswith("S:") else "other")
                    target_convs[conv_id] = {
                        "id": conv_id,
                        "name": conv_id,
                        "kind": kind,
                        "match_strategy": "message_content",
                    }
        except sqlite3.Error:
            pass
        finally:
            conn_msg.close()

    return list(target_convs.values())


# ═══════════════════════════════════════════════════════════════════
# 文件元数据查询
# ═══════════════════════════════════════════════════════════════════

def query_files_by_conversations(file_db_path, conversation_ids, keyword=None,
                                   date_from=None, date_to=None):
    """查询目标会话的文件元数据
    Args:
        file_db_path: 解密后的 file.db 路径
        conversation_ids: 目标会话ID列表
        keyword: 文件名关键词筛选（逗号分隔多关键词）
        date_from: 起始时间戳
        date_to: 结束时间戳
    Returns: 文件元数据列表
    """
    if not conversation_ids:
        return []

    conn = sqlite3.connect(f"file:{file_db_path}?mode=ro", uri=True)
    files = []
    try:
        # 构建 IN 子句占位符
        placeholders = ",".join(["?"] * len(conversation_ids))
        sql = (
            "SELECT origin, message_id, file_index, message_type, extension_type, "
            "name, size, receive_time, sender_id, conversation_id, md5 "
            f"FROM file_table4 WHERE conversation_id IN ({placeholders})"
        )
        params = list(conversation_ids)

        # 关键词筛选
        if keyword:
            keywords = [k.strip() for k in keyword.split(",") if k.strip()]
            if keywords:
                kw_conditions = " OR ".join(["name LIKE ?"] * len(keywords))
                sql += f" AND ({kw_conditions})"
                params.extend([f"%{k}%" for k in keywords])

        # 时间筛选
        if date_from:
            sql += " AND receive_time >= ?"
            params.append(date_from)
        if date_to:
            sql += " AND receive_time <= ?"
            params.append(date_to)

        sql += " ORDER BY receive_time DESC"

        cursor = conn.execute(sql, params)
        for row in cursor:
            files.append({
                "origin": row[0],
                "message_id": row[1],
                "file_index": row[2],
                "message_type": row[3],
                "extension_type": row[4],
                "name": row[5] or "",
                "size": row[6] or 0,
                "receive_time": row[7] or 0,
                "sender_id": row[8],
                "conversation_id": row[9] or "",
                "md5": row[10] or "",
            })
    except sqlite3.Error as e:
        raise RuntimeError(f"查询 file.db 失败: {e}")
    finally:
        conn.close()

    return files


def query_download_file_points(file_db_path, target_file_ids=None):
    """查询 download_file_point 表（md5 匹配失败时的回退方案）

    Args:
        file_db_path: 解密后的 file.db 路径
        target_file_ids: 目标 file_id 集合（来自 file_table4），None 则全量查询。
                         传入此参数可避免扫描所有客户下载记录，降低串客户风险。
    """
    points = []
    if not file_db_path or not os.path.isfile(file_db_path):
        return points
    conn = sqlite3.connect(f"file:{file_db_path}?mode=ro", uri=True)
    try:
        if target_file_ids:
            # 按 file_id 过滤，避免扫描所有客户下载记录
            placeholders = ",".join(["?"] * len(target_file_ids))
            sql = f"SELECT file_id, check_point, file_path, last_time FROM download_file_point WHERE file_id IN ({placeholders})"
            cursor = conn.execute(sql, list(target_file_ids))
        else:
            cursor = conn.execute("SELECT file_id, check_point, file_path, last_time FROM download_file_point")
        for row in cursor:
            points.append({
                "file_id": row[0] or "",
                "check_point": row[1] or 0,
                "file_path": row[2] or "",
                "last_time": row[3] or 0,
            })
    except sqlite3.Error:
        pass
    finally:
        conn.close()
    return points


# ═══════════════════════════════════════════════════════════════════
# 缓存目录文件匹配
# ═══════════════════════════════════════════════════════════════════

def compute_file_md5(file_path, chunk_size=8192):
    """计算文件 md5（分块读取）"""
    if not os.path.isfile(file_path):
        return ""
    md5_hash = hashlib.md5()
    try:
        with open(file_path, "rb") as f:
            while True:
                chunk = f.read(chunk_size)
                if not chunk:
                    break
                md5_hash.update(chunk)
    except OSError:
        return ""
    return md5_hash.hexdigest()


def locate_cache_dir_by_receive_time(cache_root, receive_time):
    """根据 file_table4.receive_time 精准定位缓存年月子目录

    企微缓存目录按 `媒体类型/YYYY-MM/` 组织（如 Cache/File/2026-07/），
    本函数根据文件接收时间戳推算 YYYY-MM，精准定位子目录，避免全量扫描。

    Args:
        cache_root: 缓存根目录（如 Cache/File 或 Cache/Image）
        receive_time: 文件接收时间戳（file_table4.receive_time）

    Returns:
        (precise_dir, candidate_yms):
            precise_dir: 精准目录路径（存在则返回，不存在返回 None）
            candidate_yms: 所有候选年月子目录列表（用于回退扫描）
    """
    if not receive_time or not cache_root or not os.path.isdir(cache_root):
        return None, []
    try:
        dt = datetime.datetime.fromtimestamp(receive_time)
    except (OSError, ValueError):
        return None, []
    target_ym = dt.strftime("%Y-%m")

    # 收集所有候选年月子目录
    candidate_yms = []
    try:
        for name in os.listdir(cache_root):
            if re.match(r"\d{4}-\d{2}$", name):
                candidate_yms.append(name)
    except OSError:
        return None, []
    candidate_yms.sort()

    # 精准目录
    precise_dir = os.path.join(cache_root, target_ym)
    if os.path.isdir(precise_dir):
        return precise_dir, candidate_yms
    return None, candidate_yms


def scan_cache_dir_by_message_type(cache_dir, message_type, target_year_month=None):
    """扫描缓存目录，返回 {filename: [full_path1, full_path2, ...]} 字典

    Args:
        cache_dir: 缓存根目录（Cache/File 或 Cache/Image）
        message_type: 0=文件, 1=图片（保留参数，当前未影响扫描逻辑）
        target_year_month: 精准限定年月子目录（如 "2026-07"），None 则全量扫描

    Returns:
        {filename: [full_path1, full_path2, ...]} —— 同名文件保留所有候选，
        由 match_file_in_cache 逐个 MD5 验证，避免 os.walk 顺序敏感导致的误匹配。
    """
    result = {}
    if not cache_dir or not os.path.isdir(cache_dir):
        return result

    if target_year_month:
        # 精准模式：只扫描指定年月子目录
        target_dir = os.path.join(cache_dir, target_year_month)
        if not os.path.isdir(target_dir):
            return result
        scan_roots = [target_dir]
    else:
        # 全量模式：扫描所有子目录（回退场景）
        scan_roots = [cache_dir]

    for root in scan_roots:
        for r, dirs, files in os.walk(root):
            for fname in files:
                result.setdefault(fname, []).append(os.path.join(r, fname))
    return result


def match_file_in_cache(file_meta, config, download_points=None,
                        expected_conversation_id=None, strict_conv_check=True):
    """在缓存目录中按 conversation_id 上下文 + md5 匹配实际文件

    强制校验（防串客户核心机制）：
        strict_conv_check=True 时，file_meta.conversation_id 必须等于
        expected_conversation_id，否则拒绝匹配并返回 conv_check_failed。

    四层匹配策略：
        a) 强制 conversation_id 校验（strict_conv_check=True 时）
        b) download_file_point.file_path 直接路径优先（若配置启用）
        c) 按 receive_time 精准定位年月子目录 + name 查找 + md5 验证
        d) 回退全量扫描（带 conversation_id 上下文）+ name + md5 验证

    Args:
        file_meta: 文件元数据（来自 file_table4，含 conversation_id 字段）
        config: wecom_config.json 配置
        download_points: download_file_point 表查询结果（建议已按 file_id 过滤）
        expected_conversation_id: 期望的会话ID（来自 --conv 参数或企业会话定位结果）
        strict_conv_check: 是否强制校验 conversation_id（默认 True，防串客户）

    Returns:
        (matched: bool, cache_path: str, match_strategy: str, detail: dict)
        detail 包含 conversation_id_verified 字段，标识是否通过会话上下文校验
    """
    name = file_meta.get("name", "")
    size = file_meta.get("size", 0)
    expected_md5 = file_meta.get("md5", "")
    message_type = file_meta.get("message_type", 0)
    receive_time = file_meta.get("receive_time", 0)
    file_conv_id = file_meta.get("conversation_id", "")

    # 策略 a: 强制 conversation_id 校验（防串客户核心机制）
    if strict_conv_check:
        if not expected_conversation_id:
            return False, "", "conv_check_failed", {"conversation_id_verified": False,
                "reason": "expected_conversation_id 为空"}
        if file_conv_id != expected_conversation_id:
            return False, "", "conv_check_failed", {"conversation_id_verified": False,
                "reason": f"file_meta.conv_id={file_conv_id} != expected={expected_conversation_id}"}

    if not name:
        return False, "", "no_name", {"conversation_id_verified": True}

    cache_config = config.get("cache", {})
    match_config = config.get("match", {})

    # 根据 message_type 选择缓存根目录
    if message_type == 1:
        # 图片截图
        scan_roots = [cache_config.get("image_dir", "")]
    elif message_type == 0:
        # 普通文件
        scan_roots = [cache_config.get("file_dir", "")]
    else:
        # 未知类型，两个目录都扫描
        scan_roots = [cache_config.get("file_dir", ""), cache_config.get("image_dir", "")]

    # 策略 b: download_file_point.file_path 直接路径优先
    if match_config.get("prefer_download_file_point", True) and download_points:
        for point in download_points:
            point_path = point.get("file_path", "")
            if point_path and os.path.isfile(point_path):
                if expected_md5:
                    point_md5 = compute_file_md5(point_path,
                        match_config.get("cache_scan_chunk_size", 8192))
                    if point_md5.lower() == expected_md5.lower():
                        return True, point_path, "download_file_point_md5_match", \
                            {"conversation_id_verified": True}

    # 策略 c: 精准查找（按 receive_time 定位年月子目录）
    if match_config.get("precise_year_month_lookup", True):
        for cache_root in scan_roots:
            if not cache_root or not os.path.isdir(cache_root):
                continue
            precise_dir, _ = locate_cache_dir_by_receive_time(cache_root, receive_time)
            if not precise_dir:
                continue
            target_ym = os.path.basename(precise_dir)
            cache_files = scan_cache_dir_by_message_type(cache_root, message_type, target_ym)
            matched, path, strategy = _try_match_in_cache_files(
                name, size, expected_md5, cache_files, config
            )
            if matched:
                return True, path, f"precise_{strategy}", {"conversation_id_verified": True}

    # 策略 d: 回退全量扫描（仍带 conversation_id 上下文）
    if match_config.get("fallback_to_full_scan", True):
        for cache_root in scan_roots:
            if not cache_root or not os.path.isdir(cache_root):
                continue
            cache_files = scan_cache_dir_by_message_type(cache_root, message_type)
            matched, path, strategy = _try_match_in_cache_files(
                name, size, expected_md5, cache_files, config
            )
            if matched:
                return True, path, f"fallback_{strategy}", {"conversation_id_verified": True}

    return False, "", "not_cached", {"conversation_id_verified": True}


def _try_match_in_cache_files(name, size, expected_md5, cache_files, config):
    """在 cache_files 字典中尝试匹配文件（同名多候选逐个 MD5 验证）

    Args:
        name: 目标文件名
        size: 目标文件大小
        expected_md5: 目标文件 md5
        cache_files: {filename: [path1, path2, ...]} 字典（来自 scan_cache_dir_by_message_type）
        config: wecom_config.json 配置

    Returns: (matched, cache_path, strategy)
    """
    candidates = cache_files.get(name, [])
    if not candidates:
        return False, "", "name_not_found"

    chunk_size = config.get("match", {}).get("cache_scan_chunk_size", 8192)
    for candidate_path in candidates:
        if not os.path.isfile(candidate_path):
            continue
        actual_size = os.path.getsize(candidate_path)
        if expected_md5:
            actual_md5 = compute_file_md5(candidate_path, chunk_size)
            if actual_md5.lower() == expected_md5.lower():
                return True, candidate_path, "md5_match"
        else:
            # md5 为空，按 name+size 或 name 匹配
            if size > 0 and actual_size == size:
                return True, candidate_path, "name_size_match"
            elif size == 0:
                return True, candidate_path, "name_only_match"
    return False, "", "md5_mismatch_or_size_mismatch"


# ═══════════════════════════════════════════════════════════════════
# 文件导出
# ═══════════════════════════════════════════════════════════════════

def export_file_to_dir(file_meta, cache_path, output_dir, enterprise,
                       conversation_info, user_map, config):
    """导出单个文件到目标目录，生成 .wecom_meta.json 元数据"""
    name = file_meta.get("name", "unknown")
    dest_path = os.path.join(output_dir, name)

    # 处理重名
    if os.path.exists(dest_path):
        base, ext = os.path.splitext(name)
        counter = 1
        while os.path.exists(dest_path):
            dest_path = os.path.join(output_dir, f"{base}_{counter}{ext}")
            counter += 1

    # 复制文件
    try:
        shutil.copy2(cache_path, dest_path)
    except OSError as e:
        return {"success": False, "error": str(e)}

    # 生成元数据文件
    meta = {
        "source": "wecom",
        "enterprise": enterprise,
        "message_id": file_meta.get("message_id", 0),
        "origin": file_meta.get("origin", 0),
        "file_index": file_meta.get("file_index", 0),
        "message_type": file_meta.get("message_type", 0),
        "extension_type": file_meta.get("extension_type", 0),
        "conversation_id": file_meta.get("conversation_id", ""),
        "conversation_name": conversation_info.get("name", ""),
        "original_name": name,
        "md5": file_meta.get("md5", ""),
        "size": file_meta.get("size", 0),
        "sender_id": file_meta.get("sender_id", 0),
        "sender_name": get_user_display_name(file_meta.get("sender_id"), user_map),
        "receive_time": timestamp_to_str(file_meta.get("receive_time", 0)),
        "cache_path": cache_path,
        "exported_at": datetime.datetime.now().isoformat(),
    }

    if config.get("export", {}).get("generate_meta_file", True):
        meta_suffix = config.get("export", {}).get("meta_file_suffix", ".wecom_meta.json")
        meta_path = dest_path + meta_suffix
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)

    return {"success": True, "dest_path": dest_path, "meta": meta}


def deduplicate_files(files, config):
    """文件去重（按 md5，md5 为空时按 name+size）"""
    dedup_strategy = config.get("export", {}).get("deduplicate_by", "md5_or_name_size")
    seen = {}
    deduplicated = []
    dup_count = 0

    for f in files:
        md5 = f.get("md5", "")
        name = f.get("name", "")
        size = f.get("size", 0)

        if dedup_strategy == "md5_or_name_size":
            if md5:
                key = f"md5:{md5.lower()}"
            else:
                key = f"name_size:{name}:{size}"
        elif dedup_strategy == "md5":
            key = f"md5:{md5.lower() if md5 else 'empty'}"
        else:
            key = f"name_size:{name}:{size}"

        if key in seen:
            dup_count += 1
            continue
        seen[key] = True
        deduplicated.append(f)

    return deduplicated, dup_count


# ═══════════════════════════════════════════════════════════════════
# 子命令实现：diagnose
# ═══════════════════════════════════════════════════════════════════

def cmd_diagnose(args, config):
    """诊断数据源可用性"""
    result = {
        "success": True,
        "decrypted_in_realtime": True,
        "data_source": {},
        "keys": {},
        "cache": {},
        "wxwork_process": {},
    }

    # 1. 检查数据库目录
    db_dir = config.get("data_source", {}).get("db_dir", "")
    if config.get("data_source", {}).get("auto_detect", True):
        detected_dir = wecom_crypto.auto_detect_db_dir()
        if detected_dir:
            db_dir = detected_dir

    result["data_source"]["db_dir"] = db_dir
    result["data_source"]["db_dir_exists"] = os.path.isdir(db_dir) if db_dir else False

    # 检查关键数据库文件
    critical_dbs = ["message.db", "file.db", "user.db", "session.db"]
    db_status = {}
    if db_dir and os.path.isdir(db_dir):
        for db_name in critical_dbs:
            db_path = os.path.join(db_dir, db_name)
            if os.path.isfile(db_path):
                size_mb = round(os.path.getsize(db_path) / 1024 / 1024, 2)
                db_status[db_name] = {"exists": True, "size_mb": size_mb}
            else:
                db_status[db_name] = {"exists": False}
    result["data_source"]["dbs"] = db_status
    result["data_source"]["db_available"] = all(
        db_status.get(db, {}).get("exists", False) for db in critical_dbs
    )

    # 2. 检查密钥可用性
    keys = wecom_crypto.load_keys()
    if keys:
        result["keys"]["available"] = True
        result["keys"]["source"] = "wxwork_keys.json"
        result["keys"]["db_count"] = len([k for k in keys if k != "_db_dir"])
        result["keys"]["db_dir"] = keys.get("_db_dir", "")
    else:
        # 尝试从进程内存提取
        pids = wecom_crypto.get_wxwork_pids()
        if pids:
            result["keys"]["available"] = "pending"
            result["keys"]["source"] = "process_memory"
            result["keys"]["note"] = "wxwork_keys.json 不存在，将从进程内存提取"
        else:
            result["keys"]["available"] = False
            result["keys"]["source"] = "none"
            result["keys"]["note"] = "请确保企业微信客户端正在运行"

    # 3. 检查缓存目录
    cache_config = config.get("cache", {})
    file_dir = cache_config.get("file_dir", "")
    image_dir = cache_config.get("image_dir", "")

    cache_file_count = 0
    if file_dir and os.path.isdir(file_dir):
        for root, dirs, files in os.walk(file_dir):
            cache_file_count += len(files)
    if image_dir and os.path.isdir(image_dir):
        for root, dirs, files in os.walk(image_dir):
            cache_file_count += len(files)

    result["cache"]["file_dir"] = file_dir
    result["cache"]["file_dir_exists"] = os.path.isdir(file_dir) if file_dir else False
    result["cache"]["image_dir"] = image_dir
    result["cache"]["image_dir_exists"] = os.path.isdir(image_dir) if image_dir else False
    result["cache"]["cache_file_count"] = cache_file_count

    # 4. 企微进程状态
    pids = wecom_crypto.get_wxwork_pids()
    result["wxwork_process"]["running"] = len(pids) > 0
    result["wxwork_process"]["pid_count"] = len(pids)
    result["wxwork_process"]["pids"] = [{"pid": pid, "mem_mb": mem // 1024} for pid, mem in pids]

    # 总体状态
    result["overall_ready"] = (
        result["data_source"]["db_available"]
        and result["cache"]["cache_file_count"] > 0
        and (result["keys"]["available"] is True or result["keys"]["available"] == "pending")
    )

    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["overall_ready"] else 1


# ═══════════════════════════════════════════════════════════════════
# 子命令实现：list-conversations
# ═══════════════════════════════════════════════════════════════════

def cmd_list_conversations(args, config):
    """列出会话（按企业名称关键词筛选）"""
    keyword = args.keyword
    limit = args.limit or 50
    kind_filter = args.kind

    dbs = config.get("decrypt", {}).get("dbs_for_messages", ["message.db", "user.db", "session.db"])

    with DecryptedDatabases(dbs, config) as dec:
        conversations = locate_conversations_by_enterprise(
            keyword, dec.get("session.db"), dec.get("user.db"), dec.get("message.db"), limit
        )

        # 统计每个会话的消息数
        if dec.get("message.db"):
            conn = sqlite3.connect(f"file:{dec.get('message.db')}?mode=ro", uri=True)
            try:
                for conv in conversations:
                    conv_id = conv["id"]
                    cursor = conn.execute(
                        "SELECT COUNT(*), MAX(send_time) FROM message_table WHERE conversation_id = ?",
                        (conv_id,)
                    )
                    row = cursor.fetchone()
                    conv["message_count"] = row[0] if row else 0
                    conv["last_time"] = timestamp_to_str(row[1]) if row and row[1] else ""
            except sqlite3.Error:
                pass
            finally:
                conn.close()

        # kind 筛选
        if kind_filter:
            conversations = [c for c in conversations if c["kind"] == kind_filter]

        result = {
            "success": True,
            "decrypted_in_realtime": True,
            "keyword": keyword,
            "count": len(conversations),
            "conversations": conversations,
        }

        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0


# ═══════════════════════════════════════════════════════════════════
# 子命令实现：search
# ═══════════════════════════════════════════════════════════════════

def cmd_search(args, config):
    """在指定会话中搜索消息"""
    conv_id = args.conv
    keyword = args.keyword
    limit = args.limit or config.get("search", {}).get("default_limit", 100)

    if not conv_id:
        print(json.dumps({"success": False, "error": "--conv 参数必填"}, ensure_ascii=False))
        return 1

    dbs = config.get("decrypt", {}).get("dbs_for_messages", ["message.db", "user.db", "session.db"])

    with DecryptedDatabases(dbs, config) as dec:
        user_map = load_user_map(dec.get("user.db"))

        messages = []
        if dec.get("message.db"):
            conn = sqlite3.connect(f"file:{dec.get('message.db')}?mode=ro", uri=True)
            try:
                if keyword:
                    cursor = conn.execute(
                        "SELECT message_id, sender_id, conversation_id, content_type, send_time, content "
                        "FROM message_table WHERE conversation_id = ? AND content LIKE ? "
                        "ORDER BY send_time DESC LIMIT ?",
                        (conv_id, f"%{keyword}%", limit)
                    )
                else:
                    cursor = conn.execute(
                        "SELECT message_id, sender_id, conversation_id, content_type, send_time, content "
                        "FROM message_table WHERE conversation_id = ? "
                        "ORDER BY send_time DESC LIMIT ?",
                        (conv_id, limit)
                    )

                for row in cursor:
                    msg_id, sender_id, conv, content_type, send_time, content = row
                    text = extract_text_from_protobuf(content) if content else ""
                    if keyword and keyword not in text:
                        continue  # protobuf 提取后再次确认
                    messages.append({
                        "message_id": msg_id,
                        "sender_id": sender_id,
                        "sender_name": get_user_display_name(sender_id, user_map),
                        "conversation_id": conv,
                        "content_type": content_type,
                        "send_time": timestamp_to_str(send_time),
                        "content_preview": text[:config.get("search", {}).get("max_content_length", 500)],
                    })
            except sqlite3.Error as e:
                print(json.dumps({"success": False, "error": str(e)}, ensure_ascii=False))
                return 1
            finally:
                conn.close()

        result = {
            "success": True,
            "decrypted_in_realtime": True,
            "conversation_id": conv_id,
            "keyword": keyword,
            "count": len(messages),
            "messages": messages,
        }

        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0


# ═══════════════════════════════════════════════════════════════════
# 子命令实现：list-files
# ═══════════════════════════════════════════════════════════════════

def cmd_list_files(args, config):
    """列出指定会话的文件元数据"""
    conv_id = args.conv
    keyword = args.keyword
    date_from = parse_date_to_timestamp(args.date_from) if args.date_from else None
    date_to = parse_date_to_timestamp(args.date_to) if args.date_to else None

    if not conv_id:
        print(json.dumps({"success": False, "error": "--conv 参数必填"}, ensure_ascii=False))
        return 1

    dbs = config.get("decrypt", {}).get("dbs_for_files", ["file.db", "user.db"])

    with DecryptedDatabases(dbs, config) as dec:
        user_map = load_user_map(dec.get("user.db"))

        files = query_files_by_conversations(
            dec.get("file.db"), [conv_id], keyword, date_from, date_to
        )

        # 检查缓存命中情况（按 file_id 过滤，避免扫描所有客户下载记录）
        target_file_ids = {str(f.get("message_id", "")) for f in files if f.get("message_id")}
        download_points = query_download_file_points(dec.get("file.db"), target_file_ids or None)
        for f in files:
            matched, cache_path, strategy, detail = match_file_in_cache(
                f, config, download_points,
                expected_conversation_id=conv_id,
                strict_conv_check=True,
            )
            f["cached"] = matched
            f["cache_path"] = cache_path
            f["match_strategy"] = strategy
            f["sender_name"] = get_user_display_name(f.get("sender_id"), user_map)
            f["receive_time_str"] = timestamp_to_str(f.get("receive_time", 0))

        result = {
            "success": True,
            "decrypted_in_realtime": True,
            "conversation_id": conv_id,
            "count": len(files),
            "files": files,
        }

        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0


# ═══════════════════════════════════════════════════════════════════
# 子命令实现：export-files
# ═══════════════════════════════════════════════════════════════════

def cmd_export_files(args, config):
    """导出指定会话的文件"""
    conv_id = args.conv
    out_dir = args.out
    keyword = args.keyword
    date_from = parse_date_to_timestamp(args.date_from) if args.date_from else None
    date_to = parse_date_to_timestamp(args.date_to) if args.date_to else None

    if not conv_id:
        print(json.dumps({"success": False, "error": "--conv 参数必填"}, ensure_ascii=False))
        return 1
    if not out_dir:
        print(json.dumps({"success": False, "error": "--out 参数必填"}, ensure_ascii=False))
        return 1

    os.makedirs(out_dir, exist_ok=True)

    dbs = config.get("decrypt", {}).get("dbs_for_files", ["file.db", "user.db"])

    with DecryptedDatabases(dbs, config) as dec:
        user_map = load_user_map(dec.get("user.db"))

        files = query_files_by_conversations(
            dec.get("file.db"), [conv_id], keyword, date_from, date_to
        )

        # 去重
        files, dup_count = deduplicate_files(files, config)

        # 查询 download_file_point 回退（按 file_id 过滤，避免扫描所有客户下载记录）
        target_file_ids = {str(f.get("message_id", "")) for f in files if f.get("message_id")}
        download_points = query_download_file_points(dec.get("file.db"), target_file_ids or None)

        # 匹配并导出
        exported = []
        not_cached = []

        for f in files:
            matched, cache_path, strategy, detail = match_file_in_cache(
                f, config, download_points,
                expected_conversation_id=conv_id,
                strict_conv_check=True,
            )
            if matched:
                conv_info = {"id": conv_id, "name": conv_id}
                export_result = export_file_to_dir(
                    f, cache_path, out_dir, "", conv_info, user_map, config
                )
                if export_result.get("success"):
                    exported.append({
                        "name": f["name"],
                        "dest_path": export_result["dest_path"],
                        "md5": f.get("md5", ""),
                        "size": f.get("size", 0),
                        "conversation_id": conv_id,
                        "sender_name": get_user_display_name(f.get("sender_id"), user_map),
                        "receive_time": timestamp_to_str(f.get("receive_time", 0)),
                        "message_id": f.get("message_id", 0),
                        "match_strategy": strategy,
                    })
                else:
                    not_cached.append({
                        "name": f["name"],
                        "md5": f.get("md5", ""),
                        "size": f.get("size", 0),
                        "reason": f"export_failed: {export_result.get('error', '')}",
                        "message_id": f.get("message_id", 0),
                    })
            else:
                not_cached.append({
                    "name": f["name"],
                    "md5": f.get("md5", ""),
                    "size": f.get("size", 0),
                    "reason": f"not_cached: {strategy}",
                    "message_id": f.get("message_id", 0),
                })

        total = len(exported) + len(not_cached)
        md5_match_rate = len(exported) / total if total > 0 else 0

        # ★ 安全验证：所有导出文件的 conversation_id 必须等于 --conv 参数（防串客户）
        security_violations = []
        for exp in exported:
            if exp.get("conversation_id", "") != conv_id:
                security_violations.append({
                    "file": exp.get("name", ""),
                    "conversation_id": exp.get("conversation_id", ""),
                    "reason": "conversation_id 不等于 --conv 参数（串客户风险）"
                })

        result = {
            "success": True,
            "decrypted_in_realtime": True,
            "conversation_id": conv_id,
            "exported": exported,
            "not_cached": not_cached,
            "stats": {
                "exported_count": len(exported),
                "not_cached_count": len(not_cached),
                "deduplicated_count": dup_count,
                "total_files_in_conversations": total,
                "md5_match_rate": round(md5_match_rate, 4),
            },
            "security_check": {
                "passed": len(security_violations) == 0,
                "violations": security_violations,
                "note": "所有导出文件的 conversation_id 必须等于 --conv 参数" if not security_violations else "发现串客户风险！",
            },
        }

        print(json.dumps(result, ensure_ascii=False, indent=2))

        # 退出码：2 表示部分文件未缓存或安全验证失败
        if security_violations:
            return 2
        if not_cached:
            return 2
        return 0


# ═══════════════════════════════════════════════════════════════════
# 子命令实现：collect-by-enterprise（核心命令）
# ═══════════════════════════════════════════════════════════════════

def cmd_collect_by_enterprise(args, config):
    """一键式按企业名称收集附件"""
    enterprise = args.enterprise
    out_dir = args.out
    keyword = args.keyword
    date_from = parse_date_to_timestamp(args.date_from) if args.date_from else None
    date_to = parse_date_to_timestamp(args.date_to) if args.date_to else None

    if not enterprise:
        print(json.dumps({"success": False, "error": "--enterprise 参数必填"}, ensure_ascii=False))
        return 1
    if not out_dir:
        print(json.dumps({"success": False, "error": "--out 参数必填"}, ensure_ascii=False))
        return 1

    os.makedirs(out_dir, exist_ok=True)

    dbs = config.get("decrypt", {}).get("dbs_for_collect_all",
                                         ["message.db", "file.db", "user.db", "session.db"])

    with DecryptedDatabases(dbs, config) as dec:
        # Step 2: 多策略定位目标客户会话
        conversations = locate_conversations_by_enterprise(
            enterprise, dec.get("session.db"), dec.get("user.db"), dec.get("message.db")
        )

        if not conversations:
            print(json.dumps({
                "success": False,
                "error": f"未找到企业[{enterprise}]相关的会话",
                "enterprise": enterprise,
            }, ensure_ascii=False))
            return 1

        # 构建 conversation_id 列表 + 信息映射
        conv_ids = [c["id"] for c in conversations]
        conv_info_map = {c["id"]: c for c in conversations}

        # Step 3: 查询目标会话的文件元数据
        files = query_files_by_conversations(
            dec.get("file.db"), conv_ids, keyword, date_from, date_to
        )

        if not files:
            result = {
                "success": True,
                "decrypted_in_realtime": True,
                "enterprise": enterprise,
                "conversations": conversations,
                "exported": [],
                "not_cached": [],
                "stats": {
                    "exported_count": 0,
                    "not_cached_count": 0,
                    "deduplicated_count": 0,
                    "total_files_in_conversations": 0,
                    "md5_match_rate": 0,
                },
            }
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 0

        # 去重
        files, dup_count = deduplicate_files(files, config)

        # 加载用户表
        user_map = load_user_map(dec.get("user.db"))

        # 查询 download_file_point 回退（按 file_id 过滤，避免扫描所有客户下载记录）
        target_file_ids = {str(f.get("message_id", "")) for f in files if f.get("message_id")}
        download_points = query_download_file_points(dec.get("file.db"), target_file_ids or None)

        # Step 4 & 5: 匹配缓存 + 导出
        exported = []
        not_cached = []

        for f in files:
            matched, cache_path, strategy, detail = match_file_in_cache(
                f, config, download_points,
                expected_conversation_id=f.get("conversation_id", ""),
                strict_conv_check=True,
            )
            if matched:
                conv_info = conv_info_map.get(f.get("conversation_id", ""), {"name": ""})
                export_result = export_file_to_dir(
                    f, cache_path, out_dir, enterprise, conv_info, user_map, config
                )
                if export_result.get("success"):
                    meta = export_result["meta"]
                    exported.append({
                        "name": f["name"],
                        "dest_path": export_result["dest_path"],
                        "md5": f.get("md5", ""),
                        "size": f.get("size", 0),
                        "conversation_id": f.get("conversation_id", ""),
                        "conversation_name": meta.get("conversation_name", ""),
                        "sender_name": meta.get("sender_name", ""),
                        "receive_time": meta.get("receive_time", ""),
                        "message_id": f.get("message_id", 0),
                        "match_strategy": strategy,
                    })
                else:
                    not_cached.append({
                        "name": f["name"],
                        "md5": f.get("md5", ""),
                        "size": f.get("size", 0),
                        "reason": f"export_failed: {export_result.get('error', '')}",
                        "message_id": f.get("message_id", 0),
                        "conversation_id": f.get("conversation_id", ""),
                    })
            else:
                not_cached.append({
                    "name": f["name"],
                    "md5": f.get("md5", ""),
                    "size": f.get("size", 0),
                    "reason": f"not_cached: {strategy}",
                    "message_id": f.get("message_id", 0),
                    "conversation_id": f.get("conversation_id", ""),
                })

        total = len(exported) + len(not_cached)
        md5_match_rate = len(exported) / total if total > 0 else 0

        # ★ 安全验证：所有导出文件的 conversation_id 必须在目标企业会话列表中
        security_violations = []
        for exp in exported:
            if exp["conversation_id"] not in conv_ids:
                security_violations.append({
                    "file": exp["name"],
                    "conversation_id": exp["conversation_id"],
                    "reason": "conversation_id 不在目标企业会话列表中（串客户风险）"
                })

        result = {
            "success": True,
            "decrypted_in_realtime": True,
            "enterprise": enterprise,
            "conversations": conversations,
            "exported": exported,
            "not_cached": not_cached,
            "stats": {
                "exported_count": len(exported),
                "not_cached_count": len(not_cached),
                "deduplicated_count": dup_count,
                "total_files_in_conversations": total,
                "md5_match_rate": round(md5_match_rate, 4),
            },
            "security_check": {
                "passed": len(security_violations) == 0,
                "violations": security_violations,
                "note": "所有导出文件的 conversation_id 必须在目标企业会话列表中" if not security_violations else "发现串客户风险！",
            },
        }

        # not_cached 操作指引（v1.10.0新增）
        if not_cached:
            result["not_cached_action_guide"] = _generate_not_cached_guide(
                not_cached, conversations
            )

        print(json.dumps(result, ensure_ascii=False, indent=2))

        # 退出码：2 表示部分文件未缓存
        if not_cached:
            return 2
        return 0


def _generate_not_cached_guide(not_cached_files, conversations):
    """生成未缓存文件的操作指引（v1.10.0新增）

    对 not_cached 文件，按会话分组生成操作步骤，帮助用户在企微客户端手动缓存后重新导出。

    Args:
        not_cached_files: not_cached 列表
        conversations: 目标会话列表

    Returns:
        dict: 含 step_by_step / grouped_by_conversation / prerequisite_check
    """
    conv_map = {c["id"]: c for c in conversations}

    # 按 conversation_id 分组
    by_conv = {}
    for f in not_cached_files:
        conv_id = f.get("conversation_id", "")
        by_conv.setdefault(conv_id, []).append(f)

    groups = []
    for conv_id, files in by_conv.items():
        conv_name = conv_map.get(conv_id, {}).get("display_name", conv_id)
        groups.append({
            "conversation_id": conv_id,
            "conversation_name": conv_name,
            "file_count": len(files),
            "files": [
                {
                    "name": f["name"],
                    "size": f.get("size", 0),
                    "size_display": _format_file_size(f.get("size", 0)),
                    "hint": "请在企微客户端打开该会话，找到此文件并点击下载/预览，文件会自动缓存到本地",
                }
                for f in files
            ],
        })

    guide = {
        "title": "未缓存文件操作指引",
        "summary": f"共 {len(not_cached_files)} 个文件尚未在企微客户端中缓存，需要手动操作后重新运行导出命令。",
        "why_not_cached": (
            "企微客户端仅在用户手动点击文件时才会下载到本地缓存目录。"
            "file_table4 中记录了这些文件的元数据（名称/MD5），但缓存目录中不存在对应文件。"
        ),
        "prerequisite_check": {
            "description": "请确认以下条件满足后再按步骤操作：",
            "items": [
                "企业微信客户端正在运行且已登录",
                "可以访问目标企业的聊天会话",
                "聊天会话中可以看到对应的文件消息",
            ],
        },
        "step_by_step": [
            "1. 在企微客户端中打开以下各会话",
            "2. 在聊天记录中找到每个「需手动缓存」的文件",
            "3. 点击文件进行预览或下载（企微会自动缓存到本地）",
            "4. 确认文件已打开/下载完成后，重新运行 collect-by-enterprise 命令",
        ],
        "grouped_by_conversation": groups,
        "retry_command_hint": (
            "缓存完成后重新运行：python .trae/skills/_common/wecom_query.py collect-by-enterprise "
            "--enterprise \"<企业名>\" --out \"<输出目录>\""
        ),
    }
    return guide


def _format_file_size(size_bytes):
    """格式化文件大小"""
    if size_bytes < 1024:
        return f"{size_bytes} B"
    elif size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.1f} KB"
    else:
        return f"{size_bytes / (1024 * 1024):.1f} MB"


# ═══════════════════════════════════════════════════════════════════
# 子命令实现：extract-info
# ═══════════════════════════════════════════════════════════════════

def cmd_extract_info(args, config):
    """从指定会话提取项目信息"""
    conv_id = args.conv
    keywords = args.keywords or "研发,产品,专利,项目,技术,合同,发票,社保,审计,立项"

    if not conv_id:
        print(json.dumps({"success": False, "error": "--conv 参数必填"}, ensure_ascii=False))
        return 1

    dbs = config.get("decrypt", {}).get("dbs_for_messages", ["message.db", "user.db", "session.db"])

    with DecryptedDatabases(dbs, config) as dec:
        user_map = load_user_map(dec.get("user.db"))

        # 提取消息
        messages = []
        if dec.get("message.db"):
            conn = sqlite3.connect(f"file:{dec.get('message.db')}?mode=ro", uri=True)
            try:
                cursor = conn.execute(
                    "SELECT message_id, sender_id, content_type, send_time, content "
                    "FROM message_table WHERE conversation_id = ? "
                    "ORDER BY send_time ASC LIMIT 5000",
                    (conv_id,)
                )
                for row in cursor:
                    msg_id, sender_id, content_type, send_time, content = row
                    text = extract_text_from_protobuf(content) if content else ""
                    if text:
                        messages.append({
                            "message_id": msg_id,
                            "sender_id": sender_id,
                            "sender_name": get_user_display_name(sender_id, user_map),
                            "content_type": content_type,
                            "send_time": timestamp_to_str(send_time),
                            "text": text,
                        })
            except sqlite3.Error:
                pass
            finally:
                conn.close()

        # 提取关键信息
        keyword_list = [k.strip() for k in keywords.split(",") if k.strip()]
        key_sentences = []
        mentioned_files = []
        names_mentioned = set()
        timeline = []

        for msg in messages:
            text = msg["text"]
            # 关键句子（包含关键词的句子）
            sentences = re.split(r"[。！？\n]", text)
            for sent in sentences:
                sent = sent.strip()
                if len(sent) < 5:
                    continue
                for kw in keyword_list:
                    if kw in sent:
                        key_sentences.append({
                            "sentence": sent,
                            "keyword": kw,
                            "sender": msg["sender_name"],
                            "time": msg["send_time"],
                        })
                        break

            # 提及的文件
            file_patterns = re.findall(r"[\u4e00-\u9fa5a-zA-Z0-9_\-]+\.(pdf|docx?|xlsx?|zip|rar|jpg|jpeg|png)", text, re.IGNORECASE)
            for fp in file_patterns:
                mentioned_files.append(fp)

            # 人名（简单提取：2-4 个中文字符）
            name_matches = re.findall(r"[\u4e00-\u9fa5]{2,4}", text)
            for nm in name_matches:
                if len(nm) >= 2 and len(nm) <= 4:
                    names_mentioned.add(nm)

            # 时间线
            timeline.append({
                "time": msg["send_time"],
                "sender": msg["sender_name"],
                "preview": text[:100],
            })

        result = {
            "success": True,
            "decrypted_in_realtime": True,
            "conversation_id": conv_id,
            "message_count": len(messages),
            "key_sentences": key_sentences[:50],  # 限制数量
            "mentioned_files": list(set(mentioned_files))[:30],
            "names_mentioned": list(names_mentioned)[:30],
            "timeline": timeline[:20],
        }

        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0


# ═══════════════════════════════════════════════════════════════════
# 子命令实现：verify-association
# ═══════════════════════════════════════════════════════════════════

def cmd_verify_association(args, config):
    """验证指定会话的文件-缓存关联完整性

    不导出文件，仅输出验证报告。用于检查 match_file_in_cache 的匹配状态、
    conversation_id 校验结果、精准查找命中率等，帮助诊断串客户风险。

    退出码：
        0 = 全部文件匹配成功
        2 = 部分文件未缓存或校验失败
        1 = 参数错误
    """
    conv_id = args.conv
    keyword = args.keyword
    date_from = parse_date_to_timestamp(args.date_from) if args.date_from else None
    date_to = parse_date_to_timestamp(args.date_to) if args.date_to else None

    if not conv_id:
        print(json.dumps({"success": False, "error": "--conv 参数必填"}, ensure_ascii=False))
        return 1

    dbs = config.get("decrypt", {}).get("dbs_for_files", ["file.db", "user.db"])

    with DecryptedDatabases(dbs, config) as dec:
        user_map = load_user_map(dec.get("user.db"))

        files = query_files_by_conversations(
            dec.get("file.db"), [conv_id], keyword, date_from, date_to
        )

        # 按 file_id 过滤 download_file_point
        target_file_ids = {str(f.get("message_id", "")) for f in files if f.get("message_id")}
        download_points = query_download_file_points(dec.get("file.db"), target_file_ids or None)

        report = {
            "success": True,
            "decrypted_in_realtime": True,
            "conversation_id": conv_id,
            "total": len(files),
            "matched": 0,
            "not_cached": 0,
            "conv_check_failed": 0,
            "strategy_stats": {},
            "details": [],
        }

        for f in files:
            matched, cache_path, strategy, detail = match_file_in_cache(
                f, config, download_points,
                expected_conversation_id=conv_id,
                strict_conv_check=True,
            )

            entry = {
                "name": f.get("name", ""),
                "size": f.get("size", 0),
                "md5": f.get("md5", ""),
                "receive_time": timestamp_to_str(f.get("receive_time", 0)),
                "message_type": f.get("message_type", 0),
                "matched": matched,
                "cache_path": cache_path,
                "match_strategy": strategy,
                "conversation_id_verified": detail.get("conversation_id_verified", False),
            }
            if not matched and detail.get("reason"):
                entry["reason"] = detail["reason"]

            report["details"].append(entry)
            report["strategy_stats"][strategy] = report["strategy_stats"].get(strategy, 0) + 1

            if matched:
                report["matched"] += 1
            elif strategy == "conv_check_failed":
                report["conv_check_failed"] += 1
            else:
                report["not_cached"] += 1

        report["security_check"] = {
            "passed": report["conv_check_failed"] == 0,
            "violations_count": report["conv_check_failed"],
            "note": "所有文件 conversation_id 校验通过" if report["conv_check_failed"] == 0
                    else f"发现 {report['conv_check_failed']} 个 conversation_id 校验失败（串客户风险）",
        }

        print(json.dumps(report, ensure_ascii=False, indent=2))

        if report["not_cached"] > 0 or report["conv_check_failed"] > 0:
            return 2
        return 0


# ═══════════════════════════════════════════════════════════════════
# 主入口：argparse 子命令
# ═══════════════════════════════════════════════════════════════════

def build_parser():
    """构建 argparse 解析器"""
    parser = argparse.ArgumentParser(
        description="WeCom CLI - 企业微信会话实时查询与附件收集",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
核心安全约束：
  1. 实时解密：从 Data/ 原始加密 DB 实时解密，不读取已解密数据
  2. 会话-文件-缓存三联动：所有文件操作必须经 conversation_id 上下文
  3. 不依赖 wecom_exporter：仅依赖同目录 wecom_crypto.py

示例：
  python wecom_query.py diagnose
  python wecom_query.py list-conversations --keyword "派成"
  python wecom_query.py collect-by-enterprise --enterprise "派成铝业" --out ./export
  python wecom_query.py list-files --conv "R:10696050490027793"
  python wecom_query.py export-files --conv "R:10696050490027793" --out ./export
  python wecom_query.py search --conv "R:10696050490027793" --keyword "专利"
  python wecom_query.py extract-info --conv "R:10696050490027793"
        """,
    )
    parser.add_argument("--config", default=None, help="配置文件路径（默认 _common/wecom_config.json）")

    subparsers = parser.add_subparsers(dest="command", help="子命令")

    # diagnose
    p_diag = subparsers.add_parser("diagnose", help="诊断数据源可用性")

    # list-conversations
    p_list_conv = subparsers.add_parser("list-conversations", help="列出会话（按企业名称关键词筛选）")
    p_list_conv.add_argument("--keyword", required=True, help="企业名称关键词")
    p_list_conv.add_argument("--kind", choices=["group", "single", "other"], help="会话类型筛选")
    p_list_conv.add_argument("--limit", type=int, default=50, help="最大返回数（默认50）")

    # search
    p_search = subparsers.add_parser("search", help="在指定会话中搜索消息")
    p_search.add_argument("--conv", required=True, help="会话ID（必填）")
    p_search.add_argument("--keyword", help="搜索关键词")
    p_search.add_argument("--limit", type=int, help="最大返回数")

    # list-files
    p_list_files = subparsers.add_parser("list-files", help="列出指定会话的文件元数据")
    p_list_files.add_argument("--conv", required=True, help="会话ID（必填）")
    p_list_files.add_argument("--keyword", help="文件名关键词筛选（逗号分隔）")
    p_list_files.add_argument("--date-from", help="起始日期（YYYY-MM 或 YYYY-MM-DD）")
    p_list_files.add_argument("--date-to", help="结束日期（YYYY-MM 或 YYYY-MM-DD）")

    # export-files
    p_export = subparsers.add_parser("export-files", help="导出指定会话的文件")
    p_export.add_argument("--conv", required=True, help="会话ID（必填）")
    p_export.add_argument("--out", required=True, help="输出目录（必填）")
    p_export.add_argument("--keyword", help="文件名关键词筛选（逗号分隔）")
    p_export.add_argument("--date-from", help="起始日期（YYYY-MM 或 YYYY-MM-DD）")
    p_export.add_argument("--date-to", help="结束日期（YYYY-MM 或 YYYY-MM-DD）")

    # collect-by-enterprise
    p_collect = subparsers.add_parser("collect-by-enterprise", help="一键式按企业名称收集（推荐）")
    p_collect.add_argument("--enterprise", required=True, help="企业名称（必填）")
    p_collect.add_argument("--out", required=True, help="输出目录（必填）")
    p_collect.add_argument("--keyword", help="文件名关键词筛选（逗号分隔）")
    p_collect.add_argument("--date-from", help="起始日期（YYYY-MM 或 YYYY-MM-DD）")
    p_collect.add_argument("--date-to", help="结束日期（YYYY-MM 或 YYYY-MM-DD）")

    # extract-info
    p_extract = subparsers.add_parser("extract-info", help="从指定会话提取项目信息")
    p_extract.add_argument("--conv", required=True, help="会话ID（必填）")
    p_extract.add_argument("--keywords", help="关键词（逗号分隔，默认：研发,产品,专利,项目,技术,合同,发票,社保,审计,立项）")

    # verify-association
    p_verify = subparsers.add_parser("verify-association", help="验证会话-文件-缓存关联完整性（防串客户诊断）")
    p_verify.add_argument("--conv", required=True, help="会话ID（必填）")
    p_verify.add_argument("--keyword", help="文件名关键词筛选（逗号分隔）")
    p_verify.add_argument("--date-from", help="起始日期（YYYY-MM 或 YYYY-MM-DD）")
    p_verify.add_argument("--date-to", help="结束日期（YYYY-MM 或 YYYY-MM-DD）")

    return parser


def main():
    parser = build_parser()
    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        return 1

    # 加载配置
    try:
        config = load_config(args.config)
    except FileNotFoundError as e:
        print(json.dumps({"success": False, "error": str(e)}, ensure_ascii=False))
        return 1

    # 分发到子命令
    try:
        if args.command == "diagnose":
            return cmd_diagnose(args, config)
        elif args.command == "list-conversations":
            return cmd_list_conversations(args, config)
        elif args.command == "search":
            return cmd_search(args, config)
        elif args.command == "list-files":
            return cmd_list_files(args, config)
        elif args.command == "export-files":
            return cmd_export_files(args, config)
        elif args.command == "collect-by-enterprise":
            return cmd_collect_by_enterprise(args, config)
        elif args.command == "extract-info":
            return cmd_extract_info(args, config)
        elif args.command == "verify-association":
            return cmd_verify_association(args, config)
        else:
            parser.print_help()
            return 1
    except RuntimeError as e:
        print(json.dumps({"success": False, "error": str(e)}, ensure_ascii=False))
        return 1
    except Exception as e:
        print(json.dumps({"success": False, "error": f"unexpected: {e}"}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
