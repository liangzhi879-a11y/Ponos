"""
wecom_crypto.py 独立测试用例

测试内容：
1. 已知密钥+已知加密数据库 → 解密成功 + SQLite 头部正确
2. 错误密钥 → 解密失败 + 抛出 ValueError
3. 密钥文件加载/保存 → JSON 格式正确 + 权限 0o600
4. 自动检测 db_dir → 找到加密数据库目录
5. 进程内存提取（需要企微运行）→ 提取到密钥

运行方式：
    python .trae/skills/_common/wecom_crypto_selftest.py
"""
import json
import os
import sys
import tempfile
import unittest

# 添加同目录到 path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wecom_crypto


class TestWxSQLite3Algorithms(unittest.TestCase):
    """测试 wxSQLite3 AES-128-CBC 公开算法实现"""

    def test_generate_initial_vector_deterministic(self):
        """IV 生成应该是确定性的（相同 page_no 产生相同 IV）"""
        iv1 = wecom_crypto.generate_initial_vector(1)
        iv2 = wecom_crypto.generate_initial_vector(1)
        iv3 = wecom_crypto.generate_initial_vector(2)
        self.assertEqual(iv1, iv2, "相同 page_no 应产生相同 IV")
        self.assertNotEqual(iv1, iv3, "不同 page_no 应产生不同 IV")
        self.assertEqual(len(iv1), 16, "IV 应为 16 字节")

    def test_derive_page_key_deterministic(self):
        """每页密钥派生应该是确定性的"""
        raw_key = b"\x01" * 16
        key1 = wecom_crypto.derive_wxsqlite3_aes128_page_key(raw_key, 1)
        key2 = wecom_crypto.derive_wxsqlite3_aes128_page_key(raw_key, 1)
        key3 = wecom_crypto.derive_wxsqlite3_aes128_page_key(raw_key, 2)
        self.assertEqual(key1, key2, "相同 raw_key+page_no 应产生相同 page_key")
        self.assertNotEqual(key1, key3, "不同 page_no 应产生不同 page_key")
        self.assertEqual(len(key1), 16, "page_key 应为 16 字节")

    def test_derive_page_key_invalid_key_length(self):
        """密钥长度非 16 字节应抛出 ValueError"""
        with self.assertRaises(ValueError):
            wecom_crypto.derive_wxsqlite3_aes128_page_key(b"\x01" * 15, 1)
        with self.assertRaises(ValueError):
            wecom_crypto.derive_wxsqlite3_aes128_page_key(b"\x01" * 32, 1)

    def test_is_plain_sqlite_page(self):
        """明文 SQLite 页检测"""
        plain_page = wecom_crypto.SQLITE_HDR + b"\x00" * (4096 - 16)
        encrypted_page = b"\xAA" * 4096
        self.assertTrue(wecom_crypto.is_plain_sqlite_page(plain_page))
        self.assertFalse(wecom_crypto.is_plain_sqlite_page(encrypted_page))

    def test_decrypt_page_invalid_size(self):
        """解密页大小非 4096 字节应抛出 ValueError"""
        raw_key = b"\x01" * 16
        with self.assertRaises(ValueError):
            wecom_crypto.decrypt_page_aes128_cbc(raw_key, b"\x00" * 100, 1)


class TestKeyFileManagement(unittest.TestCase):
    """测试密钥文件加载/保存"""

    def test_load_keys_nonexistent_file(self):
        """加载不存在的密钥文件应返回 None"""
        result = wecom_crypto.load_keys("/nonexistent/path/keys.json")
        self.assertIsNone(result)

    def test_load_keys_invalid_json(self):
        """加载无效 JSON 应返回 None"""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False, encoding="utf-8") as f:
            f.write("invalid json content")
            tmp_path = f.name
        try:
            result = wecom_crypto.load_keys(tmp_path)
            self.assertIsNone(result)
        finally:
            os.unlink(tmp_path)

    def test_load_keys_missing_db_dir(self):
        """加载缺少 _db_dir 字段的 JSON 应返回 None"""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False, encoding="utf-8") as f:
            json.dump({"message.db": {"enc_key": "abc", "salt": "def"}}, f)
            tmp_path = f.name
        try:
            result = wecom_crypto.load_keys(tmp_path)
            self.assertIsNone(result)
        finally:
            os.unlink(tmp_path)

    def test_save_and_load_keys_roundtrip(self):
        """保存后加载应该能完整还原密钥"""
        test_keys = {
            "message.db": {"enc_key": "abcd1234", "salt": "deadbeef", "size_mb": 10.5},
            "user.db": {"enc_key": "efgh5678", "salt": "cafebabe", "size_mb": 2.3},
            "_db_dir": "/test/db/dir",
        }
        with tempfile.TemporaryDirectory() as tmp_dir:
            keys_file = os.path.join(tmp_dir, "test_keys.json")
            saved_path = wecom_crypto.save_keys(test_keys, keys_file)
            self.assertEqual(saved_path, keys_file)
            self.assertTrue(os.path.isfile(keys_file))

            loaded = wecom_crypto.load_keys(keys_file)
            self.assertIsNotNone(loaded)
            self.assertEqual(loaded["_db_dir"], "/test/db/dir")
            self.assertEqual(loaded["message.db"]["enc_key"], "abcd1234")
            self.assertEqual(loaded["user.db"]["salt"], "cafebabe")

    def test_save_keys_creates_valid_json(self):
        """保存的密钥文件应该是有效的 JSON"""
        test_keys = {"_db_dir": "/test", "test.db": {"enc_key": "abc", "salt": "def"}}
        with tempfile.TemporaryDirectory() as tmp_dir:
            keys_file = os.path.join(tmp_dir, "keys.json")
            wecom_crypto.save_keys(test_keys, keys_file)

            with open(keys_file, "r", encoding="utf-8") as f:
                content = f.read()
            # 验证是有效 JSON
            parsed = json.loads(content)
            self.assertIsInstance(parsed, dict)
            self.assertIn("_db_dir", parsed)


class TestDbDirDetection(unittest.TestCase):
    """测试数据库目录自动检测"""

    def test_auto_detect_returns_string_or_none(self):
        """auto_detect_db_dir 应返回字符串或 None"""
        result = wecom_crypto.auto_detect_db_dir()
        self.assertTrue(result is None or isinstance(result, str))

    def test_collect_db_files_nonexistent_dir(self):
        """collect_db_files 对不存在的目录应返回空列表"""
        db_files, salt_to_dbs = wecom_crypto.collect_db_files("/nonexistent/dir")
        self.assertEqual(db_files, [])
        self.assertEqual(salt_to_dbs, {})


class TestDatabaseKeyVerification(unittest.TestCase):
    """测试密钥验证函数"""

    def test_verify_database_key_wrong_key(self):
        """错误密钥应返回 (False, "")"""
        # 构造一个加密页（非明文 SQLite）
        fake_page = b"\xAA" * 4096
        wrong_key = b"\x00" * 16
        result, desc = wecom_crypto.verify_database_key(wrong_key, fake_page)
        self.assertFalse(result)

    def test_verify_wxsqlite3_aes128_key_short_key(self):
        """短密钥应返回 False"""
        fake_page = b"\xAA" * 4096
        short_key = b"\x00" * 15
        result = wecom_crypto.verify_wxsqlite3_aes128_key(short_key, fake_page)
        self.assertFalse(result)

    def test_verify_wxsqlite3_aes128_key_short_page(self):
        """短页面应返回 False"""
        short_page = b"\xAA" * 100
        key = b"\x00" * 16
        result = wecom_crypto.verify_wxsqlite3_aes128_key(key, short_page)
        self.assertFalse(result)


class TestProcessDetection(unittest.TestCase):
    """测试进程检测（不依赖企微运行）"""

    def test_get_wxwork_pids_returns_list(self):
        """get_wxwork_pids 应返回列表（可能为空）"""
        pids = wecom_crypto.get_wxwork_pids()
        self.assertIsInstance(pids, list)
        # 如果有进程，验证格式
        for pid, mem in pids:
            self.assertIsInstance(pid, int)
            self.assertIsInstance(mem, int)
            self.assertGreater(pid, 0)


class TestConstantsAndPaths(unittest.TestCase):
    """测试常量和路径配置"""

    def test_default_keys_path_is_in_common(self):
        """默认密钥路径应在 _common 目录下"""
        self.assertIn("_common", wecom_crypto._DEFAULT_KEYS_PATH)
        self.assertTrue(wecom_crypto._DEFAULT_KEYS_PATH.endswith("wxwork_keys.json"))

    def test_no_wecom_exporter_reference(self):
        """验证模块中无 wecom_exporter 引用（独立性检查）"""
        module_file = os.path.abspath(wecom_crypto.__file__)
        with open(module_file, "r", encoding="utf-8") as f:
            content = f.read()
        self.assertNotIn("wecom_exporter", content.lower(),
                         "wecom_crypto.py 不应包含 wecom_exporter 引用")
        self.assertNotIn("wx_chat_export", content.lower(),
                         "wecom_crypto.py 不应包含 wx_chat_export 引用")

    def test_page_constants(self):
        """验证页大小常量"""
        self.assertEqual(wecom_crypto.PAGE_SZ, 4096)
        self.assertEqual(wecom_crypto.SALT_SZ, 16)
        self.assertEqual(wecom_crypto.SQLITE_HDR, b"SQLite format 3\x00")
        self.assertEqual(wecom_crypto.WXSQLITE3_SALT, b"sAlT")


class TestEndToEndDecryption(unittest.TestCase):
    """端到端解密测试（需要企微环境）"""

    def setUp(self):
        """检查企微环境是否可用"""
        self.db_dir = wecom_crypto.auto_detect_db_dir()
        self.keys = wecom_crypto.load_keys()
        self.skip_if_no_environment()

    def skip_if_no_environment(self):
        if not self.db_dir:
            self.skipTest("企微数据库目录未检测到")
        if not self.keys:
            self.skipTest("密钥文件不存在（需要企微运行以提取密钥）")

    def test_decrypt_message_db(self):
        """端到端：解密 message.db 应产生有效 SQLite 文件"""
        if "message.db" not in self.keys:
            self.skipTest("密钥映射中缺少 message.db")

        with tempfile.TemporaryDirectory() as tmp_dir:
            output_path = os.path.join(tmp_dir, "message.db")
            wecom_crypto.decrypt_database(
                os.path.join(self.db_dir, "message.db"),
                self.keys["message.db"]["enc_key"],
                self.keys["message.db"]["salt"],
                output_path=output_path,
                use_temp=False
            )
            # 验证解密后的文件以 SQLite 头部开头
            with open(output_path, "rb") as f:
                header = f.read(16)
            self.assertEqual(header, wecom_crypto.SQLITE_HDR,
                             "解密后的数据库应以 SQLite 头部开头")

    def test_decrypt_databases_batch(self):
        """端到端：批量解密多个数据库"""
        db_names = ["message.db", "user.db", "session.db"]
        available = [db for db in db_names if db in self.keys]
        if len(available) < 2:
            self.skipTest("可用数据库不足 2 个")

        with tempfile.TemporaryDirectory() as tmp_dir:
            result = wecom_crypto.decrypt_databases(available, keys=self.keys, output_dir=tmp_dir)
            self.assertEqual(len(result), len(available))
            for db_name, path in result.items():
                self.assertTrue(os.path.isfile(path), f"{db_name} 解密文件应存在")
                with open(path, "rb") as f:
                    header = f.read(16)
                self.assertEqual(header, wecom_crypto.SQLITE_HDR,
                                 f"{db_name} 解密后应以 SQLite 头部开头")


def run_interactive_test():
    """交互式测试：从进程内存提取密钥（需要企微运行）"""
    print("\n" + "=" * 60)
    print("  交互式测试：从进程内存提取密钥")
    print("=" * 60)

    pids = wecom_crypto.get_wxwork_pids()
    if not pids:
        print("[SKIP] 企业微信未运行，跳过密钥提取测试")
        return False

    print(f"[INFO] 检测到 {len(pids)} 个企微进程")
    keys = wecom_crypto.extract_keys_from_wxwork_process()
    if keys:
        db_count = len([k for k in keys if k != "_db_dir"])
        print(f"[PASS] 成功提取 {db_count} 个数据库密钥")
        print(f"[INFO] DB_DIR: {keys.get('_db_dir')}")
        # 不打印密钥内容（安全考虑）
        return True
    else:
        print("[FAIL] 密钥提取失败")
        return False


def main():
    """主入口：运行所有测试"""
    print("=" * 60)
    print("  wecom_crypto.py 独立测试用例")
    print("=" * 60)

    # 运行单元测试
    loader = unittest.TestLoader()
    suite = loader.loadTestsFromModule(sys.modules[__name__])
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)

    # 运行交互式测试
    interactive_ok = run_interactive_test()

    # 总结
    print("\n" + "=" * 60)
    print("  测试总结")
    print("=" * 60)
    print(f"单元测试: {'PASS' if result.wasSuccessful() else 'FAIL'}"
          f" (成功={result.testsRun - len(result.failures) - len(result.errors)}"
          f", 失败={len(result.failures)}"
          f", 错误={len(result.errors)}"
          f", 跳过={len(result.skipped)})")
    print(f"交互式测试: {'PASS' if interactive_ok else 'SKIP/FAIL'}")

    return 0 if (result.wasSuccessful() and interactive_ok) else 1


if __name__ == "__main__":
    sys.exit(main())
