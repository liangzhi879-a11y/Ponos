# 2026-08-18 browser-iter2：浏览器工具结构性升级（7 痛点 → 6 升级项）

依据：gsxt 端到端实测暴露的 7 痛点（用户定级）。目标：登录会话恢复、菜单树展开、下载 PDF、
抓 RD 附件、落盘 5 个关键操作各 ≤3 次原生工具调用，全程文件路径可见。
范围已与用户对齐：全部 6 项 + GUI 状态胶囊退出关闭；下载可见化只做 agent 可见层（不做 GUI 面板）；
登录过期 = 检测+事件上报，由 agent 自行点击"重新登录"。

## 架构决策（与既有代码衔接）

- **P0-1 下载模块**：`BrowserExecutor` 维护按会话下载注册表
  `this.downloads = Map<url, {filename, path, size, received, status, startedAt}>`；
  `createDownloadHandler` 挂 item `updated`/`done` 事件驱动状态（completed/cancelled/interrupted）；
  `snapshot()` 把注册表并入 `buildSnapshot` 的 `downloads` 字段（agent 可见，含文件名/路径/大小/状态）。
  既有 `{type:'download', path}` 事件保留；`closeSession` 清空该会话注册表。
- **P0-2 + P1-1 js 动作**：`browser js "表达式"`。page-context wrapper 归一化结果：
  ArrayBuffer/TypedArray/DataView → `{__br_type:'binary', size, b64}`（≤512KB 内联 base64 回传，
  更大由主进程写入临时文件返回 `{__br_type:'file', path}`）；DOM 元素 → 摘要对象；
  Map/Set → 数组；循环引用 → 深度上限截断；异常 → `{ok:false, error}`。
  `webContents.executeJavaScript` 本身 await promise；wrapper 内 `await (${expression})` 统一处理。
  **安全边界**：js 只能在导航白名单内页面执行（导航本身已被 isBlockedUrl 门控），与 click/type 同信任域，
  无需额外门控。
- **P1-2 a 标签下载语义**：collector 对 `role==='link'` 节点按 href 特征（`download` 属性 /
  `download|attachment` 路径 / `.pdf .docx .xlsx .zip` 扩展名）标 `node.download=true`，
  buildSnapshot 交互条目加 `download:true` 标记；`click` 命中 download 链接 → `webContents.downloadURL(href)`
  真导航 + 等待注册表新条目（≤15s）；`setWindowOpenHandler` 拦截全部 window.open：
  download 类 URL → downloadURL 路由（堵住"新窗口下载静默丢失"），其余 deny（agent 用 goto 处理）。
- **P2-1 会话保活**：collector 复用 bodyText 计算 `logged_in`：含 退出/注销/logout → true；
  含 请登录/未登录/操作超时/登录已过期 → false；否则 null。`snapshot()` 检测过期文本
  （操作超时|未登录|登录已过期）→ 一次性 status 事件上报（幂等标记，不刷屏）。
- **P2-2 loading 修正**：去掉"存在 spinner class 即 loading"误报，改为
  `readyState !== 'complete' || 存在可见 spinner`（getBoundingClientRect 判定，非 class 存在）。
- **GUI 胶囊**：executor `close`/`closeSession` 发 `{type:'closed'}` 事件；browserStore 收到 → 隐藏胶囊；
  后续任意 browser:event 重新显示（浏览器被 agent 再次调用时胶囊自动回来）。

## 任务拆解（每任务 TDD + 独立提交）

1. **T1 P0-1 下载模块**：注册表 + 进度事件 + 快照 downloads 字段
   - browser-executor.cjs：downloads Map、createDownloadHandler 增强（updated/done 状态）、
     waitForDownload、snapshot() 注入 downloads、closeSession 清理
   - browser-common.cjs：buildSnapshot 增加 downloads 参数 → 输出字段
   - 测试：注册表状态流转（mock item on/emit）、快照 downloads 字段
2. **T2 P0-2+P1-1 js 动作**：js wrapper 归一化 + 二进制 512KB 内联/大文件落盘 + kernel schema
   - browser-executor.cjs：buildJsWrapperScript(expression) 工厂 + runJs + 主进程 finalize（b64→inline/file）
   - browser-common.cjs：binarySize 常量/判定（或放 executor）
   - yfw-kernel BrowserTool.ts：action union 加 'js'，描述文档化；rebuild cli.mjs
   - 测试：wrapper 脚本内容（b64/元素摘要/深度截断/await）、finalize 决策（临时目录落盘）
3. **T3 P1-2 a 标签下载语义**：collector download 标记 + click downloadURL + setWindowOpenHandler
   - browser-executor.cjs：isDownloadishUrl 纯函数、collect() 记 refHrefs/download flags、
     click() 分支、ensureWindow 挂 setWindowOpenHandler
   - browser-common.cjs：buildSnapshot download 标记
   - 测试：isDownloadishUrl 判定、快照 download 标记
4. **T4 P2-1 会话保活**：logged_in 计算 + 过期检测一次性上报
   - browser-executor.cjs：collector 脚本加 logged_in、snapshot() 过期检测 + sessionExpiredFlag、
     status 事件
   - browser-common.cjs：buildSnapshot page.logged_in 透传
   - 测试：collector 字符串含 logged_in 启发、快照透传、过期标记幂等
5. **T5 P2-2 loading 修正**：collector loading 语义（可见 spinner）
   - browser-executor.cjs：collector loading 逻辑替换
   - 测试：collector 字符串断言
6. **T6 GUI 胶囊 + 内核同步**：closed 事件 → 胶囊隐藏；browserStore/BrowserStatusBar
   - browser-executor.cjs：closeAction/closeSession 发 {type:'closed'}
   - src/stores/browserStore.ts：closed → hidden；任意事件 → shown
   - src/components/browser/BrowserStatusBar.tsx：hidden 状态渲染（胶囊消失）
   - dist 重建 + release 同步；kernel cli.mjs rebuild + 同步

## 验收
- 全量 `npm test` 通过（现 82 + 新增）
- release 同步（electron/browser-{common,executor}.cjs、kernel/cli.mjs、dist bundle）+ grep 验证新标识符
- 用户重启后复测 5 关键操作；下载路径快照可见、js 动作直接可用、菜单树可展开
