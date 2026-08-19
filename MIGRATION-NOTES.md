# 迁移说明（2026-08-19）

YFWorking 开发目录由 `claude-code-gui` 迁出到本目录（`yfworking-dev`），作为**净室重建工作区**。

## 迁移了什么

- 自研代码：`src/`（GUI 渲染层）、`electron/`（主进程 + 浏览器执行器）、`server/`（bridge + python 工具）、`pet/`（桌面宠物）、`build/`、`scripts/`、`bin/`
- 资源与文档：`public/`、`docs/`（含 **docs/bridge-contract.md 桥接契约**、产品手册、历史方案）
- 配置：`package.json`、`package-lock.json`、`electron-builder.yml`、`vite.config.ts`、`tsconfig*.json`、`tailwind.config.ts`、`postcss.config.js`、`index.html`、`skills-lock.json`、`BUILD.md`、`FREEZE-INVESTIGATION.md`

## 刻意未迁移（合规隔离）

- **`yfw-kernel/claude-code/`** —— Anthropic 专有代码的泄漏副本，净室工作区不携带（法律风险隔离）
- `release/`（旧目录运行副本继续在旧位置工作）、`dist/`、`node_modules/`、`node.exe`、`.env`（含密钥，勿迁移）、调试临时目录

## 开发运行方式（关键）

应用运行时需要内核（bun + cli.mjs）。本目录无内核，启动前必须指定：

```bash
# Windows cmd
set YFWORKING_KERNEL=C:\Users\T203-15\claude-code-gui\yfw-kernel\claude-code\dist\cli.mjs
npm run dev
```

或由 bridge 的 `bootstrapKernelToUserDir` 从已知位置自动拷贝内核到 `~/.yfworking/runtime/`（需内核可达）。

## 打包调整点（本目录暂无内核，打包前需处理）

- `electron-builder.yml:77-80`：`from: yfw-kernel/claude-code/dist` 打包内核 —— 路径在本目录不存在
- `scripts/verify-permission-flow.mjs:15`：`yfw-kernel/claude-code/dist/cli.mjs` 路径
- 方案：待净室内核落地后改为新路径；过渡期可临时指向旧仓库内核（仅内部使用）

## 净室注意

- 新目录内禁止拷贝内核源码/产物作为代码依赖；bridge 契约（`docs/bridge-contract.md`）是重建的对照基线
- 提示词、消息类型名等跨层契约形状保留是协议需要；实现内部的模块划分、算法、提示词需原创
