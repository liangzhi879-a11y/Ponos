# yfljsj CLI

yfljsj 业务网关命令行客户端。命令表驱动：`<module> <action>` 直接映射网关 REST 接口，
覆盖 31 个业务模块、535 条命令，零第三方依赖（仅 Node 内置模块），单文件分发。

- 运行：`node yfljsj.mjs <command> [options]`
- 当前版本：0.5.0
- 语言：Node.js ≥ 18（仅使用内置模块，无 npm 安装要求）

---

## 安装

CLI 是一个零依赖的 Node 单文件，无需构建、无需安装依赖。

**方式一：直接运行**

```bash
node yfljsj.mjs --help
```

**方式二：加 alias（推荐，日常使用）**

```bash
# bash / zsh
alias yfljsj='node /path/to/ponos-dev/yfljsj-cli/yfljsj.mjs'

# 之后直接
yfljsj --help
yfljsj auth login --method password --user admin --password 'xxx'
```

**方式三：复制到 PATH**

```bash
cp yfljsj.mjs /usr/local/bin/yfljsj
chmod +x /usr/local/bin/yfljsj   # 或 node 直跑
```

---

## 命令树

```
yfljsj <command> [options]

auth
  auth login   --method password|captcha|tenant --user X
               (--password P | --code C | --tenant T)
  auth logout
  auth status
  auth send-code --user X

discover
  discover [--port 8899]        代理捕获浏览器请求，接口补漏并合并命令表

config
  config set <key> <value>      写配置项（如 auto-confirm-write true|false）
  config get <key> / config list

raw
  raw <path> [--method POST] [--data 'json'] [--service rcms]

schema
  schema <module> <action>      查看命令完整字段定义（类型/必填/枚举/来源/占位说明）

relations
  relations [对象]              查看业务对象关联图谱（子对象、外键 via、创建顺序）

explore
  explore <path> [--dry-run] [--method POST] [--service rcms] [--module M]
                                交互式探测接口必填字段（可写入命令表）

doc
  doc [手册名]                   查看完整操作手册（步骤 + 示例命令）

命令表驱动
  <module> <action> [--param value]...

通用
  --help / --version
```

**通用选项**

| 选项 | 说明 |
|---|---|
| `--json` | JSON 输出（默认） |
| `--human` | 表格输出（数组字段自动表头；命令表标 `sensitive` 的字段脱敏） |
| `--confirm` / `--yes` | 写操作显式确认（`kind=write` 必需） |
| `--force` | 删除/移除类操作额外强制确认 |
| `--data 'json'` | 显式请求体（覆盖命令表参数组装） |

**31 个模块**（可用 `yfljsj --help` 实时查看）：

```
asset achievement human resefunds workbench voucher enterprise reference notice
financial role permission sys datastat tech material humanManagement group declare
tenant file dictionary subject-init dp risk dept user personnel merchant income priAdmin
```

每个模块下若干 `action`（如 `user sysUser-page`、`user sysUser-add`）。
未知模块/action 会以退出码 2 报出可用列表。

---

## 登录（3 种方式）

token 保存在 `~/.yfljsj/config.json`（chmod 600）；登录成功即完成鉴权，
后续命令自动携带 token，过期前（5 分钟）自动 refresh 续期（`/auth/refresh-token`，401 时自动重试一次）。

**① 密码登录（loginMethod=1）**

```bash
# 显式传密码
yfljsj auth login --method password --user admin --password 'your-pass'

# 不传 --password 时进入交互式隐藏输入（不回显）
yfljsj auth login --method password --user admin
```

**② 验证码登录（loginMethod=2）**

```bash
# 先发验证码
yfljsj auth send-code --user admin

# 再用验证码登录
yfljsj auth login --method captcha --user admin --code 123456
```

**③ 租户登录（loginMethod=3）**

```bash
yfljsj auth login --method tenant --user admin --tenant T001
```

**会话管理**

```bash
yfljsj auth status            # 查看当前登录状态与过期时间
yfljsj auth logout            # 登出并清空本地 token
```

---

## discover：接口补漏

`discover` 启动一个本地 HTTP 代理（默认端口 8899），捕获浏览器对前端网关的真实请求，
把静态命令表（`apis.seed.json`）里缺失的接口合并写回用户命令表 `~/.yfljsj/apis.json`。

```bash
yfljsj discover                # 默认 8899 端口
yfljsj discover --port 9000    # 自定义端口
```

用法：

1. 运行 `yfljsj discover`，终端提示代理地址 `http://127.0.0.1:8899`。
2. 把前端网关 baseURL 指向该地址（如原 `https://gateway.yfljsj.com` → `http://127.0.0.1:8899`）。
3. 在浏览器里操作前端各业务模块，`discover` 逐请求捕获 method/path/body 样例。
4. 操作完成后 `Ctrl+C`，代理自动合并（按 path 去重，不重复）并写回 `~/.yfljsj/apis.json`，
   打印统计：`捕获 N 接口、M 模块、新增 K 条命令`。

合并后的命令表优先于静态 seed 生效（`~/.yfljsj/apis.json` 存在即优先加载）。

---

## raw：兜底原始调用

不查命令表，按 `path + method + data + service` 直接发认证请求：

```bash
yfljsj raw /user/sysUser/page --method POST --data '{"current":1,"size":10}'
yfljsj raw /order/list --method GET --service rcms
```

- `path`：以 `/` 开头的接口路径（相对服务前缀）。
- `--service`：目标服务前缀（`oauth` / `upms` / `rcms`，默认 `rcms`），拼成
  `https://gateway.yfljsj.com/api/<service><path>`。
- 同样走认证 / 白名单 / 审计安全钩子。

---

## schema / relations / explore / doc：字段级四件套

命令表 v2 为每条命令沉淀了字段级元数据。四个子命令分别从「字段 / 图谱 / 操作序列」三个视角
查看命令与接口，适合在 `<module> <action>` 调用之前做参数准备（`schema` 看字段 → `relations`
看图谱 → `doc` 看操作序列）。

### schema：查看命令字段定义

```bash
yfljsj schema <module> <action>
yfljsj schema workbench projectAppro-add
```

逐行输出每个字段的：类型（`number`/`string`/`boolean`）、必填/可选、中文描述、枚举取值
（`= a|b`）、字段来源（`← <来源>`）与自动注入标记（`[自动注入]`）：

```
命令: projectAppro-add (POST /workbench/projectAppro/add) [write]
字段:
  projectId          number   必填 项目ID ← projectInfo-list.id
  headPerson         string   必填 项目负责人姓名 ← user/sysUser/getUserList.username
  techEconTarget     number   必填 主要技术经济目标 = 1|3
  planFile           string   必填 计划任务书路径（无文件传占位）
  ...
```

### relations：查看业务对象关联图谱

```bash
yfljsj relations              # 列出所有业务对象
yfljsj relations project      # 查看 project 对象图谱
```

输出对象 → 子对象（外键 `via` 指向）与创建顺序，帮助理解对象间主外键关系与建单先后。

### doc：查看完整操作手册

```bash
yfljsj doc                    # 列出所有手册
yfljsj doc createProject      # 查看「创建研发项目（含立项）」手册
```

手册输出分步操作序列（每步标注对应 `<module> <action>`）与示例命令，是整条业务链的操作总览。

### explore：交互式字段探测

```bash
yfljsj explore <path> [--dry-run] [--method POST] [--service rcms] [--module M]
yfljsj explore /workbench/projectAppro/add --dry-run
```

对未知/新增接口：发空请求 → 读校验报错解析必填字段 → 逐轮补齐迭代（最多 5 轮），
把探测结果写入用户命令表 `~/.yfljsj/apis.json`（`--dry-run` 只探测不写入）。

---

## 命令表 v2：字段定义约定

命令表（静态 seed `apis.seed.json` + 用户表 `~/.yfljsj/apis.json`，用户表优先）中，
每条命令除 `method` / `path` / `kind` 外，`params` 为字段级定义，供 `schema` 展示与参数组装消费：

| 属性 | 含义 | 示例 |
|---|---|---|
| `type` | 字段类型 `number` / `string` / `boolean` | `{ type: 'number' }` |
| `required` | `true` 必填 / `false` 可选 | `{ required: true }` |
| `desc` | 中文描述（含取值与占位说明） | `{ desc: '计划任务书路径（无文件传占位）' }` |
| `enum` | 允许取值枚举，schema 显示为 `= a|b` | `{ enum: [1, 3] }` |
| `source` | 字段来源 `← <来源>`：值应取自来源命令的返回字段 | `{ source: 'projectInfo-list.id' }` |
| `auto` | `true` 表示 CLI 自动注入（如 `tenantId` 从登录态填充），用户无需传 | `{ auto: true }` |
| `sensitive` | `--human` 输出脱敏 | 密码 / 手机号 |

- **source 用法**：如 `projectId ← projectInfo-list.id`，表示取值应先跑 `workbench projectInfo-list`
  取返回 `data` 中的 `id` 填入，而非随意编造；来源命令自身若也有 `source` 则递归向上取数。
- **占位规则**：`desc` 注明「无文件传占位」的字段（如 `planFile` / `resolveFile`），
  没有真实文件时传占位字符串即可，不必卡在取文件上。

---

## 配置

配置存于 `~/.yfljsj/config.json`（chmod 600，与 token 同文件）。

```bash
yfljsj config list                          # 查看全部配置
yfljsj config get auto-confirm-write        # 读单项
yfljsj config set auto-confirm-write true   # 写单项（true/false/数字 自动类型归一）
```

当前配置项：

| 键 | 类型 | 说明 |
|---|---|---|
| `auto-confirm-write` | boolean | `true` 时写操作免 `--confirm`（默认不开启，需显式设置） |

---

## 退出码

| 退出码 | 含义 | 典型场景 |
|---|---|---|
| `0` | 成功 | 业务成功 / `--help` / `--version` |
| `1` | 业务错误 | 网关返回 `success:false` 或非 2xx（业务拒绝、HTTP 500/404 等） |
| `2` | 用法错误 | 未知命令/模块/action、缺必填参数、`--method` 非法、**安全拒绝**（写操作未确认、域名不在白名单） |
| `3` | 认证失败 | 未登录 / token 无效 / 401（refresh 后仍 401） |
| `4` | 网络错误 | 连接失败、超时、TLS 校验失败等 |

---

## 输出格式

- **stdout**：默认输出单行 JSON（`--json`）。成功与失败均输出结构化 JSON，形如
  `{"success":true|false,"code":0|1|2|3|4,"msg":"...","data":...}`。
- **stderr**：诊断信息、用法错误提示、discover 代理提示，全部走 stderr，不影响 stdout 解析。
- **--human**：数组 `data` 渲染为表格（自动表头）；命令表标记 `sensitive` 的字段（如密码、手机号）
  在 `--human` 下脱敏显示（`--json` 保留原始数据，供程序消费）。

示例：

```bash
$ yfljsj user sysUser-page current=1 size=10
{"success":true,"code":0,"msg":"ok","data":[{"userId":"U1","userName":"zhangsan",...}]}

$ yfljsj user sysUser-page current=1 size=10 --human
+--------+----------+---------------------+
| userId | userName | email               |
+--------+----------+---------------------+
| U1     | zhangsan | zhangsan@yfljsj.com |
+--------+----------+---------------------+
```

---

## 安全

- **写操作需显式确认**：命令表 `kind=write` 的命令必须加 `--confirm`（或 `--yes`），
  否则拒绝（退出码 2）；`delete`/`remove`/`batchDelete` 类命令还需额外 `--force`。
  也可 `config set auto-confirm-write true` 全局免确认（慎用）。
- **域名白名单（防 SSRF）**：请求目标仅允许 `*.yfljsj.com` 与回环地址
  （`localhost` / `127.0.0.1` / `::1`，供本地测试 mock），其余一律拒绝（退出码 2）。
- **审计日志**：每次请求追加到 `~/.yfljsj/audit.log`，记录时间戳、命令、路径、方法，
  **绝不记录 token / 密码**；审计失败不阻断请求。
- **敏感字段脱敏**：`--human` 输出对命令表标记为 `sensitive` 的字段打码。
- **本地凭证保护**：`~/.yfljsj/config.json` 以 0600 权限写入（POSIX 生效；Windows 尽力而为）。

---

## 环境变量

| 变量 | 说明 |
|---|---|
| `YFLJSJ_HOME` | 覆盖配置目录（默认 `os.homedir()`），测试隔离用；配置/凭证落 `<home>/.yfljsj/` |
| `YFLJSJ_GATEWAY` | 覆盖网关 baseURL（默认 `https://gateway.yfljsj.com/api`） |
| `YFLJSJ_INSECURE` | `=1` 时关闭 TLS 证书校验（本地自签名 mock 用，生产勿开） |

---

## 常见用法示例

```bash
# 查询分页列表（命令表驱动）
yfljsj user sysUser-page current=1 size=10

# 写操作（必须显式确认）
yfljsj user sysUser-add userName=wangwu --confirm

# 删除操作（额外 --force；如 asset building-deleteById）
yfljsj asset building-deleteById id=U9 --confirm --force

# 显式请求体（--data 覆盖命令表参数）
yfljsj user sysUser-page --data '{"current":1,"size":20}'

# 查看可用模块与命令
yfljsj --help
# 输入不存在的 action 时，报错信息会列出该模块的可用 action（退出码 2）
yfljsj user no-such-action
```

> 自动续期说明：token 到期前 5 分钟触发 `/auth/refresh-token` 续期（并发单飞，
> 同一时刻只发一个 refresh 请求）；续期后 401 自动重试一次，仍 401 则退出码 3。

---

## 目录结构

```
yfljsj-cli/
├── yfljsj.mjs         # CLI 主文件（单文件、零依赖）
├── apis.seed.json     # 静态命令表 seed（535 命令 / 31 模块）
├── scripts/           # 命令表生成脚本（gen-apis.mjs 等）
├── tests/             # 测试（auth / cli / discover / security / gen-apis）
├── README.md          # 本文档
└── AGENTS.md          # agent 接入契约（供 Claude / Ponos 等 agent 使用）
```
