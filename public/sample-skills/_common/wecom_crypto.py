"""
企微数据库实时解密模块（独立实现，不依赖任何外部项目）

核心功能：
- 从 WXWork.exe 进程内存提取密钥
- wxSQLite3 AES-128-CBC 逐页解密原始加密数据库
- 自动检测企微数据目录
- 密钥文件管理（加载/保存/交叉验证）

核心约束：
1. 实时解密：从 Data/ 目录原始加密 DB 实时解密，不读取已解密数据
2. 临时文件：解密输出到 tempfile.gettempdir()/wecom_decrypted_{timestamp}/，查询后立即清理
3. 只读：只读取加密数据库和缓存文件，不修改原文件
4. 独立性：不依赖任何外部项目，仅基于公开算法实现

算法依据：
- wxSQLite3 AES-128-CBC：来自 SQLite3MultipleCiphers 项目公开文档
- Windows API：ReadProcessMemory / VirtualQueryEx 标准系统调用
- 密钥提取：基于企微进程内存中的 cipher 结构体特征扫描
"""
import ctypes
import ctypes.wintypes as wt
import bisect
import functools
import hashlib
import hmac as hmac_mod
import json
import os
import re
import struct
import subprocess
import sys
import tempfile
import time

from Crypto.Cipher import AES

print = functools.partial(print, flush=True)

# ═══════════════════════════════════════════════════════════════════
# 常量
# ═══════════════════════════════════════════════════════════════════

PAGE_SZ = 4096
SQLITE_HDR = b"SQLite format 3\x00"
WXSQLITE3_SALT = b"sAlT"
SALT_SZ = 16

# 密钥文件唯一路径：本模块同目录下的 wxwork_keys.json
# 不再回退到任何外部项目目录
_DEFAULT_KEYS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "wxwork_keys.json")


# ═══════════════════════════════════════════════════════════════════
# wxSQLite3 AES-128-CBC 解密核心（基于 SQLite3MultipleCiphers 公开算法）
# ═══════════════════════════════════════════════════════════════════

def _modmult(a, b, c, m, s):
    """线性同余生成器辅助函数（来自 wxSQLite3 公开源码）"""
    q = s // a
    s = b * (s - a * q) - c * q
    if s < 0:
        s += m
    return s


def generate_initial_vector(page_no):
    """生成初始化向量（来自 SQLite3MultipleCiphers sqlite3mcGenerateInitialVector）"""
    z = page_no + 1
    initkey = bytearray(16)
    for idx in range(4):
        z = _modmult(52774, 40692, 3791, 2147483399, z)
        initkey[idx * 4: idx * 4 + 4] = struct.pack("<I", z & 0xFFFFFFFF)
    return hashlib.md5(initkey).digest()


def derive_wxsqlite3_aes128_page_key(raw_key, page_no):
    """派生每页 AES-128 密钥（来自 wxSQLite3 AES-128-CBC 公开算法）"""
    if len(raw_key) != 16:
        raise ValueError("wxSQLite3 AES-128 raw key must be 16 bytes")
    material = raw_key + struct.pack("<I", page_no) + WXSQLITE3_SALT
    return hashlib.md5(material).digest()


def is_plain_sqlite_page(page):
    """判断是否为明文 SQLite 页"""
    return page[:len(SQLITE_HDR)] == SQLITE_HDR


def has_wxsqlite3_plain_header_fragment(page):
    """检查 wxSQLite3 AES 模式的明文头部片段（bytes 16..23 保持明文）"""
    if len(page) < 24:
        return False
    header = page[16:24]
    page_size = (header[0] << 8) | header[1]
    if page_size == 1:
        page_size = 65536
    return (
        page_size >= 512
        and page_size <= 65536
        and (page_size & (page_size - 1)) == 0
        and header[5] == 0x40
        and header[6] == 0x20
        and header[7] == 0x20
    )


def is_wxsqlite3_aes128_page1(page):
    """判断是否为 wxSQLite3 AES-128 模式的第一页"""
    return not is_plain_sqlite_page(page) and has_wxsqlite3_plain_header_fragment(page)


def _decrypt_aes128_cbc(raw_key, page_no, data):
    """AES-128-CBC 解密单页数据"""
    page_key = derive_wxsqlite3_aes128_page_key(raw_key, page_no)
    iv = generate_initial_vector(page_no)
    return AES.new(page_key, AES.MODE_CBC, iv).decrypt(data)


def decrypt_page_aes128_cbc(raw_key, page_data, page_no):
    """解密单个 wxSQLite3 AES-128-CBC 页，返回标准 SQLite 页

    Args:
        raw_key: 16 字节原始密钥
        page_data: 4096 字节加密页数据
        page_no: 页码（从1开始）

    Returns: 4096 字节解密后的 SQLite 页
    """
    if len(page_data) != PAGE_SZ:
        raise ValueError(f"page must be exactly {PAGE_SZ} bytes")

    data = bytearray(page_data)
    if page_no == 1 and has_wxsqlite3_plain_header_fragment(data):
        db_header_fragment = bytes(data[16:24])
        data[16:24] = data[8:16]
        decrypted_tail = _decrypt_aes128_cbc(raw_key, page_no, bytes(data[16:]))
        data[16:] = decrypted_tail
        if bytes(data[16:24]) != db_header_fragment:
            raise ValueError("wxSQLite3 AES-128 key validation failed")
        data[:16] = SQLITE_HDR
        return bytes(data)

    return _decrypt_aes128_cbc(raw_key, page_no, bytes(data))


def looks_like_sqlite_page1(page):
    """验证解密后的第一页是否像有效的 SQLite 页"""
    if page[:len(SQLITE_HDR)] != SQLITE_HDR:
        return False
    if len(page) < 108:
        return False
    btree_page_type = page[100]
    return btree_page_type in (0x02, 0x05, 0x0A, 0x0D)


def verify_database_key(enc_key, db_page1):
    """验证密钥是否正确（支持 wxSQLite3 AES-128 和 SQLCipher 多种参数）

    Args:
        enc_key: 密钥字节
        db_page1: 加密数据库的第一页（4096字节）

    Returns: (成功?, 使用的配置描述)
    """
    # wxSQLite3 AES-128-CBC 验证
    if len(enc_key) == 16 and verify_wxsqlite3_aes128_key(enc_key, db_page1):
        return True, "wxSQLite3 AES-128-CBC, per-page MD5 key/IV, no HMAC"

    # SQLCipher 兼容验证（多种参数组合）
    key_sz = len(enc_key)
    for cfg_key_sz, hmac_hash, hmac_sz, iterations, reserve_sz in VERIFY_CONFIGS:
        if key_sz != cfg_key_sz:
            continue
        salt = db_page1[:SALT_SZ]
        mac_salt = bytes(b ^ 0x3A for b in salt)
        mac_key = hashlib.pbkdf2_hmac(hmac_hash, enc_key, mac_salt, iterations, dklen=cfg_key_sz)
        hmac_data = db_page1[SALT_SZ: PAGE_SZ - reserve_sz + 16]
        stored_hmac = db_page1[PAGE_SZ - hmac_sz: PAGE_SZ]
        hash_fn = getattr(hashlib, hmac_hash)
        hm = hmac_mod.new(mac_key, hmac_data, hash_fn)
        hm.update(struct.pack("<I", 1))
        if hm.digest() == stored_hmac:
            desc = f"AES-{cfg_key_sz * 8}, HMAC-{hmac_hash.upper()}, iter={iterations}"
            return True, desc
    return False, ""


def verify_wxsqlite3_aes128_key(raw_key, page1):
    """验证 wxSQLite3 AES-128 密钥"""
    if len(raw_key) != 16 or len(page1) < PAGE_SZ:
        return False
    try:
        decrypted = decrypt_page_aes128_cbc(raw_key, page1[:PAGE_SZ], 1)
    except (ValueError, KeyError):
        return False
    return looks_like_sqlite_page1(decrypted)


# ═══════════════════════════════════════════════════════════════════
# 兼容验证配置（SQLCipher 回退）
# ═══════════════════════════════════════════════════════════════════

VERIFY_CONFIGS = [
    (16, "sha512", 64, 2, 80),
    (16, "sha256", 32, 2, 48),
    (16, "sha512", 64, 4000, 80),
    (16, "sha256", 32, 4000, 48),
    (32, "sha512", 64, 2, 80),
]


# ═══════════════════════════════════════════════════════════════════
# Windows 内存读取原语（标准 Windows API）
# ═══════════════════════════════════════════════════════════════════

kernel32 = ctypes.windll.kernel32
MEM_COMMIT = 0x1000
READABLE = {0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80}


class MBI(ctypes.Structure):
    """MEMORY_BASIC_INFORMATION 结构体"""
    _fields_ = [
        ("BaseAddress", ctypes.c_uint64), ("AllocationBase", ctypes.c_uint64),
        ("AllocationProtect", wt.DWORD), ("_pad1", wt.DWORD),
        ("RegionSize", ctypes.c_uint64), ("State", wt.DWORD),
        ("Protect", wt.DWORD), ("Type", wt.DWORD), ("_pad2", wt.DWORD),
    ]


def read_mem(h, addr, sz):
    """读取进程内存（ReadProcessMemory）"""
    buf = ctypes.create_string_buffer(sz)
    n = ctypes.c_size_t(0)
    if kernel32.ReadProcessMemory(h, ctypes.c_uint64(addr), buf, sz, ctypes.byref(n)):
        return buf.raw[:n.value]
    return None


def enum_regions(h):
    """枚举进程可读内存区域（VirtualQueryEx）"""
    regs = []
    addr = 0
    mbi = MBI()
    while addr < 0x7FFFFFFFFFFF:
        if kernel32.VirtualQueryEx(h, ctypes.c_uint64(addr), ctypes.byref(mbi), ctypes.sizeof(mbi)) == 0:
            break
        if mbi.State == MEM_COMMIT and mbi.Protect in READABLE and 0 < mbi.RegionSize < 500 * 1024 * 1024:
            regs.append((mbi.BaseAddress, mbi.RegionSize))
        nxt = mbi.BaseAddress + mbi.RegionSize
        if nxt <= addr:
            break
        addr = nxt
    return regs


# ═══════════════════════════════════════════════════════════════════
# WXWork 进程发现
# ═══════════════════════════════════════════════════════════════════

WXWORK_PROCESS = "WXWork.exe"


def get_wxwork_pids():
    """返回所有 WXWork.exe 进程的 (pid, mem_kb) 列表，按内存降序"""
    r = subprocess.run(
        ["tasklist", "/FI", f"IMAGENAME eq {WXWORK_PROCESS}", "/FO", "CSV", "/NH"],
        capture_output=True, text=True,
        creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
    )
    pids = []
    for line in r.stdout.strip().split('\n'):
        if not line.strip():
            continue
        p = line.strip('"').split('","')
        if len(p) >= 5:
            pid = int(p[1])
            mem = int(p[4].replace(',', '').replace(' K', '').strip() or '0')
            pids.append((pid, mem))
    if not pids:
        return []
    pids.sort(key=lambda x: x[1], reverse=True)
    return pids


# ═══════════════════════════════════════════════════════════════════
# 数据库目录自动检测
# ═══════════════════════════════════════════════════════════════════

def _wxwork_data_dir_mtime(data_dir):
    """返回企业微信 Data 目录最近活跃时间，用于多账号自动选择。"""
    latest = 0
    for root, dirs, files in os.walk(data_dir):
        dirs[:] = [d for d in dirs if d not in ("-journal",)]
        for name in files:
            if not name.endswith((".db", ".db-wal", ".db-shm")):
                continue
            path = os.path.join(root, name)
            try:
                latest = max(latest, os.path.getmtime(path))
            except OSError:
                pass
    try:
        latest = max(latest, os.path.getmtime(data_dir))
    except OSError:
        pass
    return latest


def auto_detect_wxwork_db_dir():
    """扫描 %USERPROFILE%\\Documents\\WXWork\\*\\Data 寻找包含加密DB的目录"""
    docs = os.path.join(os.environ.get("USERPROFILE", ""), "Documents", "WXWork")
    if not os.path.isdir(docs):
        return None
    candidates = []
    for name in os.listdir(docs):
        data_dir = os.path.join(docs, name, "Data")
        if not os.path.isdir(data_dir):
            continue
        has_encrypted = False
        for fname in os.listdir(data_dir):
            if not fname.endswith(".db"):
                continue
            fpath = os.path.join(data_dir, fname)
            if os.path.getsize(fpath) < PAGE_SZ:
                continue
            with open(fpath, "rb") as f:
                header = f.read(16)
            if header != b"SQLite format 3\x00":
                has_encrypted = True
                break
        if has_encrypted:
            candidates.append(data_dir)
    if not candidates:
        return None
    candidates.sort(key=_wxwork_data_dir_mtime, reverse=True)
    return candidates[0]


def auto_detect_db_dir():
    """封装 auto_detect_wxwork_db_dir()，对外统一接口"""
    return auto_detect_wxwork_db_dir()


# ═══════════════════════════════════════════════════════════════════
# 数据库文件收集
# ═══════════════════════════════════════════════════════════════════

def collect_db_files(db_dir):
    """遍历 db_dir 收集所有 .db 文件及其第一页数据。
    返回 (db_files, salt_to_dbs):
      db_files: [(rel_path, abs_path, size, salt_hex, page1_bytes), ...]
      salt_to_dbs: {salt_hex: [rel_path, ...]}
    """
    db_files = []
    salt_to_dbs = {}
    for root, dirs, files in os.walk(db_dir):
        for name in files:
            if not name.endswith(".db") or name.endswith("-wal") or name.endswith("-shm"):
                continue
            path = os.path.join(root, name)
            size = os.path.getsize(path)
            if size < PAGE_SZ:
                continue
            with open(path, "rb") as f:
                page1 = f.read(PAGE_SZ)
            rel = os.path.relpath(path, db_dir)
            salt = page1[:SALT_SZ].hex()
            db_files.append((rel, path, size, salt, page1))
            salt_to_dbs.setdefault(salt, []).append(rel)
    return db_files, salt_to_dbs


def filter_encrypted_dbs(db_files, salt_to_dbs):
    """过滤掉未加密的数据库。"""
    filtered_files = [
        entry for entry in db_files if not is_plain_sqlite_page(entry[4])
    ]
    filtered_salts = {
        s: dbs for s, dbs in salt_to_dbs.items()
        if any(entry[3] == s and not is_plain_sqlite_page(entry[4]) for entry in db_files)
    }
    return filtered_files, filtered_salts


# ═══════════════════════════════════════════════════════════════════
# 内存 hex 模式扫描
# ═══════════════════════════════════════════════════════════════════

def scan_memory_for_hex_keys(data, hex_re, db_files, salt_to_dbs, key_map,
                               remaining_salts, base_addr, pid, print_fn):
    """扫描内存，匹配 hex 模式并用企业微信参数验证密钥。"""
    matches = 0
    for m in hex_re.finditer(data):
        hex_str = m.group(1).decode()
        addr = base_addr + m.start()
        matches += 1
        hex_len = len(hex_str)
        candidates = []
        if hex_len == 32:
            candidates.append((hex_str, None))
        elif hex_len == 64:
            candidates.append((hex_str[:32], hex_str[32:]))
            candidates.append((hex_str, None))
        elif hex_len == 96:
            candidates.append((hex_str[:64], hex_str[64:]))
            candidates.append((hex_str[:32], hex_str[-32:]))
        elif hex_len > 96 and hex_len % 2 == 0:
            candidates.append((hex_str[:64], hex_str[-32:]))
            candidates.append((hex_str[:32], hex_str[-32:]))

        for enc_key_hex, salt_hex in candidates:
            if len(enc_key_hex) not in (32, 64):
                continue
            enc_key = bytes.fromhex(enc_key_hex)
            if salt_hex and salt_hex in remaining_salts:
                for rel, path, sz, s, page1 in db_files:
                    if s == salt_hex:
                        ok, desc = verify_database_key(enc_key, page1)
                        if ok:
                            key_map[salt_hex] = enc_key_hex
                            remaining_salts.discard(salt_hex)
                            break
            elif not salt_hex and remaining_salts:
                for rel, path, sz, salt_hex_db, page1 in db_files:
                    if salt_hex_db in remaining_salts:
                        ok, desc = verify_database_key(enc_key, page1)
                        if ok:
                            key_map[salt_hex_db] = enc_key_hex
                            remaining_salts.discard(salt_hex_db)
                            break
            if not remaining_salts:
                break
    return matches


# ═══════════════════════════════════════════════════════════════════
# Cipher 结构体扫描 (WXWork 5.x 32-bit)
# ═══════════════════════════════════════════════════════════════════

def _find_region(memory_regions, starts, addr, length=4):
    """在内存区域列表中查找指定地址所在的区域"""
    idx = bisect.bisect_right(starts, addr) - 1
    if idx < 0:
        return None
    base, end, data = memory_regions[idx]
    if base <= addr and addr + length <= end:
        return base, end, data
    return None


def _read_u32(memory_regions, starts, addr):
    """从内存读取 32 位无符号整数"""
    region = _find_region(memory_regions, starts, addr, 4)
    if not region:
        return None
    base, _end, data = region
    return struct.unpack_from("<I", data, addr - base)[0]


def _valid_ptr(memory_regions, starts, addr, length=4):
    """验证指针是否指向有效内存区域"""
    return _find_region(memory_regions, starts, addr, length) is not None


def _wxwork_page_size_chain(memory_regions, starts, cipher_addr):
    """Validate the AES cipher object by following the page-size pointer chain."""
    page_size_holder = _read_u32(memory_regions, starts, cipher_addr + 0x30)
    if page_size_holder is None or not _valid_ptr(memory_regions, starts, page_size_holder, 8):
        return None
    page_size_obj = _read_u32(memory_regions, starts, page_size_holder + 4)
    if page_size_obj is None or not _valid_ptr(memory_regions, starts, page_size_obj + 0x24, 4):
        return None
    return _read_u32(memory_regions, starts, page_size_obj + 0x24)


def _record_candidate_key(enc_key, db_files, salt_to_dbs, key_map,
                          remaining_salts, pid, addr, desc, print_fn):
    """记录候选密钥并验证"""
    matched = []
    params_desc = desc
    for rel, path, sz, salt_hex, page1 in db_files:
        if salt_hex not in remaining_salts:
            continue
        ok, verified_desc = verify_database_key(enc_key, page1)
        if ok:
            key_map[salt_hex] = enc_key.hex()
            remaining_salts.discard(salt_hex)
            params_desc = verified_desc or params_desc
            matched.extend(salt_to_dbs[salt_hex])

    return bool(matched)


def scan_memory_for_cipher_structs(h, regions, db_files, salt_to_dbs,
                                    key_map, remaining_salts, pid,
                                    print_fn, max_seconds=120):
    """Scan WXWork heap objects for the in-memory wxSQLite3 AES-128 cipher."""
    t0 = time.time()
    memory_regions = []
    total_bytes = 0
    for base, size in regions:
        data = read_mem(h, base, size)
        if data:
            memory_regions.append((int(base), int(base) + len(data), data))
            total_bytes += len(data)

    memory_regions.sort(key=lambda item: item[0])
    starts = [item[0] for item in memory_regions]

    checked = 0
    ptr_hits = 0
    chain_hits = 0
    key_tests = 0
    page_sizes = {512, 1024, 2048, 4096, 8192, 16384, 32768, 65536}

    for base, end, data in memory_regions:
        max_off = len(data) - 0x40
        off = 0
        while off >= 0 and off < max_off:
            if time.time() - t0 > max_seconds:
                return key_tests

            flag0, flag4 = struct.unpack_from("<II", data, off)
            if flag0 in (1, 2) and flag4 in (1, 2, 4096, 8192, 16384):
                cipher_addr = base + off
                aes_ctx = struct.unpack_from("<I", data, off + 0x2C)[0]
                if _valid_ptr(memory_regions, starts, aes_ctx, 0x40):
                    ptr_hits += 1
                    page_size = _wxwork_page_size_chain(memory_regions, starts, cipher_addr)
                    if page_size in page_sizes:
                        chain_hits += 1
                        enc_key = data[off + 8: off + 24]
                        if enc_key != b"\x00" * 16 and len(set(enc_key)) >= 6:
                            key_tests += 1
                            if _record_candidate_key(
                                enc_key, db_files, salt_to_dbs, key_map,
                                remaining_salts, pid, cipher_addr,
                                f"wxSQLite3 AES-128-CBC, page_size={page_size}",
                                print_fn,
                            ):
                                if not remaining_salts:
                                    return key_tests

            checked += 1
            off += 4

    return key_tests


# ═══════════════════════════════════════════════════════════════════
# 交叉验证
# ═══════════════════════════════════════════════════════════════════

def cross_verify_keys(db_files, salt_to_dbs, key_map, print_fn):
    """用已找到的 key 交叉验证未匹配的 salt。"""
    missing_salts = set(salt_to_dbs.keys()) - set(key_map.keys())
    if not missing_salts or not key_map:
        return
    for salt_hex in list(missing_salts):
        for rel, path, sz, s, page1 in db_files:
            if s == salt_hex:
                for known_salt, known_key_hex in key_map.items():
                    enc_key = bytes.fromhex(known_key_hex)
                    ok, desc = verify_database_key(enc_key, page1)
                    if ok:
                        key_map[salt_hex] = known_key_hex
                        missing_salts.discard(salt_hex)
                break


# ═══════════════════════════════════════════════════════════════════
# 高层 API（独立封装）
# ═══════════════════════════════════════════════════════════════════

def load_keys(keys_file=None):
    """加载已保存的密钥文件

    唯一查找路径：本模块同目录下的 wxwork_keys.json
    不再回退到任何外部项目目录

    Returns: dict {db_name: {"enc_key": hex, "salt": hex}, "_db_dir": path} 或 None
    """
    path = keys_file or _DEFAULT_KEYS_PATH
    if not path or not os.path.isfile(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            keys = json.load(f)
        # 简单校验
        if isinstance(keys, dict) and "_db_dir" in keys:
            return keys
    except (json.JSONDecodeError, OSError):
        return None
    return None


def save_keys(keys, keys_file=None):
    """保存密钥到 JSON 文件（默认保存到 _common/wxwork_keys.json）"""
    if keys_file is None:
        keys_file = _DEFAULT_KEYS_PATH
    tmp_file = keys_file + ".tmp"
    with open(tmp_file, "w", encoding="utf-8") as f:
        json.dump(keys, f, indent=2, ensure_ascii=False)
    try:
        os.chmod(tmp_file, 0o600)
    except OSError:
        pass
    os.replace(tmp_file, keys_file)
    return keys_file


def extract_keys_from_wxwork_process():
    """从 WXWork.exe 进程内存提取密钥

    流程：
    1. auto_detect_wxwork_db_dir() 检测数据库目录
    2. collect_db_files() + filter_encrypted_dbs() 收集加密数据库
    3. get_wxwork_pids() 发现企微进程
    4. OpenProcess + enum_regions() 枚举内存区域
    5. scan_memory_for_hex_keys() hex 模式扫描
    6. scan_memory_for_cipher_structs() cipher 结构体扫描
    7. cross_verify_keys() 交叉验证

    Returns: dict 密钥映射 或 None（企微未运行时）
    """
    db_dir = auto_detect_wxwork_db_dir()
    if not db_dir:
        return None

    db_files, salt_to_dbs = collect_db_files(db_dir)
    db_files, salt_to_dbs = filter_encrypted_dbs(db_files, salt_to_dbs)
    if not db_files:
        return None

    pids = get_wxwork_pids()
    if not pids:
        return None

    hex_re = re.compile(b"x'([0-9a-fA-F]{32,192})'")
    key_map = {}
    remaining_salts = set(salt_to_dbs.keys())
    _noop_print = lambda *a, **kw: None

    for pid, mem_kb in pids:
        h = kernel32.OpenProcess(0x0010 | 0x0400, False, pid)
        if not h:
            continue
        try:
            regions = enum_regions(h)
            for base, size in regions:
                data = read_mem(h, base, size)
                if not data:
                    continue
                scan_memory_for_hex_keys(
                    data, hex_re, db_files, salt_to_dbs,
                    key_map, remaining_salts, base, pid, _noop_print,
                )
                if not remaining_salts:
                    break
            if remaining_salts:
                scan_memory_for_cipher_structs(
                    h, regions, db_files, salt_to_dbs,
                    key_map, remaining_salts, pid, _noop_print,
                )
        finally:
            kernel32.CloseHandle(h)
        if not remaining_salts:
            break

    cross_verify_keys(db_files, salt_to_dbs, key_map, _noop_print)

    if not key_map:
        return None

    # 构造结果（与 wxwork_keys.json 格式一致）
    result = {}
    for rel, path, sz, salt_hex, page1 in db_files:
        if salt_hex in key_map:
            result[rel] = {
                "enc_key": key_map[salt_hex],
                "salt": salt_hex,
                "size_mb": round(sz / 1024 / 1024, 1),
            }
    if not result:
        return None
    result["_db_dir"] = db_dir
    return result


def decrypt_database(db_path, enc_key, salt, output_path=None, use_temp=True):
    """解密单个加密数据库

    逐页 AES-128-CBC 解密（基于 wxSQLite3 公开算法）

    Args:
        db_path: 加密数据库路径
        enc_key: 16字节密钥（hex字符串）
        salt: salt（hex字符串）
        output_path: 输出路径（None则使用临时文件）
        use_temp: 是否使用临时目录

    Returns: 解密后的数据库路径
    """
    if not os.path.isfile(db_path):
        raise FileNotFoundError(f"加密数据库不存在: {db_path}")

    raw_key = bytes.fromhex(enc_key)

    if output_path is None:
        if use_temp:
            output_path = os.path.join(
                tempfile.gettempdir(),
                f"wecom_decrypted_{int(time.time())}_{os.path.basename(db_path)}",
            )
        else:
            output_path = db_path + ".decrypted"

    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    with open(db_path, "rb") as fin, open(output_path, "wb") as fout:
        page_no = 1
        while True:
            page = fin.read(PAGE_SZ)
            if not page:
                break
            if len(page) < PAGE_SZ:
                page += b"\x00" * (PAGE_SZ - len(page))

            if page_no == 1:
                # 第一页：检查是否已解密或解密
                if is_plain_sqlite_page(page):
                    fout.write(page)
                    page_no += 1
                    continue
                # 验证 salt 匹配
                page_salt = page[:SALT_SZ].hex()
                if page_salt != salt:
                    # salt 不匹配，尝试直接解密（可能是 wxSQLite3 AES 模式）
                    pass
                fout.write(decrypt_page_aes128_cbc(raw_key, page, page_no))
            else:
                if is_plain_sqlite_page(page[:16]):
                    # 后续页可能是明文（数据库混合模式），直接写入
                    fout.write(page)
                else:
                    fout.write(decrypt_page_aes128_cbc(raw_key, page, page_no))
            page_no += 1

    return output_path


def decrypt_databases(db_names, keys=None, output_dir=None):
    """批量解密多个数据库

    Args:
        db_names: 需要解密的数据库列表（如 ["message.db", "user.db", "session.db"]）
        keys: 密钥映射（None则自动load_keys或extract_keys_from_wxwork_process）
        output_dir: 输出目录（None则使用 tempfile.gettempdir()/wecom_decrypted_{timestamp}/）

    Returns: dict {db_name: decrypted_path}
    """
    # 加载或提取密钥
    if keys is None:
        keys = load_keys()
        if keys is None:
            keys = extract_keys_from_wxwork_process()
            if keys is None:
                raise RuntimeError(
                    "密钥不可用：wxwork_keys.json 不存在且无法从企微进程内存提取。"
                    "请确保企业微信客户端正在运行。"
                )
            # 保存提取的密钥供下次使用
            try:
                save_keys(keys)
            except OSError:
                pass

    db_dir = keys.get("_db_dir")
    if not db_dir:
        # 从密钥推断 db_dir
        db_dir = auto_detect_wxwork_db_dir()
        if not db_dir:
            raise RuntimeError("无法确定企微数据库目录")

    # 准备输出目录
    if output_dir is None:
        output_dir = os.path.join(
            tempfile.gettempdir(),
            f"wecom_decrypted_{int(time.time())}",
        )
    os.makedirs(output_dir, exist_ok=True)

    result = {}
    for db_name in db_names:
        if db_name not in keys:
            raise KeyError(f"密钥映射中缺少 {db_name} 的密钥信息")

        db_path = os.path.join(db_dir, db_name)
        if not os.path.isfile(db_path):
            raise FileNotFoundError(f"数据库文件不存在: {db_path}")

        enc_key = keys[db_name]["enc_key"]
        salt = keys[db_name]["salt"]
        output_path = os.path.join(output_dir, db_name)

        decrypt_database(db_path, enc_key, salt, output_path=output_path, use_temp=False)
        result[db_name] = output_path

    return result


def cleanup_temp_db(temp_paths):
    """清理临时解密文件（删除文件 + 删除空目录）"""
    if isinstance(temp_paths, str):
        temp_paths = [temp_paths]
    elif isinstance(temp_paths, dict):
        temp_paths = list(temp_paths.values())

    cleaned_files = []
    cleaned_dirs = set()

    for path in temp_paths:
        if not path or not os.path.exists(path):
            continue
        try:
            if os.path.isfile(path):
                os.remove(path)
                cleaned_files.append(path)
                # 尝试删除父目录（如果为空）
                parent = os.path.dirname(path)
                while parent and parent not in cleaned_dirs:
                    try:
                        if os.path.isdir(parent) and not os.listdir(parent):
                            os.rmdir(parent)
                            cleaned_dirs.add(parent)
                            parent = os.path.dirname(parent)
                        else:
                            break
                    except OSError:
                        break
        except OSError:
            pass

    return {"cleaned_files": len(cleaned_files), "cleaned_dirs": len(cleaned_dirs)}


# ═══════════════════════════════════════════════════════════════════
# 模块自检
# ═══════════════════════════════════════════════════════════════════

def _self_test():
    """模块自检：验证密钥加载和数据库目录检测"""
    print("=" * 60)
    print("  wecom_crypto.py 自检（独立实现）")
    print("=" * 60)

    # 1. 数据库目录检测
    db_dir = auto_detect_db_dir()
    print(f"DB_DIR: {db_dir}")
    if not db_dir:
        print("[FAIL] 无法检测企微数据库目录")
        return False

    # 2. 密钥加载
    keys = load_keys()
    if keys:
        print(f"KEYS_LOADED: {len([k for k in keys if k != '_db_dir'])} 个数据库密钥")
        print(f"KEYS_FILE_DB_DIR: {keys.get('_db_dir')}")
        print(f"KEYS_FILE_PATH: {_DEFAULT_KEYS_PATH}")
    else:
        print("KEYS_LOADED: None（需要从进程内存提取）")
        print(f"KEYS_FILE_PATH: {_DEFAULT_KEYS_PATH}")

    # 3. 企微进程状态
    pids = get_wxwork_pids()
    print(f"WXWORK_PIDS: {len(pids)} 个进程")
    for pid, mem in pids:
        print(f"  PID={pid} ({mem // 1024}MB)")

    return True


if __name__ == "__main__":
    _self_test()
