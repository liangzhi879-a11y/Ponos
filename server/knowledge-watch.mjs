/**
 * 知识空间文件监听（2026-09-14，对标 Obsidian 批次 4）。
 *
 * ## 为什么需要
 *
 * 知识空间的目录**本来就是共享的** —— 用户可以同时用 Obsidian / VSCode / 记事本直接改这些 md。
 * 没有监听时，本应用直到"下一次内核进程被拉起"才会发现变化：用户在外面改完回到窗口，
 * 看到的仍是旧内容、旧目录树、旧反链，且**没有任何提示**说"你看到的是过期的"。
 * 他会以为自己的修改没保存，或者以为应用把它覆盖掉了 —— 两种判断都会让用户不敢再用。
 *
 * ## 为什么放在服务端（而不是内核）
 *
 * 本应用的内核是**短命子进程**：每次 CLI 调用起一个、干完就退。在那里挂 watcher 等于挂在一个
 * 马上就要死的进程上。服务端（bridge）是长驻的，且已经有向 GUI 广播消息的通道
 * （`broadcastGui`），所以 watcher 放这里、变化经广播通知 GUI 失效缓存，是唯一可行的位置。
 *
 * ## 设计要点
 *
 * 1. **只监听 `spaces/`**，不监听 `index/` 与 `trash/`。索引与回收站是**本应用自己**的产物：
 *    重建索引会批量改写 `index/`，若把它也盯上，就会形成
 *    "改文件 → 通知 GUI → GUI 拉数据 → 内核重建索引 → 又通知 GUI"的自激循环。
 *    `spaces/` 里的变化才是用户关心的"内容变了"。
 * 2. **防抖 400ms**：一次保存/一次解压/一次批量同步会连续产生几十上百个事件。
 *    逐个转发等于让 GUI 反复失效并反复拉起内核进程（每个进程都是真金白银的开销）。
 *    400ms 是"用户感觉不到延迟"与"合并掉突发"之间的取舍。
 * 3. **忽略原子写的临时文件**（`.yfw-tmp-*`）：保存一篇文档会产生
 *    "创建 tmp → rename"两个事件，其中 tmp 的创建与删除都不是内容变化。
 *    不过滤的话每次保存都会多通知一轮。
 * 4. **平台降级必须出声**：Linux 上 `fs.watch({recursive:true})` 需要 Node ≥ 20，
 *    老版本会抛。此时退化为"逐个空间目录浅监听"（覆盖 `spaces/<spaceId>/*.md` 这一层，
 *    子目录内的改动漏报），并把 `mode` 如实报给调用方 —— 静默降级会让"为什么有时不同步"
 *    变成无法排查的玄学问题。
 * 5. **回调只给"变了"这个事实 + 路径样本**，不做增量解析：解析是内核的事，
 *    watcher 不该知道 markdown 是什么。路径样本带上限（50）—— 大目录同步会一次产生上千条，
 *    全塞进广播帧只是浪费带宽，GUI 也用不到第 51 条。
 */

import { existsSync, mkdirSync, readdirSync, watch } from 'node:fs'
import { join } from 'node:path'
import { isAtomicTmpName } from '../shared/atomic-write.mjs'

/** 防抖窗口（毫秒）：见文件头第 2 点 */
const DEBOUNCE_MS = 400

/** 单批广播里携带的路径样本上限：见文件头第 5 点 */
const MAX_PATHS_PER_BATCH = 50

/**
 * 启动监听。返回句柄：`{ ok, mode, root, stop(), revision() }`。
 *
 * `mode`：`'recursive'`（理想）| `'shallow'`（平台不支持递归时的降级）| `'failed'`（连浅监听都不行）
 * `onChange`：收到一批变化时调用（已防抖、已过滤），参数 `{ revision, paths, count, external }`
 *
 * **永不抛错**：监听失败不该拖垮服务端启动（它是"更好用"的能力，不是核心功能）。
 * 失败信息通过返回值与 `onChange` 之外的一条 `onError` 回报（缺省只记在句柄里）。
 */
export function startKnowledgeWatch({ root, onChange, onError = null, debounceMs = DEBOUNCE_MS } = {}) {
  const handle = {
    ok: false,
    mode: 'failed',
    root: root || null,
    stop: () => {},
    revision: () => rev,
    error: null,
  }
  let rev = 0
  if (!root) {
    handle.error = 'no-root'
    return handle
  }
  let watcher = null
  /**
   * 让监听句柄**不阻止进程退出**（2026-09-14 批次 4 实测踩到）。
   *
   * `fs.watch` 返回的是 libuv handle，它会**把事件循环钉住**：只挂监听、不做别的，
   * 进程就永远不退出（实测 `node -e "startKnowledgeWatch(...)"` 打印完日志仍然挂着，
   * 只能被 kill）。后果不是"应用不能关"（bridge 收信号即退），而是**测试进程不再自然结束**：
   * 起 bridge 等进程自然退出的一组用例全部超时（本批次实测 `diag-info` 等 3 个套件被挂住）。
   *
   * 这也是语义上正确的选择：监听是"更好用"的增强，不该成为"进程必须活着"的理由。
   * 真正需要常驻的理由（HTTP server / WS 连接）自己有 handle 管着。
   */
  const unref = (w) => { try { w?.unref?.() } catch { /* 平台不支持 unref：不影响功能，只是句柄会钉住事件循环 */ } }
  const attach = () => {
    // 递归监听优先；抛错则降级为"浅监听 spaces/ 下的每个空间目录"
    try {
      watcher = watch(root, { recursive: true }, onEvent)
      unref(watcher)
      handle.mode = 'recursive'
      return
    } catch (e) {
      handle.error = `recursive-unavailable: ${String(e?.message ?? e)}`
    }
    try {
      // 降级：浅监听 root 本身 + 每个一级子目录（本应用的空间布局就一层：
      // `spaces/<spaceId>/*.md`）—— 子目录更深处的变化会漏报，故 mode 如实标 'shallow'。
      watcher = watch(root, { recursive: false }, onEvent)
      unref(watcher)
      for (const name of safeReaddir(root)) {
        try {
          const w = watch(join(root, name), { recursive: false }, onEvent)
          unref(w)
          watchers.push(w)
        } catch { /* 单个空间目录监听失败：不影响其它空间 */ }
      }
      handle.mode = 'shallow'
    } catch (e) {
      handle.error = `watch-failed: ${String(e?.message ?? e)}`
      handle.mode = 'failed'
    }
  }
  const watchers = []
  let timer = null
  const pending = new Set()
  const onEvent = (_evt, filename) => {
    // filename 在部分平台上可能为 null（例如目录整体被替换）—— 那本身就是一次变化，照样收下
    const name = filename == null ? '' : String(filename)
    // 过滤原子写的临时文件：见文件头第 3 点（保存一篇文档会产生两个事件，tmp 的两个都不是内容变化）
    if (name && isAtomicTmpName(name.split(/[\\/]/).pop() || '')) return
    if (name) pending.add(name.split(/[\\/]/).join('/'))
    else pending.add('*')
    if (timer) clearTimeout(timer)
    timer = setTimeout(flush, debounceMs)
    // 防抖计时器不该阻止进程退出（bridge 关闭时 watcher.stop() 会清掉它）
    if (typeof timer.unref === 'function') timer.unref()
  }
  const flush = () => {
    timer = null
    const all = [...pending]
    pending.clear()
    if (!all.length) return
    rev += 1
    try {
      onChange?.({
        revision: rev,
        count: all.length,
        paths: all.slice(0, MAX_PATHS_PER_BATCH),
        // 样本被截断时如实标注：GUI 若要做"哪些文件变了"的精细提示，需要知道这份清单不完整
        pathsTruncated: all.length > MAX_PATHS_PER_BATCH,
        external: true,
      })
    } catch (e) {
      onError?.(e)
    }
  }

  try {
    if (!existsSync(root)) mkdirSync(root, { recursive: true })
    attach()
    handle.ok = handle.mode !== 'failed'
  } catch (e) {
    // 建目录/挂监听失败：能力不可用，但不影响服务端其它功能
    handle.error = `start-failed: ${String(e?.message ?? e)}`
    handle.ok = false
  }
  handle.stop = () => {
    if (timer) { clearTimeout(timer); timer = null }
    for (const w of [...watchers, watcher]) {
      try { w?.close() } catch { /* 已关或已失效 */ }
    }
    watchers.length = 0
    watcher = null
    handle.ok = false
  }
  return handle
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir)
  } catch { return [] }
}
