// kit/lib/contract-doc.test.mjs —— T5 契约文档解析器（DevKit P1 · 契约快照）
//
// 为什么必须有这些断言：
//   · 文档侧是"受控子集"（plan §1 方案 B）：解析结果**只**声明文档说了什么，不做任何推断。
//     §5/§6 表按 ` / ` 拆行（`milestones` / `milestone-start` / `milestone-ok` 是三件事）；
//     §7 每行按反引号 + 顿号分组（一行可以声明 5 条端点）；§7.1 逐行给"方法 + 路径"。
//   · **文档里的 `*` 不给覆盖信用**（plan §7 反例 ⑧）：`/providers/*` 只声明命名空间，
//     子路径**不得**被凭空展开 —— 解析器若把 `*` 展开或抹掉标记，T7 的"未覆盖面登记"就会假绿。
//   · 每条解析结果都要能**反查回章节**（`sections`）：对账报告要给"文档缺失/文档腐烂"定位到节。
//   · 文档腐烂是真相之一：§7.1 的 `PUT /workflows/bindings`（POST 同义）与代码的 405 冲突 ——
//     解析器只如实记录，判定留给 T7；测试钉住"它确实被解析出来了，没有被人肉抹平"。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDoc } from './contract-doc.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const DOC = join(ROOT, 'docs/bridge-contract.md')

const FIXTURE_DOC = [
  '# 桥接契约（夹具）',
  '',
  '## 3. 内核 stdin 协议（bridge → kernel）',
  '',
  '| type | 载荷 | 语义 |',
  '|---|---|---|',
  "| `user` | `{ message }` | 投递一轮用户消息 |",
  "| `loop_command` | `{ op }` | loop 指令族 |",
  "| `control_request` | `{ request }` | 中断/取消 |",
  "| `control_response` | `{ response }` | 审批回执 |",
  '',
  '## 5. WebSocket：bridge → GUI（outbound 事件）',
  '',
  '| type | 载荷 | 说明 |',
  '|---|---|---|',
  "| `event` | `{ data }` | 内核事件原样包装转发 |",
  "| `ack` | `{ requestId, sessionId }` | `send` 已受理 |",
  "| `milestones` / `milestone-start` / `milestone-ok` | 标记数据 | 结构化进度 |",
  "| `pet:show-main` / `pet:quit-app` | `{}` | 宠物广播 |",
  '',
  '## 6. WebSocket：GUI → bridge（inbound 消息）',
  '',
  '| type | 载荷 | 语义 |',
  '|---|---|---|',
  "| `send` | `{ sessionId }` | 发消息 |",
  "| `cancel` | `{ sessionId }` | 优雅停止 |",
  "| `executor:hello` | — | 执行器注册 |",
  '',
  '## 7. HTTP REST API（同端口 51517）',
  '',
  '| 端点 | 用途 |',
  '|---|---|',
  '| `/drives`、`/list-dir`、`/save-temp-image` | 文件系统访问 |',
  '| `/session/anchor-applied`（POST） | 锚定上报 |',
  '| `/config`、`/providers`、`/providers/*` | 配置读写 |',
  '',
  '### 7.1 工作流模块（`/workflows`）',
  '',
  '| 方法 + 路径 | 请求体 | 响应（成功） |',
  '|---|---|---|',
  '| `GET /workflows` | — | `{ ok:true, workflows:[…] }` |',
  '| `POST /workflows` | `{ id, model?, yaml? }` | `{ ok:true, id }` |',
  '| `GET /workflows/runs?name=<wfId>`（兼容 `?id=`） | — | `{ ok:true, runs:[…] }` |',
  '| `PUT /workflows/bindings`（POST 同义） | `{ agents, trusted }` | `{ ok:true }` |',
  '',
].join('\n')

test('★§5/§6：反引号分组（一行可声明多条），去重后按节归类', () => {
  const d = parseDoc(FIXTURE_DOC)
  assert.deepEqual([...d.wsOut].sort(),
    ['ack', 'event', 'milestone-ok', 'milestone-start', 'milestones', 'pet:quit-app', 'pet:show-main'])
  assert.deepEqual([...d.wsIn].sort(), ['cancel', 'executor:hello', 'send'])
  // §3/§4 同样解析（契约里有 stdin/stdout 两张表），但**不混进** wsOut/wsIn
  assert.deepEqual(d.sections.get('§3').types, ['user', 'loop_command', 'control_request', 'control_response'])
  assert.equal(d.wsOut.has('user'), false, '内核 stdin 类型不是 WS 事件')
})

test('★§7：每行按反引号 + 顿号分组；（POST）给方法；`*` 只声明命名空间、不展开', () => {
  const d = parseDoc(FIXTURE_DOC)
  assert.deepEqual([...d.routes.keys()].sort(),
    ['/config', '/drives', '/list-dir', '/providers', '/providers/*', '/save-temp-image', '/session/anchor-applied'],
    '一行里的多条端点必须逐条拆出来（顿号分组）')
  assert.equal(d.routes.get('/session/anchor-applied').method, 'POST', '（POST）是文档声明的方法，必须读出来')
  assert.equal(d.routes.get('/config').method, null, '没写方法就是 null（不猜 GET）')
  assert.equal(d.routes.get('/providers/*').wildcard, true)
  assert.deepEqual(d.sections.get('§7').wildcards, ['/providers/*'], '通配必须单列给对账用')
  assert.equal(d.routes.has('/providers/xyz'), false,
    '`*` 不得被展开成子路径 —— 那等于给未覆盖面凭空发放覆盖信用（plan §7 反例 ⑧）')
  assert.equal(d.sections.get('§7').rows, 3, '表行数（表头与分隔行不算）')
})

test('★§7.1 逐行：方法 + 路径成键；query 与（注解）剥掉；同义方法如实记录', () => {
  const d = parseDoc(FIXTURE_DOC)
  assert.deepEqual([...d.workflowRoutes.keys()].sort(),
    ['GET /workflows', 'GET /workflows/runs', 'POST /workflows', 'PUT /workflows/bindings'])
  assert.equal(d.workflowRoutes.get('GET /workflows/runs').raw, 'GET /workflows/runs?name=<wfId>',
    'raw 保留原文（query 剥掉但原文可查）')
  assert.deepEqual(d.workflowRoutes.get('PUT /workflows/bindings').synonyms, ['POST'],
    '（POST 同义）必须如实记录：代码只认 GET/PUT，这种冲突要能被 T7 看见（文档腐烂）')
  assert.equal(d.sections.get('§7.1').rows, 4)
})

test('★sections 反查：每条解析结果都能回到它的章节（行号可定位）', () => {
  const d = parseDoc(FIXTURE_DOC)
  assert.deepEqual([...d.sections.keys()].sort(), ['§3', '§5', '§6', '§7', '§7.1'])
  assert.equal(d.sections.get('§5').title.includes('bridge → GUI'), true)
  assert.ok(d.sections.get('§5').line > 1)
  assert.deepEqual([...d.sections.get('§5').types].sort(), [...d.wsOut].sort())
  assert.deepEqual([...d.sections.get('§7').routes].sort(), [...d.routes.keys()].sort())
  assert.equal(d.sections.get('§7').routes.every((p) => d.routes.get(p).section === '§7'), true)
  assert.equal(d.sections.get('§7.1').workflowRoutes.every((k) => d.workflowRoutes.get(k).section === '§7.1'), true)
})

test('★确定性：同一份文本两次解析逐字相同（快照可复算）', () => {
  const a = parseDoc(FIXTURE_DOC)
  const b = parseDoc(FIXTURE_DOC)
  const dump = (d) => JSON.stringify({
    wsOut: [...d.wsOut].sort(), wsIn: [...d.wsIn].sort(),
    routes: [...d.routes.entries()].sort(), workflowRoutes: [...d.workflowRoutes.entries()].sort(),
    sections: [...d.sections.entries()].sort(),
  })
  assert.equal(dump(a), dump(b))
  assert.notEqual(dump(a), dump(parseDoc(FIXTURE_DOC.replace('`ack`', '`ack2`'))), '改一个字必须能被看见（不是恒真式）')
})

test('真仓 docs/bridge-contract.md：wsOut 20 / wsIn 13 / §7 ≥ 32 条 / §7.1 17 行（文档侧基线）', () => {
  const d = parseDoc(readFileSync(DOC, 'utf8'))
  assert.equal(d.wsOut.size, 20, `§5 出站事件类型数，实测 ${[...d.wsOut].sort().join(',')}`)
  assert.equal(d.wsIn.size, 13, `§6 入站消息类型数，实测 ${[...d.wsIn].sort().join(',')}`)
  // ★ §7 的**精确**条数刻意不钉：文档正被另一批在途改动补充端点
  //   （HEAD 上 32 条，工作树已 35 条）—— 精确条数属于快照/CT3（T7），不在提取器里硬卡。
  //   这里只钉不受在途改动影响的部分：计数下界 + 秳固的端点 + 逐项属性。
  assert.ok(d.routes.size >= 32, `§7 声明的端点条数（P1 计划记 ≈38），实测 ${d.routes.size}`)
  assert.equal(d.workflowRoutes.size, 17, '§7.1 逐行的方法+路径条数')
  for (const p of ['/drives', '/health', '/session/anchor-applied', '/workflows', '/workflows/*']) {
    assert.ok(d.routes.has(p), `§7 必须声明 ${p}`)
  }
  assert.equal(d.routes.get('/providers/*').wildcard, true)
  assert.equal(d.routes.get('/providers/*').docSection, '§7')
  assert.equal(d.routes.get('/session/anchor-applied').method, 'POST')
  assert.ok(d.workflowRoutes.has('GET /workflows') && d.workflowRoutes.has('POST /workflows'))
  // 代码侧有、文档侧没有的（如 §6 缺 effort/ping/app:exec:response）是**真差异**，
  // 这里只钉住"解析器如实呈现"：文档 §6 的 13 条里不得混进代码特有的那三条
  for (const t of ['effort', 'ping', 'app:exec:response', 'app-info']) {
    assert.equal(d.wsIn.has(t) || d.wsOut.has(t), false, `${t} 不在文档里就不该被解析出来（不得凭代码补文档）`)
  }
})

// ── P1.5：§11（IPC 推送通道）与 §12（工具结构指纹）──────────────────────────
//
// 新增章节的**目的**：把"只能登记、无法对账"的两类（IPC / 工具 input_schema）拉回文档面 ⇒
// 契约对账回到"文档 ↔ 代码"直接双向（P1 的 92 条登记降到只剩无法文档化的空洞）。
// 解析纪律与 §5/§6 **完全相同**（反引号分组、一行可多条、` / ` 与顿号二次拆），另加两条：
//   I4 §11/§12 同样**只解析章节的第一张连续表**（后文的示例表不得混进声明集）；
//   I5 §12 的**指纹必须被反引号包住**且形如 8 位十六进制 —— 表里散文中的裸串不算、缺指纹即
//      `fp:null`（由 CT3 报红）。理由：指纹是被**逐字比对**的东西，靠"扫行内像不像指纹"来猜
//      等于把判定交给正则的宽容度；宁可要求写清，也不要"猜对了就绿"。
const FIXTURE_P15 = [
  '# 契约夹具（P1.5）',
  '',
  '## 11. IPC 通道（main ↔ renderer 推送）',
  '',
  '表外散文里的 `ch:not-a-decl` 不算声明（只有表内才进集合）。',
  '',
  '| 通道 | 方向 | 时机 |',
  '|---|---|---|',
  '| `app:generate-progress` | main → renderer | 生成长任务进度 |',
  '| `boot:progress` / `gpu:crash` | main → renderer | 启动进度与 GPU 崩溃 |',
  '',
  '下面这张表是**示例**，不得进声明集：',
  '',
  '| 通道 | 方向 |',
  '|---|---|',
  '| `zzz-second-table` | main → renderer |',
  '',
  '## 12. 工具 input_schema 出口',
  '',
  '| 工具 | 结构指纹 | 用途 |',
  '|---|---|---|',
  '| `Agent` | `1977c7ba` | 委派子 Agent |',
  '| `Bash` | `055829fc` | 执行 shell 命令 |',
  '| `NoFp` | 缺指纹 | 故意不包反引号（必须解析成 null，不得猜） |',
  '',
].join('\n')

test('★§11/§12（P1.5）：IPC 通道进 Set、工具名+指纹进 Map；只取第一张连续表、指纹必须反引号', () => {
  const d = parseDoc(FIXTURE_P15)
  assert.deepEqual([...d.ipc].sort(), ['app:generate-progress', 'boot:progress', 'gpu:crash'],
    '一行可声明多条（` / ` 拆）；表外散文的反引号不进集合')
  assert.equal(d.ipc.has('ch:not-a-decl'), false, '§11 的声明只来自表内')
  assert.equal(d.ipc.has('zzz-second-table'), false, '只解析章节的**第一张**连续表（后文示例表不算声明）')
  assert.deepEqual([...d.tools.keys()].sort(), ['Agent', 'Bash', 'NoFp'])
  assert.equal(d.tools.get('Agent').fp, '1977c7ba', '指纹逐字取反引号里的 8 位十六进制')
  assert.equal(d.tools.get('Bash').fp, '055829fc')
  assert.equal(d.tools.get('NoFp').fp, null, '缺指纹（没包反引号）⇒ null，绝不猜（由 CT3 报红）')
  for (const n of d.tools.keys()) {
    assert.equal(Number.isInteger(d.tools.get(n).row) && d.tools.get(n).line > 1, true, `${n} 必须能反查行号`)
  }
  // 章节反查与形状：§11/§12 各自进 sections（types = 该节声明的名字清单）
  assert.deepEqual([...d.sections.keys()].sort(), ['§11', '§12'])
  assert.deepEqual([...d.sections.get('§11').types].sort(), [...d.ipc].sort())
  assert.deepEqual([...d.sections.get('§12').types].sort(), [...d.tools.keys()].sort())
  assert.equal(d.sections.get('§11').rows, 2, '表行数（表头与分隔行不算）')
  assert.equal(d.sections.get('§12').rows, 3)
  // 确定性：同输入必同输出（快照/复算的前提）；改一个字必须能被看见（不是恒真式）
  const dump = (x) => JSON.stringify({ ipc: [...x.ipc].sort(), tools: [...x.tools.entries()] })
  assert.equal(dump(parseDoc(FIXTURE_P15)), dump(d))
  assert.notEqual(dump(parseDoc(FIXTURE_P15.replace('1977c7ba', '1977c7bb'))), dump(d),
    '指纹改一位必须能被看见 —— 否则 CT3 的"逐字比对"就是恒真的')
  // 完全没有 §11/§12 的文档 ⇒ 两个集合为空（解析器是纯增量，老文档不炸）
  const old = parseDoc(FIXTURE_DOC)
  assert.equal(old.ipc.size, 0)
  assert.equal(old.tools.size, 0)
})
