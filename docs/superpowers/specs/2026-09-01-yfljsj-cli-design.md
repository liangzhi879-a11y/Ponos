# yfljsj CLI 全量封装设计（2026-09-01）

## 1. 背景与目标

深圳市远方数据技术有限公司平台（前端 `www.yfljsj.com`，网关 `gateway.yfljsj.com`）是一套
功能完整的企业管理系统：高企管理、研发费用、成果转化、人事薪酬、资产管理、凭证管理、
租户管理、工作台等 12 大模块。用户需要将其**全量封装为纯标准 CLI**：

1. **纯标准 CLI**：Node.js 单文件、零依赖，任何 agent 可通过 shell 子进程调用
2. **读写全做**：覆盖全部业务模块的查询与写操作
3. **多认证保留**：密码 / 验证码 / 租户 3 种登录 + refresh-token 自动续期
4. **命令形态**：层级子命令（`yfljsj <module> <action>`）+ 默认 JSON 输出（agent 友好）

## 2. 已探明的平台架构

| 项 | 值 | 来源 |
|---|---|---|
| 前端 | Vue 3 + Element UI SPA | `www.yfljsj.com`，JS bundle 逆向 |
| 网关 | `https://gateway.yfljsj.com` | axios baseURL 提取 |
| 微服务 | `/api/oauth`（认证）、`/api/upms`（用户权限）、`/api/rcms`（业务主服务） | axios 实例提取 |
| 登录 | `POST /api/oauth/auth/login`，body `{loginMethod, ...}`（1=密码 2=验证码 3=租户） | 网关探测 |
| 刷新 | `POST /api/oauth/auth/refresh-token` | 网关探测 |
| 登出 | `POST /api/oauth/auth/logout` | JS 提取 |
| 响应 | 统一 `{success, code, msg, data, timestamp}` | 网关实测 |
| 认证 | JWT（accessToken + refreshToken + tenantId） | JS 提取 |

**关键发现**：前端 JS 中 API 请求路径是动态拼接（`GO(instance, path)` 传变量），
**无法从静态 JS 一次性提取完整接口清单**。12 模块 × 读写 = 数百接口，逐个手写不现实。
→ 采用**运行时代理捕获**（discover）生成命令表。

## 3. 总体架构

```
yfljsj.mjs（单文件，零依赖，node 直跑）
├── CLI 入口（参数解析）
├── 命令路由（module/action 匹配）
├── 认证模块（3 种登录 + token 管理 + refresh 续期）
├── 通用命令执行器（命令表 apis.json 驱动）
├── 接口发现（discover 代理捕获）
└── 输出格式化（JSON 默认 / --human 表格）

数据流：
  认证 → token 存储(~/.yfljsj/config.json) → 请求自动带 token → 401 时 refresh 续期
  命令 → 查命令表 → 拼 URL → 发请求 → JSON 输出
  发现 → 本地代理捕获浏览器真实请求 → 生成/合并 apis.json
```

### 核心设计决策

1. **单文件零依赖**：纯 Node 内置模块（https/fs/readline），与 Ponos 内核哲学一致
2. **命令表驱动**：`apis.json` 描述接口映射，通用执行器按表执行，避免数百命令手写
3. **运行时发现**：discover 代理捕获解决接口清单问题，可增量扩充
4. **agent 契约**：stdout 纯 JSON + 退出码语义化 + stderr 诊断，任何 agent 可 shell 调用

## 4. 认证模块

### 4.1 三种登录方式

```
yfljsj auth login --method password --user <手机号> --password <密码>
yfljsj auth login --method captcha --user <手机号> --code <验证码>
yfljsj auth login --method tenant --user <手机号> --tenant <租户ID>
```

- `--password` 缺省时交互输入（readline 隐藏回显，不 echo、不落盘）
- 验证码方式支持 `yfljsj auth send-code`（前端发送验证码接口，discover 后入表）

### 4.2 Token 存储与管理

`~/.yfljsj/config.json`（chmod 600）：
```json
{
  "accessToken": "jwt...",
  "refreshToken": "jwt...",
  "tenantId": "xx",
  "expiresAt": 1788222223,
  "userInfo": { "id": "...", "name": "..." }
}
```

- **自动续期**：请求前检查 `expiresAt`（<5min 或 401）→ refresh-token → 更新存储 → 重试
- **并发安全**：单 in-flight refresh promise，后续请求 await 复用
- **登出**：调 logout + 清本地 token

### 4.3 退出码契约（agent 友好）

| 场景 | 退出码 | stdout |
|---|---|---|
| 成功 | 0 | `{"success":true,"data":...}` |
| 业务错误 | 1 | 透传网关 `{success:false,code,msg}` |
| 用法错误 | 2 | `{"success":false,"code":"USAGE_ERROR",...}` |
| 认证失败 | 3 | `{"success":false,"code":"AUTH_REQUIRED",...}` |
| 网络错误 | 4 | `{"success":false,"code":"NETWORK_ERROR",...}` |

## 5. 命令执行器 + 接口发现

### 5.1 命令表（~/.yfljsj/apis.json）

```json
{
  "version": 1,
  "capturedAt": 1788222223,
  "services": {
    "oauth": "https://gateway.yfljsj.com/api/oauth",
    "upms": "https://gateway.yfljsj.com/api/upms",
    "rcms": "https://gateway.yfljsj.com/api/rcms"
  },
  "modules": {
    "hitech": {
      "title": "高企管理",
      "commands": [
        {
          "action": "declare-list",
          "method": "GET",
          "path": "/highTechMgr/declareMgr/page",
          "params": { "current": "number", "size": "number", "status": "string" },
          "desc": "高企申报分页列表",
          "kind": "read"
        }
      ]
    }
  }
}
```

### 5.2 通用命令执行器

`yfljsj <module> <action> [--param value]...`：
1. 查命令表匹配 action
2. 校验必填参数（params 声明类型）
3. 拼 URL：`services[service] + path`（service 缺省 rcms）
4. 带 token 发请求（GET→query / POST/PUT→body JSON）
5. 输出：`--json`（默认）原样透传；`--human` 表格化

参数传递：标量 `--key value`；复杂 JSON `--data '{"k":"v"}'`。
未知命令 → 模糊提示相似命令 → 兜底 `yfljsj raw <path>`。

### 5.3 接口发现（discover）

`yfljsj discover [--port 8899]`：
1. 启动本地 HTTP 代理（监听 8899）
2. 用户浏览器代理指向 `127.0.0.1:8899`，在已登录前端操作各模块
3. 代理透传 `gateway.yfljsj.com`，记录 method+path+请求/响应体样例
4. Ctrl+C 结束 → 按路径前缀聚合模块 → 生成/合并 apis.json
5. 输出统计：N 接口 / M 模块 / 待复核项

**为什么代理而非静态抓 JS**：捕获真实 API 调用（路径/方法/参数样例全），
比逆向混淆 bundle 可靠；用户操作一遍 = 全量接口自动入表；可增量补录。
参数语义（必填/枚举）经样例启发式生成，标 `NEEDS_REVIEW` 待人工复核。

### 5.4 模块骨架（discover 前预置，立即可用）

```
hitech   高企管理（board/declareMgr/highMgr/psMgr）
research 研发费用（budgetManagement/in/out/pay/subject）
tech     成果转化（articleMgr/evaluateMgr/registManagement/report）
hr       人事薪酬（member/org/role/salary/attn）
asset    资产管理（build/cap/equip/intangible）
voucher  凭证管理（list/detail/special/subjectInit）
tenant   租户管理（tenantMgr/groupMgr/orgView）
config   配置（hr/salary/project/risk）
workbench 工作台（projectList/welcome）
```

每个骨架含 2-4 个核心命令（list/detail），discover 后扩满。

## 6. Agent 接入与安全

### 6.1 Agent 接入

```bash
node /opt/yfljsj/yfljsj.mjs hitech declare-list --current 1 --size 10
# → stdout: {"success":true,"data":{...}}

node /opt/yfljsj/yfljsj.mjs research in --data '{"amount":1000,"subject":"材料费"}'
# → stdout: {"success":true,"data":{...}}
```

- stdout 只含 JSON（诊断走 stderr）
- 退出码 0/1/2/3/4 语义化（见 4.3）
- 纯 CLI 天然兼容所有 agent（Ponos 注册为 `yfljsj_*` 工具 / Claude Code Bash 调用 / 自研框架子进程），无需 MCP

### 6.2 安全设计

| 项 | 措施 |
|---|---|
| 敏感信息 | token/密码仅存 `~/.yfljsj/config.json` chmod 600；密码永不落盘 |
| 敏感输出 | 命令表可标 `sensitive: true` 字段，--human 脱敏 |
| 写操作 | 命令表分 read/write；写操作默认需 `--confirm`/`--yes`；delete 需 `--force`；`yfljsj config set auto-confirm-write` 可调 |
| 网络 | 仅连接白名单 `*.yfljsj.com`（防 SSRF）；支持 HTTPS_PROXY |
| 审计 | 每次请求写 `~/.yfljsj/audit.log`（时间戳+命令+路径+方法，不含 token/密码） |

### 6.3 分发

- 单文件 `yfljsj.mjs` → 任意目录/PATH
- `alias yfljsj='node /opt/yfljsj/yfljsj.mjs'`
- Windows 同 node 直跑（跨平台）

### 6.4 不做（YAGNI）

- 不做 MCP server（用户明确选纯 CLI）
- 不做 OAuth 网页授权流（平台无此机制）
- 不做交互式 TUI（--human 表格足够）
- 不做多租户并行会话管理（单账号单租户）

## 7. 测试

- **认证**：mock 网关（本地 https server）验证 3 种登录、token 存储、refresh 续期、401 重试、并发 refresh 单飞
- **命令执行器**：mock 命令表 + mock 网关，验证参数拼接、JSON 输出、退出码
- **discover**：mock 代理捕获流程（本地 server 模拟浏览器请求）
- **agent 契约**：退出码矩阵测试（0/1/2/3/4）
- 命令：`node --test tests/`（Node 原生测试，零依赖）

## 8. 验收标准

1. `yfljsj auth login` 三种方式均可用（密码/验证码/租户），token 持久化 + 自动续期
2. `yfljsj <module> <action>` 命令表驱动，读写命令可用，JSON 输出
3. `yfljsj discover` 代理捕获真实接口，生成命令表
4. 退出码契约稳定（agent 可依赖）
5. 写操作需确认，delete 需 --force；审计日志留痕
6. 单文件零依赖，跨平台 node 直跑
7. 全量测试通过
