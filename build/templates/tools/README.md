# YFWorking 内置工具库

本目录存放 YFWorking 内置 CLI 工具。agent 通过 `~/.yfworking/tools/<name>/` 路径调用。

## 当前内置工具

| 工具名 | 用途 | 调用方式 |
|--------|------|----------|
| `yfw-helper` | 文件批量处理（重命名/校验/格式转换） | `node ~/.yfworking/tools/yfw-helper/index.mjs --help` |

## 安装更多工具

YFWorking 工具可以通过以下途径获取：
- 某些 skill  内置 binary（如 `yfwx-seal-extract` 自带 `make-look-scanned.exe`）
- 通过 `yfw-helper` 安装第三方 CLI（参考 `--help`）
- 手动放置可执行文件到本目录，并在 `agent.md` 中声明工具描述

## 自定义工具

每个工具一个子目录：
```
~/.yfworking/tools/<your-tool>/
├── tool.exe (或 tool.mjs / tool.sh)
├── README.md
└── LICENSE
```

agent 路由时会扫描本目录，按工具 `README.md` 中的描述与 agent 需求匹配。