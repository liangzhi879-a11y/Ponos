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

test('真仓 docs/bridge-contract.md：wsOut 27 / wsIn 16 / §7 ≥ 100 条 / §7.1 17 行（文档侧基线）', () => {
  const d = parseDoc(readFileSync(DOC, 'utf8'))
  // ★ P1.5 起 §5/§6 已把"代码有、文档缺"的 9 条补齐（20+6 / 13+3）⇒ 条数从下界改为**精确**：
  //   这两节不受他人在途改动影响（他们只改 §7），故精确值在两个树上都成立，是更强的判据。
  // ★ P1.5 收尾批：§5 再 +1（`browser:event`，26 ⇒ 27）—— 它是**真出站**（`server/browser-routing.mjs`
  //   广播给 GUI），补它之后 CT2/CT3 才能按方向判（否则"代码双向、文档只 §6 声明"会让 `wsOut` 真值非空）。
  assert.equal(d.wsOut.size, 27, `§5 出站事件类型数，实测 ${[...d.wsOut].sort().join(',')}`)
  assert.equal(d.wsIn.size, 16, `§6 入站消息类型数，实测 ${[...d.wsIn].sort().join(',')}`)
  // ★ §7 的**精确**条数仍不钉：文档正被另一批在途改动补充端点（P1.5 后：干净克隆 100 = 32 + 68 distinct
  //   P1.5 条；主树 102 = 再加他人在途的 /app-info、/generate-title）。精确条数属于快照/CT3，不在提取器里硬卡。
  assert.ok(d.routes.size >= 100, `§7 声明的端点条数（P1 批记 ≈38 → P1.5 后 ≥100），实测 ${d.routes.size}`)
  assert.equal(d.workflowRoutes.size, 17, '§7.1 逐行的方法+路径条数')
  for (const p of ['/drives', '/health', '/session/anchor-applied', '/workflows', '/workflows/*',
    // P1.5 补齐的代表性端点（每个命名空间挑一条：漏抽任何一族都会在这里红）
    '/agents', '/disabled', '/skill-detail', '/api/usage', '/team/status', '/boot-status',
    '/knowledge/search', '/file-collab/claim', '/mcp/prompts/get', '/transcript/delete', '/egress/policy']) {
    assert.ok(d.routes.has(p), `§7 必须声明 ${p}`)
  }
  assert.equal(d.routes.get('/providers/*').wildcard, true)
  assert.equal(d.routes.get('/providers/*').docSection, '§7')
  assert.equal(d.routes.get('/session/anchor-applied').method, 'POST')
  assert.ok(d.workflowRoutes.has('GET /workflows') && d.workflowRoutes.has('POST /workflows'))
  // P1.5 补齐的 9 条 WS 类型必须在**正确的那一节**（入站三条进 §6；`bridge_hello` 等出站进 §5）
  for (const t of ['effort', 'ping', 'app:exec:response']) assert.ok(d.wsIn.has(t), `§6 必须声明入站类型 ${t}`)
  for (const t of ['bridge_hello', 'pong', 'approval-expired', 'kernel-stall', 'knowledge_changed', 'provider_updated']) {
    assert.ok(d.wsOut.has(t), `§5 必须声明出站类型 ${t}`)
  }
  // `app-info` 是**路由**（且属他人在途的代码+文档）⇒ 任何情况下都不得出现在 WS 集合里
  assert.equal(d.wsIn.has('app-info') || d.wsOut.has('app-info'), false, '`/app-info` 是端点，不是 WS 类型（不得混进 §5/§6）')
})

test('真仓 §11/§12（P1.5 新增面）：7 条 IPC 推送 + 21 个工具，指纹与台账逐字相等', () => {
  const d = parseDoc(readFileSync(DOC, 'utf8'))
  // §11：IPC 推送侧（主进程 → 渲染层）。这里钉的是**文档 ↔ 台账**的一致（台账是提交物、
  // 由 CT1 保证可从代码复算）——工具指纹尤其重要：它是 CT3 逐字比对的那一份。
  assert.equal(d.ipc.size, 7, `§11 通道数，实测 ${[...d.ipc].sort().join(',')}`)
  assert.deepEqual([...d.ipc].sort(), [
    'app:generate-progress', 'boot:progress', 'diag:status-changed', 'editor:open-file',
    'editor:sync-bounds', 'experience:pending-alert', 'gpu:crash',
  ])
  // §12：工具出口。名字集与指纹都直接对台账（versions.json#channels.tools）——不写死 21 个名字，
  // 铁律 4：真仓数字会随他人改动漂移；"逐字相等"才是判据（名字多一个少一个都会红）。
  const ledger = JSON.parse(readFileSync(join(ROOT, 'kit/manifest/versions.json'), 'utf8')).channels.tools
  assert.deepEqual([...d.tools.keys()].sort(), Object.keys(ledger).sort(),
    `§12 的工具名集必须与台账一致（实测 doc=${d.tools.size} / 台账=${Object.keys(ledger).length}）`)
  const mismatch = [...d.tools.entries()].filter(([n, v]) => v.fp !== ledger[n]).map(([n, v]) => `${n}: doc=${v.fp} 台账=${ledger[n]}`)
  assert.deepEqual(mismatch, [], `§12 的指纹必须与台账逐字相等：${mismatch.join(' | ')}`)
  assert.equal([...d.tools.values()].every((v) => typeof v.fp === 'string' && /^[0-9a-f]{8}$/.test(v.fp)), true,
    '§12 的每一行都必须给出 8 位十六进制指纹（缺了就 null，由 CT3 报红）')
  assert.deepEqual(d.sections.get('§12').types, [...d.tools.keys()], '§12 的 types = 该节声明的工具名清单')
})

// ── 批 M：**方法维度**（§7 的行内方法必须逐条入账，同路径多方法不得互相覆盖）──────
//
// 为什么要这三条（此前是"真做假面"）：`routes` 的 key 是 **path** ⇒
//   ① 同一路径在多行声明（`/api/profile` 的读行 + `（POST）` 写行）时，**后一条整条丢失**
//      （`if (!routes.has(p))` 只留第一条）⇒ 方法声明凭空消失；
//   ② 方法只从**行尾全角括号**里读 ⇒ 反引号里的行内方法（`POST /x`、`GET/POST /x`）**整条端点
//      都解析不出来**（旧解析器要求 token 以 `/` 开头，`GET /x` 直接 continue）⇒ 静默漏声明。
// 解析器只如实记录"文档写了什么方法"，判定（相容/不相容）留给 CT3（见 contract-rules.test.mjs）。
const FIXTURE_METHODS = [
  '# 契约夹具（方法维度）',
  '',
  '## 7. HTTP REST API',
  '',
  '| 端点 | 用途 |',
  '|---|---|',
  '| `/config`、`/providers` | 配置读写（这行没写方法 ⇒ 该路径方法集为空，不猜 GET） |',
  '| `/api/profile` | 读档案（同一路径的**另一行**写了方法：旧解析器会把它整条丢掉） |',
  '| `/api/profile`（POST） | 写档案 |',
  '| `GET /a`、`POST /b` | 行内方法写在反引号里（两个 token 各带一个方法） |',
  '| `GET/POST /c` | 一个 token 里两种方法（逐个判） |',
  '| `/d`、`/e`（PUT） | 行尾全角括号的方法适用于本行**未自带宽方法**的 token |',
  '| `/f` (DELETE/PATCH) | 行尾半角括号同样认（`(A/B)` 形态） |',
  '',
].join('\n')

test('★批 M —— §7 方法入账：同路径多方法不互相覆盖、行内方法（`POST /x` / `GET/POST`）、行尾括号适用本行', () => {
  const d = parseDoc(FIXTURE_METHODS)
  const lineOf = (needle) => FIXTURE_METHODS.split('\n').findIndex((l) => l.includes(needle)) + 1
  assert.deepEqual([...d.routes.keys()].sort(),
    ['/a', '/api/profile', '/b', '/c', '/config', '/d', '/e', '/f', '/providers'],
    '行内方法形态（`GET /a`、`GET/POST /c`）也必须被解析成端点，不得整条漏掉')
  // ① 同路径多方法：两行声明**合并**进同一路径的值（旧实现只留第一行 ⇒ POST 声明凭空消失）
  assert.deepEqual([...d.routes.get('/api/profile').methods], ['POST'])
  assert.equal(d.routes.get('/api/profile').method, 'POST', '兼容字段 `method` = 按字典序首个被声明的方法（此前因覆盖而恒为 null）')
  assert.equal(d.routes.get('/api/profile').methodLines.get('POST'), lineOf('写档案'),
    '每个方法都要能反查它出现的行（finding 要指到那一行）')
  assert.equal(d.routes.get('/api/profile').line, lineOf('读档案'), '`line` 仍是首次声明那行（既有消费方语义不变）')
  // ② 没写方法的路径：方法集为空、`method` 为 null（不猜 GET —— 一猜就是海量假红）
  assert.equal(d.routes.get('/config').method, null)
  assert.equal(d.routes.get('/config').methods.size, 0)
  assert.equal(d.routes.get('/providers').methods.size, 0)
  // ③ 行内方法形态：token 自带方法（`GET /a`、`POST /b`、`GET/POST /c`）
  assert.deepEqual([...d.routes.get('/a').methods], ['GET'])
  assert.deepEqual([...d.routes.get('/b').methods], ['POST'])
  assert.deepEqual([...d.routes.get('/c').methods].sort(), ['GET', 'POST'], '一个 token 里的 `GET/POST` 逐个记')
  // ④ 行尾括号（全角/半角）适用于本行所有未自带宽方法的 token
  assert.deepEqual([...d.routes.get('/d').methods], ['PUT'])
  assert.deepEqual([...d.routes.get('/e').methods], ['PUT'])
  assert.deepEqual([...d.routes.get('/f').methods].sort(), ['DELETE', 'PATCH'])
  // 章节反查：同一条路径声明两行时**只记一次**（也不是"少记一行"：rows 仍是 7）
  assert.equal(d.sections.get('§7').rows, 7)
  assert.deepEqual([...d.sections.get('§7').routes].sort(), [...d.routes.keys()].sort())
  assert.equal(d.sections.get('§7').routes.length, 9, '9 条 distinct 路径（/api/profile 两行声明只记一次）')
})

test('★批 M —— 确定性：方法集合与顺序无关（`GET/POST` 与 `POST/GET` 解析结果相同）', () => {
  const dump = (text) => JSON.stringify({
    routes: [...parseDoc(text).routes.entries()]
      .map(([p, v]) => [p, [...v.methods].sort(), v.method, [...(v.methodLines || new Map())].sort()])
      .sort(),
  })
  assert.equal(dump(FIXTURE_METHODS), dump(FIXTURE_METHODS), '同输入必同输出（可复算）')
  const swapped = FIXTURE_METHODS.replace('`GET/POST /c`', '`POST/GET /c`').replace('(DELETE/PATCH)', '(PATCH/DELETE)')
  assert.equal(dump(swapped), dump(FIXTURE_METHODS), '方法次序是噪声：`GET/POST` 与 `POST/GET` 必须给出同一结果')
  assert.notEqual(dump(FIXTURE_METHODS.replace('/api/profile`（POST）', '/api/profile`（DELETE）')), dump(FIXTURE_METHODS),
    '改一个方法必须能被看见（否则 CT3 的方法判据就是恒真的）')
})

// ── 批 M 复审：方法名**大小写不敏感** + 结果**规范化为大写** ──────────────────────
//
// 为什么必须单列（审查发现的**可绕过口**，且此前**零测试覆盖**）：判据（CT3 的方法维度）在，
// 但输入一变小写就整条失效 —— 三种失效方向都不一样，正好把"假绿"和"误导性红"都覆盖了：
//   ① 行尾括号写小写 `（delete）` ⇒ 旧解析器只认大写 ⇒ 该条被当成"没写方法" ⇒ **静默绿**
//      （按规则③"文档没写方法 ⇒ 不判方法"跳过，门禁毫无反应）；
//   ② 反引号里写小写 `post /x` ⇒ 旧解析器要求 token 以 `/` 开头 ⇒ **整条端点消失** ⇒ 反被 CT2 报
//      "代码有、文档没有"（红是红了，但红在错的地方，会把维护者引向"补文档"而不是"改大小写"）；
//   ③ §7.1 写小写 `get /workflows` ⇒ 整行解析不出 ⇒ 既不在 `paths` 也不在 `routeMethods`
//      ⇒ **连 CT2 都不红**（纯假绿：这一行的路径与方法都不参与任何对账）。
// 规范化到**大写**是判据的前提（不是美观）：`Set`/`Map` 是逐字键 —— 若 `post` 与 `POST` 并存，
// `methods.size` 会虚高、CT3 会各判一半，台账与快照也会跟着漂。
const FIXTURE_CASE = [
  '# 契约夹具（方法名大小写）',
  '',
  '## 7. HTTP REST API',
  '',
  '| 端点 | 用途 |',
  '|---|---|',
  '| `/alpha`（post） | 行尾括号写小写（① 静默绿的那一类） |',
  '| `delete /beta` | 行内方法写小写（② 整条消失的那一类） |',
  '| `GET/POST /gamma` | 大小写混排的 token（方法名与路径都要能拆） |',
  '| `/delta`（put 同义） | 同义注释写小写：**仍不是**方法声明（只是注解） |',
  '',
  '### 7.1 工作流模块',
  '',
  '| 方法 + 路径 | 请求体 | 响应（成功） |',
  '|---|---|---|',
  '| `get /workflows` | — | `{ ok:true }` |',
  '| `PUT /workflows/bindings`（post 同义） | `{ agents }` | `{ ok:true }` |',
  '',
].join('\n')

test('★批 M 复审① —— 方法名大小写不敏感：小写括号（不再静默绿）、小写行内（不再整条消失）、小写 §7.1 键', () => {
  const d = parseDoc(FIXTURE_CASE)
  // ③ 小写 §7.1 键：整行必须解析出来（旧解析器 ⇒ 这条路径与方法**都不进任何集合** = 纯假绿）
  assert.deepEqual([...d.workflowRoutes.keys()].sort(), ['GET /workflows', 'PUT /workflows/bindings'],
    '§7.1 的小写 `get /workflows` 必须被解析成 `GET /workflows`；同义注释不另生成键')
  assert.equal([...d.workflowRoutes.keys()].every((k) => {
    const m = k.slice(0, k.indexOf(' '))
    return m === m.toUpperCase()
  }), true, '键里的方法必须规范化成大写（否则 `get /x` 与 `GET /x` 在 Map 里是两个键，各判一半）')
  // ① 行尾括号小写：必须是"写了 POST"，而不是"没写方法"（后者会让 CT3 跳过 ⇒ 静默绿）
  assert.deepEqual([...d.routes.get('/alpha').methods], ['POST'], '`（post）` 与 `（POST）` 必须等价')
  assert.equal(d.routes.get('/alpha').method, 'POST')
  // ② 行内小写：端点本身必须存在（旧解析器让 `/beta` 整条消失 ⇒ CT2 误导性红）
  assert.deepEqual([...d.routes.keys()].sort(), ['/alpha', '/beta', '/delta', '/gamma'])
  assert.deepEqual([...d.routes.get('/beta').methods], ['DELETE'])
  // 混排 token：方法集与路径都拆对
  assert.deepEqual([...d.routes.get('/gamma').methods].sort(), ['GET', 'POST'])
  // 同义注释（小写形态）**仍不判**：`（put 同义）` 不给 `/delta` 发放 PUT 声明，也不改 `（post 同义）` 的语义
  assert.equal(d.routes.get('/delta').methods.size, 0, '同义注释是"也接受"的注解，不是"这一行声明的方法"')
  assert.equal(d.routes.has('/delta'), true)
  assert.deepEqual(d.workflowRoutes.get('PUT /workflows/bindings').synonyms, ['POST'],
    '`（post 同义）` 照旧只记 synonyms（加 `i` 只防"小写把注释丢掉"，注解语义未变）')
  assert.equal(d.workflowRoutes.has('POST /workflows/bindings'), false,
    '同义注释**不得**生成一条"必须存在"的方法声明（否则门禁会凭空多出假红）')
})

test('★批 M 复审② —— 大小写是噪声而非信息：同一份契约的大小写两版必须解析出**逐字相同**的结果', () => {
  const UPPER = FIXTURE_CASE
    .replace('（post）', '（POST）')
    .replace('`delete /beta`', '`DELETE /beta`')
    .replace('（put 同义）', '（PUT 同义）')
    .replace('`get /workflows`', '`GET /workflows`')
    .replace('（post 同义）', '（POST 同义）')
  assert.notEqual(UPPER, FIXTURE_CASE, '夹具替换必须真的生效（否则这条等价断言是恒真式）')
  const dump = (text) => JSON.stringify({
    routes: [...parseDoc(text).routes.entries()].map(([p, v]) => [p, [...v.methods].sort(), v.method, [...(v.methodLines || new Map())].sort()]).sort(),
    // `raw` 刻意保留**原文**（大小写原样，供 finding/复查看），它不是判据 ⇒ 不参与等价性比较；
    // 其余字段（键、同义注释、行号、章节）都必须逐字相同。
    wf: [...parseDoc(text).workflowRoutes.entries()]
      .map(([k, v]) => [k, { synonyms: v.synonyms, row: v.row, line: v.line, section: v.section }]).sort(),
  })
  assert.equal(dump(FIXTURE_CASE), dump(UPPER),
    '大小写不该影响任何结论：小写形态必须与大写形态给出同一份解析结果（含方法集、兼容字段、行号映射）')
  assert.equal(parseDoc(FIXTURE_CASE).workflowRoutes.get('GET /workflows').raw, 'get /workflows',
    '`raw` 保留原文（只有规范化后的键/方法集参与判定）')
  // 不是恒真式：把小写换成**另一个**方法必须能被看见
  assert.notEqual(dump(FIXTURE_CASE.replace('（post）', '（delete）')), dump(FIXTURE_CASE),
    '改方法名（不只是改大小写）必须能被看见')
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
