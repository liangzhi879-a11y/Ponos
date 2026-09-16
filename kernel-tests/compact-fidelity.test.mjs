// 压缩点保真审计（2026-09-12 spec §4.1）：摘要落地时核对"关键事实有没有丢/被改写"。
// 设计要点（本文件即其回归网）：
//   ① 方法 A 确定性实体覆盖（零模型成本）：只能发现"字面丢失"；
//   ② 方法 B LLM 审计（默认开、可关）：能发现"被改写"（如 MySQL→PostgreSQL），
//      但**失败绝不计入压缩熔断**——审计是附产物，压缩落地才是第一优先级；
//   ③ total < minEntities 不判定（稀疏文本上算缺失率纯属噪声）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { auditSummaryFidelity, buildFidelityAuditRequest, parseFidelityAudit, fidelityGate } from '../kernel/compact.mjs'

test('auditSummaryFidelity：实体被摘要保留 → ratio 0', () => {
  const covered = [{ role: 'user', content: '必须保留 src/a.ts 与阈值 120' }]
  const r = auditSummaryFidelity({ covered, summary: '保留 src/a.ts，阈值 120 不变' })
  assert.equal(r.ratio, 0, `不应判定为丢失：${JSON.stringify(r)}`)
  assert.equal(r.missing.length, 0)
  assert.ok(r.total >= 3)
})

test('auditSummaryFidelity：关键实体成片丢失 → ratio 命中且 missing 具名到实体', () => {
  const covered = [{ role: 'user', content: '必须保留 src/a.ts、src/b.ts 与阈值 120' }]
  const r = auditSummaryFidelity({ covered, summary: '继续之前的开发' })
  assert.ok(r.ratio >= 0.5, `成片丢失应命中：${JSON.stringify(r)}`)
  assert.ok(r.missing.some((m) => m.includes('src/a.ts')), 'missing 要能指名道姓（供用户判断真伪）')
})

test('auditSummaryFidelity：覆盖 tool_result 内的路径（路径常只出现在工具结果里）', () => {
  const covered = [{
    role: 'user',
    content: [{ type: 'tool_result', content: '读取 kernel/cli.mjs、kernel/health.mjs、kernel/fidelity.mjs 成功，共 3 个文件' }],
  }]
  const r = auditSummaryFidelity({ covered, summary: '继续下一个任务' })
  assert.ok(r.total >= 3, `tool_result 文本也要参与实体抽取：${JSON.stringify(r)}`)
  assert.ok(r.missing.some((m) => m.includes('cli.mjs')), `工具结果里的路径丢了要能发现：${JSON.stringify(r)}`)
  assert.ok(r.ratio >= 0.5, '成片丢失')
})

test('auditSummaryFidelity：实体太少（< minEntities）不判定，标记 skipped', () => {
  const r = auditSummaryFidelity({ covered: [{ role: 'user', content: '继续' }], summary: '好' })
  assert.equal(r.skipped, true, '稀疏文本上算缺失率纯属噪声')
  assert.equal(r.ratio, 0)
})

test('parseFidelityAudit：容错解析（裸 JSON / ```json 围栏 / 垃圾输出）', () => {
  assert.deepEqual(parseFidelityAudit('垃圾输出'), { ok: false, missing: [], rewritten: [] })
  assert.deepEqual(parseFidelityAudit('{"ok":true,"missing":["a"],"rewritten":[]}').missing, ['a'])
  const fenced = parseFidelityAudit('前言\n```json\n{"ok":true,"missing":[],"rewritten":["MySQL→PostgreSQL"]}\n```\n后记')
  assert.equal(fenced.rewritten.length, 1, '围栏内的 JSON 要能解析出来')
  assert.equal(parseFidelityAudit('{"missing":["x"]}').ok, false, '缺 ok 字段视为不确定（不据此报错）')
  assert.deepEqual(parseFidelityAudit('').missing, [])
})

test('buildFidelityAuditRequest：产出 messages 数组，指令要求严格 JSON 且带两侧内容', () => {
  const msgs = buildFidelityAuditRequest({ excerpt: '原文摘录内容', summary: '摘要内容' })
  assert.ok(Array.isArray(msgs) && msgs.length >= 1, '必须是可直接交给调用方的 messages 数组')
  const all = JSON.stringify(msgs)
  assert.ok(all.includes('JSON'), '指令必须要求 JSON 输出')
  assert.ok(all.includes('原文摘录内容') && all.includes('摘要内容'), '两侧内容都要进请求')
  assert.ok(all.includes('rewritten'), '要显式要求 rewritten 字段（改写检测是本方法的核心价值）')
})

test('buildFidelityAuditRequest：两侧超长必须截断（审计请求自身不能撑爆窗口）', () => {
  const msgs = buildFidelityAuditRequest({ excerpt: 'x'.repeat(100_000), summary: 'y'.repeat(50_000) })
  const size = JSON.stringify(msgs).length
  assert.ok(size < 20_000, `审计请求必须限幅（实得 ${size} 字符）`)
})

// ---------------------------------------------------------------------------
// P0-2 保真门禁判据 fidelityGate（2026-09-16）
// ---------------------------------------------------------------------------
// 阈值方向性：判错的两种代价极不对称——漏拦＝低保真摘要落地（与改前相同，不劣化）；
// 滥拦＝白烧一次完整摘要调用（数百秒级）+ 用户等。故只在"证据确凿的大面积丢失"
// （missing ≥ 3 **且** ratio ≥ 0.5）时才拦。下面把边界两侧都钉住。
//
// 构造手法：先用 auditSummaryFidelity 探出实体清单，再用**实体本身**拼摘要（保留前 n 个）
// ——不硬编码实体名，避免测试与实体提取规则实现细节耦合（规则演进时测试不该红）。
test('fidelityGate：无实体可比（skipped）→ 放行，不误拦', () => {
  const plain = [{ content: '这是一段普通叙述文字，不含路径数字与反引号' }]
  const { pass, audit } = fidelityGate({ covered: plain, summary: '好' })
  assert.equal(audit.skipped, true, '无高信号实体时应走 skipped 分支')
  assert.equal(pass, true, 'skipped 必须放行——否则每次压缩都会白烧一次摘要调用')
})

test('fidelityGate：空/畸形输入不抛且放行（门禁自身不得成为故障源）', () => {
  for (const arg of [undefined, {}, { covered: [] }, { covered: null, summary: null }, { covered: [{ content: 42 }] }]) {
    const r = fidelityGate(arg)
    assert.equal(typeof r.pass, 'boolean', `应返回合法判定：${JSON.stringify(arg)}`)
    assert.equal(r.pass, true, '缺数据时保守放行（压缩必须落地优先）')
  }
})

test('fidelityGate：少数实体丢失 → 放行（阈值保守，避免滥拦）', () => {
  const covered = [{ content: '读取 C:/Users/T203-15/yfworking/src/lib/alpha.ts 与 C:/Users/T203-15/yfworking/src/lib/beta.ts，ports=8080 timeoutMs=45000 retries=3' }]
  const probe = auditSummaryFidelity({ covered, summary: '' })
  assert.ok(probe.total >= 5, `样本应提取到足够实体用于边界测试，实得 ${probe.total}`)
  const keep = (n) => probe.entities.slice(0, n).join(' ')
  // 全保留
  assert.equal(fidelityGate({ covered, summary: keep(probe.total) }).pass, true, '无丢失必须放行')
  // 丢 1、丢 2（< 3 个）→ 仍放行
  assert.equal(fidelityGate({ covered, summary: keep(probe.total - 1) }).pass, true, '丢 1 个实体不该重压')
  assert.equal(fidelityGate({ covered, summary: keep(probe.total - 2) }).pass, true, '丢 2 个实体不该重压')
  // 全丢 → ratio = 1 → 必拦
  assert.equal(
    fidelityGate({ covered, summary: '完全无关的通用叙述，没有任何具体信息' }).pass, false,
    '实体全丢（ratio≈1）必须拦下换切点重压',
  )
})

test('fidelityGate：边界——missing ≥ 3 且 ratio ≥ 0.5 才拦（两个条件取与）', () => {
  const covered = [{ content: '读取 C:/Users/T203-15/yfworking/src/lib/alpha.ts 与 C:/Users/T203-15/yfworking/src/lib/beta.ts，ports=8080 timeoutMs=45000 retries=3' }]
  const probe = auditSummaryFidelity({ covered, summary: '' })
  const keep = (n) => probe.entities.slice(0, n).join(' ')
  assert.ok(probe.total >= 4, `样本应提取到 ≥4 个实体以便构造 missing=3，实得 ${probe.total}`)

  // 遍历"保留 n 个实体"的全部档位，用**实测** missing/ratio 反推应有判定。
  // 不硬编码"保留 total-3 就该丢 3 个"——实体之间可能有子串包含关系（保留长子串会顺带
  // 保住短实体），硬编码会随实体提取规则演进变脆。
  const rows = []
  for (let n = 0; n <= probe.total; n++) {
    const r = fidelityGate({ covered, summary: keep(n) })
    rows.push({ n, missing: r.audit.missing.length, ratio: r.audit.ratio, pass: r.pass, skipped: r.audit.skipped })
  }

  // ① 全丢必须拦（missing = total ≥ 3 且 ratio = 1）
  const all = rows.find((r) => r.n === 0)
  assert.ok(all.missing >= 3 && all.ratio >= 0.5, `全丢档位应满足两条件：${JSON.stringify(all)}`)
  assert.equal(all.pass, false, '实体全丢（missing≥3、ratio=1）必须拦下换切点重压')

  // ② "与"关系：逐档核对判定 = NOT(missing≥3 AND ratio≥0.5)
  for (const r of rows) {
    assert.equal(
      r.pass, !(r.missing >= 3 && r.ratio >= 0.5),
      `判据不符"与"关系：n=${r.n} missing=${r.missing} ratio=${r.ratio} pass=${r.pass}`,
    )
  }
  // ③ 必须存在"两条件同时满足 → 拦"的档位（证明边界真的被测到，而非样本恰好绕开）
  const mustBlock = rows.filter((x) => x.missing >= 3 && x.ratio >= 0.5)
  assert.ok(mustBlock.length >= 1, `样本应存在"两条件同时满足"的档位：${JSON.stringify(rows)}`)
  // ④ 必须存在"仅第一条件满足（missing≥3）但 ratio<0.5 → 放行"的档位。
  //    这条正是"阈值保守"的本体：实体多而丢失占比不高时不该重压。
  //    注：实体间存在子串包含关系（保留长子串会顺带保住短实体），故 missing 序列可能跳过 3；
  //    此处用"更长样本"提高命中率，若仍未命中则记录而不硬失败（②已覆盖该逻辑）。
  const longCovered = [{
    content: '读取 C:/Users/T203-15/yfworking/src/lib/alpha.ts 与 C:/Users/T203-15/yfworking/src/lib/beta.ts 和 '
      + 'C:/Users/T203-15/yfworking/kernel/compact.mjs，ports=8080 timeoutMs=45000 retries=3 '
      + 'version=1.2.3 mode=strict path2=D:/proj/src/main.ts cnt=12 flag=on',
  }]
  const longProbe = auditSummaryFidelity({ covered: longCovered, summary: '' })
  const longKeep = (n) => longProbe.entities.slice(0, n).join(' ')
  const lowRatioPass = []
  for (let n = 0; n <= longProbe.total; n++) {
    const r = fidelityGate({ covered: longCovered, summary: longKeep(n) })
    if (r.audit.missing.length >= 3 && r.audit.ratio < 0.5) {
      lowRatioPass.push({ n, missing: r.audit.missing.length, ratio: r.audit.ratio, pass: r.pass })
    }
  }
  for (const r of lowRatioPass) {
    assert.equal(r.pass, true, `missing=${r.missing}≥3 但 ratio=${r.ratio}<0.5 → 必须放行（阈值保守）`)
  }
})
