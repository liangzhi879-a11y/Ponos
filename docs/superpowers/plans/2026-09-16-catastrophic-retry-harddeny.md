# 实施计划：内核 P0-3 审批不可绕过化

对应 spec：`docs/superpowers/specs/2026-09-16-catastrophic-retry-harddeny-design.md`
执行纪律：每步先跑该步验证命令，绿了再进下一步；任何一步红了就地修复，不带病前进。

## S1 — blacklist.mjs：判定返回值升级为「族 id | null」

1. `scanSegment(segment, depth)`：`return false/true` → 返回族 id 字符串或 `null`；
   包装器递归分支同步（`flat.length ? scanSegment(...) : null`）；
   `DELETE_TOOLS` 命中条件不变，只把结果包成族 id；`diskpart|fdisk|parted` → `format-partition`；
   `init 0|6`、`systemctl reboot|poweroff|halt|shutdown` → `power-control`。
2. 新增导出 `catastrophicFamily(command) → familyId | null`（原 `matchesCatastrophic` 主体搬入，逐段 `try` 语义保留）。
3. `matchesCatastrophic(command)` 改为 `catastrophicFamily(command) !== null`。
4. 更新文件头注释：说明两函数的分工（同判定、不同返回粒度）。

**验证 S1**：`node --test kernel-tests/blacklist.test.mjs`
→ 既有 4 个用例必须仍全绿（证明「返回值语义不变」），此步**不加新用例**——先证基线不破。

## S2 — blacklist 测试：补族归因与新不变量

1. 五族各一条断言到预期 family id（含 Windows 形态：`rd /s /q C:\`、`format D:`、`dd of=\\.\PhysicalDrive0`、`Stop-Computer`）。
2. 非灾难（`npm run format`、`rm -rf node_modules`、`grep shutdown app.log`）→ `null`。
3. **改写/升权同族**（本任务的核心能力）：`rm -rf /`、`rm -rf /*`、`rm -rf ~`、`sudo rm -rf /`、`bash -c "rm -rf /"` 全部 → `root-or-home-recursive-delete`。
4. 一致性不变量：对上面全部用例断言 `matchesCatastrophic(c) === (catastrophicFamily(c) !== null)`。

**验证 S2**：`node --test kernel-tests/blacklist.test.mjs`

## S3 — engine.mjs：新增轮内已拒族集合

1. `engine.mjs:1843` 附近（`denialStreak` 同级）声明 `const deniedCatastrophicFamilies = new Set()`，附注释说明用途与轮内语义。
2. `runTurnInternal()`（`:912`）开头 `deniedCatastrophicFamilies.clear()`，注明「轮起点清空 = 文档的『同一 turn 内』」。

**验证 S3**：`node --check kernel/engine.mjs` + `node --test kernel-tests/permission-gate-mode.test.mjs`（全绿证明未破坏既有档位语义）。

## S4 — engine.mjs：拦截分支 + 记录分支

1. `gateToolUse` 的 `ask` 分支最前面：若 `perm.hard` 且该族已在集合中 → 直接 `return { allowed: false, message }`（不发 control_request、不动计数）。
2. `ask` 分支内计算一次 `hardFamily`（`perm.hard ? catastrophicFamily(command) : null`）复用；`command` 由 `toolUse.input.command` 取。
3. 拒绝回填处：`decision.behavior !== 'allow' && !== 'timeout' && perm.hard && hardFamily` → 写入集合。

**验证 S4**：`node --check kernel/engine.mjs`

## S5 — e2e：新测试文件（含防假绿双断言）

`kernel-tests/catastrophic-retry.test.mjs`，夹具复用 `permission-gate-mode.test.mjs` 的 `setup()` 形态（mock API + wire 收事件 + 手动 resolveApproval）：

- 用例 1（核心）：`mode:'manual'`、`approve:false`，一轮 `[mock:tool-catastrophic]`：
  - 断言 A（**证明重试真的发生**，防假绿）：会话里 `rm -rf /` 的模型 tool_use 块数 `>= 2`；
  - 断言 B（**拦截生效**）：灾难命令的 `control_request` 恰好 `1` 个；
  - 断言 C：模型收到的拒绝 tool_result 文案命中硬拒说明。
- 用例 2（防「永久封禁」）：同一 engine 连跑两轮，每轮灾难命令**都应至少弹一次窗**（轮内集合已清空）。
- 用例 3（不误伤）：同轮内**普通高危**命令（`[mock:tool]`）在灾难命令被拒后**仍能弹窗**（族拦截不外溢到 highrisk）。

**验证 S5**：`node --test kernel-tests/catastrophic-retry.test.mjs`
**若用例 1 断言 A 不成立**（mock 未在同轮重发）→ 在 `kernel/api.mjs` 增一个「同轮连发两发、第二发为改写变体」的 mock 标记（纯增量，不动既有分支），再重跑。

## S6 — 全量门禁 + 回归

1. `npm run typecheck`
2. `node --test kernel-tests/*.test.mjs`（串行，注意 `--test-concurrency` 并行端口竞争会造成假失败）
3. `node --test server/*.test.mjs`
4. `node --test "src/**/*.test.ts"`
5. 有失败 → 先判「是否与本次改动相关」（单跑 + 看是否 flake），相关则修，不相关则在报告中如实标注。

**验证 S6**：四条命令的 pass/fail 汇总数字。

## S7 — 同步调试版（交付人工调试）

1. `kernel/blacklist.mjs`、`kernel/engine.mjs` → `release/YFWorking/kernel/`
2. 若 S5 需要，`kernel/api.mjs` 同步（api.mjs 属内核测试支撑，若 release 内不依赖可省，但为一致性一并同步）
3. 冒烟：`node --check release/YFWorking/kernel/engine.mjs`；对调试版目录跑一次 `kernel-tests` 的关键子集（blacklist + 新 e2e），证明调试版代码可跑。
4. 若应用在运行且需生效：内核改动需**应用重启**才加载（bridge 以 `--resume` 拉起内核），报告中明确告知。

**验证 S7**：关键文件 md5 源码 vs 调试版一致 + 关键子集测试通过。

## S8 — 更新待处理清单 + 报告

- 该 P1 条目**不勾选**（P0 尚余 P0-2/P0-4），按规则追加进度说明：P0-1 已闭环（**附核查证据**）、P0-3 本轮完成（附证据）、P0-2/P0-4 未做及原因。
- 输出本轮摘要：任务、结果、证据、清单变更、下一轮建议。
