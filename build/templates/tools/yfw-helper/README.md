# yfw-helper

YFWorking 内置命令行工具：文件批量处理、校验、格式转换。

## 用法

```bash
node yfw-helper hash <dir>              # 计算目录下所有文件 SHA-256
node yfw-helper rename <dir> <from> <to> # 批量替换文件名（带 .bak 备份）
node yfw-helper count <dir>             # 统计目录文件数与总大小
node yfw-helper help                    # 显示帮助
```

## 适用场景

- 申报材料批量规范化命名
- 大批量文件 SHA-256 校验（确保未损坏）
- 目录体积盘点（评估上传/打包需求）

## 特性

- rename 始终先做 `.bak` 备份，出问题可回滚
- count 递归遍历（含子目录）
- 不依赖任何第三方包（仅 Node.js 内置 fs/crypto/path）