import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  MODEL_COORD_MAX, ABS_COORD_MAX, READ_ACTS, INPUT_ACTS, ACT_SPECS,
  IMPLEMENTED_ACTS, ALL_ACTS, isInputAct, fieldsOfAct,
  KEY_NAME_MAP, KEY_MODIFIER_MAP, SENDKEYS_NATIVE_RE, normalizeKeySequence,
  TEXT_MAX_CODE_UNITS, normalizeTextInput,
  SEQUENCE_STEP_ACTS, MAX_SEQUENCE_STEPS, MAX_STEP_WAIT_MS, normalizeSequenceSteps,
} = require('./screen-contract.cjs')

test('坐标域常量与 spec §3.3 一致', () => {
  assert.equal(MODEL_COORD_MAX, 1000, '模型面 0..1000（把分辨率适配挪到驱动器侧）')
  assert.equal(ABS_COORD_MAX, 65535, 'SendInput MOUSEEVENTF_ABSOLUTE 的 0..65535 原生域')
})

test('★ P2d：登记面与实现面 —— 登记的输入 act 现在**全部**已实现（typeText / sequence 是最后两条）', () => {
  // ★ **改写说明（不是放宽断言）**：本条原为"P2b 已实现 5 条，P2d 的 typeText 仍未实现"。
  //   那条断言是「P2d 是欠账」的编码；2026-10-17 实现 typeText/sequence 后该欠账已清 ⇒
  //   命题换成**更强**的一条：登记面里的每个输入 act 都必须已实现（"只登记不实现"= 假契约），
  //   同时仍然钉住"未实现的 act 不得出现在 IMPLEMENTED_ACTS 里"这条原意 —— 现在的实现方式是
  //   "登记面与实现面必须相等"，比原来只盯一条 typeText 覆盖面更宽。
  for (const a of READ_ACTS) {
    assert.ok(IMPLEMENTED_ACTS.includes(a), `只读 act ${a} 必须已实现`)
    assert.equal(isInputAct(a), false, `${a} 是只读 act，不得发输入`)
  }
  for (const a of ['move', 'clickAt', 'drag', 'scroll', 'keyCombo', 'typeText', 'sequence']) {
    assert.ok(INPUT_ACTS.includes(a), `${a} 必须登记为输入 act`)
    assert.equal(isInputAct(a), true)
    assert.ok(IMPLEMENTED_ACTS.includes(a), `${a} 必须已实现（否则审批按 act 分类无从谈起）`)
  }
  // ★ 登记面 ≡ 实现面里的输入部分（没有"登记了但没实现"的 act 留作占位）
  const declaredInput = INPUT_ACTS.filter((a) => !READ_ACTS.includes(a)).sort()
  const implInput = IMPLEMENTED_ACTS.filter((a) => !READ_ACTS.includes(a)).sort()
  assert.deepEqual(declaredInput, implInput, '登记的输入 act 必须与已实现的输入 act **完全一致**')
})

test('只读与输入 act 不重叠；ALL_ACTS 是两者并集且去重', () => {
  const overlap = READ_ACTS.filter((a) => INPUT_ACTS.includes(a))
  assert.deepEqual(overlap, [], '同一 act 不得同时是只读与输入')

  // ★ P2c（2026-10-15）：只读实现面从 3 条变 4 条（+ `look` 视觉定位 —— 它只读，不发输入）。
  const implRead = IMPLEMENTED_ACTS.filter((a) => READ_ACTS.includes(a)).sort()
  assert.deepEqual(implRead, ['capture', 'displays', 'look', 'windows'], '只读实现面 = P2a 三条 + P2c 的 look')

  // 已实现的输入 act：P2b 的 5 条 + P2d 的 typeText / sequence
  const implInput = IMPLEMENTED_ACTS.filter((a) => !READ_ACTS.includes(a)).sort()
  assert.deepEqual(implInput, ['clickAt', 'drag', 'keyCombo', 'move', 'scroll', 'sequence', 'typeText'],
    '已实现的输入 act = P2b 五条 + P2d 的 typeText/sequence')

  // 两者并集必须**恰好**等于已实现集合（不许有无归属的实现，也不许漏）
  assert.deepEqual([...implRead, ...implInput].sort(), IMPLEMENTED_ACTS,
    'IMPLEMENTED_ACTS 必须恰是「只读 act ∪ 已实现的输入 act」')

  // ALL_ACTS = 只读 ∪ 输入，且去重
  assert.deepEqual(ALL_ACTS, [...new Set([...READ_ACTS, ...INPUT_ACTS])].sort())
})

// ─────────────────────────────────────────────────────────────────────────────
// 2026-10-15 真机冒烟修复 #2 / C2：`keyCombo.value` 是**键名**，不是要输入的文本
// ─────────────────────────────────────────────────────────────────────────────

test('★ C2：键名 → SendKeys 语法 —— 键名不是文本，认不出一律拒（绝不逐字打出去）', () => {
  // 根因（真机实测）：`SendKeys::SendWait` 把**裸字符串当要输入的文本** —— `keyCombo{value:"Enter"}`
  // 打出的是字母 E-N-T-E-R（靶窗地面真值 KEY_DOWN code 69/78/84/69/82）**且工具报 ok:true**。
  // ① 具名键（大小写不敏感）
  assert.deepEqual(normalizeKeySequence('Enter'), { ok: true, value: '{ENTER}' })
  assert.deepEqual(normalizeKeySequence('enter'), { ok: true, value: '{ENTER}' })
  assert.deepEqual(normalizeKeySequence('Return'), { ok: true, value: '{ENTER}' })
  assert.deepEqual(normalizeKeySequence('TAB'), { ok: true, value: '{TAB}' })
  assert.deepEqual(normalizeKeySequence('Esc'), { ok: true, value: '{ESC}' })
  assert.deepEqual(normalizeKeySequence('Space'), { ok: true, value: '{SPACE}' })
  assert.deepEqual(normalizeKeySequence('Backspace'), { ok: true, value: '{BACKSPACE}' })
  assert.deepEqual(normalizeKeySequence('Del'), { ok: true, value: '{DELETE}' })
  assert.deepEqual(normalizeKeySequence('PageUp'), { ok: true, value: '{PGUP}' })
  assert.deepEqual(normalizeKeySequence('F5'), { ok: true, value: '{F5}' })
  assert.deepEqual(normalizeKeySequence('f24'), { ok: true, value: '{F24}' })
  // ② 组合键（spec §4 与工具描述给模型的例子就是 Enter / Ctrl+C）
  assert.deepEqual(normalizeKeySequence('Ctrl+C'), { ok: true, value: '^c' })
  assert.deepEqual(normalizeKeySequence('Control+C'), { ok: true, value: '^c' })
  assert.deepEqual(normalizeKeySequence('Shift+Tab'), { ok: true, value: '+{TAB}' })
  assert.deepEqual(normalizeKeySequence('Alt+F4'), { ok: true, value: '%{F4}' })
  assert.deepEqual(normalizeKeySequence('Ctrl+Shift+S'), { ok: true, value: '^+s' })
  // ③ 单个字母数字：**原样**（回归：老行为 b -> b 不得变）
  assert.deepEqual(normalizeKeySequence('b'), { ok: true, value: 'b' })
  assert.deepEqual(normalizeKeySequence('7'), { ok: true, value: '7' })
  // ④ SendKeys 原生写法原样（与 uia 的 key act 同口径）
  assert.deepEqual(normalizeKeySequence('^s'), { ok: true, value: '^s' })
  assert.deepEqual(normalizeKeySequence('%{F4}'), { ok: true, value: '%{F4}' })
  assert.deepEqual(normalizeKeySequence('{ENTER}'), { ok: true, value: '{ENTER}' })
  assert.deepEqual(normalizeKeySequence('+{TAB}'), { ok: true, value: '+{TAB}' })
  // ⑤ ★ 认不出 ⇒ **错误**（绝不返回"原样发出去"—— 那正是 C2 的失败模式）
  for (const bad of ['NoSuchKey', 'Hello World', '50% off', 'abc', 'x+y', 'Ctrl+NoSuchKey', '', '   ']) {
    const r = normalizeKeySequence(bad)
    assert.equal(r.ok, false, `${JSON.stringify(bad)} 必须被拒（不得当字面文本发出去）`)
    assert.equal(typeof r.error, 'string')
    assert.ok(r.error.length > 6, '提示必须是一句可执行的话，不是占位符')
  }
  // ⑥ 表本身的形状（防悄悄缩水成两三个键）
  assert.ok(Object.keys(KEY_NAME_MAP).length >= 45, `键名表太小（${Object.keys(KEY_NAME_MAP).length}）`)
  assert.deepEqual(KEY_MODIFIER_MAP, { ctrl: '^', control: '^', alt: '%', shift: '+' })
  for (const n of ['enter', 'return', 'tab', 'esc', 'escape', 'space', 'backspace', 'delete', 'insert',
    'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown']) {
    assert.ok(KEY_NAME_MAP[n], `键名表缺 ${n}`)
  }
  for (let i = 1; i <= 24; i++) assert.equal(KEY_NAME_MAP[`f${i}`], `{F${i}}`, `F${i} 必须齐（SendKeys 支持到 F24）`)
})

test('★ C2：翻译必须**幂等**且结果都是合法的 SendKeys 写法（两侧都翻时不叠加语义）', () => {
  // 为什么重要：翻译在两处可能发生（执行器构造期校验用契约侧规格、真值侧 ps1 真的翻译）。
  // 若翻译不幂等，"两侧都翻一次"就得到第三种结果 ⇒ 排障时看到的行为与生产不一致。
  for (const [name, token] of Object.entries(KEY_NAME_MAP)) {
    assert.ok(SENDKEYS_NATIVE_RE.test(token), `${name} 的记号 ${token} 必须是合法的 SendKeys 写法`)
    assert.deepEqual(normalizeKeySequence(token), { ok: true, value: token }, `翻译必须幂等：${token}`)
  }
  for (const v of ['Enter', 'Ctrl+C', 'Ctrl+Shift+S', 'Shift+Tab', 'b']) {
    const once = normalizeKeySequence(v).value
    assert.deepEqual(normalizeKeySequence(once), { ok: true, value: once }, `${v} -> ${once} 再翻译必须不变`)
  }
})

test('★ C2：原生写法的判据必须是**严格单键语法**，不能"含元字符就放行"', () => {
  // 放宽成"含 + ^ % ~ ( ) { } [ ] 就放行"会把"逐字打出文本"这条最坏的路径放回来：
  // 文本里的 `50%`、`(note)` 恰好含元字符 ⇒ 会被当 SendKeys 写法原样发出去。
  assert.ok(SENDKEYS_NATIVE_RE.test('^c'))
  assert.ok(SENDKEYS_NATIVE_RE.test('%{F4}'))
  assert.ok(SENDKEYS_NATIVE_RE.test('{ENTER}'))
  assert.ok(SENDKEYS_NATIVE_RE.test('{+}'))
  assert.ok(SENDKEYS_NATIVE_RE.test('+{TAB}'))
  for (const text of ['50% off', '(note)', 'a+b', 'E~mail', '^hello', '{ENTER}x', 'abc def']) {
    assert.ok(!SENDKEYS_NATIVE_RE.test(text), `${JSON.stringify(text)} 是**文本**，不得被当 SendKeys 写法放行`)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// P2d（2026-10-17）：`typeText` 的**文本**语义 + `sequence` 的步骤面
//
// 为什么这两条要写在契约测试里：typeText 与 keyCombo 是**语义相反**的两个 act
// （文字 vs 键名），而 C2 的根因正是"两种语义被塞进同一个字段且没写下来"。
// 故契约必须把两条边界都钉住：文本**不做键名翻译**、键名**不做文本发送**、
// 控制字符既不进文本（会变成"顺手发了个回车"）、也不静默截断。
// ─────────────────────────────────────────────────────────────────────────────

test('★ P2d：typeText 收的是**字面文本**（中文/emoji 都要能打），绝不当键名翻译', () => {
  assert.deepEqual(normalizeTextInput('PONOS_DEMO_1017'), { ok: true, text: 'PONOS_DEMO_1017' })
  assert.deepEqual(normalizeTextInput('演示文本'), { ok: true, text: '演示文本' })
  assert.deepEqual(normalizeTextInput(' 前导与尾随空格 '), { ok: true, text: ' 前导与尾随空格 ' },
    '不得 trim：空格是用户真要打的字符，悄悄裁掉就是"报成功但内容不对"')
  // ★ 关键回归：这些串在 keyCombo 里是**键名或非法**，在 typeText 里就是普通文字
  for (const t of ['Enter', 'Ctrl+C', '50% off', '(note)']) {
    assert.deepEqual(normalizeTextInput(t), { ok: true, text: t }, `${JSON.stringify(t)} 作为文本必须原样接受`)
    // 反向：它作为键名要么被翻译、要么被拒（总之不会"原样发这一串字"）
    const k = normalizeKeySequence(t)
    assert.ok(k.ok === false || k.value !== t, `${JSON.stringify(t)} 在 keyCombo 里不得原样当文本发出去（C2 的失败模式）`)
  }
  // SendKeys **原生写法**（`{ENTER}` / `^s`）：在 keyCombo 里是语法（原样放行、由 SendKeys 解释），
  // 在 typeText 里就是这 6 个字符本身 —— 同一个串在两条路上的含义**不同且都明确**，这正是拆成两个
  // act 的理由（含糊才会出 C2 那种"报成功但内容错"）。
  for (const t of ['{ENTER}', '^s']) {
    assert.deepEqual(normalizeTextInput(t), { ok: true, text: t })
    assert.deepEqual(normalizeKeySequence(t), { ok: true, value: t }, `${t} 在 keyCombo 里是 SendKeys 语法`)
  }
  // emoji：非 BMP 字符 = 2 个 UTF-16 码元（真值侧逐码元发送，故长度按码元计）
  // ★ 用「🎉」（U+1F389）而不是「✅」（U+2705）：后者在 BMP 内、只占 1 个码元，测不出代理对。
  const emoji = normalizeTextInput('完成🎉')
  assert.equal(emoji.ok, true)
  assert.equal(emoji.text.length, 4, '「完成🎉」= 2 个汉字 + 1 个代理对(2 码元) = 4 个码元')
})

test('★ P2d：typeText 的三条拒收（空 / 控制字符 / 超长），且绝不静默截断', () => {
  assert.equal(normalizeTextInput('').ok, false)
  assert.equal(normalizeTextInput(null).ok, false)
  assert.equal(normalizeTextInput(123).ok, false, '非字符串必须拒（不是 [object Number] 这种糊上去）')
  for (const t of ['a\nb', 'a\tb', 'a\r\nb', '\u0000', '\u001B[31m', 'x\u007Fy']) {
    const r = normalizeTextInput(t)
    assert.equal(r.ok, false, `${JSON.stringify(t)} 含控制字符，必须拒（要回车请用 keyCombo）`)
    assert.match(r.error, /控制字符/, '理由必须说清是控制字符')
    assert.match(r.error, /keyCombo/, '必须给出可执行的替代（回车/制表用 keyCombo）')
  }
  // 边界：恰好上限通过，多一个码元即拒（且**不是**截断后照发）
  const atLimit = 'x'.repeat(TEXT_MAX_CODE_UNITS)
  assert.deepEqual(normalizeTextInput(atLimit), { ok: true, text: atLimit }, `恰好 ${TEXT_MAX_CODE_UNITS} 码元必须通过`)
  const over = normalizeTextInput('x'.repeat(TEXT_MAX_CODE_UNITS + 1))
  assert.equal(over.ok, false)
  assert.equal(over.text, undefined, '超限时不得回吐"截断后"的文本（静默截断=报成功但少了一半）')
  assert.match(over.error, /分批/, '必须给出可执行的下一步')
})

test('★ P2d：sequence 的步骤面是**白名单**（只读 act 与未验收的 drag/scroll 一律拒）', () => {
  assert.deepEqual(SEQUENCE_STEP_ACTS, ['move', 'clickAt', 'keyCombo', 'typeText', 'wait'])
  assert.ok(MAX_SEQUENCE_STEPS > 0 && MAX_STEP_WAIT_MS > 0)
  const ok = normalizeSequenceSteps([
    { act: 'clickAt', x: 900, y: 800, button: 'right' },
    { act: 'wait', ms: 700 },
    { act: 'keyCombo', value: 'w' },
    { act: 'typeText', value: '演示' },
    { act: 'keyCombo', value: 'Enter' },
  ])
  assert.equal(ok.ok, true, JSON.stringify(ok))
  assert.deepEqual(ok.steps[0], { act: 'clickAt', x: 900, y: 800, button: 'right' })
  // 规范化只保留真值侧真读的字段（多传的字段不转发 —— 免得"多发一个字段"悄悄改变行为）
  const extra = normalizeSequenceSteps([{ act: 'typeText', value: 'a', target: 'x', window: 'w' }])
  assert.deepEqual(extra.steps, [{ act: 'typeText', value: 'a' }], '未登记的字段不得被转发到真值侧')

  // 拒：只读 act / 未验收的输入 act / 结构错误 / 越界 / 空
  for (const bad of [
    [{ act: 'capture' }],
    [{ act: 'look', target: 'x' }],
    [{ act: 'drag', from: { x: 1, y: 1 }, to: { x: 2, y: 2 } }],
    [{ act: 'scroll', delta: 120 }],
    [{ act: 'clickAt', x: 2000, y: 1 }],
    [{ act: 'clickAt', x: 1.5, y: 1 }],
    [{ act: 'clickAt', x: 1, y: 1, button: '左键' }],
    [{ act: 'wait' }],
    [{ act: 'wait', ms: MAX_STEP_WAIT_MS + 1 }],
    [{ act: 'keyCombo', value: 'NoSuchKey' }],
    [{ act: 'typeText', value: 'a\nb' }],
    [{ act: 'move' }],
    [],
    'not-an-array',
  ]) {
    const r = normalizeSequenceSteps(bad)
    assert.equal(r.ok, false, `${JSON.stringify(bad)} 必须被拒`)
    assert.ok(String(r.error).length > 6, '拒绝理由必须可读')
  }
  // 步数上限
  const many = Array.from({ length: MAX_SEQUENCE_STEPS + 1 }, () => ({ act: 'wait', ms: 1 }))
  assert.equal(normalizeSequenceSteps(many).ok, false, `超过 ${MAX_SEQUENCE_STEPS} 步必须拒（不静默丢步）`)
  assert.equal(normalizeSequenceSteps(many.slice(0, MAX_SEQUENCE_STEPS)).ok, true, '恰好上限必须通过')
})

test('★ P2d：typeText / sequence 都是**输入 act**（审批、授权闸、急停都按同一判据）', () => {
  assert.equal(isInputAct('typeText'), true)
  assert.equal(isInputAct('sequence'), true)
  assert.deepEqual(fieldsOfAct('typeText'), ['value', 'window', 'hwnd'])
  assert.deepEqual(fieldsOfAct('sequence'), ['steps', 'window', 'hwnd'])
  // 它们都不是"鼠标类"（自验只按告警档：文本/序列合法地会改变前台）
  const { isMouseAct } = require('./screen-contract.cjs')
  assert.equal(isMouseAct('typeText'), false)
  assert.equal(isMouseAct('sequence'), false)
})
