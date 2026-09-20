// kit/lib/agent-guide.mjs —— agent 套件规范的**唯一真源**（纯数据 + 一个纯渲染函数）
//
// 为什么单独成文件、而不是写在 kit/AGENT.md 里：
//   同一份清单有**两个**消费出口 —— ① `node kit/gui.mjs --agent`（终端里给 agent 读的纯文本）、
//   ② GUI 第 8 段视图（人读的同一批条目）。清单若各写一份，两份迟早漂移，
//   而"agent 读的规范"与"人看到的规范"不一致是**最坏的一种漂移**（人按 A 做、agent 按 B 做）。
//   ⇒ 真源只有这里一份；kit/AGENT.md 只做指针（见该文件开头的说明），不承载清单内容。
//
// 为什么是**纯数据**（可 JSON.stringify）：
//   GUI 把整包数据内联进单文件 HTML（`<script type="application/json" id="kit-data">`），
//   一旦本对象里混进 Set/Map/函数，内联就会静默丢字段（JSON.stringify 会把它们变成 {} 或直接丢弃）
//   —— 于是"页面上的规范"比真源少几条而没人发现。测试里钉了 JSON round-trip 与"每条 cmd 都在文本里"。
//
// 内容口径：**从当前仓库事实出发**（kit/README.md 的「契约快照与范围登记」「规则表」、
//   docs/ci.md 的「DevKit 台账门禁」、package.json 的 scripts、.github/workflows/ci.yml）。
//   ★ 但**不含** README 的「四条铁律」—— 那是**另一份清单**（sync 字段 / 放行可见 / 扫描域 = `git ls-files` /
//   **真仓数字口径**），真源在 `kit/README.md`，与本文件的 `assertionRules`（**断言与基线纪律**）
//   内容与用途都不同、**并行生效**。此前把两者混称为"铁律"⇒ 同一份指南里"铁律 4"能指到两个东西
//   （README 的"数字口径" vs 本文件的"不许加基线"），照它执行会理解错 ⇒ 现已改名区分。
//   引用的数字（如 CI 行号）由测试**对着真源复核**：ci.line 与 ci.yml 里 `kit:check` 的实际行号必须一致，
//   CI 文件改了行号这条就会红 —— 规范文本不允许"大概对"。

/**
 * agent 套件规范。结构固定为 `{ version, intro, sections[4], assertionRules[], ci }`。
 *
 * `sections[].items[].cmd` 为 `null` 表示"这条没有可复制的命令"（纯纪律项），
 * 刻意用 `null` 而不是省略键：GUI 与文本渲染都要能一眼看出"这条没命令"。
 */
export const AGENT_GUIDE = {
  version: 1,
  intro: '本项目用 DevKit（kit/）做契约快照门禁。任何改动契约面（路由/WS/IPC/工具 schema/台账/版本线）的开发，都必须按下面四段执行。',
  sections: [
    {
      id: 'before',
      title: '开工前（3 步）',
      items: [
        {
          do: '读 `kit/README.md` 的「契约快照与范围登记」（含 committed 口径）与「规则表」（CT0–CT12）两节',
          why: '契约规则的真值取自**提交态（HEAD）**，不是工作树：不懂这条会把 CT8 的在途黄灯当成自己造的错，也会把"跑过 sync 了"误当成"在途端点已入账"。',
          cmd: null,
        },
        {
          do: '先跑 `npm run kit:check`，记下**基线**红灯/黄灯数再动手',
          why: '本仓长期有他人在途改动 ⇒ 报告里的黄灯/红灯未必是你造的。先拿基线才能把"存量"与"本次引入"分开。★ 别照抄"应该是红 0/黄几条"之类数字：**口径必需**（盘根**干净克隆** @ 当时 HEAD 才是权威；本机**主树**因他人在途会多出 CT8 黄灯）。要拿准确数就自己跑一次，别信任何写死在文档里的数字。',
          cmd: 'npm run kit:check',
        },
        {
          do: '`git worktree list` 确认并行工作线；`git status --porcelain` 确认他人在途改动量',
          why: '本仓常态有 4+ 条并行工作线（`git worktree list` 实测）+ **数十项**他人在途改动（数量随时变化，以 `git status --porcelain | wc -l` 实测为准，别信写死的数字）⇒ 绝不许 `git add -A`（会把别人的改动一起提交），也不要在别人的 worktree 里跑 `kit:sync`。',
          cmd: 'git worktree list',
        },
      ],
    },
    {
      id: 'during',
      title: '改动契约面时',
      items: [
        {
          do: '**先提交，再 `npm run kit:sync`**，然后把台账（`kit/manifest/versions.json#channels`）的变化单独提交',
          why: '台账按**提交态**落盘：在途差异不会入账（sync 会打印"工作树有 N 处在途契约差异未落盘"）。顺序反了会把别人未提交的端点写进台账 —— 那是"把在途当已定"的静默失真。',
          cmd: 'npm run kit:sync',
        },
        {
          do: '**人确认** `channels` 的差异：`routes` / `wsOut` / `wsIn` / `tools` 真的变了才提交（逐类看差异条数）',
          why: 'sync 只是复算，判不了"这次契约变更是有意的还是误伤"。快照变了意味着契约真的变了 —— 那要有人点头，不能让它跟着 sync 自动过去。',
          cmd: 'git diff kit/manifest/versions.json',
        },
        {
          do: '`docs/bridge-contract.md` 与实现同步：新端点补 §7/§7.1、WS **按方向**补 §5（出）/§6（入）、IPC 推送补 §11、工具名 + 结构指纹补 §12',
          why: '不同步 ⇒ 提交后 CT2（文档缺声明）与 CT3（文档腐烂）红。CT3 的工具指纹是**逐字相等**，漏一个 8 位哈希就红；WS 方向写反也红（§5 的必须在代码 `ws.out` 里）。',
          cmd: null,
        },
        {
          do: '该文档**不许** `git add <path>`（他人在途改动多）⇒ 走 README 的**局部暂存**：`git show HEAD:<path>` → 改 → `hash-object -w` → `git update-index --cacheinfo`；提交后用三方 `git merge-file` 把工作树补回同步',
          why: '`git add` 会把别人未提交的文档改动一起提交；而局部暂存后**工作树仍是旧版**，下一手只要 `git add` 这份文件，你的改动就被静默覆盖（门禁不会报警，因为 HEAD 是对的）。',
          cmd: 'git diff --numstat -- docs/bridge-contract.md',
        },
        {
          do: '改**工具指纹口径**必须按固定顺序：改 `shapeOfNode` → 同步 `kit/lib/contract-tools.test.mjs` 的两份关键字名单 → `npm run kit:sync` → 同步 §12 的 21 个指纹',
          why: '字段次序就是哈希本身，动一处 21 个指纹全变、CT3 一次报满 21 条红；守卫测试还会扫全仓工具 schema，出现"结构类关键字未在名单里"直接失败（逼后来者显式决定，杜绝静默漏判）。',
          cmd: 'node kit/sync-fingerprints.mjs --check docs/bridge-contract.md',
        },
      ],
    },
    {
      id: 'after',
      title: '交付前（缺一不可）',
      items: [
        {
          do: '`npm run kit:check` ⇒ **红 0**（EXIT=0）',
          why: '台账是提交物、CI 在干净检出上跑同一条命令 ⇒ 本机红灯就是 CI 红灯。有红灯不要提交。',
          cmd: 'npm run kit:check',
        },
        {
          do: '`node --test --test-timeout=120000 "kit/**/*.test.mjs"` ⇒ 全绿（★ glob **必须加引号**）',
          why: '实测：不加引号时 shell 先把 `**` 当单个 `*` 展开 ⇒ 实际只跑 `kit/lib/*.test.mjs`（19 个），**漏掉 `kit/` 根下的两个入口测试** `kit/cli.test.mjs` 与 `kit/gui.test.mjs`。漏跑是静默的（照样打印"全绿"）⇒ 必须加引号让 node 自己展开。',
          cmd: 'node --test --test-timeout=120000 "kit/**/*.test.mjs"',
        },
        {
          do: '`npm run verify:ci` ⇒ EXIT=0',
          why: '这条是 CI 的 test:ci 链路的一部分；verify:ci 挂的是 7 个 verify-*.mjs（milestones/s4-security/skill-listing/experience-inject/knowledge-gui/highrisk/knowledge-import-gui）——漏挂或腐烂都在这里暴露。',
          cmd: 'npm run verify:ci',
        },
        {
          do: '`node scripts/check-doc-anchors.mjs` ⇒ EXIT=0（新增测试文件要先 `git add`，再 `npm run anchors:write`）',
          why: '文档锚点门禁只算**已跟踪**文件：新写的测试文件不 `git add` 就不在域内，本机绿、CI 干净克隆上必红。',
          cmd: 'node scripts/check-doc-anchors.mjs',
        },
        {
          do: '若动了端点/工具面：在**盘根**干净克隆上复算 `routes` / `wsOut` / `wsIn` / `tools` 数与基线比（并自证 `import nanoid` 失败）',
          why: '本仓家目录链上有杂散 node_modules，会把缺声明的包解析到 ⇒ "本机全绿"不构成证据；只有 CI（干净检出）与盘根克隆上的判定才是真实的（★ README「四条铁律」之 4：真仓数字必须写清测的是哪棵树 —— 注意这是 **README 那份**铁律，不是本文件末尾的"断言与基线纪律"）。',
          cmd: 'git clone . C:/p2rev',
        },
      ],
    },
    {
      id: 'redlight',
      title: '红灯怎么修',
      items: [
        {
          do: '`CT1` = 快照 ↔ 从提交态现场重算的代码不一致 ⇒ 跑 `npm run kit:sync`（**先提交**）',
          why: 'CT1 绝不读快照当答案，所以"手改快照"永远修不掉它；它红了通常意味着"提交了端点改动却没 sync"。',
          cmd: 'npm run kit:sync',
        },
        {
          do: '`CT2` = 代码 → 文档：真值里某条在 §5/§6/§7/§7.1/§11/§12 里定位不到 ⇒ 补文档，**或**在 `kit/manifest/contract-scope.json` 登记 scope',
          why: '两条路都是有意的：能写出具体端点就补文档（首选）；确实"没有具体端点可写"（命名空间由运行时 id 拼装）才能登记，且每条必须写清"为什么补不了文档"。',
          cmd: 'node kit/cli.mjs check --verbose',
        },
        {
          do: '`CT3` = 文档 → 代码：文档声明的每条都得真在代码里 ⇒ 文档与实现必须同步（★ 方法**逐个判**）',
          why: '写了方法（含 `（delete）` 这类小写）就得在代码里有相容键（代码为 `ANY` 与任意方法相容）；路径只被动态前缀认领时按规则跳过方法判定。"没声明"与"声明错"是两回事，别把文档写松来换绿。',
          cmd: null,
        },
        {
          do: '`CT4` / `CT4B` / `CT4C` = 范围登记 ⇒ `members` 逐条精确（多一少一都红）、禁 `*`/正则、每条写 `reason`、无重复；新增范围**同时**上调 `channels.scopeCount` / `scopeRedCount`',
          why: '登记做的是**集合相等**，用通配或前缀代替成员清单等于把边界藏起来（CT4C 直接红）；封顶值人工维护是"范围被显式批准"的唯一痕迹，跟着入口自动涨就等于没有门禁。',
          cmd: 'node kit/cli.mjs check --verbose',
        },
        {
          do: '`CT6` = 快照 ↔ 运行时 ⇒ 现场重算（`toolSchemas()` 出口 ⊆ 快照、静态 registry 计数、逐工具结构指纹）',
          why: 'CT3 对的是**快照**、CT6 对的是**运行时**、CT1 对的是**代码**：三者串起来才是传递覆盖。"改坏 kernel/tools.mjs 而 CT3 仍绿"是设计（CT6 会红），不是漏判。',
          cmd: 'node kit/cli.mjs check --verbose',
        },
        {
          do: '`CT8` = 工作树 ∖ HEAD 的在途差异 ⇒ **黄灯、只报不拦**，提交后自己变空；**不要**为它加基线',
          why: '在途改动不是欠账、是这个仓每天的常态。为它加基线会把"真实的已知差异"清单变成垃圾桶，且一旦入账就永远不再报（真实端点键的差异会被永久降级）。',
          cmd: 'npm run kit:check',
        },
        {
          do: '`CT9` = 渲染层 fetch 的历史欠账 ⇒ 基线**必须仍是 5 条且全 CT9**；摘除条目时同步下调 `history.baselineCount`',
          why: '动这条等于伪造门禁：基线条目数超登记值会报 `BASE` 红，而契约对账类规则（CT0–CT8）与品牌规则（CT10）根本不接受基线豁免（`BASELINE_FORBIDDEN`）。',
          cmd: 'node kit/cli.mjs check',
        },
      ],
    },
  ],
  // ★ 这四条**不是** README 的「四条铁律」（sync 字段 / 放行可见 / 扫描域 / 真仓数字口径 —— 那份真源在 README，
  //   并行生效）。它们是**断言与基线纪律**：讲"怎么改测试/基线才算老实"，避免把门禁做成摆设。
  //   此前沿用"铁律"之名，导致同一份指南里"铁律 4"既能指 README 的数字口径、又能指这里的"不许加基线" ⇒ 已改名。
  assertionRules: [
    '不许放宽断言：门禁要能红。删断言、把"精确相等"改成"包含"、把期望值改成实际值，都等于拆门禁。',
    '不许恒真断言：`assert.ok(true)`、`x === x` 这类恒真式，以及"用实现算出来的值当期望值"，都是做假。',
    '不许 `|| true` 吞错：CI 步骤不许 `continue-on-error` / `|| true` / `; exit 0` 把红变绿。',
    '不许靠加基线让红变绿：`drift-baseline.json` 只放**真实的已知差异**（每条写 reason + 何时摘除），条目数不得增加；契约对账类（CT0–CT8）**与品牌规则（CT10）**都不支持基线豁免（`BASELINE_FORBIDDEN`），只有 CT9 的历史欠账可登记。',
  ],
  // ★ 自动注入入口：规范"不必靠 agent 自觉去找"的那一层。此前它**只在会话提示词里被口头描述**、
  //   真源里零登记 ⇒ 改了真源忘改入口不会红（与本批刚修的 `lines[].label` 是同一类"无门禁"漏洞）。
  entry: {
    file: 'AGENTS.md',
    why: '多数 agent 工具（Codex / Cursor / Cline 等）开工时会自动读**仓库根**的这个文件；'
      + 'Ponos 内核自己也自动发现它（`kernel/prompt.mjs`：从 cwd 逐级向上直到 `.git` 所在目录 + `--add-dir` 的根）。'
      + '⇒ 它是"入口层"，**不是**第二份清单。',
    mustMention: [
      {
        id: 'truth-source',
        contains: 'kit/lib/agent-guide.mjs',
        why: '入口必须指出**完整清单在哪**（本文件）。不指出来，入口自己就会长成第二份清单 —— 那必然漂移。',
      },
      {
        id: 'kit-check',
        contains: 'npm run kit:check',
        why: '"开工拿基线 / 交付红 0"必须可见 —— 这是唯一被 CI 拦的命令，agent 不照做整套纪律都落空。',
      },
      {
        id: 'assertion-rules',
        contains: '四条断言与基线纪律',
        why: '入口与真源必须用**同一个名字**称呼这份清单（真源 `assertionRules`），否则会被读成两份不同的规矩。',
      },
      {
        id: 'iron-rules-disambiguation',
        contains: '四条铁律',
        why: '★ 本仓有**两份**"四条"清单（`assertionRules` 与 README 的「四条铁律」）同名不同物、并行生效；'
          + '入口必须点明这一点并指向真源，否则"铁律 4"会被当成同一个东西 —— 这是本批实际修过的误解。',
      },
      {
        id: 'no-add-all',
        contains: 'git add -A',
        why: '本仓常态**数十项**他人在途改动 ⇒ "不许 `git add -A`"是开工第一次提交就会踩的红线。',
      },
      {
        id: 'quote-test-glob',
        contains: '"kit/**/*.test.mjs"',
        why: '引号不是风格问题：不加引号时 shell 把 `**` 当单个 `*`，**静默漏跑** `kit/cli.test.mjs` 与 `kit/gui.test.mjs`。',
      },
    ],
    maxLines: 90,
    maxLinesWhy: '入口写长就必然**变成第二份清单** —— 把真源的内容抄一份，两份漂移是迟早的事。'
      + `真源永远只允许一份（\`kit/lib/agent-guide.mjs\`）：入口只放"入口 + 红线 + 坑"。`,
    // ★ 入口必须能随"更新"进入便携版（调试版）。**用户口径（2026-09-20）**：
    //   "人工测试跑的是 release 中的便携版（调试版）" + "确保调试版更新了不会掉"。
    //   实测这件事此前**完全没有保障**：`AGENTS.md` 不在任何同步清单里 ⇒ 便携版里从来就没有入口，
    //   调试版里跑的 agent **不受规范约束**，而且**症状是静默的**（面板上看不出来 —— 不是"掉了"，
    //   而是"从来没有过"）。所以把它登记进真源、由 CT11 核（删掉清单项即红）。
    // ★ 送达链路本身（内核**怎么发现**入口）—— 这份知识必须留在真源，不能只藏在代码注释里。
    //   实测（2026-09-20）：`release/YFWorking`（便携版/调试版）就在**仓库内部** ⇒ 从它上溯会同时命中
    //   「便携版/AGENTS.md」（同步副本）与「仓库根/AGENTS.md」（原版）= **同一份规范的两份副本**。
    //   内核原按 **path** 去重，挡不住（两个路径不同）⇒ 实测返回 7732 字符 ≈ 两份之和；
    //   而两份若因同步时机不同而漂移（实测 83 行 vs 81 行），模型会同时收到**互相矛盾**的两版规范。
    //   ⇒ `kernel/prompt.mjs#discoverAgentsMd` 必须按**内容**去重（内容相同只留近者那份；内容不同仍各自注入，
    //     多项目规则是设计意图）。CT11 核它还在（`delivery.mustContain`）—— 谁把去重删掉就红。
    delivery: {
      file: 'kernel/prompt.mjs',
      mustContain: ['seenContent'],
      why: '入口送达链路：`discoverAgentsMd({ cwd, addDirs })` 的候选根 = 从 cwd 逐级向上**直到 `.git` 所在目录**'
        + '（含）+ `--add-dir` 的根（`kernel/prompt.mjs:1006` 传的是 `args.addDirs[0]` + 整个 `addDirs`）'
        + '⇒ **同一份规范出现在多个候选路径时必须按内容去重**（否则重复注入；版本漂移时更会注入互相矛盾的两版）。',
    },
    portableSync: {
      why: '人工测试跑的是 `release/YFWorking`（便携版/调试版）⇒ 入口必须能随更新进入便携版，'
        + '否则调试版里的 agent 不受规范约束。★ 三条路径缺哪条都会造成"以为同步了、其实没带上"。',
      paths: [
        { file: 'electron/dev-source-sync.cjs', mustContain: ['AGENTS.md'], what: '调试版**每次启动**的 autoSync（`.yfw-dev-source.json` 的 `autoSync: true`）—— 这条才是人工测试时实际走的路径' },
        { file: 'scripts/verify-portable-layout.mjs', mustContain: ['AGENTS.md'], what: '便携版布局校验（真掉了会让这条红，而不是无声无息）' },
      ],
      // ★ 为什么"打包同步"那条**没**登记成判据（而不是漏了）：
      //   `scripts/package-portable-zip.mjs` 目前**未被 git 跟踪**（他人在途的新文件）。
      //   CT11 读**提交态** ⇒ 若把它登记进 `paths[]`，门禁会**永远红**（读不到文件），
      //   而"永远红"等于没有红灯（本仓最忌）。本批已把它改好（新增 `SYNC_FILES = ['AGENTS.md']`
      //   + `walk()` 之外的单文件循环），等它入库后应**立刻**补进 `paths[]`。
      pending: [{
        file: 'scripts/package-portable-zip.mjs',
        mustContain: ['AGENTS.md'],
        what: '打包/手工同步（`--sync`：把仓库源码同步进 release/YFWorking）—— 少了它，用打包/同步方式更新出来的便携版就没有入口（调试版里 agent 静默不受约束）',
        why: '★ 未跟踪期间不登记成判据（否则门禁永远红 ⇒ "永远红"等于没有红灯）；**一旦它入库就自动开始核**（条件判据，无需人工补登记）。',
      }],
    },
  },
  ci: {
    file: '.github/workflows/ci.yml',
    line: 72,
    script: 'npm run kit:check',
    note: 'DevKit 门禁在 CI 里是**单独一步**（归因：台账漂移 ≠ 测试挂了，一眼可辨）；`npm run test:ci` 链路里也含它，便于本地一条命令跑全。行号由 gui-data 的测试对着 ci.yml 复核 —— 改了 CI 文件的行号，那条测试就会红。',
  },
}

/** 渲染用的一行前缀（人类可读的层次，不参与判据） */
const BAR = '─'.repeat(4)

/**
 * 把 guide 渲染成**纯文本**（终端可直接读；供 agent 用一条命令拿到全部纪律）。
 *
 * 为什么是纯文本而不是 Markdown/JSON：agent 常常是把它 `| head -30` 或整段塞进上下文，
 * 带表格语法的输出会多花 token 且容易被误读；纯文本里每条的 `cmd` 单独一行、以 `$ ` 起头，
 * 可以**直接复制去跑**（GUI 视图里则是 `<code>` + 一键复制）。
 */
export function renderAgentGuideText(guide = AGENT_GUIDE) {
  const lines = []
  lines.push(`DevKit agent 套件规范 v${guide.version}（真源：kit/lib/agent-guide.mjs；GUI 视图见 kit-report.html）`)
  lines.push('')
  lines.push(guide.intro)
  for (const s of guide.sections) {
    lines.push('')
    lines.push(`${BAR} ${s.title}（${s.items.length} 条）${BAR}`)
    s.items.forEach((item, i) => {
      lines.push(`  ${i + 1}. ${item.do}`)
      lines.push(`     为什么：${item.why}`)
      // cmd 可能是 null（纯纪律项）—— 刻意只在有命令时打印，避免出现空的 `$ ` 行让人以为漏了内容
      if (item.cmd) lines.push(`     $ ${item.cmd}`)
    })
  }
  lines.push('')
  lines.push(`${BAR} 四条断言与基线纪律 ${BAR}`)
  guide.assertionRules.forEach((r, i) => lines.push(`  ${i + 1}. ${r}`))
  lines.push('')
  lines.push('★ 另有一套「四条铁律」在 kit/README.md（sync 字段 / 放行可见 / 扫描域 = git ls-files / 真仓数字口径）——')
  lines.push('  那是**另一份清单**、并行生效，真源在 README，本文件不复制其内容。')
  lines.push('')
  lines.push(`CI 锚点：${guide.ci.file}:${guide.ci.line} → ${guide.ci.script}`)
  lines.push(`  ${guide.ci.note}`)
  return lines.join('\n')
}
