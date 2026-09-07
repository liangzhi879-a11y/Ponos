"""path_config.py 独立性回归测试（v1.1.0）

测试项：
1. 项目根目录推断正确
2. 模板目录存在
3. 技能目录包含 gxtz-* 子目录
4. 锁目录可创建
5. 环境变量覆盖优先级
6. 独立性测试：path_config.py 不含 "T203-15" 字符串
7. 企业数据目录函数（v1.1.0 新增）：默认返回 None，环境变量覆盖生效

用法：
    python path_config_selftest.py
"""
import os
import sys
import unittest
import tempfile

# 添加同目录到 path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import path_config


class TestPathConfigBasics(unittest.TestCase):
    """基础路径推断测试"""

    def test_project_root_inferred_correctly(self):
        """项目根目录推断正确（应包含 .trae/skills/_common）"""
        root = path_config.get_project_root()
        root_str = str(root)
        # 项目根目录应该存在
        self.assertTrue(root.exists(), f"项目根目录不存在: {root}")
        # 项目根目录下应有 .trae/skills/_common 结构
        common_dir = root / ".trae" / "skills" / "_common"
        self.assertTrue(common_dir.exists(), f"_common 目录不存在: {common_dir}")

    def test_common_dir_equals_module_dir(self):
        """_common 目录应等于本模块所在目录"""
        expected = os.path.dirname(os.path.abspath(path_config.__file__))
        actual = str(path_config.get_common_dir())
        # Windows 下 Path.resolve() 可能返回大写盘符，os.path.abspath 可能返回小写盘符
        # 使用 os.path.normcase 进行大小写无关比较
        self.assertEqual(os.path.normcase(os.path.normpath(actual)),
                         os.path.normcase(os.path.normpath(expected)))


class TestPathConfigDirs(unittest.TestCase):
    """目录存在性测试"""

    def test_template_dir_exists(self):
        """模板目录应存在（00 高新模板（全））"""
        template_dir = path_config.get_template_dir()
        self.assertTrue(template_dir.exists(),
                        f"模板目录不存在: {template_dir}，请检查项目根目录推断")

    def test_skills_dir_contains_gxtz(self):
        """技能目录应包含 gxtz-* 子目录"""
        skills_dir = path_config.get_skills_dir()
        self.assertTrue(skills_dir.exists(), f"技能目录不存在: {skills_dir}")
        gxtz_dirs = [d for d in skills_dir.iterdir()
                     if d.is_dir() and d.name.startswith("gxtz-")]
        self.assertGreater(len(gxtz_dirs), 0,
                           f"技能目录下未找到 gxtz-* 子目录: {skills_dir}")

    def test_lock_dir_creatable(self):
        """锁目录应可创建（如不存在则创建）"""
        lock_dir = path_config.get_lock_dir()
        try:
            lock_dir.mkdir(parents=True, exist_ok=True)
            self.assertTrue(lock_dir.exists(), f"锁目录创建失败: {lock_dir}")
        except PermissionError:
            self.skipTest(f"无权限创建锁目录: {lock_dir}")

    def test_config_path_wecom_config(self):
        """配置文件路径应指向 _common 下的 wecom_config.json"""
        config_path = path_config.get_config_path("wecom_config.json")
        self.assertTrue(config_path.exists(),
                        f"wecom_config.json 不存在: {config_path}")
        self.assertIn("_common", str(config_path))


class TestEnvironmentVariableOverride(unittest.TestCase):
    """环境变量覆盖优先级测试"""

    def setUp(self):
        """保存原始环境变量"""
        self._orig_env = {}
        for var in ["GXTZ_PROJECT_ROOT", "GXTZ_TEMPLATE_DIR",
                    "GXTZ_SKILLS_DIR", "GXTZ_LOCK_DIR",
                    "GXTZ_ENTERPRISE_DATA_DIR"]:
            self._orig_env[var] = os.environ.get(var)

    def tearDown(self):
        """恢复原始环境变量"""
        for var, val in self._orig_env.items():
            if val is None:
                os.environ.pop(var, None)
            else:
                os.environ[var] = val

    def test_env_var_override_template_dir(self):
        """环境变量 GXTZ_TEMPLATE_DIR 应覆盖默认值"""
        with tempfile.TemporaryDirectory() as tmpdir:
            os.environ["GXTZ_TEMPLATE_DIR"] = tmpdir
            result = path_config.get_template_dir()
            self.assertEqual(str(result), tmpdir)

    def test_env_var_override_skills_dir(self):
        """环境变量 GXTZ_SKILLS_DIR 应覆盖默认值"""
        with tempfile.TemporaryDirectory() as tmpdir:
            os.environ["GXTZ_SKILLS_DIR"] = tmpdir
            result = path_config.get_skills_dir()
            self.assertEqual(str(result), tmpdir)

    def test_env_var_override_lock_dir(self):
        """环境变量 GXTZ_LOCK_DIR 应覆盖默认值"""
        with tempfile.TemporaryDirectory() as tmpdir:
            os.environ["GXTZ_LOCK_DIR"] = tmpdir
            result = path_config.get_lock_dir()
            self.assertEqual(str(result), tmpdir)

    def test_enterprise_data_dir_default_none(self):
        """企业数据目录默认应返回 None（v1.1.0 新增）"""
        # setUp 已保存并清空环境变量，确保默认返回 None
        os.environ.pop("GXTZ_ENTERPRISE_DATA_DIR", None)
        result = path_config.get_enterprise_data_dir()
        self.assertIsNone(result, "未设置环境变量时 get_enterprise_data_dir() 应返回 None")
        # 字符串便捷函数应返回空字符串
        result_str = path_config.get_enterprise_data_dir_str()
        self.assertEqual(result_str, "", "未设置环境变量时 get_enterprise_data_dir_str() 应返回空字符串")

    def test_env_var_override_enterprise_data_dir(self):
        """环境变量 GXTZ_ENTERPRISE_DATA_DIR 应覆盖默认值（v1.1.0 新增）"""
        with tempfile.TemporaryDirectory() as tmpdir:
            os.environ["GXTZ_ENTERPRISE_DATA_DIR"] = tmpdir
            result = path_config.get_enterprise_data_dir()
            self.assertIsNotNone(result, "设置环境变量后应返回非 None")
            self.assertEqual(str(result), tmpdir)
            # 字符串便捷函数应返回完整路径
            result_str = path_config.get_enterprise_data_dir_str()
            self.assertEqual(result_str, tmpdir)


class TestIndependence(unittest.TestCase):
    """独立性测试（关键：不含硬编码个人路径）"""

    def test_no_hardcoded_t203_15(self):
        """path_config.py 不应包含 'T203-15' 硬编码字符串"""
        module_file = os.path.abspath(path_config.__file__)
        with open(module_file, "r", encoding="utf-8") as f:
            content = f.read()
        self.assertNotIn("T203-15", content,
                         "path_config.py 不应包含 T203-15 硬编码字符串")

    def test_no_hardcoded_username(self):
        """path_config.py 不应包含 'C:\\Users\\' 硬编码路径"""
        module_file = os.path.abspath(path_config.__file__)
        with open(module_file, "r", encoding="utf-8") as f:
            content = f.read()
        # 允许在注释中出现作为示例，但代码中不应硬编码
        # 检查是否在非注释行中出现
        for line_num, line in enumerate(content.split("\n"), 1):
            stripped = line.strip()
            if stripped.startswith("#") or stripped.startswith('"""') or stripped.startswith("'''"):
                continue
            if 'C:\\\\Users\\\\' in line or 'C:/Users/' in line:
                self.fail(f"第 {line_num} 行包含硬编码用户路径: {line}")


class TestStringConvenienceFunctions(unittest.TestCase):
    """字符串便捷函数测试"""

    def test_str_functions_return_strings(self):
        """字符串便捷函数应返回 str 类型"""
        self.assertIsInstance(path_config.get_project_root_str(), str)
        self.assertIsInstance(path_config.get_template_dir_str(), str)
        self.assertIsInstance(path_config.get_skills_dir_str(), str)
        self.assertIsInstance(path_config.get_lock_dir_str(), str)

    def test_str_and_path_consistent(self):
        """字符串函数与 Path 函数应返回一致结果"""
        self.assertEqual(path_config.get_project_root_str(),
                         str(path_config.get_project_root()))
        self.assertEqual(path_config.get_template_dir_str(),
                         str(path_config.get_template_dir()))
        self.assertEqual(path_config.get_skills_dir_str(),
                         str(path_config.get_skills_dir()))
        self.assertEqual(path_config.get_lock_dir_str(),
                         str(path_config.get_lock_dir()))


def run_tests():
    """运行所有测试"""
    loader = unittest.TestLoader()
    suite = unittest.TestSuite()

    # 加载所有测试类
    test_classes = [
        TestPathConfigBasics,
        TestPathConfigDirs,
        TestEnvironmentVariableOverride,
        TestIndependence,
        TestStringConvenienceFunctions,
    ]

    for test_class in test_classes:
        tests = loader.loadTestsFromTestCase(test_class)
        suite.addTests(tests)

    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)

    print("\n" + "=" * 60)
    print("path_config_selftest.py 测试总结")
    print("=" * 60)
    print(f"运行测试: {result.testsRun}")
    print(f"成功: {result.testsRun - len(result.failures) - len(result.errors)}")
    print(f"失败: {len(result.failures)}")
    print(f"错误: {len(result.errors)}")
    print(f"跳过: {len(result.skipped) if hasattr(result, 'skipped') else 0}")

    return result.wasSuccessful()


if __name__ == "__main__":
    success = run_tests()
    sys.exit(0 if success else 1)
