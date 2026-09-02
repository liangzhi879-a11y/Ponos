'use strict'
/** Agent Bridge 占位实现（Task 10 实装 kernel spawn；P1 中间态返回 NOT_READY）。 */
function createAgentBridge() {
  return {
    send: () => ({ ok: false, error: 'NOT_READY' }),
    cancel: () => ({ ok: false, error: 'NOT_READY' }),
    status: () => ({ ok: false, error: 'NOT_READY' }),
  }
}
module.exports = { createAgentBridge }
