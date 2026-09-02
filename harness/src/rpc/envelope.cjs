'use strict'

const DEFAULT_TTL = 16

function makeEnvelope({ method, params, id, x_sender, x_target = 'broadcast', x_trace_id }) {
  const env = { jsonrpc: '2.0', method, x_sender, x_target, x_ttl: DEFAULT_TTL }
  if (id !== undefined) env.id = id
  if (params !== undefined) env.params = params
  if (x_trace_id) env.x_trace_id = x_trace_id
  return env
}

function validateEnvelope(env) {
  if (!env || typeof env !== 'object') return { ok: false, error: 'envelope 必须为对象' }
  if (env.jsonrpc !== '2.0') return { ok: false, error: 'jsonrpc 必须为 2.0' }
  if (typeof env.method !== 'string' || env.method.length === 0) return { ok: false, error: 'method 必须为非空字符串' }
  if (typeof env.x_sender !== 'string' || env.x_sender.length === 0) return { ok: false, error: 'x_sender 必须为非空字符串' }
  if (env.x_ttl !== undefined && (typeof env.x_ttl !== 'number' || env.x_ttl < 1)) return { ok: false, error: 'x_ttl 非法' }
  return { ok: true }
}

function decrementTtl(env) {
  const t = typeof env.x_ttl === 'number' ? env.x_ttl : DEFAULT_TTL
  return Math.max(0, t - 1)
}

module.exports = { makeEnvelope, validateEnvelope, decrementTtl, DEFAULT_TTL }
