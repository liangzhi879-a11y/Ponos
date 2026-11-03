'use strict'
/**
 * `Screen` 工具的 **act 契约唯一真源**（P2 computeruse 像素层，P2a）。
 *
 * 为什么必须有这个模块：Screen 的 act 清单与字段面要在**四处**保持一致 ——
 *   ① `kernel/tools.mjs` 的 input_schema（暴露给模型）
 *   ② `kernel/engine.mjs` 的 `runScreen`（转发）
 *   ③ `electron/screen-executor.cjs` 的 argv 构造（真读哪些字段）
 *   ④ `electron/screen.ps1` 的参数读取（真值侧）
 * 四处各写一份必然漂移（uia 侧就踩过：`DESKTOP_CONTRACT` 给 `focus` 写了 `ref`，
 * 而桌面侧根本没有元素编号概念，见 uia spec §2）。故收敛成一份数据 + 契约测试对账
 *（`kernel-tests/screen-contract.test.mjs`，手法同 `kernel-tests/app-uia-contract.test.mjs`）。
 *
 * 分层：本模块**不 import electron/**（它是底层契约，反过来被 electron/kernel 引用；
 * 与真实实现的一致性由测试对账，同 `shared/app-control-commands.cjs` 先例）。
 *
 * CJS + ESM 双用：`electron/*.cjs` 直接 require；kernel/server（ESM）走 default 导入。
 */

/** 模型面坐标域：0..1000（把分辨率适配从模型侧挪到驱动器侧，模型不接触绝对像素） */
const MODEL_COORD_MAX = 1000

/** `SendInput(MOUSEEVENTF_ABSOLUTE)` 的原生归一化域 */
const ABS_COORD_MAX = 65535

/**
 * 只读 act（不发送任何键鼠输入、也不抢前台）—— P2a 实现的就是这一组，P2b 未改动它们。
 * ★ 审批分类按本清单给 `read`（任何档位自动执行）：这正是"输入 act 每次必问、只读 act 不打扰"
 *   那条验收（spec §6 A5）的依据 —— 见 `kernel/approval-mode.mjs` 的 `classifyTool`。
 */
const READ_ACTS = ['displays', 'windows', 'capture', 'look']

/**
 * 输入 act —— **"哪些 act 会发真实键鼠"的真源**（与 `ACT_SPECS` 的"实现面"分工不同、互不替代）。
 * P2b（2026-10-15）实现了 `move`/`clickAt`/`drag`/`scroll`/`keyCombo`；
 * P2d（2026-10-17）补齐 `typeText`（SendInput Unicode 直发，见 `normalizeTextInput`）与
 * `sequence`（**同一请求内**连续多步 —— 桌面右键菜单这类短生命周期弹窗的唯一可行路径）。
 * ★ 本清单仍是"会发输入"的**唯一判据**：审批分类（`kernel/approval-mode.mjs`）、执行器的授权闸、
 *   接管/急停的硬拒绝都取它 ⇒ 新增输入 act 只需登记在这里 + `ACT_SPECS`。
 */
const INPUT_ACTS = ['move', 'clickAt', 'drag', 'scroll', 'typeText', 'keyCombo', 'sequence']

/**
 * **Node 侧 act**：由主进程直接执行的**复合动作**，**不下发到 PowerShell 真值侧**。
 *
 * 为什么必须把它与"真值侧 act"分开（2026-10-15 P2c 实测教训）：
 *   `look`（视觉定位）内部要**先截图、再 OCR、再做匹配与坐标换算**，全程在 Node 侧；
 *   `electron/screen.ps1` 根本不认识它。若不区分，契约与 ps1 的 act 表对账
 *   （`kernel-tests/screen-contract.test.mjs` 的"四面一致"）就会**永远红**。
 * ⇒ 对账规则：`ps1 侧 act = IMPLEMENTED_ACTS 去掉 NODE_ACTS`（导出为 `ps1Acts()`），
 *   再与 ps1 的 `$script:ScreenActs` 比。加 Node 侧 act 时**只需改这里**。
 */
const NODE_ACTS = ['look']

/**
 * act → 字段面。**只登记真实现的字段**（P2a 的只读三条 + P2b 的坐标类输入五条）。
 * `required` ∪ `optional` = 该 act 真读的全部字段（对账判据）。
 *
 * ★ 有意**不含** `save`：P2a 的截图不落盘（spec §3.5 S5）；声明一个不实现的字段
 *   正是 spec §2.1 批评过的"契约占位"。要留痕时（P2e）再加，届时同步对账测试。
 * ★ 输入 act 的字段面（P2b spec §4）：
 *   `x`/`y` 是**模型面 0..1000**（相对**目标窗口矩形**），`delta` 是**有符号**滚轮格数
 *   （正数=向上，与直觉相反），`button` ∈ left/right/middle（缺省 left），
 *   `value` 是按键序列（如 `Enter` / `Ctrl+C`）。
 *   ★ `value` 的**语义**（C2 修复后）：它是**键名**，不是要输入的文本 —— 翻译表在 `KEY_NAME_MAP`
 *     / `KEY_MODIFIER_MAP`，认不出的键名一律 BadArg（绝不退化成逐字符打字）。
 *   ★ 0..1000 → 0..65535 的映射**不在 Node 侧**：它必须按"发送那一刻"的目标窗矩形算
 *   （窗口可能在感知与动作之间被移动/缩放），故归 `electron/screen.ps1`
 *   —— 跨语言公式对账由 `kernel-tests/screen-coord-parity.test.mjs` 锁死。
 */
const ACT_SPECS = {
  displays: { required: [], optional: [] },
  // includePopups：把无标题弹窗（菜单/下拉框，class 形如 '#32768'）也列出来 ——
  // 要看/点菜单就得先知道它在哪（缺了它菜单在 windows 结果里是"不存在"的）
  windows: { required: [], optional: ['filter', 'includePopups'] },
  // ★ P2c 视觉定位（Node 侧复合 act，见 NODE_ACTS）：在截图里按文字找目标，给出可直接点用的坐标。
  //   ★ P2d：需要窗口的 act，`window`（标题）与 `hwnd` **至少给一个**；hwnd 用于同名多实例。
  //   `region` 与 `window` 二选一（**必须给范围** —— 不接受"没有任何范围"的截图）；
  //   `frame` 指定归一化坐标系（缺省 = 本次截图矩形）；`minScore` 是 OCR 置信度下限（不达标即失败，不猜）。
  look: { required: ['target'], optional: ['window', 'hwnd', 'region', 'windowRegion', 'frame', 'minScore', 'allowSlowOcr'] },
  // region（"x,y,w,h"）：按屏幕矩形截图 —— 用于截**菜单/下拉框**这类独立顶层窗口
  capture: { required: [], optional: ['window', 'hwnd', 'scope', 'region'] },
  // ── P2b（2026-10-15）：坐标类**输入**（会真的发键鼠；授权闸在构造期，见 screen-executor.cjs）──
  // ★ P2d：`x/y` 与 `target` **二选一** —— 用 `target`（自然语言）时由执行器**在同一次调用内**
  //   先用 look 定位、再点击（消除"看着时在这、点的时候窗口已动"的竞态，也省一次往返）。
  //   故 `x/y` 从 required 移到 optional；真正的"二选一"由 `buildScreenCommand` 在构造期强制。
  move: { required: [], optional: ['window', 'hwnd', 'x', 'y', 'target', 'minScore'] },
  clickAt: { required: [], optional: ['window', 'hwnd', 'x', 'y', 'button', 'target', 'minScore'] },
  drag: { required: ['from', 'to'], optional: ['window', 'hwnd', 'button'] },
  scroll: { required: ['delta'], optional: ['window', 'hwnd', 'x', 'y'] },
  keyCombo: { required: ['value'], optional: ['window', 'hwnd'] },
  // ── P2d（2026-10-17）：**字面文本**输入 ────────────────────────────────────────────────
  // ★ 与 `keyCombo` 的分工就是 C2 的教训本身：`keyCombo.value` 是**键名**（`Enter`），
  //   `typeText.value` 是**要打出来的文字**（`PONOS_DEMO_1017` / 中文）。两者语义相反，故拆成两个 act，
  //   而不是"让 keyCombo 顺便支持文本"—— 那条路正是"静默发出错误内容"的老家。
  // 真值侧：SendInput + KEYEVENTF_UNICODE **逐 UTF-16 码元**直发（不经过键盘布局/IME 组字），
  //   故中文、日文、emoji 都能打；也因为逐码元发送，长度按**码元**计数（见 TEXT_MAX_CODE_UNITS）。
  typeText: { required: ['value'], optional: ['window', 'hwnd'] },
  // ── P2d：**同一请求内**的多步序列（唯一的跨步字段是 steps）──────────────────────────────
  // 为什么必须有它（实测结论，不是设计偏好）：桌面/菜单这类**短生命周期弹出窗口**在"一个动作一次
  // 进程 + 启动抢前台"的模型下，菜单在下一个动作到达前就关了 —— 2026-10-15 十余次尝试仅偶然成功 1 次，
  // 加延时（450/800/1200ms）全部无效（机制冲突，不是时序问题）。`sequence` 把整串动作放进**同一次**
  // 请求：闸门（授权/锚定/进程核对/抢前台/矩形）只跑一次，随后按 steps 顺序发送。
  sequence: { required: ['steps'], optional: ['window', 'hwnd'] },
}

/** 真正实现的 act（真值侧有分支的）—— 由 `ACT_SPECS` 的键派生，故扩契约时自动跟随 */
const IMPLEMENTED_ACTS = Object.keys(ACT_SPECS).sort()

/** 全部登记过的 act（含未实现的） */
const ALL_ACTS = [...READ_ACTS, ...INPUT_ACTS].sort()

/**
 * 输入 act 的**小写索引**。必需，因为 `INPUT_ACTS` 里有驼峰名（`clickAt` / `typeText`），
 * 而 `isInputAct` 按大小写不敏感口径比较 —— 直接 `INPUT_ACTS.includes(lowercased)` 对这两个
 * act 恒为 false（`'clickat' !== 'clickAt'`）。方向是 **fail-open**（调用方会当它不是输入 act
 * 而放行），正是 P2a 最不能出错的地方，故此处显式建索引。
 */
const INPUT_ACT_SET = new Set(INPUT_ACTS.map((a) => a.toLowerCase()))

/** 是否输入类 act（P2b 起才可能为真；P2a 的调用方据此 fail-closed 拒绝） */
function isInputAct(act) {
  return INPUT_ACT_SET.has(String(act ?? '').trim().toLowerCase())
}

/**
 * 输入 act 中**动光标**的那一组（P2b 自验的判据分档，2026-10-15 安全审查修复）。
 *
 * 为什么这是一个契约事实、而不是执行器里随手写的一份名单：自验的**硬度**按它分档 ——
 *   · 鼠标类（本清单）：发送后必须回报**测量到的**证据，并且是**硬判据**
 *     （`foregroundAfter` = 发送后 GetForegroundWindow 是否仍等于目标窗；
 *      `cursorAfter` = GetCursorPos 与本次意图像素的偏差）；
 *   · `keyCombo`（**不在**本清单）：同样回报测量值，但只作**报告与告警** ——
 *     组合键合法地可能改变焦点（`Ctrl+Tab`/`Alt+Tab`），把"焦点变了"当失败会制造假失败，
 *     而假失败的常见修法是"把判据关掉"（那才是真风险）。见 `verifyScreenFrame`。
 * ⇒ 名单写在契约真源里，执行器与真值侧各取所需，不各写一份。
 */
const MOUSE_ACTS = ['move', 'clickAt', 'drag', 'scroll']

/** 鼠标类 act 的**小写索引**（理由同 `INPUT_ACT_SET`：`clickAt` 是驼峰名） */
const MOUSE_ACT_SET = new Set(MOUSE_ACTS.map((a) => a.toLowerCase()))

/** 是否为"动光标"的输入 act（自验的硬判据范围） */
function isMouseAct(act) {
  return MOUSE_ACT_SET.has(String(act ?? '').trim().toLowerCase())
}

// ─────────────────────────────────────────────────────────────────────────────
// `keyCombo.value` 的**键名 → SendKeys 语法**映射（P2b 真机冒烟修复 #2 / C2，2026-10-15）
//
// 为什么必须是契约事实、而不是 ps1 里的私事：WinForms `SendKeys::SendWait` 把**裸字符串当"要输入的
// 文本"**。真机实测（自建靶窗 + 地面真值）：`keyCombo{value:'Enter'}` 返回 `ok:true`，而靶窗记录到的
// 是 `KEY_DOWN code 69/78/84/69/82` —— 打出的是字母 E-N-T-E-R，**不是回车键**；`Ctrl+C` 同理会被当
// 字面文字打出去。工具报成功、内容却错 ⇒ 调用方与模型都发现不了（静默做错事是最坏的失败模式）。
// ⇒ 模型面给的是**键名**，发送前必须翻译成 SendKeys 语法；**翻译不了就报错**，绝不原样当文本发。
//
// ★ 与 uia 的 `key` act 共用**同一张表**：`electron/app-uia-exec.cjs` 的 `KEY_ALIASES`（P1 起就在用，
//   2026-09-21 真机冒烟 14/14）。两条路径各写一份键名，同一个键名就会在一侧变成组合键、在另一侧
//   变成一段文字 —— 故 `kernel-tests/screen-contract.test.mjs` 把两张表**逐项对账**（改一处漏一处即红）。
const KEY_NAME_MAP = {
  enter: '{ENTER}', return: '{ENTER}', cr: '{ENTER}',
  tab: '{TAB}', esc: '{ESC}', escape: '{ESC}',
  space: '{SPACE}', spacebar: '{SPACE}',
  backspace: '{BACKSPACE}', bs: '{BACKSPACE}',
  del: '{DELETE}', delete: '{DELETE}',
  ins: '{INSERT}', insert: '{INSERT}',
  up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}',
  home: '{HOME}', end: '{END}',
  pageup: '{PGUP}', pgup: '{PGUP}', pagedown: '{PGDN}', pgdn: '{PGDN}',
  f1: '{F1}', f2: '{F2}', f3: '{F3}', f4: '{F4}', f5: '{F5}', f6: '{F6}',
  f7: '{F7}', f8: '{F8}', f9: '{F9}', f10: '{F10}', f11: '{F11}', f12: '{F12}',
  f13: '{F13}', f14: '{F14}', f15: '{F15}', f16: '{F16}',
  f17: '{F17}', f18: '{F18}', f19: '{F19}', f20: '{F20}', f21: '{F21}', f22: '{F22}',
  f23: '{F23}', f24: '{F24}',
}

/**
 * 组合键的**修饰键名 → SendKeys 前缀**。模型面写法是 `Ctrl+C` / `Shift+Tab` / `Alt+F4`
 *（契约与 spec §4 的例子就是这两个），而 SendKeys 要的是 `^c` / `+{TAB}` / `%{F4}`。
 * 大小写不敏感（`ctrl` / `Ctrl` / `CONTROL` 都收）。
 */
const KEY_MODIFIER_MAP = { ctrl: '^', control: '^', alt: '%', shift: '+' }

/**
 * SendKeys **原生写法**的严格语法：可选修饰前缀（`^` Ctrl / `%` Alt / `+` Shift / `~` Enter）
 * + 恰好**一个**按键记号（`{ENTER}`、转义元字符 `{+}`、或单个字母数字）。
 *
 * 为什么要一条**严格**语法、而不是"含元字符就放行"：`{` `}` `^` `%` `+` `~` `(` `)` `[` `]` 只是
 * SendKeys 的元字符，一段**文本**里出现其中一个（`50%`、`(note)`）就放行的话，"逐字打出文本"
 * 这条最坏的路径又回来了（`Hello World!` 虽不含元字符会被拒，`50% off` 却会被放行）。故只认
 * 完整合法的单键写法；其余一律 BadArg。
 */
const SENDKEYS_NATIVE_RE = /^[+^%~]*(?:\{[A-Za-z0-9]+\}|\{[+^%~(){}[\]]\}|[A-Za-z0-9])$/

/**
 * **纯函数**：模型面按键序列 → SendKeys 语法（`node` 侧是**可执行规格**；生产路径上真正生效的
 * 那份在 `electron/win-safety.ps1` 的 `ConvertTo-SendKeysValue`，两者由
 * `kernel-tests/screen-key-parity.test.mjs` 逐例对账）。
 *
 * 规则（顺序即优先级）：
 *   ① 组合键 `Mod[+Mod…]+Key`：修饰键查 `KEY_MODIFIER_MAP`，末键查 `KEY_NAME_MAP` 或单个字母数字
 *      （末键的大小写不敏感 —— `Ctrl+C` 与 `Ctrl+c` 都是 Ctrl+C；大写字母在 SendKeys 里是
 *      **Shift+该键**，那正是组合键要显式表达的东西，故此处不靠大小写暗示 Shift）；
 *   ② 单个字母数字：**原样**（`b` → `b`；`B` → SendKeys 的 Shift+B，这是 SendKeys 的既有语义）；
 *   ③ 具名键（`Enter` / `F5` / `PageUp`，大小写不敏感）→ 查表；
 *   ④ SendKeys 原生写法（`^s` / `%{F4}` / `{ENTER}` / `+{TAB}`）→ 原样（与 uia `key` act 同口径）；
 *   ⑤ 其余一律 **BadArg** —— 绝不把认不出的键名当字面文本发出去。
 *
 * @param {unknown} value
 * @returns {{ok:true, value:string} | {ok:false, error:string}}
 */
function normalizeKeySequence(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return { ok: false, error: 'keyCombo 必须有非空 value（键名，如 "Enter" / "Ctrl+C"）' }
  // ① 组合键
  const parts = raw.split('+')
  if (parts.length > 1) {
    const mods = []
    let allMods = true
    for (let i = 0; i < parts.length - 1; i++) {
      const m = KEY_MODIFIER_MAP[parts[i].trim().toLowerCase()]
      if (!m) { allMods = false; break }
      mods.push(m)
    }
    if (allMods) {
      const last = parts[parts.length - 1].trim()
      // 末键：单个字母数字按**小写**取（见上方规则①；组合键的 Shift 只能来自显式修饰键名）
      const token = /^[A-Za-z0-9]$/.test(last)
        ? last.toLowerCase()
        : KEY_NAME_MAP[last.toLowerCase()]
      if (!token) return { ok: false, error: unknownKeyError(last) }
      return { ok: true, value: mods.join('') + token }
    }
    // 修饰键认不全 ⇒ 可能是一条 SendKeys 原生写法（`+{TAB}`、`^{ENTER}`）⇒ 落到 ④，不在此报错
  }
  // ② 单个字母数字：原样
  if (/^[A-Za-z0-9]$/.test(raw)) return { ok: true, value: raw }
  // ③ 具名键
  const named = KEY_NAME_MAP[raw.toLowerCase()]
  if (named) return { ok: true, value: named }
  // ④ SendKeys 原生写法
  if (SENDKEYS_NATIVE_RE.test(raw)) return { ok: true, value: raw }
  // ⑤ 认不出 ⇒ 报错（**绝不**原样发出去当字面文本）
  return { ok: false, error: unknownKeyError(raw) }
}

/** 未知键名的模型面提示（同一句话，避免两处各写一份文案） */
function unknownKeyError(raw) {
  return `无法识别的按键名："${raw}" —— keyCombo 收的是**键名**（如 Enter/Tab/Esc/F5/PageUp/Ctrl+C），`
    + '不是要输入的文本；要输入文字请用 typeText'
}

// ─────────────────────────────────────────────────────────────────────────────
// P2d：`typeText.value` 的**要输入文本**校验（2026-10-17）
//
// 为什么需要一条校验、而不是"原样发出去"：
//   · 真值侧用 SendInput + KEYEVENTF_UNICODE **逐 UTF-16 码元**直发（不经过键盘布局，故中文能打）。
//     逐码元 ⇒ 长度按**码元**计（一个 emoji = 2 个码元），上限也按码元算，两侧口径一致。
//   · **控制字符一律拒**（C0 + DEL）：`\n` `\t` 这类在真值侧会被当字符打进去，而"按下回车键"
//     是另一件事（会提交表单/触发默认按钮）⇒ 要回车请用 `keyCombo{value:'Enter'}`。
//     让 typeText 顺手发控制字符 = 把 `keyCombo` 的语义偷偷塞进文本通路，正是 C2 的同类错误。
//   · 长度上限：typeText 逐字符发送（每个字符一次 SendInput + 间隔），无上限时一次调用可能挂几分钟
//     且难以中断 ⇒ 上限内分批调用是**可预期**的行为。超限**报错**，绝不静默截断
//    （静默截断 = 工具报成功但内容少了一半，与"静默发错内容"同级）。
// ─────────────────────────────────────────────────────────────────────────────

/** typeText 单次最多多少个 UTF-16 码元（真值侧 `$script:TextMaxCodeUnits` 必须同值，由对账测试锁死） */
const TEXT_MAX_CODE_UNITS = 500

/** 控制字符（C0 + DEL）：typeText 拒收 */
const TEXT_CONTROL_RE = /[\u0000-\u001F\u007F]/

/**
 * **纯函数**：typeText 的文本校验（可执行规格；真值侧那一份是 `Test-TextInput`，由
 * `kernel-tests/screen-text-parity.test.mjs` 逐例对账）。
 * @param {unknown} value
 * @returns {{ok:true, text:string} | {ok:false, error:string}}
 */
function normalizeTextInput(value) {
  if (typeof value !== 'string') {
    return { ok: false, error: `typeText 的 value 必须是字符串（要输入的**文本**）—— 实得 ${JSON.stringify(value)}；要按按键请用 keyCombo` }
  }
  if (value.length === 0) return { ok: false, error: 'typeText 的 value 不能为空（空文本是空操作，等价于静默无动作）' }
  const m = TEXT_CONTROL_RE.exec(value)
  if (m) {
    const code = `U+${m[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`
    return { ok: false, error: `typeText 的 value 含控制字符（${code}）—— 回车/制表这类**按键**请用 keyCombo（如 "Enter"），不要塞进文本` }
  }
  if (value.length > TEXT_MAX_CODE_UNITS) {
    return { ok: false, error: `typeText 单次最多 ${TEXT_MAX_CODE_UNITS} 个字符（实得 ${value.length}）—— 不静默截断，请分批调用` }
  }
  return { ok: true, text: value }
}

// ─────────────────────────────────────────────────────────────────────────────
// P2d：`sequence.steps` 的**步骤面**（真值侧 `$script:SequenceStepActs` 必须逐项同值，由对账测试锁死）
//
// 为什么步骤面是一份**白名单**而不是"接受任何 act"：
//   · 只读 act（capture/look/displays/windows）在序列里没有意义（它们不动光标、也不承接"下一步"），
//     放进来只会让调用方以为"一次调用能截图+点击"，而截图事实上发生在**另一个进程**。
//   · `drag`/`scroll` 暂不在步骤面里：它们各自有"必须插值/必须先移动光标"的额外约束，
//     加进序列需要单独的真机验收 —— 宁可明确报错，也不给一条没验收过的通路。
//   · `wait`（毫秒）是序列的必要成员：菜单/子菜单弹出、内联编辑框就绪都需要时间，且**只能**在
//     同一请求内等（跨请求等 = 菜单已关闭）。
// ─────────────────────────────────────────────────────────────────────────────

/** 序列里允许的步骤 act（与 ps1 的 `$script:SequenceStepActs` 逐项一致） */
const SEQUENCE_STEP_ACTS = ['move', 'clickAt', 'keyCombo', 'typeText', 'wait']

/** 单次 sequence 最多几步（超过则拒：无上限的序列一旦卡住，调用方只能等超时） */
const MAX_SEQUENCE_STEPS = 20

/** 单步 wait 的上限（毫秒） */
const MAX_STEP_WAIT_MS = 5000

/**
 * **纯函数**：校验并规范化一个序列步骤。只保留真值侧真读的字段（多传的字段不转发）。
 * @param {unknown} step
 * @param {number} index 步序号（1 起，仅用于错误文案）
 * @returns {{ok:true, step:object} | {ok:false, error:string}}
 */
function normalizeSequenceStep(step, index) {
  const at = `第 ${index} 步`
  if (!step || typeof step !== 'object' || Array.isArray(step)) {
    return { ok: false, error: `${at}必须是对象（如 {act:'clickAt', x:500, y:500}），实得 ${JSON.stringify(step)}` }
  }
  // ★ 显式标注为可索引对象：`typeof x === 'object'` 只把 unknown 收窄到 `object`，
  //   而 `object` 上读不到 `.act/.x/.ms`（T3 棘轮会报 TS2339；新文件未登记 ⇒ 一命中即红）。
  //   这一步**不改运行期行为**，只是把"我们已经确认它是对象"这件事告诉类型系统。
  const s = /** @type {Record<string, any>} */ (step)
  const act = String(s.act ?? '').trim()
  if (!SEQUENCE_STEP_ACTS.includes(act)) {
    return { ok: false, error: `${at}的 act 不在序列支持范围内：${JSON.stringify(s.act)}（可用：${SEQUENCE_STEP_ACTS.join(' / ')}）` }
  }
  if (act === 'wait') {
    const ms = s.ms
    if (typeof ms !== 'number' || !Number.isInteger(ms) || ms < 0 || ms > MAX_STEP_WAIT_MS) {
      return { ok: false, error: `${at}（wait）必须有 0..${MAX_STEP_WAIT_MS} 的整数 ms（实得 ${JSON.stringify(ms)}）` }
    }
    return { ok: true, step: { act, ms } }
  }
  if (act === 'move' || act === 'clickAt') {
    for (const k of ['x', 'y']) {
      const v = s[k]
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > MODEL_COORD_MAX) {
        return { ok: false, error: `${at}（${act}）的 ${k} 必须是 0..${MODEL_COORD_MAX} 的整数（实得 ${JSON.stringify(v)}）` }
      }
    }
    const out = { act, x: s.x, y: s.y }
    if (act === 'clickAt') {
      const b = s.button === undefined || s.button === null || s.button === ''
        ? 'left'
        : String(s.button).trim().toLowerCase()
      if (!['left', 'right', 'middle'].includes(b)) {
        return { ok: false, error: `${at}（clickAt）的 button 只允许 left / right / middle（实得 ${JSON.stringify(s.button)}）` }
      }
      out.button = b
    }
    return { ok: true, step: out }
  }
  // keyCombo / typeText：value 的语义相反，各用各的校验器（C2 的教训：绝不混用）
  if (act === 'keyCombo') {
    const r = normalizeKeySequence(s.value)
    if (r.ok === true) return { ok: true, step: { act, value: String(s.value) } }
    return { ok: false, error: `${at}（keyCombo）：${r.error}` }
  }
  const r = normalizeTextInput(s.value)
  if (r.ok === true) return { ok: true, step: { act, value: r.text } }
  return { ok: false, error: `${at}（typeText）：${r.error}` }
}

/**
 * **纯函数**：校验整个 steps 数组（结构 + 每步字段），返回**规范化**后的步骤（只含真值侧真读的字段）。
 * @param {unknown} steps
 * @returns {{ok:true, steps:object[]} | {ok:false, error:string}}
 */
function normalizeSequenceSteps(steps) {
  if (!Array.isArray(steps)) {
    return { ok: false, error: `sequence 的 steps 必须是数组（实得 ${JSON.stringify(steps)}）` }
  }
  if (steps.length === 0) return { ok: false, error: 'sequence 的 steps 不能为空（空序列是空操作）' }
  if (steps.length > MAX_SEQUENCE_STEPS) {
    return { ok: false, error: `sequence 最多 ${MAX_SEQUENCE_STEPS} 步（实得 ${steps.length}）—— 请拆成多次调用` }
  }
  const out = []
  for (let i = 0; i < steps.length; i++) {
    const r = normalizeSequenceStep(steps[i], i + 1)
    if (r.ok !== true) return { ok: false, error: r.error }
    out.push(r.step)
  }
  return { ok: true, steps: out }
}

/**
 * act → 字段面的**小写索引**（2026-10-17 P2d 发现并修的盲区）。
 *
 * ★ 为什么必须有它：`fieldsOfAct` 原本写成 `ACT_SPECS[act.toLowerCase()]` —— 而 `ACT_SPECS` 的键是
 *   **驼峰**（`clickAt` / `keyCombo` / `typeText`）。于是这三个 act 的字段面**恒返回空数组**：
 *   "契约字段面 ≡ .ps1 真读的参数"那条对账测试对它们一直是**空转**（扫了个空，永远绿）。
 *   这是本仓第三次踩"大小写索引"（前两次是 `INPUT_ACT_SET` 与执行器的 `ACT_SPEC_BY_LOWER`）。
 *   修法同前：显式建一份小写索引，别靠调用方记得传对大小写。
 */
const ACT_SPEC_BY_LOWER = new Map(Object.entries(ACT_SPECS).map(([k, s]) => [k.toLowerCase(), s]))

/** 某 act 真读的字段（required ∪ optional）；未知 act 返回空数组（**不抛**，调用方自行报错） */
function fieldsOfAct(act) {
  const s = ACT_SPEC_BY_LOWER.get(String(act ?? '').trim().toLowerCase())
  if (!s) return []
  return [...s.required, ...s.optional]
}

/**
 * ps1 真值侧实际执行的 act（= 全部已实现 − Node 侧复合 act）—— 契约对账用。
 *
 * ★ 必须写成**普通函数声明**再以简写导出（2026-10-15 实测踩到，很隐蔽）：
 *   Node 对 CJS 的具名导出走**静态分析**（cjs-module-lexer），
 *   若在 `module.exports = { ... }` 里写 `ps1Acts: () => ...`（箭头函数作属性值），
 *   分析会**提前收手** ⇒ ESM 侧 `import { isInputAct } from '…cjs'` 报
 *   "does not provide an export named 'isInputAct'"：**明明导出了却读不到**，
 *   而且报错指向的是**另一个**名字，极易误导（我先怀疑注释、再怀疑顺序，实为箭头函数）。
 *   ⇒ 导出字面量只放**简写标识符**。
 */
function ps1Acts() {
  return IMPLEMENTED_ACTS.filter((a) => !NODE_ACTS.includes(a))
}

module.exports = {
  MODEL_COORD_MAX, ABS_COORD_MAX,
  READ_ACTS, INPUT_ACTS, MOUSE_ACTS, ACT_SPECS, IMPLEMENTED_ACTS, ALL_ACTS,
  NODE_ACTS,
  ps1Acts,
  KEY_NAME_MAP, KEY_MODIFIER_MAP, SENDKEYS_NATIVE_RE, normalizeKeySequence,
  TEXT_MAX_CODE_UNITS, TEXT_CONTROL_RE, normalizeTextInput,
  SEQUENCE_STEP_ACTS, MAX_SEQUENCE_STEPS, MAX_STEP_WAIT_MS, normalizeSequenceStep, normalizeSequenceSteps,
  isInputAct, isMouseAct, fieldsOfAct,
}
