# 知识库对标 Obsidian —— 批次 4 实施记录（工程健壮性）

> 来源：2026-09-14 对标分析。批次 1（元数据/标签/内链/检索呈现）见 `2026-09-14-knowledge-obsidian-parity-batch1.md`，
> 批次 2（引用体系）见 `2026-09-14-knowledge-obsidian-parity-batch2.md`。本文件只含**批次 4**。
> 批次 3（搜索语法层）见 `2026-09-14-knowledge-obsidian-parity-batch3.md`。

## 本批次解决的四类"静默坏结果"

这批不是加功能，是把四条**不报错但会造成数据损失或认知错误**的路径补上。判定"是否值得做"的标准就一条：
出了问题用户能不能自己看出来。

| # | 现象 | 为什么危险 |
| --- | --- | --- |
| 1 | `writeFileSync` 就地覆写文档 | 进程被杀/磁盘满 → 用户的 md 停在半截，**且没有任何报错留下** |
| 2 | 覆盖磁盘上的外部改动 | 知识空间目录与 Obsidian/VSCode 共享；外部那笔改动**无声消失** |
| 3 | 索引撞 `maxFiles` 静默停手 | 用户看到"索引成功"，而超限文档搜不到、图谱没有、统计也不含 —— 只会怀疑"搜索坏了" |
| 4 | 外部改了文件，应用不知道 | 回到窗口看到的仍是旧内容，没有"你看到的是过期的"提示 → 用户以为修改没保存，或以为被覆盖了 |

## 交付

### 1. 写入原子化（`shared/atomic-write.mjs` + `server/knowledge-routes.mjs`）

`writeFileAtomicSync(path, content)`：同目录临时文件 → `fsync` → `rename` 覆盖。

- **同目录**：跨文件系统 rename 会 `EXDEV`，退化成"复制 + 删除"就失去原子性。
- **先 fsync 再 rename**：否则 rename 可能先于数据落盘被持久化（ext4 延迟分配 / Windows 写缓存），断电后新文件是空的。
- **临时名 `.yfw-tmp-<pid>-<rand>-<basename>`**：点号开头便于遍历跳过，随机段避免同进程并发写同名目标时互撞。
- 明示**不做目录 fsync**：Windows 上打开目录句柄 fsync 不可用（Node 抛 EPERM/EISDIR），为跨平台一致性选择不做，而不是"在 Windows 上静默跳过"。
- 失败**抛错**，不回退成普通写入 —— 回退正是本模块要消灭的东西。

**连带影响（关键）**：临时文件的名字**以目标名结尾、同样是 `.md`**，会被 `walkMd` 的 `/\.md$/i` 收进索引
→ "保存一次文档"在库里多出一篇同名文档，进程被强杀留下的残留还会长期污染索引。
所以 `walkMd` 必须 `isAtomicTmpName` 跳过（`kernel/knowledge.mjs`），两个模块共用同一套命名规则。

### 2. 覆盖冲突前置校验 + 覆盖前备份（`server/knowledge-routes.mjs` → `writeDocWithGuard`）

旧的 `handleWriteDoc` 结尾是一行裸 `writeFileSync`。现在落盘阶段独立成 `writeDocWithGuard`：

- **409 冲突**：客户端带 `mtime`（加载时看到的）时，比对磁盘实际 `mtime`；不一致 → **拒绝写入**并回带磁盘真实 `mtime`/`size`。
  不带 `mtime` 的老调用方 → 跳过校验，行为与旧版逐字一致（不误报）。
  容差 **1ms**：不同文件系统 mtime 精度不同（FAT32 是 2 秒），用 0 会把正常保存判成冲突 —— 比不校验更糟。
- **覆盖前备份**：用户明确 `force` 时，先调内核 `stash-doc --reason overwrite` 把磁盘那份**复制**进回收站；
  **备份失败则放弃写入**（返回 500 `backup-failed`）—— 宁可这次不保存，也不能把别人的改动销毁得无影无踪。
- **同内容短路**：内容与磁盘完全一致 → 不写盘（不改 mtime → 不触发索引失效重算），但仍刷新索引：
  "每次被接受的写入都触发增量索引"是既有契约（老测试钉着），省一次内核进程不值得破契约。

### 3. 文件数上限出声（`kernel/knowledge.mjs`）

- **`maxFiles` 变成真正的上限**：旧实现只在**外层**判 `out.length < maxFiles`，内层把一个目录的条目**全部**收完 ——
  单目录 2 万个文件时会全收下，`maxFiles` 根本不是上限。现在把判定挪到**入数组那一刻**，丢弃即置位。
- `walkMd(root, { maxFiles, stats })`：`stats.truncated` 的含义精确为"**有文件本可收录但没收**"
  （不是"栈里还有目录"，也不是"扫完了"）。返回值形状不变（仍是数组）—— 既有调用方与测试不受影响。
- `scanAll` 按空间收集截断信息 → 写进 `manifest.filesTruncated`（**只有截断时才写键**，常态不留痕，
  与 `relLines` 同一取舍）→ `stats().filesTruncated` 暴露给 GUI。
- **`indexStale` 在截断时跳过"磁盘已删"清扫**：`seen` 里没有的文件可能只是排在 5001 名之后。
  不跳过的话，>5000 文件的库每次 `load` 都判 stale → 全量重建 → 重建写回的 `lastFiles` 依然缺那些文件 → 下次又重建，
  **索引永远追不上**，CPU 白烧还与写入抢盘。代价是超限空间真删了文件这一轮发现不了 —— 诚实的不确定 > 假装知道。
- manifest 里的截断留痕在 `load` 时**回读**：否则"库里少了 N 篇"只在触发重建的那一次进程里可见，
  用户重启客户端就再也看不到（一个只在重建瞬间存在的警告等于没有警告）。

### 4. 知识空间文件监听（`server/knowledge-watch.mjs` + `server/bridge.mjs` + `src/hooks/useYFWCLI.ts`）

- **放服务端而非内核**：内核是**短命子进程**（每次 CLI 调用起一个、干完就退），在那里挂 watcher 等于挂在一个马上要死的进程上。
  服务端长驻且已有 `broadcastGui` 通道。
- **只监听 `spaces/`**：`index/` 与 `trash/` 是本应用自己的产物。重建索引会批量改写 `index/`，
  若把它也盯上就会自激：改文件 → 通知 GUI → GUI 拉数据 → 内核重建索引 → 又通知 GUI。
- **防抖 400ms**：一次保存/解压/批量同步会连续产生几十上百个事件，逐个转发等于让 GUI 反复失效并反复拉起内核进程。
- **忽略 `.yfw-tmp-*`**：保存一篇文档产生"创建 tmp → rename"两个事件，其中 tmp 的两个都不是内容变化。
- **平台降级如实标注**：Linux 上递归监听需 Node ≥ 20，抛错时降级为逐个空间目录浅监听，`mode` 报 `'shallow'` ——
  静默降级会让"为什么有时不同步"变成无法排查的玄学。
- **`unref()` 监听句柄（实测踩到）**：`fs.watch` 是 libuv handle，会**把事件循环钉住** ——
  挂上监听后进程不再自然退出。应用侧无感（bridge 收信号即退），但**测试进程不再结束**：
  `diag-info` / `browser-whitelist` / `provider-env-sig` 三个套件被挂到超时。这也是语义上正确的选择：
  监听是"更好用"的增强，不该成为"进程必须活着"的理由。
- GUI：`knowledge_changed` 帧 → `invalidateKnowledge('')` 全量失效 + 用单调 `revision` 丢弃乱序旧批次。
  **必须显式传空串**：不传参数会变成 `startsWith(undefined)` → 一条键都不匹配 → 整个监听链路静默什么都不做。

### 5. 顺手修的既有缺陷

- **`mentions:` / `brokenLinks:` 未进写路径失效清单**：批次 2 新增两个派生视图时漏补，
  症状是保存完切到右栏看到的还是保存前的"提到但没连"清单。已补进 `saveDoc` 与 `importDocuments`（各 2 处）。
- **`kernel/knowledge-cli.mjs` 的 `OPS` 少了五个回收站 op**：批次 2 加新 op 时拿带 `])` 的结尾行当锚点替换，
  把 `'trash-list','delete-doc','delete-space','restore','purge'` 整行覆盖掉了（`WRITE_OPS` 里还留着它们）。
  症状是这些 op 全部 "unknown knowledge op"。已恢复并加注：**往 Set 字面量里加东西时不要拿结尾行当锚点**。

## 验证

| 项 | 结果 |
| --- | --- |
| `shared/**` + `server/*` | 558 tests / 558 pass / 0 fail |
| `kernel-tests/*` | 1511 tests / 1510 pass / 0 fail / 1 skipped |
| `src/**/*.test.ts` | 386 / 386 pass |
| `electron/*.test.mjs` | 53 / 53 pass |
| `tsc --noEmit` | exit 0 |
| `vite build` | exit 0 |
| 真进程 CLI 端到端 | `stash-doc` 返回 `via=copy`、原文件保留、`trash-list` 条目 `reason=overwrite`；不存在文件 → exit 1；`.yfw-tmp-*.md` 不进 `tree` |

新增用例：
- `shared/atomic-write.test.mjs`（4）：写入完整 + 不留临时文件；**观察者并发读永不见半截**（20 万字节内容反复替换）；失败时目标原封不动；清理残留。
- `server/knowledge-routes.test.mjs`（+5）：409 冲突且不落盘；mtime 一致则正常写不备份；`force` 先备份再写、备份失败放弃写入；同内容不重写；不留临时文件。
- `server/knowledge-watch.test.mjs`（4）：外部写入触发一次合并批次 + revision 递增；临时文件不触发；`stop()` 后不再回调；root 不存在时自动创建 / 无 root 明确失败。
- `kernel-tests/knowledge-batch4.test.mjs`（5）：`stashDoc` 复制且原文件保留 + 条目 `reason=overwrite` + 可还原让位命名；路径/空间校验；临时文件不进索引；`stats().filesTruncated` 合约字段 + 未截断不留 manifest 痕；`walkMd` 截断置位。
- `kernel-tests/knowledge-cli.test.mjs`（+3）：`--reason` 登记；`stash-doc` 真进程复制留档；失败返回非 0。
- `src/lib/knowledgeRobustness.test.ts`（5）：源码契约守卫 —— 空串前缀失效、乱序批次丢弃、`mentions:`/`brokenLinks:` 双路径失效、编辑器带 mtime + 冲突独立出口 + `onClick` 不裸传、409 冲突信息透出。

## 改动清单（均为修改既有文件，无新增目录）

- 新增：`shared/atomic-write.mjs`、`server/knowledge-watch.mjs`、`shared/atomic-write.test.mjs`、`server/knowledge-watch.test.mjs`、`kernel-tests/knowledge-batch4.test.mjs`、`src/lib/knowledgeRobustness.test.ts`
- 修改：`kernel/knowledge.mjs`、`kernel/knowledge-cli.mjs`、`kernel/cli.mjs`、`server/knowledge-routes.mjs`、`server/bridge.mjs`、`src/lib/knowledgeApi.ts`、`src/hooks/useKnowledge.ts`、`src/hooks/useYFWCLI.ts`、`src/components/knowledge/{KnowledgeEditorView,KnowledgePanel,KnowledgeToolbar}.tsx`、`src/i18n/translations/{zh-CN,en-US}.ts`

## 明确不做

- **目录 fsync**（理由见上，跨平台不一致）。
- **每次保存都备份**：只备份"即将覆盖别人改动"的那次 —— 否则回收站会被每次 Ctrl+S 的副本灌满，
  用户学会无视它，真需要时反而找不到。
- **监听 `index/`、`trash/`**（自激风险）。
- **粒度化增量解析**：watcher 只给"变了"这个事实 + 路径样本，解析是内核的事。
- **批次 3（搜索语法层）**：`field:value`、正则、布尔组合 —— 工程量最大，单独排期。
