// Node 24 兼容垫片（仅评测用，不修改被测内核）
// ---------------------------------------------------------------------------
// 背景：Ponos-turbo 内核的取消机制是自定义信号对象 { aborted: false }，
//   engine.mjs 将其直接传给 fetch()。Node ≥22 的 undici 严格校验 signal
//   必须是 AbortSignal 实例，否则抛 "Expected signal (...) to be an instance
//   of AbortSignal"。内核自身在流循环检查点检查 signal.aborted 实现取消，
//   fetch 层的 signal 是冗余的，剥离后取消语义不变。
// 作用：启动内核时 --import 本模块，把非 AbortSignal 的信号从 fetch init 中
//   去掉，使旧内核提交（T001-T003 base）与当前 HEAD 均能在本机 Node 上真实运行。
// ---------------------------------------------------------------------------
const origFetch = globalThis.fetch
globalThis.fetch = function (input, init) {
  if (init && init.signal !== undefined && !(init.signal instanceof AbortSignal)) {
    const { signal, ...rest } = init
    init = rest
  }
  return origFetch.call(this, input, init)
}
