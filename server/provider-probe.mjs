// API 能力探测与自动适配推导（2026-09-09；2026-09-11 实测优先）——纯模块（推导
// 函数零副作用，网络探测显式传参）。桥经 /probe-provider 路由调用：探测端点能力
// （/v1/models 元数据——多候选 URL 含 anthropic 端点剥后缀试 OpenAI 根；1-token
// TTFT；~8k tokens 预填充吞吐）→ applyProbeResults **服务端实测值覆盖预置**回填
// contextWindow（防 1M 虚高类事故；探测不到的字段才只填空位）→ 内核 400 学习
// 事件（context_window_adopted）经 maybeAdoptWindowFromEvent 只下调持久回流。
// 欠费检测：探测 ping 即检验计费异常（402/余额不足 → billing 标记 + 提示）。
import http from 'http'
import https from 'https'

// ---------------------------------------------------------------------------
// 网络探测
// ---------------------------------------------------------------------------

// /v1/models 候选 URL（2026-09-11 实测优先）：anthropic 兼容端点（…/anthropic 或
// …/anthropic/v1）通常没有 models 元数据，剥掉后缀改试 OpenAI 根（deepseek 等
// 双协议服务）；原样 + 剥后缀 + /models 兜底。逐候选试到有结果。
export function modelMetaUrlCandidates(baseUrl) {
  const b = String(baseUrl || '').replace(/\/+$/, '')
  const cands = new Set()
  if (b) { cands.add(b + '/v1/models'); cands.add(b + '/models') }
  const stripped = b.replace(/\/(?:anthropic(\/v1)?|v1)\/?$/, '')
  if (stripped && stripped !== b) {
    cands.add(stripped + '/v1/models')
    cands.add(stripped + '/models')
  }
  return [...cands]
}

/** 逐个候选 GET models 元数据（vLLM max_model_len / OpenAI 系 context 字段）。
 *  任一候选成功即止；全部 404/超时 → null。 */
function fetchModelsMeta({ baseUrl, authToken, timeoutMs }) {
  const candidates = modelMetaUrlCandidates(baseUrl)
  return new Promise((resolve) => {
    let idx = 0
    const tryNext = () => {
      if (idx >= candidates.length) return resolve(null)
      const url = candidates[idx++]
      const lib = url.startsWith('https:') ? https : http
      const req = lib.get(url, {
        timeout: Math.min(timeoutMs, 10000),
        headers: {
          accept: 'application/json',
          ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
        },
      }, (res) => {
        let body = ''
        res.on('data', (d) => { body += d })
        res.on('end', () => {
          if (res.statusCode !== 200) return tryNext()
          try {
            const j = JSON.parse(body)
            const data = Array.isArray(j?.data) ? j.data : null
            if (!data) return tryNext()
            // 窗口字段（实测优先，2026-09-11）：vLLM max_model_len、OpenAI 系
            // context_length / max_input_tokens / context_window / maxContextLength
            const winOf = (m) => {
              const v = m?.max_model_len ?? m?.context_length ?? m?.max_input_tokens ?? m?.context_window ?? m?.maxContextLength ?? m?.max_context_length
              return Number(v) > 0 ? Number(v) : null
            }
            const meta = data
              .map((m) => ({ id: String(m?.id ?? ''), maxModelLen: winOf(m) }))
              .filter((m) => m.id && m.maxModelLen !== null)
            resolve(meta.length ? meta : null)
          } catch { tryNext() }
        })
      })
      req.on('timeout', () => { req.destroy(); tryNext() })
      req.on('error', () => tryNext())
    }
    tryNext()
  })
}

/** 单次 messages 请求（可带 padding），返回 { ok, ttftMs, latencyMs, billing }。
 *  欠费检测（2026-09-11）：402 或响应体含 Insufficient Balance / 余额不足 →
 *  billing='insufficient_balance'（探测即检验计费异常，不只在调用失败时才发现）。 */
function postMessages({ baseUrl, authToken, model, padding, timeoutMs, tools }) {
  const candidates = [String(baseUrl).replace(/\/+$/, '') + '/v1/messages', String(baseUrl).replace(/\/+$/, '') + '/messages']
  const body = JSON.stringify({
    model,
    max_tokens: 1,
    messages: [{ role: 'user', content: padding ? `${padding}\n\n请回答：1+1等于几？` : 'ping' }],
    // 工具能力探测（2026-09-12）：**刻意不带 tool_choice**——与内核真实请求同形
    // （kernel/api.mjs anthropicStream 只发 tools，tool_choice 走服务端默认）。
    // 带 tool_choice 的探测会掩盖"服务端默认 tool_choice 不可用"这类失败（实测
    // vLLM 未开 --enable-auto-tool-choice 时 tool_choice:'none' 能过、默认必 400）。
    ...(Array.isArray(tools) && tools.length ? { tools } : {}),
  })
  return new Promise((resolve) => {
    const tryCandidate = (i) => {
      if (i >= candidates.length) return resolve({ ok: false })
      const url = candidates[i]
      const lib = url.startsWith('https:') ? https : http
      const t0 = Date.now()
      let ttftMs = null
      const req = lib.request(url, {
        method: 'POST',
        timeout: Math.min(timeoutMs, 60000),
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          'content-length': Buffer.byteLength(body),
          ...(authToken ? { 'x-api-key': authToken } : {}),
        },
      }, (res) => {
        if (res.statusCode >= 400) {
          let buf = ''
          res.on('data', (d) => { buf += d })
          res.on('end', () => {
            const billing = /insufficient balance|余额不足|quota|billing|payment|402/i.test(buf) ? 'insufficient_balance' : undefined
            resolve({ ok: false, status: res.statusCode, billing, detail: buf.slice(0, 300) })
          })
          return
        }
        res.once('data', () => { ttftMs = Date.now() - t0 })
        res.on('end', () => resolve({ ok: true, ttftMs, latencyMs: Date.now() - t0 }))
      })
      req.on('timeout', () => { req.destroy(); resolve({ ok: false }) })
      req.on('error', () => tryCandidate(i + 1))
      req.write(body)
      req.end()
    }
    tryCandidate(0)
  })
}

/** 预填充基准填充文本：~8k tokens 的变体文本。种子缺省按时间变化——每次探测
 *  内容唯一，避免 vLLM 前缀缓存命中导致测量失真（缓存命中时 prefill 瞬时完成，
 *  吞吐会被高估数百倍）。 */
function buildPrefillPadding(seed) {
  const words = ['项目', '数据', '处理', '系统', '文件', '配置', '模块', '测试', '结果', '输出', '错误', '参数', '执行', '检查', '验证', '修改', '更新', '记录', '分析', '统计', '生成', '读取', '写入', '目录', '路径', '窗口', '进程', '服务', '网络', '连接', '状态', '时间', '任务', '工具', '命令', '代码', '函数', '接口', '流程', '步骤', '需求', '设计', '方案', '评估', '风险', '预算', '进度', '质量', '安全', '性能', '优化', '兼容', '环境', '部署', '日志', '缓存', '索引', '查询', '字段', '表格', '报表', '图表', '文档', '模板', '规则', '权限', '审核', '批准', '提交', '保存', '备份', '恢复', '迁移', '升级', '版本', '依赖', '冲突', '异常', '警告', '提示', '消息', '通知', '会话', '用户', '角色', '登录', '退出', '加密', '证书', '协议', '端口', '地址', '域名', '主机', '集群', '节点', '容器', '镜像', '调度', '负载', '均衡', '监控', '告警', '追踪', '采样', '聚合', '过滤', '排序', '分页', '批量', '定时', '触发', '回调', '队列', '线程', '锁', '同步', '异步', '并行', '串行', '事务', '回滚', '快照', '哈希', '压缩', '解压', '编码', '解码', '转换', '映射', '序列化', '反序列化']
  let s = (Number(seed) || Date.now()) % 2147483648
  const rand = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648 }
  let out = ''
  // CJK 约 0.85 token/字：~9500 字 ≈ 8k tokens
  for (let i = 0; i < 1400; i++) {
    out += words[Math.floor(rand() * words.length)] + i + ' '
    if (i % 40 === 39) out += '\n'
  }
  return out.trim()
}

/**
 * 能力探测（渐进降级：任一步失败不影响其余结果）：
 *  1. /v1/models 元数据（max_model_len/模型清单）
 *  2. 1-token ping（TTFT + 总延迟）
 *  3. ~8k tokens 预填充基准（非流式 max_tokens=1，总时长 ≈ prefill 时长 → 吞吐）
 *  4. 工具能力（带最小工具定义、不带 tool_choice 的请求——与内核真实请求同形）
 */
export async function probeProviderCapabilities({ apiBaseUrl, authToken, model, timeoutMs = 60000 }) {
  const result = { ok: false, modelsMeta: null, ttftMs: null, latencyMs: null, prefillTokPerSec: null, billing: null, toolsSupported: null }
  if (!apiBaseUrl || !model) return result

  const ping = await postMessages({ baseUrl: apiBaseUrl, authToken, model, timeoutMs })
  result.ok = ping.ok === true
  result.ttftMs = ping.ttftMs ?? null
  result.latencyMs = ping.latencyMs ?? null
  // 欠费检测（2026-09-11）：探测即检验计费异常（402/余额不足），前端据此提示
  result.billing = ping.billing ?? null

  result.modelsMeta = await fetchModelsMeta({ baseUrl: apiBaseUrl, authToken, timeoutMs })

  if (ping.ok) {
    const padding = buildPrefillPadding()
    const padded = await postMessages({ baseUrl: apiBaseUrl, authToken, model, padding, timeoutMs })
    if (padded.ok && padded.latencyMs && padded.latencyMs > 2000) {
      const prefillTokens = Math.round(padding.length / 2) // 中文≈每字 1 token 上界的一半，粗估 8k
      result.prefillTokPerSec = Math.round(prefillTokens / (padded.latencyMs / 1000))
    }
    // 工具能力（2026-09-12）：**排在预填充之后**——预填充吞吐靠单请求时长测量，
    // 并发请求会污染计时。不带 tools 的 ping 能过 ≠ 带 tools 能过（实测 vLLM 未开
    // --enable-auto-tool-choice 时正是此形态：探测全绿、首个回合 400）。
    result.toolsSupported = await probeToolSupport({ apiBaseUrl, authToken, model, timeoutMs })
  }
  return result
}

/** 工具能力探测：发一个带最小工具定义（不带 tool_choice）的请求。
 *  返回 true=端点接受了带工具的请求；false=端点明确以"工具调用未启用"拒绝；
 *  null=不确定（网络/超时/其它错误）——**不确定不猜**，只在 false 时报警告，
 *  避免把无关故障说成"该 provider 不支持工具调用"。只探测不改变任何配置。 */
export async function probeToolSupport({ apiBaseUrl, authToken, model, timeoutMs = 60000 }) {
  const res = await postMessages({
    baseUrl: apiBaseUrl, authToken, model, timeoutMs,
    tools: [{ name: 'probe_noop', description: '探测用占位工具，请勿调用。', input_schema: { type: 'object', properties: {} } }],
  })
  return classifyToolProbeResult(res)
}

/** 工具探测结果判定（导出供单测与内核分类器交叉校验，防两处正则漂移）。
 *  与 kernel/api.mjs 的 TOOLS_UNSUPPORTED_RE 同源语义：vLLM 的启动参数原话，或
 *  "tools ... not supported/disabled" 类否定句。 */
export const TOOLS_REJECT_RE = /enable-auto-tool-choice|tool-call-parser|\btools?(?![a-z0-9])[^.\n]{0,40}(?:not supported|unsupported|not enabled|not available|disabled)|\bnot support(?:s|ed)?\b[^.\n]{0,20}\btools?(?![a-z0-9])/i

export function classifyToolProbeResult(res) {
  if (res?.ok === true) return true
  const status = Number(res?.status) || 0
  if (status !== 400 && status !== 422) return null // 5xx/超时/连接失败：与工具能力无关，不猜
  return TOOLS_REJECT_RE.test(String(res?.detail || '')) ? false : null
}

// ---------------------------------------------------------------------------
// 回填推导（纯函数）
// ---------------------------------------------------------------------------

/** 实测优先回填（2026-09-11 语义变更）：服务端返回的参数是权威——contextWindow
 *  只要探测到就覆盖写入（不再尊重预置/硬编码值，防 1M 虚高类事故）；探测不到的
 *  字段仍只填空位。欠费等计费异常在 notes 中显式报告。 */
export function applyProbeResults(provider = {}, probe = {}, { profile = 'cloud' } = {}) {
  const updates = {}
  const notes = []

  if (probe?.billing === 'insufficient_balance') {
    notes.push('⚠ 检测到欠费/额度不足：该 provider 计费异常，请先充值后再使用')
  }

  // 工具能力（2026-09-12）：**只报告、不改行为**——不自动去掉 tools、不自动切 provider
  // （本应用靠工具执行任务，静默降级只会让模型空谈不干活，比报错更难排查）。探测已
  // 实测该端点是否接受带 tools 的请求；运行期同一问题由内核 tools-unsupported 分类
  // 落可操作提示（kernel/api.mjs → engine loopStop）。
  if (probe?.toolsSupported === false) {
    notes.push('⚠ 该 provider 未开启工具调用：服务端拒绝了带工具定义的请求（需以 --enable-auto-tool-choice --tool-call-parser <解析器> 启动，Qwen3.x 常见 qwen3_xml / hermes）——若服务端已开该参数，请核对本应用配置的 API 地址/端口是否指向该服务（代理或端口可能转到另一个未开启工具调用的后端）；未开启时本应用无法执行任务')
  } else if (probe?.toolsSupported === true) {
    notes.push('工具调用可用（探测实测）')
  }

  const window = resolveWindowFromProbe(provider, probe)
  if (window !== null) {
    const current = Number(provider.contextWindow) > 0 ? Number(provider.contextWindow) : null
    updates.contextWindow = window
    notes.push(`上下文窗口 ${window}（服务端实测${current && current !== window ? `，原配置 ${current} 已校正` : ''}）`)
  }

  // 可用模型清单（2026-09-11 实时更新）：服务端 /v1/models 实测列表 → 同步
  // provider.models。**模型改名适配**：primaryModel/subagentModel/visionModel 不在
  // 新清单时全部落到首项（提供方升级改名后配置自动跟随，不残留旧模型名）。
  const modelIds = (Array.isArray(probe?.modelsMeta) ? probe.modelsMeta : []).map((m) => String(m?.id ?? '')).filter(Boolean)
  if (modelIds.length) {
    const currentList = Array.isArray(provider.models) ? provider.models.map(String) : []
    if (JSON.stringify(modelIds) !== JSON.stringify(currentList)) {
      updates.models = modelIds
      const stale = []
      if (provider.primaryModel && !modelIds.includes(provider.primaryModel)) {
        updates.primaryModel = modelIds[0]
        stale.push(`主模型 ${provider.primaryModel}`)
      }
      if (provider.subagentModel && !modelIds.includes(provider.subagentModel)) {
        updates.subagentModel = modelIds[0]
        stale.push(`子 Agent 模型 ${provider.subagentModel}`)
      }
      if (provider.visionModel && !modelIds.includes(provider.visionModel)) {
        updates.visionModel = modelIds[0]
        stale.push(`视觉模型 ${provider.visionModel}`)
      }
      notes.push(`可用模型 ${modelIds.length} 个（服务端实测同步${stale.length ? `；旧模型已下线，自动适配：${stale.join('、')} → ${modelIds[0]}` : ''}）`)
    }
  }

  const firstByteMs = deriveFirstByteMs(window, probe.prefillTokPerSec, { profile })
  if (firstByteMs !== null && (provider.firstByteMs === undefined || provider.firstByteMs === null)) {
    updates.firstByteMs = firstByteMs
    notes.push(`首字节宽限 ${Math.round(firstByteMs / 1000)}s（预填充吞吐实测推导）`)
  }

  // 可见性回填（2026-09-11）：采样温度/空闲窗口/云端输出预算非端点探测项，填
  // **内核默认值**让界面显示真实生效值——注入后与内核默认一致，行为不变。
  if (provider.temperature === undefined || provider.temperature === null || provider.temperature === '') {
    updates.temperature = profile === 'local' ? 1.0 : 0
    notes.push(`采样温度 ${updates.temperature}（内核默认）`)
  }
  if (!(provider.idleMs > 0)) {
    updates.idleMs = 300000
    notes.push(`空闲窗口 300000ms（内核默认）`)
  }
  if (profile === 'cloud' && !(provider.maxOutputTokens > 0)) {
    updates.maxOutputTokens = 64000
    notes.push(`输出预算 64000（内核默认）`)
  }

  if (profile === 'local' && window !== null && !(provider.maxOutputTokens > 0)) {
    const budget = Math.min(16384, Math.floor(window / 8))
    updates.maxOutputTokens = budget
    notes.push(`输出预算 ${budget}`)
  }

  const skipped = []
  for (const k of ['contextWindow', 'firstByteMs', 'maxOutputTokens']) {
    if (provider[k] !== undefined && provider[k] !== null && updates[k] === undefined && k !== 'temperature' && k !== 'idleMs') {
      skipped.push(k)
    }
  }
  return { updates, notes, skipped }
}

/** 探测 → 窗口：模型名精确匹配 maxModelLen；fallback 单模型列表唯一项；无→null。 */
export function resolveWindowFromProbe(provider = {}, probe = {}) {
  const meta = Array.isArray(probe.modelsMeta) ? probe.modelsMeta : null
  if (!meta) return null
  const model = provider.primaryModel || (Array.isArray(provider.models) && provider.models[0]) || ''
  const hit = meta.find((m) => m.id === model)
  if (hit && hit.maxModelLen) return hit.maxModelLen
  if (meta.length === 1 && meta[0].maxModelLen) return meta[0].maxModelLen
  return null
}

/** firstByteMs 推导：最坏全窗口 prefill × 安全系数（local 2x / cloud 3x），
 *  下限 local 60s / cloud 120s，上限 480s（engine 硬上限）。2026-09-09 事故
 *  三次校准：首内容前零数据 = prefill + 模型隐藏思考（tools 触发工具规划推理，
 *  服务端缓冲不流式，实测 35-260s）——300s 封顶会假 abort 健康长思考步
 *  （300+3+300+3+301=907s 重试链），480s 覆盖最坏思考+prefill 且封死病态宽限。 */
export function deriveFirstByteMs(window, prefillTokPerSec, { profile = 'cloud' } = {}) {
  if (!window || !prefillTokPerSec || prefillTokPerSec <= 0) return null
  const worstPrefillMs = (window / prefillTokPerSec) * 1000
  const factor = profile === 'local' ? 2 : 3
  const floorMs = profile === 'local' ? 60_000 : 120_000
  return Math.min(480_000, Math.max(floorMs, Math.ceil(worstPrefillMs * factor)))
}

/** 内核 400 学习回流判定（只下调）：采纳窗口 < 当前配置值 → 返回新值，否则 null。 */
export function maybeAdoptWindowFromEvent(provider = {}, adoptedWindow) {
  const n = Number(adoptedWindow)
  if (!Number.isFinite(n) || n <= 0) return null
  const current = provider.contextWindow
  if (current !== undefined && current !== null && Number(current) > 0 && Number(current) <= n) return null
  return Math.floor(n)
}
