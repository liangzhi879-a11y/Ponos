// 会话自动标题（chat + task 模式通用）：
//   ① 首条用户消息到达 → truncateTitle 即时标题（≤12 字）；
//   ② 首轮回复完成 / 打开仍为占位标题的旧会话 → generateChatTitle 模型概括升级。
// 标题长度硬上限 12 字符（按 code point 计，汉字 1 字）。
// 手动重命名后（titleAuto=false）永不自动覆盖——由 chatStore 侧把关，本模块只管生成。
import { useSettingsStore } from '../stores/settingsStore'
import { fetchBridgeConfig, getBridgeUrl } from './config'

const MAX_TITLE = 12

/** 即时标题：折叠空白后截断到 12 字符。空文本返回 ''。 */
export function truncateTitle(text: string, max: number = MAX_TITLE): string {
  const clean = (text || '').replace(/\s+/g, ' ').trim()
  if (!clean) return ''
  return [...clean].slice(0, max).join('')
}

/** 模型输出清洗：去首尾引号/标点/空白，压缩内部空白，截断到 12 字符。无效返回 null。 */
export function sanitizeTitle(raw: string): string | null {
  let t = (raw || '').replace(/\s+/g, ' ').trim()
  t = t.replace(
    /^[\s"'“”‘’「」『』【】《》\[\]()（）:：!！?？.。,，、;；]+|[\s"'“”‘’「」『』【】《》\[\]()（）:：!！?？.。,，、;；]+$/g,
    '',
  )
  t = [...t].slice(0, MAX_TITLE).join('')
  return t || null
}

interface TitleProvider {
  baseUrl: string
  token: string
  model: string
}

/**
 * 解析标题生成所用 provider 配置：
 * 1) GUI 设置（localStorage）——用户 GUI 级选择，token 齐全时优先；
 * 2) bridge /config 兜底——与内核同源（localStorage 损坏/未配置时仍能取到
 *    真实 token；GUI 的 provider 管理本就会同步到 bridge）。
 */
async function resolveTitleProvider(): Promise<TitleProvider | null> {
  const { settings } = useSettingsStore.getState()
  const gp = settings.providers?.find((p) => p.id === settings.activeProvider)
  const gui: TitleProvider = {
    baseUrl: (gp?.apiBaseUrl || settings.apiUrl || '').replace(/\/+$/, ''),
    token: gp?.authToken || settings.apiKey || '',
    model: gp?.subagentModel || gp?.primaryModel || settings.model || '',
  }
  if (gui.baseUrl && gui.token && gui.model) return gui
  try {
    const cfg = await fetchBridgeConfig()
    const bp = (cfg.providers || []).find((p) => p.id === cfg.activeProvider) || cfg.providers?.[0]
    if (bp?.apiBaseUrl && bp.authToken) {
      return {
        baseUrl: bp.apiBaseUrl.replace(/\/+$/, ''),
        token: bp.authToken,
        model: bp.subagentModel || bp.primaryModel || bp.models?.[0] || '',
      }
    }
  } catch {
    /* bridge 未启动：无兜底 */
  }
  return null
}

function buildPrompt(userText: string, assistantText: string): string {
  return (
    '根据以下对话内容生成一个不超过12个字的概括标题（名词短语优先，无引号无结尾标点），只输出标题本身：\n' +
    `用户：${(userText || '').slice(0, 400)}\n` +
    `助手：${(assistantText || '').slice(0, 400)}`
  )
}

/**
 * 调 provider 生成会话概括标题（≤12 字）。失败（未配置/网络/超时/响应异常）
 * 返回 null——调用方保留原标题（首条消息截断值），静默降级。
 *
 * 端点策略：先试 OpenAI 兼容 /v1/chat/completions（vLLM 等本地服务器；
 * chat_template_kwargs 关闭 Qwen3 系 thinking，避免模型"想半天不出题"）；
 * 非 2xx 再退回 Anthropic 兼容 /v1/messages（deepseek/minimax 的 /anthropic
 * 基址只实现该格式）。
 */
export async function generateChatTitle(userText: string, assistantText = ''): Promise<string | null> {
  const p = await resolveTitleProvider()
  if (!p) return null
  const prompt = buildPrompt(userText, assistantText)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  try {
    // 1) OpenAI 兼容（本地 vLLM 等）
    let res = await fetch(`${p.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${p.token}` },
      body: JSON.stringify({
        model: p.model,
        max_tokens: 64,
        temperature: 0.3,
        messages: [{ role: 'user', content: prompt }],
        chat_template_kwargs: { enable_thinking: false },
      }),
      signal: controller.signal,
    })
    if (res.ok) {
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
      const raw = data?.choices?.[0]?.message?.content
      const title = sanitizeTitle(typeof raw === 'string' ? raw : '')
      if (title) return title
      console.error('[titleGen] chat/completions 输出无法解析:', raw?.slice(0, 80))
      return null
    }
    // 2) Anthropic 兼容（deepseek/minimax /anthropic 基址）
    res = await fetch(`${p.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': p.token,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: p.model,
        max_tokens: 64,
        temperature: 0.3,
        system: '你是标题生成器，只输出标题本身，不要任何解释。',
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    })
    if (!res.ok) {
      console.error('[titleGen] provider HTTP', res.status)
      return null
    }
    const data = (await res.json()) as { content?: Array<{ text?: string }> }
    const raw = (Array.isArray(data?.content) ? data.content : [])
      .map((b) => b?.text || '')
      .join('')
    const title = sanitizeTitle(raw)
    if (!title) console.error('[titleGen] messages 输出无法解析:', raw.slice(0, 80))
    return title
  } catch (e) {
    console.error('[titleGen] 调用失败:', e)
    return null
  } finally {
    clearTimeout(timer)
  }
}
