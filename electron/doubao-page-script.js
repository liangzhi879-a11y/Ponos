// 豆包页面上下文执行脚本构造器（webContents.executeJavaScript 注入）。
// 页面内 window.fetch 已被豆包 JS 劫持 → 自动注入 a_bogus/msToken 签名。
//
// P0 校准结论（2026-08-17 实测捕获）：
// 1. /api/image/generate 已不可用（网关对所有 /api/* 路径返回 401，含不存在路径）。
// 2. 真实链路 = POST /chat/completion（SSE 流式文本）→ 轮询 /im/chain/recent_conv
//    （cmd 3200, not_need_message:false）→ 从最新会话消息的 content_block
//    block_type=2074 creation_block.creations[].image.image_thumb.url 取图。
// 3. 图片 URL 为 CDN 签名 URL（~tplv-...wm... 模板即水印），原始 key 无签名 403，
//    去水印由 bridge 端 watermark_remove.py 完成（cv2.inpaint / crop 降级）。

// 注入脚本：挂捕获钩子到 window（首次调用时包装 fetch，记录匹配请求的 url/options）。
// 注意：绝不读响应体（r.clone().text() 在 SSE 流上会阻塞到流结束，而生成脚本读流后
// 提前 break，流不结束 → fetch 永不 resolve → executeJavaScript 挂起超时——P0 已踩坑）
const CAPTURE_HOOK = `(() => {
  if (window.__DOUBAO_CAPTURE_HOOKED__) return 'already'
  const orig = window.fetch
  window.fetch = async (...args) => {
    const r = await orig(...args)
    try {
      if (/\\/api\\/|\\/chat\\/completion|\\/im\\/chain/.test(String(args[0]))) {
        window.__DOUBAO_CAPTURED__ = { url: String(args[0]), options: args[1] }
      }
    } catch {}
    return r
  }
  window.__DOUBAO_CAPTURE_HOOKED__ = true
  return 'hooked'
})()`

// 生成脚本：POST /chat/completion → SSE 收流 → 轮询 recent_conv 取图
export function buildGenerateScript(payload) {
  return `(async () => {
    const payload = ${JSON.stringify(payload)}
    const sleep = ms => new Promise(r => setTimeout(r, ms))
    const uuid = () => crypto.randomUUID()
    const localConv = 'local_' + Date.now() + Math.floor(Math.random() * 1000)
    const now = Date.now()
    const ratio = payload.ratio || '1:1'
    const count = Math.max(1, Math.min(4, Number(payload.count) || 1))
    // 与 AI 创作页一致的触发文本（页面实测为 "生成图片：" + 用户输入）
    const text = (String(payload.prompt || '')).includes('生成图片') ? String(payload.prompt) : '生成图片：' + String(payload.prompt || '')
    const body = {
      client_meta: { local_conversation_id: localConv, conversation_id: '', bot_id: '7338286299411103781', last_section_id: '', last_message_index: null },
      messages: [{
        local_message_id: uuid(),
        content_block: [{ block_type: 10000, content: { text_block: { text, icon_url: '', icon_url_dark: '', summary: '' }, pc_event_block: '' }, block_id: uuid(), parent_id: '', meta_info: [], append_fields: [] }],
        message_status: 0,
      }],
      option: {
        send_message_scene: '', create_time_ms: now, collect_id: '', is_audio: false, answer_with_suggest: false, tts_switch: false,
        need_deep_think: 0, click_clear_context: false, from_suggest: false, is_regen: false, is_replace: false,
        is_from_click_option: false, is_from_click_softlink: false, disable_sse_cache: false, select_text_action: '', is_select_text: false,
        resend_for_regen: false, scene_type: 0, unique_key: uuid(), start_seq: 0, need_create_conversation: true,
        conversation_init_option: { need_ack_conversation: true }, regen_query_id: [], edit_query_id: [], regen_instruction: '',
        no_replace_for_regen: false, message_from: 0, shared_app_name: '', shared_app_id: '',
        sse_recv_event_options: { support_chunk_delta: true }, is_ai_playground: false, is_old_user: true,
        recovery_option: { is_recovery: false, req_create_time_sec: Math.floor(now / 1000), append_sse_event_scene: 0 },
        message_storage_type: 0, related_deleted_message_ids: {}, connector_info_list: [],
        model_config: { model_item_key: '', model_extra_params: {} }, aggregate_params: { model_item_key: '', provider_id: '' },
      },
      chat_ability: { ability_type: 3, ability_param: JSON.stringify({ ability_param: { model: 'Seedream 4.5', ratio }, ability_type: 1 }) },
      user_context: [],
      ext: { answer_with_suggest: '0', sub_conv_firstmet_type: '1', collection_id: '', conversation_init_option: '{"need_ack_conversation":true}', commerce_credit_config_enable: '0' },
    }
    // P0 校准：/chat/completion 需带完整 query（aid/device_id/web_id 等），裸路径请求虽返回
    // 200 + SSE 事件但生成任务不落库（无图片消息）——与真实页面请求一致
    const webIdStore = (() => { try { return JSON.parse(localStorage.getItem('samantha_web_web_id') || '{}') } catch { return {} } })()
    const teaStore = (() => { try { return JSON.parse(localStorage.getItem('__tea_cache_tokens_497858') || '{}') } catch { return {} } })()
    const deviceId = webIdStore.web_id || ''
    const webId = teaStore.web_id || deviceId
    const baseQ = 'version_code=20800&language=zh&device_platform=web&doubao_device_platform=web&aid=497858&real_aid=497858&pkg_type=release_version&device_id=' + encodeURIComponent(deviceId) + '&pc_version=3.32.8&doubao_pc_version=3.32.8&web_id=' + encodeURIComponent(webId) + '&tea_uuid=' + encodeURIComponent(webId) + '&region=CN&sys_region=CN&samantha_web=1&web_platform=browser&use-olympus-account=1&web_tab_id=' + uuid()
    try {
      const res = await fetch('/chat/completion?' + baseQ, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Agw-Js-Conv': 'str, str', 'Referer': location.origin + '/chat/' + localConv },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const t = await res.text().catch(() => '')
        return { code: res.status === 401 ? 401 : -1, message: 'http ' + res.status + ' ' + t.slice(0, 200) }
      }
      // SSE 收流：无需解析图片，只需等到回复结束（answer_finish_attr / msg_finish_attr / 流结束）。
      // 兜底：45s 无 finish 也强制进入轮询（豆包改版事件名或异常流时防挂起 180s）
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      const sseStart = Date.now()
      let matchedFinish = false
      while (Date.now() - sseStart < 45000) {
        let done = false, value
        try { const r = await reader.read(); done = r.done; value = r.value } catch { break }
        if (done) break
        buf += dec.decode(value, { stream: true })
        if (buf.includes('"answer_finish_attr"') || buf.includes('"msg_finish_attr"')) { matchedFinish = true; break }
      }
      const sseDiag = { ms: Date.now() - sseStart, bytes: buf.length, matchedFinish, head: buf.slice(0, 200) }
      // 轮询取图：recent_conv 找最新会话（not_need_message:true 仅返回会话元数据）→
      // batch_single（cmd 3101）拉取该会话消息 → 消息 content 为 JSON 字符串，
      // 解析后取 block_type=2074 creation_block.creations[].image URL（P0 校准，最多等 60s）
      const ctHeaders = { 'Content-Type': 'application/json; encoding=utf-8', 'Agw-Js-Conv': 'str, str' }
      const recentConvBody = { cmd: 3200, uplink_body: { pull_recent_conv_chain_uplink_body: { limit: 20, message_count_per_conv: 10, api_version: 1, conv_version: 0, direction: 3, option: { not_need_message: true, need_complete_conversation: true, need_coco_conversation: true, need_coco_bot: true, need_pc_pin_chain: true, pc_pin_query_type: 0 } } }, sequence_id: uuid(), channel: 2, version: '1' }
      const extractFromContent = (contentStr) => {
        // 消息 content 是 JSON 字符串（可能为 block 数组 / content_block 对象 / 嵌套结构），
        // 递归遍历查找 block_type=2074 creation_block.creations 提取图片 URL
        let data
        try { data = JSON.parse(contentStr) } catch { return { urls: [], blocks: 0, seen2074: 0, imageKeySample: '' } }
        const urls = []
        let seen2074 = 0
        let blocksSeen = 0
        let imageKeySample = ''
        const walk = (node) => {
          if (!node || typeof node !== 'object') return
          if (Array.isArray(node)) { for (const x of node) walk(x); return }
          if (node.block_type === 2074 && node.content && node.content.creation_block && node.content.creation_block.creations) {
            seen2074++
            for (const c of node.content.creation_block.creations) {
              if (c && c.image && !imageKeySample) imageKeySample = Object.keys(c.image).join(',')
              const u = c && c.image && (c.image.image_thumb && c.image.image_thumb.url || c.image.image_ori && c.image.image_ori.url)
              if (u && !urls.includes(u)) urls.push(u)
            }
          }
          if (Array.isArray(node.content_block)) blocksSeen += node.content_block.length
          for (const k of Object.keys(node)) {
            const v = node[k]
            if (v && typeof v === 'object') walk(v)
          }
        }
        walk(data)
        return { urls, blocks: blocksSeen, seen2074, imageKeySample }
      }
      const pullConv = async (convId) => {
        const br = await fetch('/im/chain/batch_single?' + baseQ, {
          method: 'POST', headers: ctHeaders,
          body: JSON.stringify({ cmd: 3101, uplink_body: { batch_pull_singe_chain_uplink_body: { conversation_type: 3, direction: 3, limit: 20, params: [{ conversation_id: convId }], evaluate_ab_params: '', evaluate_common_params: '', ext: {} } }, sequence_id: uuid(), channel: 2, version: '1' }),
        })
        if (!br.ok) return { urls: [], stat: { msgs: 0, blocks: 0, seen2074: 0, imageKeySample: '', http: br.status } }
        const bj = await br.json()
        const mm = bj.downlink_body && bj.downlink_body.batch_pull_singe_chain_downlink_body && bj.downlink_body.batch_pull_singe_chain_downlink_body.message_map || {}
        const msgs = (mm[convId] && mm[convId].messages) || []
        const urls = []
        const stat = { msgs: msgs.length, blocks: 0, seen2074: 0, imageKeySample: '', samples: [] }
        for (const m of msgs) {
          // content 可能为字符串（真实）或对象（兼容）
          const contentStr = typeof m.content === 'string' ? m.content : (m.content ? JSON.stringify(m.content) : '')
          if (stat.samples.length < 4 && contentStr) stat.samples.push(contentStr.slice(0, 180))
          if (!contentStr) continue
          const r = extractFromContent(contentStr)
          stat.blocks += r.blocks; stat.seen2074 += r.seen2074
          if (r.imageKeySample && !stat.imageKeySample) stat.imageKeySample = r.imageKeySample
          for (const u of r.urls) if (!urls.includes(u)) urls.push(u)
        }
        return { urls, stat }
      }
      const diag = { rounds: [] }
      for (let i = 0; i < 30; i++) {
        await sleep(2000)
        const round = { i, pulls: [] }
        try {
          const cr = await fetch('/im/chain/recent_conv?' + baseQ, { method: 'POST', headers: ctHeaders, body: JSON.stringify(recentConvBody) })
          round.recentHttp = cr.status
          if (!cr.ok) { diag.rounds.push(round); continue }
          const ct = await cr.json()
          round.recentStatus = ct.status_code ?? ct.status ?? null
          const inner = ct.downlink_body && ct.downlink_body.pull_recent_conv_chain_downlink_body || {}
          const cells = inner.cells || []
          // 生成复用已有会话（不新建），取 update_time 最新的会话（cell 可能无 conversation 键，回退到 cell 本身）
          const cands = cells
            .map(c => c.conversation || c)
            .filter(c => c && c.conversation_id)
            .sort((a, b) => Number(b.update_time || 0) - Number(a.update_time || 0))
          round.cells = cells.length
          round.cands = cands.length
          round.top = cands.slice(0, 3).map(c => String(c.conversation_id).slice(0, 12))
          for (const conv of cands.slice(0, 3)) {
            const pr = await pullConv(conv.conversation_id)
            round.pulls.push({ conv: String(conv.conversation_id).slice(0, 12), n: pr.urls.length, stat: pr.stat })
            if (pr.urls.length >= count) return { code: 0, data: { images: pr.urls.slice(0, count) }, sse: sseDiag }
          }
        } catch (e) { round.err = e && e.message || String(e) }
        diag.rounds.push(round)
      }
      return { code: -1, message: 'no image in response', sse: sseDiag, diag: diag.rounds.slice(-3) }
    } catch (e) { return { code: -1, message: e && e.message || String(e), sse: sseDiag } }
  })()`
}

// 捕获脚本：返回最近一次被记录的匹配请求
export function buildCaptureScript() {
  return `(() => {
    if (!window.__DOUBAO_CAPTURED__) return { code: 404, message: 'no capture yet' }
    return { code: 0, captured: window.__DOUBAO_CAPTURED__ }
  })()`
}

export { CAPTURE_HOOK }
