'use strict'
/**
 * 应用智控的**全量控制命令目录 + 覆盖率**（唯一实现，2026-09-17，P1「真正 agent 可智控」）。
 *
 * 为什么需要这个模块：清单 P1 的验收里有一句「网站和应用应至少 70% 能匹配上全量控制命令」，
 * 而**全仓此前既没有"全量控制命令"的定义、也没有任何比例型度量**（`git grep 全量控制|控制命令|匹配率`
 * 唯一命中就是清单那一行自身）。没有定义就没有验收 —— 于是先把这个定义落成代码。
 *
 * 设计要点（每条都对应一个具体的自欺方式）：
 *  ① **分母写死在这里，是契约，不随实现缩水。** 若按"实现了什么就算什么"来定义分母，
 *     把没实现的能力从分母删掉就能刷出 100% —— 这是本项最容易出现的自欺。
 *  ② **收录判据是"作用于目标本身"**，故 `pause_for_human` / `resume` / `close` **明确排除**：
 *     它们控制的是"我们的会话/人工接管"，不是目标（`pause_for_human` 在 `withTimeout` 里被
 *     特意豁免超时，语义就是"把控制权交回人"）。
 *  ③ **"可执行"必须以代码事实为准**，不能凭契约宣称：`uia` 的 4 个 act 在契约里存在，
 *     但后端是桩（`electron/app-runner-desktop.cjs` 的 `runUia` 恒返回"未接入"）⇒ 记为**不可用**，
 *     覆盖率如实扣分，并且**不从分母里删除**。
 *  ④ **本模块不 import electron/**。它是底层契约，反过来被 electron/kernel 引用；与真实实现的
 *     一致性由测试对账（`shared/app-control-commands.test.mjs` 直接读 `electron/app-generate.cjs`
 *     与 `electron/browser-executor.cjs` 的源码做集合比对）—— 比运行期互相 import 更强：
 *     既避免分层倒挂，又能在任何一边单边改动时立刻变红。
 *
 * CJS + ESM 双用：`electron/*.cjs` 直接 require；桥/kernel（ESM）走 `app-control-commands.mjs` 转发层。
 * 同 `shared/proxy-config.cjs`、`server/bridge-token.cjs` 先例。
 */

/** 目标类别：网站（web）与桌面应用（desktop）。 */
const TARGET_CLASSES = ['web', 'desktop']

/** 覆盖率阈值（需求给定：至少 70%）。 */
const COVERAGE_THRESHOLD = 0.7

/**
 * 各驱动属于哪个目标类别。用于把「某个 Spec 用哪个驱动」映射到类别覆盖率。
 * `browser` → web；其余（process/script/uia/http/file）都是桌面应用的接口面 → desktop。
 * 注：桌面应用也可能通过"本地 Web UI"用 browser 驱动（`electron/app-capability.cjs` 的 web-ui 通道），
 * 那种情况按 web 类别计 —— 类别由**驱动**决定，不由 target.type 决定（与 `driverOf` 同口径）。
 */
const CLASS_BY_DRIVER = {
  browser: 'web',
  process: 'desktop',
  script: 'desktop',
  uia: 'desktop',
  http: 'desktop',
  file: 'desktop',
}

/**
 * 不可用原因（i18n key 由界面渲染，本模块不产出中文句子）。
 * `uiaUnavailable`：UI 自动化后端未接入（需原生 UIA/SendKeys 能力，属 P1「computeruse工具的开发」范围）。
 */
const UNAVAILABLE_REASON = {
  uiaUnavailable: 'apps.cmdUnavailableUia',
}

/**
 * **全量控制命令目录**（分母）。
 *
 * 字段：
 *  · `id`        稳定标识（也是 i18n key 的后半段：`apps.cmd_<class>_<id>`）
 *  · `area`      能力分组（navigate / read / interact / invoke / wait），供界面分组显示
 *  · `driver`    由哪个驱动的哪个 act 实现
 *  · `implemented`  **是否真能执行**（代码事实，不是愿景）。false ⇒ 计入缺失。
 *  · `reasonKey`  不可用原因（仅 implemented=false 时有意义）
 *  · `note`      给维护者/界面工具提示用的补充（不放文案，只是注释性说明）
 */
const CONTROL_COMMANDS = {
  // ---------------------------------------------------------------------------
  // 网站（web）—— 12 条。全部由 browser 驱动的 runAction 分支实现。
  // ---------------------------------------------------------------------------
  web: [
    { id: 'goto', area: 'navigate', driver: 'browser', act: 'goto', implemented: true },
    { id: 'back', area: 'navigate', driver: 'browser', act: 'back', implemented: true },
    { id: 'forward', area: 'navigate', driver: 'browser', act: 'forward', implemented: true },
    { id: 'refresh', area: 'navigate', driver: 'browser', act: 'refresh', implemented: true },
    { id: 'snapshot', area: 'read', driver: 'browser', act: 'snapshot', implemented: true },
    { id: 'click', area: 'interact', driver: 'browser', act: 'click', implemented: true },
    { id: 'type', area: 'interact', driver: 'browser', act: 'type', implemented: true },
    { id: 'select', area: 'interact', driver: 'browser', act: 'select', implemented: true },
    { id: 'scroll', area: 'interact', driver: 'browser', act: 'scroll', implemented: true },
    { id: 'hover', area: 'interact', driver: 'browser', act: 'hover', implemented: true },
    { id: 'js', area: 'invoke', driver: 'browser', act: 'js', implemented: true },
    { id: 'wait', area: 'wait', driver: 'browser', act: 'wait', implemented: true },
  ],
  // ---------------------------------------------------------------------------
  // 桌面应用（desktop）—— 9 条，横跨 process / script / http / file / uia 五个接口面。
  // 前 5 条已可用；后 4 条（uia）后端未接入 ⇒ 如实记 false，**分母不因此缩小**。
  // ---------------------------------------------------------------------------
  desktop: [
    { id: 'cli', area: 'invoke', driver: 'process', act: 'cli', implemented: true },
    { id: 'script', area: 'invoke', driver: 'script', act: 'script', implemented: true },
    { id: 'request', area: 'invoke', driver: 'http', act: 'request', implemented: true },
    { id: 'read', area: 'read', driver: 'file', act: 'read', implemented: true },
    { id: 'query', area: 'read', driver: 'file', act: 'query', implemented: true },
    { id: 'focus', area: 'interact', driver: 'uia', act: 'focus', implemented: false, reasonKey: UNAVAILABLE_REASON.uiaUnavailable },
    { id: 'type', area: 'interact', driver: 'uia', act: 'type', implemented: false, reasonKey: UNAVAILABLE_REASON.uiaUnavailable },
    { id: 'key', area: 'interact', driver: 'uia', act: 'key', implemented: false, reasonKey: UNAVAILABLE_REASON.uiaUnavailable },
    { id: 'wait', area: 'wait', driver: 'uia', act: 'wait', implemented: false, reasonKey: UNAVAILABLE_REASON.uiaUnavailable },
  ],
}

/**
 * **明确排除**在"控制命令"之外的动作（有据可查，不是遗漏）。
 * 界面/文档提到全量命令时若把它们算进去，覆盖率会被无意义地拉低；而它们的语义是
 * "会话生命周期/人工接管"，与"能否控制目标"不是一回事。
 */
const EXCLUDED_ORCHESTRATION_ACTS = ['pause_for_human', 'resume', 'close']

/** i18n key：`apps.cmd_<class>_<id>`（class 参与命名，因为 web/desktop 都有 type 与 wait，语义不同）。 */
function commandI18nKey(targetClass, id) {
  return `apps.cmd_${targetClass}_${id}`
}

/** 该类别是否已定义（未知类别返回 false，调用方据此走兜底，不抛）。 */
function isTargetClass(targetClass) {
  return TARGET_CLASSES.includes(targetClass)
}

/** 类别 → 是否属于该类别（未知驱动返回 null：调用方需自行兜底，不要猜）。 */
function classOfDriver(driver) {
  return CLASS_BY_DRIVER[String(driver || '').trim()] || null
}

/** 该 Spec 对应的目标类别（未知驱动 → null）。 */
function classOfSpec(spec) {
  return classOfDriver(spec && spec.driver)
}

/** 该类别的全量命令（浅拷贝副本，避免调用方误改内部常量）。 */
function commandsForClass(targetClass) {
  const list = CONTROL_COMMANDS[targetClass]
  return Array.isArray(list) ? list.map((c) => ({ ...c })) : []
}

/**
 * 类别覆盖率。
 * @returns {{class:string, covered:number, total:number, ratio:number, met:boolean,
 *            threshold:number, missing:Array<{id:string,i18nKey:string,area:string,reasonKey?:string}>, unknown?:boolean}}
 * 未知类别返回 `unknown:true` + 零值 —— **不抛**：界面可能拿到脏 driver（老 Spec / 手改），
 * 崩掉会让整个控制台打不开，而"显示不出来"远比"少显示一个数"严重。
 */
function coverageForClass(targetClass) {
  const list = commandsForClass(targetClass)
  const total = list.length
  const missing = list.filter((c) => !c.implemented)
  const covered = total - missing.length
  return {
    class: targetClass,
    covered,
    total,
    ratio: total === 0 ? 0 : covered / total,
    threshold: COVERAGE_THRESHOLD,
    met: total > 0 && covered / total >= COVERAGE_THRESHOLD,
    missing: missing.map((c) => ({
      id: c.id,
      area: c.area,
      i18nKey: commandI18nKey(targetClass, c.id),
      reasonKey: c.reasonKey,
    })),
    ...(total === 0 ? { unknown: true } : {}),
  }
}

/** 全类别报告（顺序固定：web 在前，界面显示顺序稳定）。 */
function coverageReport() {
  return TARGET_CLASSES.map((c) => coverageForClass(c))
}

/**
 * 某个 Spec 的**信息性**度量：它用到的命令面（不参与 70% 判定，别拿它当覆盖率）。
 *
 * 为什么要分开：真实语料里 3 个 web 目标**没有一个**用到 click/type/select/scroll/hover
 * （全部 `goto + wait + snapshot/js` 一步到位），若用"Spec 用到的 act / 全量"当覆盖率，
 * 会得出 33% 这种失真数字 —— 能力明明在，只是这批命令没用到。
 * 故：覆盖率看**能力面**（本模块的 coverageForClass），"用到什么"只作信息展示。
 * @returns {{class:string|null, driver:string, usedActs:string[], unusedActs:string[], unknownDriver:boolean}}
 */
function specCoverage(spec) {
  const driver = String((spec && spec.driver) || '').trim()
  const targetClass = classOfDriver(driver)
  const used = new Set()
  for (const cmd of (spec && spec.commands) || []) {
    for (const step of (cmd && cmd.steps) || []) {
      if (step && step.act) used.add(String(step.act))
    }
  }
  const relevant = targetClass ? commandsForClass(targetClass).filter((c) => c.driver === driver) : []
  const usedIds = relevant.filter((c) => used.has(c.act)).map((c) => c.id)
  const unusedIds = relevant.filter((c) => !used.has(c.act)).map((c) => c.id)
  return {
    class: targetClass,
    driver,
    usedActs: [...used].sort(),
    usedIds,
    unusedIds,
    unknownDriver: !targetClass,
  }
}

/** 便于界面把"缺失清单"渲染成一句话的点分文本（`cli、script` 这类）。 */
function missingIdsText(targetClass) {
  return coverageForClass(targetClass).missing.map((m) => m.id).join('、')
}

module.exports = {
  TARGET_CLASSES,
  COVERAGE_THRESHOLD,
  CLASS_BY_DRIVER,
  UNAVAILABLE_REASON,
  CONTROL_COMMANDS,
  EXCLUDED_ORCHESTRATION_ACTS,
  commandI18nKey,
  isTargetClass,
  classOfDriver,
  classOfSpec,
  commandsForClass,
  coverageForClass,
  coverageReport,
  specCoverage,
  missingIdsText,
}
