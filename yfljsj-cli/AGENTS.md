# yfljsj CLI — Agent 接入契约

本文档面向 **AI Agent**（Claude / Ponos 等）：说明如何以「子进程调用」方式稳定接入
yfljsj 业务网关 CLI，正确处理输出、退出码与安全约束。**Agent 一律不解析 stderr 做业务判断，
以 stdout JSON + 退出码为准。**

- 可执行文件：`yfljsj-cli/yfljsj.mjs`（单文件、零依赖）
- 调用方式：`node yfljsj-cli/yfljsj.mjs <command> [options]`（工作目录为仓库根即可）

---

## 1. 调用契约（stdout / stderr / 退出码）

| 通道 | 内容 | 用途 |
|---|---|---|
| **stdout** | 单行结构化 JSON（默认 `--json`） | 唯一业务数据来源，必须 JSON.parse |
| **stderr** | 诊断、用法错误提示、discover 代理提示 | 仅日志/排障，**不得**用于业务判断 |
| **退出码** | `0-4`（见下表） | 程序化分支依据 |

**退出码语义（固定契约）：**

| 退出码 | 含义 | Agent 应如何处理 |
|---|---|---|
| `0` | 成功 | 解析 stdout JSON，取 `data` 用 |
| `1` | 业务错误 | 网关/业务拒绝；取 `msg` 反馈给用户，可修正入参重试 |
| `2` | 用法错误 / 安全拒绝 | 命令拼错、缺必填参数、**写操作未 `--confirm`**、域名不在白名单；修正命令后重试 |
| `3` | 认证失败 | 未登录或 token 失效；先 `auth login` 再重试 |
| `4` | 网络错误 | 网关不可达/超时；稍后重试 |

stdout JSON 统一结构：`{"success":bool,"code":0-4,"msg":string,"data":<业务数据|null>}`。

---

## 2. 最小接入流程（Agent 的 checklist）

1. **先确认已登录**：`node yfljsj-cli/yfljsj.mjs auth status`
   - 退出码 `0` → 已登录，继续；
   - 退出码 `3` → 先执行登录（密码/验证码/租户，见下）。
2. **查询类操作**：`<module> <action> [param=value ...]`，无额外确认。
3. **写操作**：必须追加 `--confirm`；删除类再追加 `--force`。
   - 若拒绝（退出码 2 + "需显式确认"），**不要**自行绕过，补上 `--confirm` 重试。
4. **解析**：只读 stdout，`JSON.parse` 后按 `success` / `code` 判断，不要依赖 `msg` 文本匹配。

---

## 3. 命令示例

### 登录（3 种方式，任选其一）

```bash
# ① 密码登录（--password 缺省时交互输入，Agent 场景务必显式传）
node yfljsj-cli/yfljsj.mjs auth login --method password --user admin --password 'xxx'

# ② 验证码登录（先发码再登录）
node yfljsj-cli/yfljsj.mjs auth send-code --user admin
node yfljsj-cli/yfljsj.mjs auth login --method captcha --user admin --code 123456

# ③ 租户登录
node yfljsj-cli/yfljsj.mjs auth login --method tenant --user admin --tenant T001

# 会话状态 / 登出
node yfljsj-cli/yfljsj.mjs auth status
node yfljsj-cli/yfljsj.mjs auth logout
```

### 查询（只读，无确认）

```bash
# 命令表驱动：user 模块 sysUser-page action，分页参数
node yfljsj-cli/yfljsj.mjs user sysUser-page current=1 size=10

# 显式请求体（--data 覆盖命令表参数组装）
node yfljsj-cli/yfljsj.mjs raw /user/sysUser/page --method POST --data '{"current":1,"size":10}'

# 人类可读表格（Agent 解析建议仍用默认 --json）
node yfljsj-cli/yfljsj.mjs user sysUser-page current=1 size=10 --human
```

### 写操作（必须显式确认）

```bash
# 写操作：--confirm 必需
node yfljsj-cli/yfljsj.mjs user sysUser-add userName=wangwu --confirm

# 删除类操作：--confirm 之外还需 --force
node yfljsj-cli/yfljsj.mjs asset building-deleteById id=1001 --confirm --force
```

### 排查命令

```bash
node yfljsj-cli/yfljsj.mjs --help           # 命令树 + 可用模块列表
node yfljsj-cli/yfljsj.mjs --version
```

---

## 4. 安全注意事项（Agent 必须遵守）

- **写操作三原则**：写操作加 `--confirm`；删除类再加 `--force`；
  除非用户明确授权，不得设置 `config set auto-confirm-write true` 绕过确认。
- **域名白名单**：CLI 只允许请求 `*.yfljsj.com` 与 `localhost/127.0.0.1`。
  收到退出码 2 + "域名不在白名单" 时，**不要**尝试改 URL 绕过。
- **敏感信息**：token/密码仅存于 `~/.yfljsj/config.json`（chmod 600）；
  审计日志 `~/.yfljsj/audit.log` 不含任何凭证。输出 token 时注意脱敏（`--human` 已自动脱敏命令表标记字段）。
- **切勿注入凭证到日志/对话**：CLI 的 stdout 不会回显密码，Agent 也不应把 `--password` 值写入审计或回放。

---

## 5. 环境变量（Agent 可覆盖以隔离环境）

| 变量 | 说明 | 场景 |
|---|---|---|
| `YFLJSJ_HOME` | 覆盖配置目录（默认 `os.homedir()`） | 测试隔离，避免污染真实凭证 |
| `YFLJSJ_GATEWAY` | 覆盖网关 baseURL（默认 `https://gateway.yfljsj.com/api`） | 指向测试/模拟网关 |
| `YFLJSJ_INSECURE` | `=1` 关闭 TLS 校验 | 本地自签名 mock，**生产禁开** |

示例（测试隔离）：

```bash
YFLJSJ_HOME=/tmp/yfljsj-agent-test \
YFLJSJ_GATEWAY=https://127.0.0.1:8443 \
YFLJSJ_INSECURE=1 \
node yfljsj-cli/yfljsj.mjs auth login --method password --user admin --password 'x'
```

---

## 6. Ponos / Claude 等 Agent 接入建议

将 CLI 注册为一组 `yfljsj_*` 工具（每个工具 = 一次子进程调用 + 契约解析）：

1. **工具签名（建议）**
   - `yfljsj_auth_status` → `yfljsj.mjs auth status`
   - `yfljsj_auth_login` → `yfljsj.mjs auth login --method <m> --user <u> [--password <p>|--code <c>|--tenant <t>]`
   - `yfljsj_discover` → `yfljsj.mjs discover [--port N]`（交互式，通常由人操作）
   - `yfljsj_raw` → `yfljsj.mjs raw <path> [--method M] [--data 'json'] [--service S]`
   - `yfljsj_call` → `yfljsj.mjs <module> <action> [--param value]... [--confirm] [--force]`
     （命令表驱动的通用调用工具，参数透传）

2. **工具输出处理**
   - 捕获子进程 `stdout`（业务 JSON）与 `exitCode`；`stderr` 仅作日志。
   - 返回给主 Agent 的内容：`{ exitCode, stdout(parsed) }`；`exitCode` 非 0 时把 `msg` 一并返回。

3. **写操作自动加确认**：`yfljsj_call` 工具对写操作统一追加 `--confirm`；
   若 action 名匹配 `delete|remove|batchDelete` 再追加 `--force`（与 CLI 安全规则一致，避免安全拒绝返回）。
   不确定某命令是否写操作时，**先以只读命令确认**（如列表/详情），确认无误再加确认参数。

4. **错误处理策略**
   - `3`（认证失败）→ 调 `yfljsj_auth_login` 重新登录后重试一次，仍失败则中止并报告。
   - `4`（网络错误）→ 等 1-2s 指数退避重试（最多 2 次）。
   - `2`（用法/安全拒绝）→ 修正命令/补确认，不盲目重试。
   - `1`（业务错误）→ 将 `msg` 反馈给用户，避免无意义重试。

5. **命令表来源**：命令表在 `~/.yfljsj/apis.json`（discover 合并产物）与静态 seed
   `yfljsj-cli/apis.seed.json` 中；不确定可用 action 时，跑 `yfljsj --help` 看模块列表，
   或读取 `apis.json` / `apis.seed.json` 的 `modules[<module>].commands[].action` 列表
   （输入不存在的 action 时 CLI 会以退出码 2 报出该模块全部可用 action）。
