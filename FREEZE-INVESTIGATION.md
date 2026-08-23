# 卡死调查线索文件（2026-08-17 首次调查）

> 目的：系统在调试期间多次整机卡死（需强制断电），常在子 agent 启动时发生。
> 本文件记录已核实的证据、已排除的假设、仍待验证的根因候选与下一步计划。
> **任何重启后继续调查的会话，请先读本文件。**

---

## 1. 卡死时间线（事件日志核实）

| 时间 (2026) | 事件 |
|---|---|
| 08-17 07:37 / 10:41 / 11:11 / 11:18 / 11:28 | **5 次 Event 41 Kernel-Power（强制断电）+ 6008**（今天一天） |
| 08-13 ~ 08-16 | 资源耗尽检测器多次运行中断；用户当时在调试渲染层动画/GPU 问题 |
| 08-15 19:22+19:23、08-16 11:48×2、22:04 | GPU TDR 事件 4101（7 次历史：7/31、8/11、8/15、8/16） |
| 08-17（今天） | **没有任何 4101** —— 要么不是 GPU 可恢复型挂起，要么是完全挂死（TDR 未成功恢复时不会记 4101） |

- 上一轮死掉的会话 `0df4ab39`（11:11 卡死）本身就在排查同一问题：
  用户原话 = "应用导致了资源管理器（可能是硬盘）阻塞/卡死，或与subagent执行和结束相关，详查问题"。
  该会话 transcript 保留在 `~/.claude/projects/C--Users-T203-15-claude-code-gui/0df4ab39-*.jsonl`，
  已收集到的部分证据：进程计数（bun/node/rg/python/electron/git）+ bridge.log 的 spawn/exit 扫描。
- pet.log 显示 app 在 11:12、11:19 两次重启后重连 bridge——与 11:18、11:28 两次卡死吻合：
  用户重启 app 后 6 分钟内再次卡死。

## 2. 硬件环境（已核实）

- 内存 16GB；页面文件自动管理（C:，已分配 7GB，卡死期间 Windows **从未**诊断出低虚拟内存）
- C: = 256GB NVMe SSD（剩 53GB）；**D: = 2TB 5400 转 SATA 机械盘（剩 388GB）**；E: = 16GB 恢复分区（剩 1.9GB，勿动）；Y:/Z: 网络盘
- 显卡三块叠用：**Radeon RX 460（驱动 2022-08）+ Intel HD 630（驱动 2018-11）+ OrayIddDriver（向日葵/AweSun 远程桌面虚拟显示驱动）**
- 有 AweSun（向日葵）远程桌面进程在跑 —— 用户很可能经常远程操作本机
- SMART：两块物理盘均 Healthy/OK；System 日志无磁盘/控制器错误（7/11/51/129/153 干净）
- 实测 D: 盘延迟：读平均 122ms、写最大 394ms 尖峰 —— 机械盘繁忙时延迟会暴涨到秒级

## 3. 应用架构（已核实）

```
Electron 主进程 (electron/main.cjs, node server/bridge.mjs)
  └─ bridge (WS:51311 + HTTP) ──stdio──▶ bun 内核 (kernel/cli.mjs, 每个会话一个进程)
                                          ├─ CLAUDE_CONFIG_DIR 重定向到 ~/.ponos
                                          ├─ 会话 transcript 落盘 ~/.ponos/projects/ (896MB)
                                          ├─ 子 agent 输出经 diskOutput.ts 写盘（上限 5GB/task）
                                          └─ 会话 cwd 可能在 D:（国高咨询项目在 D:/Projects/...）
```

- 打包版 release 路径：`release/Ponos_ms92cd6u/`（bun.exe + kernel/cli.mjs + vendor/ripgrep 已带 rg.exe）
- 应用启动会自动 resume 多个最近会话（bridge.log 实证 4~5 个并发 bun 内核，各带 1M 上下文模型）
- 渲染层：流式事件按 animation frame 批处理（已有优化）；无目录轮询/watch；localStorage 很小（6.5MB）

## 4. 已排除的假设（不要重复查）

| 假设 | 排除依据 |
|---|---|
| 内存 commit 耗尽 | 资源耗尽检测器日志 488×1001/434×1002 全是例行启停，**无 2004/1004 低虚拟内存事件**；1003/1008 是 5 月/7 月旧事件 |
| 磁盘硬件故障 | SMART Healthy；无磁盘错误事件；延迟测试盘可用（虽然慢） |
| ripgrep 缺失→全树递归搜索 | 打包版已带 `kernel/vendor/ripgrep/x64-win32/rg.exe`，快速路径生效 |
| 渲染层 localStorage/leveldb 洪写 | userData（%APPDATA%/ponos-gui）仅 6.5MB |
| 视觉桥接 spawn 风暴 | `maybeBridgeImageBlocks` 是纯 API 调用无 spawn；VisionTool 每次只 spawn 1 个 python（10min 超时+清理）。注意：桥接无缓存命中逻辑，重复桥接 = 重复 API 调用（费钱不卡机） |
| bridge stdio 缓冲堆积 | readline 逐行消费，无累积 |
| bridge 文件浏览 sync 卡死 | FileBrowser 仅在用户点击时 fetch /list-dir，无轮询 |

## 5. 根因候选（按可能性排序）

### 候选 A：GPU/显示驱动挂死（整机冻死经典特征）
- 老 AMD 驱动（2022）+ 更老的 Intel 驱动（2018）+ **OrayIddDriver 远程虚拟显示**三层叠加；
  远程桌面镜像驱动 + 旧 GPU 组合是 TDR/死锁高发区。
- 本机 7 次 TDR（4101）前科；main.cjs 里满是 GPU 崩溃兜底代码（作者已知显卡不稳）。
- 触发时机吻合：**子 agent 启动 = 任务卡片/动画事件突发**（glass 透明主题下全窗合成路径 + 动画），
  渲染峰值 → GPU 挂起 → DPC 风暴 → 整机假死。用户 11:12/11:19 重启 app 后 6 分钟再卡，
  恰是 app 启动 + 会话自动恢复 + 渲染密集的窗口。
- 8/17 无 4101 = 挂起未恢复（TDR 成功恢复才记 4101）。
- **验证方法**：① 关闭 AweSun/向日葵，本地直连操作本机，跑同样工作流看是否还卡；
  ② 使用非 glass 主题 + 应用内置"极速形态"（GPU 崩溃后自动开）；③ 卡死瞬间若有第二台设备，
  远程 ping 本机：能 ping 通但无显示响应 = 显示栈挂死而非整机死。

### 候选 B：D: 机械盘 I/O 饱和 → Explorer 挂起（用户自己的直觉）
- 国高项目会话在 D:（机械盘）；子 agent 启动/结束 = git status/rg 扫描/文档转换/transcript 写入的
  I/O 突发，全部压在 5400 转机械盘上；实测该盘读平均 122ms，忙时尖峰秒级。
- explorer.exe 在这台机器上有挂起前科（7/31 三次 Winlogon 强杀 explorer + Application Hang 记录）；
  Windows 搜索索引器也会跟着 agent 改文件节奏重索引 D:。
- 机械盘忙 + shell 同盘 = 桌面全僵，用户被迫断电。
- **验证方法**：把会话换到 C: 项目测试；或用 `typeperf "\PhysicalDisk(0 D:)\% Disk Time"` 监控
  子 agent 启动时 D: 是否 100% 忙。

### 候选 C（放大器，非主因）：多会话自动恢复的内存压力
- 每次启动自动 resume 4~5 个 bun 内核，各带 1M 上下文（deepseek 1M 模型），
  单进程可吃数 GB → 16GB 吃紧 → 页面文件打盘（C: SSD）→ 放大 A/B 的任何卡顿。
- 从未被系统正式判定为内存耗尽，但值得后续加：启动时只恢复当前会话，其余按需拉起。

## 6. 下次卡死时怎么做（重要）

1. **不要立刻断电**。先试：Ctrl+Shift+Esc 能否唤起任务管理器；NumLock/CapsLock 灯能否切换
   （键盘灯无响应 = 内核级挂死，GPU 方向；键盘有响应 = 用户态/IO 阻塞）。
2. 若键盘有响应但桌面僵：`Ctrl+Alt+Del` → 任务管理器 → 结束 explorer.exe 再重启它（Win+R → explorer）。
3. 留证据：
   - `C:\Windows\Minidump` 是否出现新 dump（至今一个都没有 —— 与"挂死而非蓝屏"一致）；
   - 在另一台设备上 `ping` 本机；
   - 卡死前开着 `perfmon /rel`（可靠性监视器）事后看红色叉。
4. 重启后立即记录时间，对照事件日志 4101/6008/41 时间线。

## 7. 已保存的调查资产（重启后可用）

| 资产 | 位置 |
|---|---|
| 本线索文件 | 仓库根 `FREEZE-INVESTIGATION.md` |
| 系统快照脚本（只读） | `.salvage-work/freeze-diag.ps1` |
| 打包版 bridge 日志 | `release/Ponos_ms92cd6u/bridge.log`（+bridge.err.log） |
| 内核会话库 | `~/.ponos/projects/`（896MB，含 D: 项目会话） |
| 死掉会话 transcript | `~/.claude/projects/C--Users-T203-15-claude-code-gui/0df4ab39-*.jsonl`（最后动作=进程计数+bridge.log扫描） |
| 宠物日志（app 存活心跳） | `~/.ponos/pet.log`（每次 bridge 重连都记一行） |
| GUI userData | `%APPDATA%/ponos-gui/`（6.5MB，无大库） |

## 8. 修复方向（待用户确认后再动代码）

1. **短期止血**：AweSun 远程期间避免重型 agent 任务；非 glass 主题；app 启动只恢复当前会话。
2. **代码级**：
   - 桥接层对每次"子 agent 任务通知"的渲染做降频/合并（任务卡动画事件目前逐条 upsertSubAgentTask）；
   - bridge.mjs `send()` 无 WS 背压处理——渲染层卡顿时消息在 socket 缓冲堆积（ws 库无界），
     应加 `bufferedAmount` 上限 + 客户端慢时丢弃非关键事件（milestone/progress 类）；
   - 会话启动时限制并发 resume 数量；
   - 国高等大项目会话引导到 C:（或给 bridge 加"会话盘位置"提示）。
3. **系统级**：更新 RX 460 驱动（当前 2022-08）；检查向日葵虚拟显示驱动与应用的兼容性；
   考虑关闭 Windows 搜索索引对 D: 国高目录的索引。

## 9. 本次调查的安全边界

本次调查全程未启动 app、未 spawn 子 agent、未跑任何写盘重活（仅 40 次 64KB 延迟测试文件，已删除）。
系统当前状态健康（16GB 空闲 10.6GB）。若本会话再次意外终止，以上全部资产均可独立复原。

---

## 10. 系统性修复记录（2026-08-17，已实施并验证）

### 修复 1：WS 背压（server/bridge.mjs `send()`）
- 每客户端 `bufferedAmount` 超 8MB 标记过载（滞回下限 2MB），过载期间丢弃低优先级事件：
  milestones/milestone-start/milestone-ok/question-resolved/raw/stderr + system task_progress；
  assistant/result/审批/提问/错误/关闭/ack 等关键事件永不丢。断流后自动恢复全量。

### 修复 2：task_progress 按帧合并（src/hooks/usePonosCLI.ts）
- task_progress 进 Map<(sid,taskId)→event> 合并队列，rAF 每帧每任务只应用最后一条；
  task_started/task_notification 仍即时送达；error/cancelled/closed 路径清队列防任务卡复活；
  页面隐藏时兜底 flush。

### 修复 3：/list-dir 异步化 + 条目上限（server/bridge.mjs）
- fs/promises 异步 readdir/stat，目录/文件排序语义不变；上限 2000 条 + `truncated` 标志
  （前端自动忽略未知字段）。不再有同步 statSync 阻塞事件循环的路径。

### 修复 4：内核空闲回收（server/bridge.mjs）
- 新增 `reapIdleKernels`（60s 扫描）：仅当「轮次已结束（result 已到）+ 无待答提问 +
  无待批审批 + 空闲超时」时回收 bun 内核进程（taskkill 进程树），下次发消息以
  --resume 原会话 ID 自动重启（首次 token 稍慢，无缝续聊）。回收退出不广播 closed
  （渲染层保留任务卡）。默认阈值 10 分钟；`PONOS_KERNEL_IDLE_MS` 覆盖毫秒数，`0` 关闭。
- 注：原"启动只恢复当前会话"假设不成立——渲染层无自动恢复逻辑，多内核是用户切换
  会话累积的；空闲回收才是正确的内存上界手段。

### 验证结果（全部通过，未启动 app）
- `node --check server/bridge.mjs` / `electron/main.cjs` ✓
- `npm run typecheck`（tsc --noEmit）✓ 无错误
- `npm test`（node --test server/*.test.mjs）✓ 56/56 通过

### 部署注意（重要）
- 前端修改需 `npm run build` 重新生成 dist/ 才生效；
- 打包版 release/Ponos_ms92cd6u/ 下的 server/bridge.mjs 与 dist/ 需按既定流程同步；
- 调试期可用 `PONOS_KERNEL_IDLE_MS=60000` 快速验证回收行为（日志关键字 `idle kernel reaped`）。

### 部署状态（2026-08-17 已完成）
- `npm run build` 成功（dist 新 bundle：index-CfhKq-Hr.js）；
- 按 BUILD.md 流程同步两份副本：release/Ponos/ 与 release/Ponos_ms92cd6u/
  （dist 镜像 + server/* 复制）；已验证：两份 bridge.mjs 均含 `idle kernel reaped` 与
  `_ponosOverloaded`，dist/index.html 均指向新 bundle。

---

## 11. 晚间第二轮调查（2026-08-17 19:00+）：新根因候选 360+VBS，双修部署

### 新事实（用户报告"powershell 挂起阻塞 + 应用交互没反应 + 系统卡死"）
- **Event 41 再添 4 次**：16:26:38 / 16:42:40 / 19:03:46 / 19:07:37（全天共 9 次硬重启）。
  上午 4 项修复未止住冻死；19:07 那次**app 未运行**（app 19:08:42 才启动）→ app 是放大器，不是唯一触发源。
- **新根因候选（此前调查完全遗漏）**：本机跑着 **360天擎企业版**（ZhuDongFangYu.exe 主动防御 +
  360FsFlt/360Box64/file_filter/load_driver/npsvctrig 内核过滤驱动，2018~2025 各版本混装），
  同时 **VBS/HVCI 开启**（Secure Kernel + Hypervisor mitigations 事件实锤）。WinDefend 已停
  （360 接管杀毒）。企业版带防篡改，用户可能无法自行卸载。
- **powershell 挂起 = 系统失速的金丝雀**：内核会话 transcript 实锤多次挂起
  （Get-Process / Get-CimInstance Win32_VideoController / Get-WinEvent / Get-NetTCPConnection，
  上午+晚间均有）；本轮调查**现场复现**：Get-Process 指定服务进程名 >40s 才返回、
  偶发 spawn bash EPERM。恢复后同一命令 1.4s。挂起命令共性 = 都要 spawn 新 powershell
  （进程创建被 360 钩子 + VBS 双内核层拖慢）或查询触及显卡/向日葵领地。
- 冻死前无任何日志/无 dump（三窗口取证：Event 41 前 5 秒只有启动序列）→ 内核级楔死，
  与驱动钩子死锁一致（非蓝屏）。
- 当前实例（19:08 启动）豆包登录窗为 modal 弹窗——加载 doubao.com 重站点期间会阻塞主窗口交互。

### 本轮修复（已部署，无需重新 build——只改了 electron/main.cjs 与 server/bridge.mjs）
- **修复 5：内核失速看门狗**（server/bridge.mjs）：轮次活跃但 stdout 静默超阈值 → 日志
  `kernel stall warning` + kernel-stall 事件（只告警不自动杀，防丢工作）。`PONOS_KERNEL_STALL_MS`
  覆盖（默认 10min，0 关闭）。
- **修复 6：豆包窗口去模态 + 空闲销毁**（electron/main.cjs）：
  ① modal:true→false——登录窗加载慢/挂起不再阻塞主窗口；② 空闲超阈值销毁隐藏窗
  （doubao.com SSE/shared worker/动画是常驻 GPU/网络负载源），下次生成 ensureDoubaoReady
  静默重建（persist:doubao 分区 cookie 不丢，60s 等自动登录）。`PONOS_DOUBAO_IDLE_MS`
  覆盖（默认 10min，0 关闭）。
- 验证：node --check ×2 ✓；npm test 75/75 ✓；两份 release 副本已同步。
- **生效前提：用户重启 app**（当前运行实例加载的是旧代码）。

### 待用户执行的系统级处置（按优先级）
1. **360天擎信任区**：把 C:\Users\T203-15\claude-code-gui、D:\Projects、~\.ponos、
   %LOCALAPPDATA%\Temp\claude 加入 360 实时防护信任/白名单（减少 agent 文件风暴被扫）；
   如 360 有"核晶防护"（内核虚拟化）选项则关闭——与 VBS 叠加是冻死最大嫌疑。
2. **VBS/HVCI**：设置→Windows 安全→设备安全→内核隔离→内存完整性，若非公司策略强制，
   关闭（2018 老驱动 + 双虚拟化 = 冻死组合）。
   ✅ **已完成（2026-08-17 晚）**：经 WMI 查证 HVCI 本就未运行（SecurityServicesRunning=0）；
   VBS 层由用户手动注册表关闭：`EnableVirtualizationBasedSecurity=0` +
   `HVCI Enabled=0`（均 DWord，双端验证通过）。**待重启生效**；重启后应观察到
   VirtualizationBasedSecurityStatus=0 且启动日志无 Secure Kernel/Hypervisor 事件。
3. **AweSun/向日葵**：不用远程时退出客户端（OrayIddDriver 虚拟显示 + 远程会话是叠加风险）。
4. 更新 RX460/Intel 显卡驱动；Windows 搜索索引排除 D: 项目目录；国高项目会话迁到 C:。

---

## 12. 第三轮调查（2026-08-18 11:0x-12:0x）：360 已卸载 + Defender 恢复 + 停止链路断裂

### 本轮新事实（全部经最新代码与系统状态核实，修正了旧记录中的误判）

- **Event 41 第 13 次**：2026-08-18 10:59:52（+6008）。8/17 全天 12 次后仍继续卡死；
  卡死前后 System 日志 20 分钟空白（内核级楔死，无任何先兆事件）。
- **卡死时 app 在运行**：pet.log 最后心跳 10:05:23 → 恢复于 12:02:44。
- **360 天擎已卸载干净**（用户确认 + 系统核实）：
  - 服务/驱动/注册表均无 360/QH/ZhuDong 残留；`C:\Program Files (x86)\360` 仅剩空壳目录
    `360TptMon\TMService.dll`（无进程无服务无驱动）。
  - **修正旧误判**：第 2 轮把 `npsvctrig.sys` 归为"360 内核过滤驱动"有误——经
    Get-AuthenticodeSignature 核实其为 **CN=Microsoft Windows 签名**的 Windows 自带
    网络策略服务触发器驱动。后续勿再引用该归类。
- **新放大因素：Defender 恢复实时扫描**（360 卸载后自动接管）：
  - `Get-MpComputerStatus`：RealTimeProtectionEnabled=True，签名更新 8/18 05:43；
  - 事件日志 8/18 11:06:33：FilterManager 加载 `WdFilter` 过滤驱动 + Defender 三服务启动。
  - **结论**：文件系统过滤驱动钩子（Defender WdFilter 而非 360）仍在系统栈上，逐文件扫描
    + 进程行为监控，对 subagent 并发文件风暴是当前最大 I/O 放大器。
- **VBS 仍未完全关闭**：VirtualizationBasedSecurityStatus=2（enabled but not running），
  8/17 注册表修改未完全生效。弱嫌疑，待系统侧再次确认。
- **系统基线（空闲）**：239 进程 / 89,090 句柄 / 3,432 线程 / WS 7.2GB / commit 可用 16GB /
  页面文件 C: 7GB 用量 0 —— 全部正常，无累积泄漏迹象（卡死是"风暴临界"而非"常态泄漏"）。

### 停止链路断裂（本轮定位的确定性代码缺陷）

GUI 停止复用 CLI 的 interrupt 语义，在桌面应用场景完全失效：

1. **ShellCommand.ts:189 `#abortHandler()`**：`abortSignal.reason === 'interrupt'` 时
   **故意不 kill** shell（设计意图：CLI 里用户中断后转后台让模型看部分输出）。
   → GUI 点停止 → 正在执行的 bash 不退出 → subagent 卡住、任务卡挂着。
2. **AgentTool.tsx:701**：异步 subagent（`run_in_background`/`background:true`/coordinator/
   proactive）使用**独立 AbortController 且明确"不链接父级 abort"** → interrupt 不级联。
3. **bridge.mjs:1906 cancel 兜底**：6 秒后 `taskkill /F /T` 整树强杀——卡死/慢盘时同样失效，
   且强杀会丢会话状态。
4. **多会话进程形态**：bridge 以 `shell:true`（bridge.mjs:780,784）经 cmd.exe 中转 spawn
   每个 bun 内核 → 每会话 = cmd + conhost + bun 三个进程；Bash 工具每次再 spawn
   bash.exe（+嵌套+conhost）。进程树实锤：bun→bash→嵌套 bash→conhost。
5. **D: 机械盘负载确认**：transcript/工具结果写 C:（~/.ponos/projects，937MB，写队列
   +flush 节流，非 D: 负载）；**D: 负载 = subagent 实际操作国高项目文件**
   （bridge.log 实锤两个会话 cwd 在 `D:/Projects/【国高】...`，git/rg/文档转换/读写全压机械盘）。

### 根因结论（第三轮）

1. **直接原因（确定性）**：停止链路断裂 → subagent 停不掉、bash 进程树不释放 → 反复
   停止/重试后进程与句柄累积；风暴临界时触发系统级楔死。
2. **系统级放大**：Defender WdFilter 实时扫描（360 卸载后接管）× D: 机械盘（subagent
   项目文件风暴）× 老显卡驱动栈（7 次 TDR 前科，OrayIddDriver 叠加）。
3. **触发场景**：subagent/多任务并行 = 内核内多路并发 + 并发进程 spawn + 并发 D: 文件操作
   + Defender 逐文件扫描。

## 13. 修复 7：停止语义拆分（2026-08-18 实施，代码级止血）

### 问题
GUI 停止复用 CLI 的 interrupt（语义 = "长 bash 转后台让模型看部分输出"），导致：
停止后正在执行的 bash 不退出（ShellCommand.ts `abortSignal.reason === 'interrupt'` → background 而非 kill）、
异步 subagent 的独立 AbortController 不级联（AgentTool.tsx:701 明确不链接父级 abort）→ 任务卡挂着、
bash 进程树不释放、进程/句柄累积。

### 方案：协议层区分 cancel vs interrupt
bridge 的 GUI cancel 不再发 `interrupt`，改发新的 control_request `cancel`；内核 onCancel 执行"全停"。

| 文件 | 改动 |
|---|---|
| `src/bridge/bridgeMessaging.ts` | 新增 `onCancel` 回调 + `case 'cancel'`（全停语义注释） |
| `src/bridge/initReplBridge.ts` / `replBridge.ts` / `remoteBridgeCore.ts` | 透传 `onCancel` |
| `src/hooks/useReplBridge.tsx` | `onCancel()`：`abortControllerRef.abort('cancel')`（reason 非 interrupt → ShellCommand 真正 kill bash）+ `killAllRunningAgentTasks(store.tasks, setAppState)`（逐个 abort 异步子 agent，reason-less → bash kill） |
| `server/bridge.mjs` | cancel 分支发 `{ subtype: 'cancel' }`；6 秒 taskkill 兜底保留 |

### 验证（全部通过，未启动 app）
- `node --check server/bridge.mjs` ✓
- 内核 `tsc --noEmit`：除预存 `src/server/web/__tests__/session-manager.test.ts` 报错外 0 错误 ✓
- 主项目 `npm run typecheck` ✓；`npm test` 75/75 ✓
- 内核 `bun scripts/build-bundle.ts` → dist/cli.mjs 20.9MB ✓
- 双副本同步 + 特征验证：`subtype: 'cancel'`（bridge.mjs）、`case "cancel"` / `abort("cancel")` / `killAllRunningAgentTasks`（cli.mjs）✓

### 生效前提与复测方法
- **需重启 app**（release/Ponos_ms92cd6u 当前运行实例加载旧代码）。
- 复测：并行 4 个 subagent（各跑 60s+ 长 Bash）→ 点停止一个 → 任务卡应立即消失、
  bash 进程树立即退出；再观察事件日志无新增 Event 41。

### 待系统侧处置（更新）
1. **Defender 排除项**：`~/.ponos`、`D:\Projects`、`C:\Users\T203-15\claude-code-gui`
   加入 Defender 实时保护排除目录（消除逐文件扫描放大）。
2. 国高项目会话迁到 C: SSD（D: 机械盘仅做归档）。
3. VBS 完全关闭确认；AweSun 退出；显卡驱动更新。

---

## 14. 压力测试验证修复生效（2026-08-18 12:33-12:35，重启后实测）

### 环境确认
- app 已重启：electron 12:28:31、内核 bun 12:29:22；加载 12:26:20 同步的修复版 cli.mjs（cancel 语义）✓
- 同步收集脚本 `.ponos/stress-test/collect.sh` 独立后台运行（每 2s 采集响应耗时/内存/进程表/Event41），
  卡死也不丢证据；cancel 触发器 `cancel-sender.cjs` 经 WS 模拟 GUI 停止按钮走完整链路。

### 测试过程
- 并行发起 4 个 subagent（du 循环 / find 遍历 / 读 20MB 大文件 / grep 搜索，各设计持续 40-50s），
  期间 bash 进程峰值 17（基线 8-10）。
- 12:34:26 WS 发送 `{type:'cancel', sessionId:b3a8ce6b}` → bridge → 内核 `control_request(cancel)`。

### 结果（PID 级证据）
| 指标 | cancel 前 (12:34:25) | cancel 后 3s (12:34:29) | 结论 |
|---|---|---|---|
| bash 进程 | 18（含 4 subagent 负载树） | 12，**9 个旧 PID 同步消失** | 负载 bash 被杀 ✓ |
| bun 内核 | 16044 | 16044（存活） | 只停任务不杀会话 ✓ |
| 响应耗时 dt_ms | 2.2-2.6s | 2.2-2.6s（无飙升） | 系统未阻塞 ✓ |
| Event 41 | 10:59:52 | 无新增（保持 10:59:52） | 无冻结 ✓ |
| cancel 后 1 分钟 | — | bash 稳定 8-13（基线波动） | 无泄漏增长 ✓ |

### 结论
修复链路在真实压力下生效：GUI 停止 → cancel 协议 → 内核 `abort('cancel')` + `killAllRunningAgentTasks`
→ 4 个并行 subagent 的 bash 进程树 3 秒内全部消失，内核会话保留，全程无系统阻塞、无新增 Event 41。
"停止后任务卡挂、进程累积 → 系统冻结"的直接链路已被掐断。

### 遗留（非代码层）
- 负载期间 dt_ms 基线约 2.3s（PowerShell 采样开销），与机械盘延迟叠加时系统整体偏慢属预期；
- Defender 排除项 / D→C 迁移 / 显卡驱动仍未落实，长期看仍建议执行 §13 待系统侧处置清单。


## 15. §14 结论更正：cancel 从未真正到达内核（2026-08-18 12:55 复查）

### 关键更正
§14 判定"修复生效"的测试存在**致命方法错误**，结论无效。复查发现两个叠加断点：

**断点 1（测试工具 bug）：sessionId 用错，cancel 从未出 bridge**
- GUI 停止按钮发送 `sessionId = conversationId`（GUI 对话 ID），bridge `sessions` map 的 key 就是它
  （server/bridge.mjs `getOrCreateSession(sid,…)` → `sessions.set(sid, session)`）。
- 内核 CLI 的 `--resume <sessionId>` 是**另一个 ID**（对话的 `sessionId` 字段），不是 sessions 的 key。
- §14 测试误用内核 sessionId `b3a8ce6b…` → `sessions.get()` 返回 undefined → bridge **静默忽略**
  （只回 `{type:'cancelled'}`，不发 control_request）→ 内核完全不知情 → 全部"被杀"观察实为短命令自然结束。
- 实证：CDP 读取 renderer localStorage，当前对话 `conversationId=1787025772773-vpi21th`、
  `sessionId=b3a8ce6b-…`，两者不同。

**断点 2（release 产物未同步）：即使 cancel 到达，旧内核报 unsupported**
- 源码 `ponos-kernel/claude-code/src/bridge/bridgeMessaging.ts` 有 `case 'cancel':`（384-396 行）。
- release 实际运行的 `release/Ponos_ms92cd6u/kernel/cli.mjs` **不含 cancel case**
  （grep "case 'cancel'" = 0 处，default 分支报 "Unsupported control request subtype"）。
- 2026-08-18 12:26 构建的 cli.mjs 早于 cancel 修复编译，未同步（§13 修复只进了源码，
  构建产物仍是旧的）——再次踩中"源码改动必须同步 release 并重启进程"的老坑。

### 实测证据（12:54，修正后链路）
- 用**正确 conversationId**（`test-cancel-<ts>` 测试对话）发 send + 8s 后 cancel：
  - bridge 正确下发 control_request；
  - 内核回 `{"subtype":"error","request_id":"cancel-…","error":"Unsupported control request subtype"}`；
  - 内核未执行任何取消动作（旧产物无 cancel 分支）。
- 修复动作：重新构建内核（`bun scripts/build-bundle.ts --minify`）→ 同步 `dist/cli.mjs` 到
  release kernel → 用新测试会话验证 cancel 真正生效（control_response success + bash 被杀）。
### 根因三（最终，13:00 定位）：cancel 修复改错了入口文件
- GUI→bridge→内核 stdin 的 control_request 由 **`src/cli/print.ts`**（--print 模式 stdin 处理器）消费，
  其 switch（print.ts:2851 起）覆盖 interrupt/stop_task/cancel_async_message 等 **29 个 subtype，唯独没有 cancel**
  → 落入 4042 行 else → `Unsupported control request subtype`。
- §13 修复 7 改的是 **`src/bridge/bridgeMessaging.ts`**（SDK bridge 连接的消息入口）——
  GUI 链路根本不经它，等价于没修。
- 实证：重新构建 + 同步 release 后仍报 unsupported → 排除产物同步问题 → 定位到 print.ts。

### 真正的修复（2026-08-18 13:00，print.ts）
在 print.ts control_request switch 的 interrupt 分支后新增 `cancel` 分支（镜像 useReplBridge.onCancel）：
1. `abortController.abort('cancel')` —— reason='cancel'（非 'interrupt'），ShellCommand #abortHandler 判定
   reason ≠ 'interrupt' → `kill()` → `treeKill(pid, SIGKILL)`（Windows taskkill /F /T 杀整棵 bash 树）；
   print.ts 的 abortController（1035/2154）即 query toolUseContext.abortController（2207）→ Bash 绑定同一 signal；
2. 清理 suggestionState（同 interrupt）；
3. `killAllRunningAgentTasks(getAppState().tasks, setAppState)` —— 遍历 local_agent running 任务，
   `task.abortController.abort()`（reason-less → bash 被杀）+ 状态置 killed + unregisterCleanup + evictTaskOutput。
- import 新增 `killAllRunningAgentTasks`（src/tasks/LocalAgentTask/LocalAgentTask.js，纯函数无 React 副作用）。
- 重新构建（13:01）→ 同步 release kernel/cli.mjs。

### 验证（13:02-13:05，独立测试会话，全程不动当前会话）
**测试 A：主 turn bash 被杀**
- send `echo T0; sleep 25; echo T1` → 8s 后 cancel → 8.0s `control_response success`；
  8.3s `tool_result: Exit code 145`（sleep 提前被杀，未等到 25s 自然结束）+ `[Request interrupted by user for tool use]` + `result error_during_execution`。
- 结论：cancel 中止主 turn 并 tree-kill 正在运行的 bash ✅

**测试 B：并行 subagent 的 bash 全被杀（killAllRunningAgentTasks）**
- 2 个异步 subagent 各跑 `sleep 30`（bash 进程数升至 14-17）→ 20s 后 cancel →
  `control_response success` + 两个 subagent 均收到 task_notification（被杀）→ bash 数回落 10-12
  （若未杀，sleep 30 应存活至 ~39s）。
- 结论：killAllRunningAgentTasks 对异步 subagent 的独立 AbortController 生效 ✅

**系统级（collect.sh 同步采集）**：全程 Event 41 保持 10:59:52（无新增冻结）、dt_ms 稳定 2.2-4.3s（无阻塞）、
测试内核会话保留（idle reap 机制正常）。

### 遗留观察（非阻塞）
- cancel 后 subagent 被杀产生的 task_notification 会作为新消息注入内核，触发一次"回应 subagent 停止"的
  模型 turn（约 2-5s，资源占用小，GUI 停止后 stopStreaming 不再渲染）。属既有行为（killAll 路径一致），
  不构成卡死；如需"全停后零模型活动"可在后续迭代加 cancel 后 turn 抑制标志。
- 当前会话内核（bun 16044，--resume b3a8ce6b）仍是修复前旧产物启动的进程，进程内已无 cancel 语义
  （print.ts 修复需新 spawn 才生效）；GUI 重启应用后新会话即用新产物。测试用独立会话验证，未动当前会话。

---

## §16 GUI 卡住 subagent 图标（GUI task-state 同步缺陷 + 修复）

**现象**：压力测试期间被外部 taskkill 强杀的内核所派生的 subagent，GUI RunningAgentsBar 永远显示
运行中（8 个任务卡 running，直到界面重载）。用户反馈"UI界面上subagent图标还是显示运行"。

**根因**：GUI 的 subAgentTasks 是运行时状态（不落盘），仅由内核 system/task_started、
task_progress、task_notification 事件驱动；终态只能由 task_notification 或会话 `closed`
事件触发清理。内核被外部终止（taskkill/崩溃）时发不出终态通知 → 任务卡 running 直到 GUI 重启。
（cancel 修复的 killAllRunningAgentTasks 会发终态通知，属正常路径；外部强杀不在此列。）

**修复（GUI 侧防御，2026-08-18）**：
- `SubAgentTask` 新增运行时字段 `lastSeenAt`（事件心跳）+ `staleSwept`（超时清理标记）。
- task_started / task_progress 刷新 lastSeenAt；task_progress 同时显式带 status:'running'。
- `usePonosCLI.ts` 新增孤任务超时清理 `sweepStaleSubAgentTasks()`：running 任务超过 10 分钟
  无任何事件 → 标记 stopped（summary"子代理进程已退出，状态超时自动清理"）。挂在挂载周期
  500ms 心跳里，60s 节流。
- `chatStore.upsertSubAgentTask` 增加复活逻辑：staleSwept 任务收到新进度（lastSeenAt）→
  恢复 running（防误判：慢 LLM turn 可能 >10min 无进度）；真终态通知到达清除 staleSwept。
- 阈值选择：10 分钟（> 单次 agent LLM turn 的典型 1-5min，低于则可视为孤儿）。

**即时清理（无重启）**：CDP `Page.reload` 仅重载渲染层——subAgentTasks 是运行时状态，
重载即清零；不动主进程/内核（bun 16044、bridge node 7208 存活验证）；对话/transcript
从持久化恢复。已验证：新 bundle `index-ClDbozQ0.js` 加载、RunningAgentsBar 卡片 0、
activeConversation 1787025772773-vpi21th 恢复。已征得用户同意后执行。

**验证 CDP 不可行路径**：尝试从 React fiber 树定位 zustand store 直接 setState 清理——
React DevTools hook 未注入（`window.__REACT_DEVTOOLS_GLOBAL_HOOK__` 不存在）、store 未暴露
到 window、fiber memoizedState 只存 useSyncExternalStore 的快照函数不含 api 对象 → 不可行，
只能用重载清运行时状态。
