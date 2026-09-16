# 应用及密码管理库（Password Vault）设计

- 关联清单条目：`P1` 建立应用及密码管理库，保存用户用到的账号密码
- 日期：2026-09-15
- 状态：v1 设计（已实现核心；主密码/可移植性层为**未决项**，见 §8）

---

## 1. 背景与现状（实测，非假设）

| 事实 | 证据 |
|---|---|
| 应用**没有任何静态加密能力** | 全仓 `safeStorage` / `encryptString` / `decryptString` / `keytar` 零命中 |
| 模型供应商 API Key 目前**明文存 localStorage** | `src/stores/settingsStore.ts:64 apiKey` + `persist({ name: 'yfworking-settings' })`（zustand persist → localStorage） |
| 应用数据根已有单一解析源 | `server/yfw-home.cjs resolveYfwHome()`（`YFWORKING_HOME` → `CLAUDE_CONFIG_DIR` → `~/.yfworking`） |
| 已有日志脱敏模块 | `kernel/redact.mjs redactText/redactEntry` |
| 个人信息窗口的"密码"**不是**本任务对象 | `ProfileWindowRoot.tsx` 改的是**应用登录口令**（`/api/auth/change-password`，盐 + 哈希），与"用户在各站点/应用的账号密码"无关 |

**结论**：这是一个从零开始的能力，且顺带暴露了一个既有安全债（API Key 明文）。v1 先建**通用密钥库地基**，API Key 迁移列为非目标（§6）。

## 2. 威胁模型

**要防的**
- T1 本机落盘文件被人拿到（备份、同步盘、误拷、其它软件扫描）→ 密文不可直接读。
- T2 应用自身日志/崩溃转储泄密 → 明文不得进日志。
- T3 界面肩窥与误粘贴 → 默认不显示明文、剪贴板定时清空。
- T4 写入过程被中断 → 不得产生半截文件（否则表现为"库空了"）。
- T5 静默降级 → 任何"加密不可用"都不允许退化成明文落盘。

**明确不防的（写下来比默默不防重要）**
- N1 已取得当前 OS 用户会话的攻击者：DPAPI/Keychain 由 OS 解锁，同账户进程可解密。这是"OS 绑定方案"的固有边界。
- N2 内存取证（解密后条目在 main 进程内存中）。
- N3 用户自己的屏幕录像/恶意输入法。
- N4 换机/换 OS 账户后无法解密（§8 未决项的根因）。

## 3. 关键决策

| # | 决策 | 理由 |
|---|---|---|
| D1 | 静态加密**只用** OS 能力（Electron `safeStorage`：Windows DPAPI / macOS Keychain / Linux libsecret），**不自研 AES+KDF** | 自研密钥派生与分组模式是同类应用的主要失血点；OS 方案由系统托管密钥生命周期 |
| D2 | **fail-closed**：`safeStorage.isEncryptionAvailable()` 为假时**拒绝存储/读取**并显式报错，绝不回退明文 | T5。宁可"用不了"，不可"以为加密了其实没有"——后者会让用户继续往里放密码 |
| D3 | 全部密码学与文件 IO 在**主进程**；渲染进程只经 IPC 取数据 | 密文与密钥不进入渲染进程（无 XSS/注入面）；与既有 `app-*` IPC 体例一致 |
| D4 | **整库单块加密**（整份 JSON → 一次 `encryptString`），非逐字段 | 落盘不留任何明文字段（连条目标题都不留）；库小（KB 级），全量重写代价可接受 |
| D5 | 原子写：临时文件 + `rename` + **回读校验** | T4。半截文件在读取侧会被误判为"库损坏/库空" |
| D6 | 损坏/无法解密 → **显式报错且绝不覆盖原文件** | 防止一次误判把用户全部密码清空（不可恢复） |
| D7 | 明文只在两处短暂出现：显式"显示"（按住/点击）与复制到剪贴板；**剪贴板定时清空**（默认 30s，且只在内容未变时清） | T3 |
| D8 | 日志只记 id/计数/错误码，不记字段值 | T2 |
| D9 | 前端逻辑落 `.ts`、UI 落 `.tsx` | 仓库既定纪律：`.tsx` 无法被 `node --test` import，逻辑放 `.tsx` 会失去单测 |
| D10 | 加密器**依赖注入**（`createVault({ home, crypto })`），不在模块内直接 `require('electron')` | 单测（`node --test`，无 Electron）可覆盖 CRUD/原子写/损坏恢复/不可用分支；同时避免 `require('electron')` 在非 Electron 进程里抛错 |

## 4. 数据格式

落盘 `<YFW_HOME>/vault.enc`（UTF-8 JSON 信封，**外壳不含任何秘密**）：

```json
{
  "v": 1,
  "scheme": "electron-safe-storage",
  "updatedAt": "2026-09-15T12:00:00.000Z",
  "cipher": "<base64 of safeStorage.encryptString(JSON.stringify({ entries: [...] }))>"
}
```

解密后的明文结构（仅存在于主进程内存）：

```json
{ "entries": [
  { "id": "…", "name": "某某系统", "url": "https://…", "username": "…",
    "password": "…", "notes": "…", "tags": ["工作"],
    "createdAt": "…", "updatedAt": "…" }
] }
```

- `v` + `scheme` 是为**未来加入主密码/可移植方案**留的迁移位（§8）：新方案写 `scheme: "master-key-v2"`，读取侧按 `scheme` 分派，老库照旧可读、可按需迁移。
- 信封给 `scheme` 而非全密文的意义：加密不可用（D2）与文件损坏是**两种不同故障**，外壳可读才分得清、才能给出可执行提示。

## 5. IPC 面（最小集）

| 通道 | 语义 | 返回 |
|---|---|---|
| `vault:status` | 加密可用性 + 条目数 | `{ ok, available, count, error? }` |
| `vault:list` | 列表（**不含 password**） | `{ ok, entries: [ …无 password… ] }` |
| `vault:upsert` | 新增/更新（带明文 password） | `{ ok, entry(无 password), error? }` |
| `vault:remove` | 删除 | `{ ok, error? }` |
| `vault:reveal` | **单条**取明文密码 | `{ ok, password, error? }` |
| `vault:copy` | 复制到剪贴板 + 定时清空 | `{ ok, clearInMs, error? }` |

`list` **刻意不下发 password**（默认不可见，符合 T3 最小暴露）；`reveal` 逐条按需取。这是"泄漏面随需求放大，而非默认放大"。

## 6. 非目标（v1 不做，避免范围蔓延）

1. **不迁移** provider API Key（localStorage → 库）。它需要动 `settingsStore` 的同步读取路径（大量调用点），属独立一轮。
2. 不做主密码/跨机可移植（§8）。
3. 不做浏览器扩展/自动填充（涉及外部进程与权限，另立项）。
4. 不做密码强度审计/弱密码扫描/泄露库比对。
5. 不写任何用户站点（不代登录）。

## 7. 验收标准

- A1 加密可用时：增删改查往返一致；`vault.enc` 全文**不含**任何明文密码/用户名（逐字节 grep 断言）。
- A2 加密不可用时：`upsert` 返回明确错误，**且不产生** `vault.enc`（fail-closed，D2）。
- A3 写入中断安全：写入失败不破坏既有库（旧内容仍可读）。
- A4 损坏文件：`list` 返回错误并保留原文件字节不变；**不得**返回"空库"。
- A5 `vault:list` 响应中不含 `password` 字段。
- A6 主进程日志路径下不出现明文密码。
- A7 剪贴板在 TTL 后清空（内容未变时）；内容已被用户改掉时不覆盖用户剪贴板。

## 8. 未决项（需用户确认，故清单不勾"全部完成"之外的语义）

**Q1：是否需要"主密码 + KDF"层（跨机可移植）？**
- 现状（D1/D2）库绑定本机 OS 账户：换机、换 OS 账户、重装系统后将**无法解密**——这是 DPAPI/Keychain 方案的固有属性，不是缺陷，但用户必须知情。
- 若需要可移植：加一层用户主密码（Argon2id/scrypt + AES-GCM），`scheme` 升 `master-key-v2`，信封分派读取，老库可迁移。**代价**：忘记主密码 = 数据永久丢失（无任何后门），且需自研密钥派生（与 D1 的取舍相反）。
- **倾向**：保持 OS 绑定（更安全、零自研密码学），并补"加密备份导出/导入"（导出仍是密文、仍绑定本机，仅防误删）；跨机需求用"明文导出 + 用户自担风险"或后续高版本方案。**此项需用户拍板。**

**Q2：AI/API Key 是否也纳入库管理（含明文存量清理）？** 见 §6.1，建议下一轮单独做。

---

## 9. 实现记录

见 `docs/superpowers/plans/2026-09-15-password-vault.md`（步骤 + 每步验证）。
