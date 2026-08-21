请修复以下问题（来自真实开源项目 sympy/sympy 的 issue）。

## 问题描述

Rational calc value error
python 3.11, sympy 1.11.1
when calc Rational('0.5', '100'), the value is 1/100100; but Rational(0.5, 100) the value is 1/200, this value is the true value, and the version of sympy 1.8 is normal

## 要求

- 只修改源代码，修复问题描述中的 bug。
- 不要修改测试文件；测试由评测系统独立运行。
- 修复后如果方便，可以运行相关测试验证（例如 `python -m pytest <测试文件>`）。
- 项目为 Python 项目，源码在仓库根目录，可直接 `python -c "import <包名>"` 验证。
- 完成后用一句话总结你的修改。
