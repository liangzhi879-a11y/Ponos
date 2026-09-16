# 工作目录选择器资源管理器化 —— 实施计划

- 关联清单：`P1` 工作目录的选择，要接近 win 资源管理器形态（含快捷入口），用户上手难度低
- 设计：`docs/superpowers/specs/2026-09-15-workdir-picker-design.md`
- 状态：已实施（各步验证结果见文末"执行记录"）

## 步骤（每步含验证方式）

| # | 步骤 | 产出 | 验证 |
|---|---|---|---|
| 1 | 新增 `/known-folders` 端点 | `server/bridge.mjs`：导入 `homedir`，实现端点，只回真实存在目录 | `node --check server/bridge.mjs`；起服务 `curl /known-folders` 看返回且**不含**不存在项 |
| 2 | 纯逻辑层 | `src/lib/dirPicker.ts`：`normalizePath` / `breadcrumbSegments` / `foldBreadcrumb` / `initHistory·pushHistory·goBack·goForward·canGo*·currentPath` / `normalizeFolders` / `cleanPathInput` / `isSameOrUnder` | `node --test src/lib/dirPicker.test.ts` 全绿 |
| 3 | 逻辑层测试 | `src/lib/dirPicker.test.ts` 覆盖 A2/A3/A5/A6 + 脏数据归一 + 边界 | 同上；失败即改 |
| 4 | UI 改造 | `src/components/chat/DirectoryPicker.tsx`：左导航窗格（快捷入口+盘符，可折叠）、←→↑ 工具条、面包屑⇄可编辑地址栏、错误条保持当前目录、中文文案 | `npm run typecheck`；`npm run build` |
| 5 | 回归 | 4 处调用方 props 不变（`{value,onChange,onClose}`） | `grep` 调用点；typecheck 通过 |
| 6 | 全量门禁 | — | `npm test`（对照基线 2832 pass） |
| 7 | 同步 release | `release/YFWorking/server/bridge.mjs` + `dist/` | `diff` 核验；确认 bundle 名与 `known-folders` 已进 release |
| 8 | 回写清单 | `docs/待处理清单.md` 勾选 + 证据 | 人工核对 |

## 风险与对策

| 风险 | 对策 |
|---|---|
| 端点列出**不存在**的目录（服务器常无"音乐/视频"）→ 用户点了报错 | `existsSync` + `statSync().isDirectory()` 双筛，单项异常 `catch` 跳过不影响其余 |
| 渲染层拼路径（`C:/Users/.../Desktop`）在非 C 盘/非英文用户名/Mac/Linux 上必错 | 路径一律由 bridge 用 `homedir()`+`join` 算出（D1） |
| 手输错路径把当前目录弄丢（最难恢复） | 跳转失败**只写错误条**、不碰 `entries/parent/loaded`，"当前目录不变"结构上成立（A4/D5） |
| 面包屑过深把末级挤出可视区 | `foldBreadcrumb` 保留"首级 + … + 末两级"（A6/D6） |
| 与既有 4 处调用方耦合 | props 契约不变；类型检查把"改坏调用点"变成编译错误 |
| 逻辑写进 `.tsx` 无法被 `node --test` import | 逻辑全部落 `src/lib/dirPicker.ts`（D3） |
| 重复跳同一路径撑满历史 | `pushHistory` 对同路径返回原状态；历史上限 100 并保 `index` 指栈顶 |

## 执行记录（实际证据）

- 步骤 1：`node --check server/bridge.mjs` 通过；端点见 `server/bridge.mjs`（`homedir` 导入 + `/known-folders`）。
- 步骤 2–3：`node --test src/lib/dirPicker.test.ts` → **17 pass / 0 fail**（含一次修正：测试自身漏写 `.map` 导致误判，已修）。
- 步骤 4–5：`npm run typecheck` 零错误；`npm run build` 成功；`DirectoryPicker.tsx` 580 行，11 个逻辑函数全部接线，props 未变。
- 步骤 6：`npm test` → **2852 tests / 2851 pass / 0 fail / 1 skipped**（唯一 skip 为既有跳过项；期间出现 2 例 Windows 临时目录 teardown flake，单跑均通过，非本改动引入）。
- 步骤 7：`diff server/bridge.mjs release/YFWorking/server/bridge.mjs` 差异确认**仅本改动**（`homedir` + `/known-folders`），已同步。
- 步骤 8：清单回写。
