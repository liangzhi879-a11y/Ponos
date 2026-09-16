# 实施计划：应用及密码管理库（v1）

- spec：`docs/superpowers/specs/2026-09-15-password-vault-design.md`
- 原则：每步可独立验证；先核心后界面；失败即停（不推进下一步掩盖问题）
- **状态：Step 1–8 已执行完毕**（含一轮独立安全审查后的整改），验收结果见文末。

## Step 1 — 核心模块 `electron/vault.cjs` ✅

- [x] `createVault({ home, crypto, now? })`，`crypto = { isAvailable(), encryptString, decryptString }`（依赖注入，D10）
- [x] `status()` / `list()` / `upsert(input)` / `remove(id)` / `reveal(id)`
- [x] 原子写（tmp + rename + 回读校验，D5）+ **语义级回读**（密文能解回原文才算写成功）
- [x] fail-closed（D2，含 Linux `basic_text` 假可用）+ 损坏不覆盖（D6）+ 日志不落明文（D8）
- 验证：`node --test electron/vault.test.mjs` → 17 pass

## Step 2 — 单测 `electron/vault.test.mjs` ✅

- [x] CRUD 往返、id 生成与稳定性、`createdAt` 保持
- [x] **磁盘字节不含明文**（逐字节断言，A1）
- [x] 加密不可用 → 报错且**不产生**文件（A2）
- [x] 写失败不破坏旧库（A3）+ 空密文/解不回 → 放弃写入
- [x] 损坏文件 → 报错且**原字节不变**、不返回空库（A4）
- [x] `list()` 不含 password（A5）
- [x] 错误信息不泄漏密码（A6/§7）
- [x] 回归：形状不符条目 / 版本不认识 / `password:null` / 读取失败非 ENOENT / basic_text

## Step 3 — IPC + preload ✅

- [x] `electron/vault-ipc.cjs`：`registerVaultHandlers(...)`，6 条通道（§5）
- [x] `electron/main.cjs`：require + 注册（传 `safeStorage` + `resolveYfwHome()` + `clipboard`）
- [x] `electron/preload.cjs`：独立 `yfworkingVault` 命名空间
- [x] 剪贴板定时清空：只在内容未变时清（A7）；`unref()` 不吊住进程
- 验证：`electron/vault-ipc.test.mjs` → 12 pass

## Step 4 — 渲染层数据层 `src/lib/vaultApi.ts`（+ `.test.ts`）✅

- [x] 类型 + 响应校验（不信任 bridge 形状）+ 失败分类（无 bridge / 不可用 / 损坏 / io）
- [x] 逻辑落 `.ts`（D9）；`.tsx` 只做展示
- 验证：`src/lib/vaultApi.test.ts` → 13 pass（含一处真实 bug 修复：no-host 列表结果缺 `entries` 会让 UI 崩）

## Step 5 — UI：密码库面板 ✅

- [x] `src/components/vault/VaultPanel.tsx`：列表 + 搜索 + 新增/编辑 + 删除确认 + 复制 + 逐条显示
- [x] 默认不显示明文；显示后 20s 自动隐藏；复制提示"将于 N 秒后清空剪贴板"
- [x] 挂载到个人信息窗口（`ProfileWindowRoot`）作标签页：个人信息 / 密码库
- [x] 失败态与空库严格区分（unavailable / corrupt 给不同引导）
- 验证：`npm run typecheck` 零错误 + `npm run build` 通过

## Step 6 — 接线守卫测试 ✅

- [x] `electron/vault-ipc.test.mjs` 内含源码级守卫：main.cjs 注册且传 safeStorage、preload 暴露 6 方法、
      UI 不直连 bridge / 不 console / 编辑留空密码必须**省略字段**（传 `''` 会清空已存密码）
- [x] 守卫只看**代码**（`codeOf()` 剥注释），避免注释里的话造成假红

## Step 7 — 质量门禁与同步 ✅

- [x] `npm run typecheck` 零错误
- [x] `npm test` 全量：**2812 tests / 2810 pass / 1 skipped（既有）/ 1 fail**
      —— 唯一 fail 为 `kernel-tests/engine-ask-user.test.mjs:152` 的 `rmSync` **Windows 临时目录清理 flake**
      （EPERM；单跑 3/3 通过；未改任何 kernel 代码，与本次无关）
      基线对照：改动前 2769 pass，本次净增 42 个新测试
- [x] `npm run build` 通过
- [x] 同步 `release/YFWorking/`：`electron/{vault,vault-ipc,main,preload}.cjs` + 新 bundle

## Step 8 — 清单回写 ✅

- [x] 在 `docs/待处理清单.md` 对应条目追加实现记录与证据
- [x] 未决项 Q1（主密码/可移植层，**需用户拍板**）与 Q2（API Key 迁移）已写明

---

## 独立安全审查后的整改（reviewer 子代理）

审查独立复现出 **1 处真实数据丢失路径**，已修并加回归测试：

| 编号 | 问题 | 处置 |
|---|---|---|
| H1 | `filter(isEntryShaped)` 静默丢弃不合形状条目，`list` 仍 `ok:true`，随后任一次 upsert 把"被截断的库"写回 → 条目**永久消失** | 形状不符 ⇒ `corrupt` + 拒绝写回；并补 `env.v` 校验 |
| M1 | 新增时 `password:null` 被 `String()` 存成字面量 `"null"` | 非字符串 ⇒ `invalid` |
| M2 | 空密文仍报成功并 rename 覆盖 → 好库换成解不开的坏库 | 空密文 ⇒ `io`；再加语义级回读 |
| L1 | `existsSync` 吞错，EACCES 被当"空库"→ 可覆盖原文件 | 改 `statSync`，仅 `ENOENT` 算不存在 |
| L2 | 读文件失败被归 corrupt，UI 引导误导 | 读失败 ⇒ `io` |
| L3 | 旧条目缺 `password` → `undefined` 落盘、错误码错 | `keep.password ?? ''` |
| M3 | Linux `basic_text` 后端"假可用" | 明确报该后端 ⇒ 判不可用（与 D2 一致） |

**未修（明确记录）**：M4（剪贴板历史/云同步标记，需实机验证 API）、L5（字段长度上限）、
L6（退出前清剪贴板）、L10（io 三档文案、tags 重复 key、loading 期可否新增）。
