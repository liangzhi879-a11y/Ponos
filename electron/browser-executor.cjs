'use strict'
// 主进程浏览器执行器：按会话分区 BrowserWindow + CDP 可信输入 + 快照精简 + 人工接管 + 下载。
//
// 职责边界（spec §4.4）：
//   - 窗口生命周期：首次 browser:exec 按分区 lazily 创建可见窗口（~1100x780），
//     动作间隐藏保留（不销毁，保登录态与页面）；仅 closeSession 清存储并销毁。
//   - CDP 会话：webContents.debugger.attach('1.3')；attach 失败销毁重建重试 1 次。
//   - ref 模型：模型不写选择器。动作前在页面上下文收集可交互元素并直存
//     window.__brRefs[ref] = element（元素对象引用），动作脚本按 ref 取元素；
//     browser-common.pickSelector 生成的字符串选择器作为元素引用失效时的 fallback。
//   - 快照：页面上下文收集原始节点 {role,name,value,checked,href,path_hint,visible}，
//     主进程 buildSnapshot 做裁剪/脱敏/ref 编号（页面上下文不裁剪）。
//   - 可信输入：Input.dispatchMouseEvent / Input.dispatchKeyEvent / Input.insertText。
//   - 人工接管：pause → 500ms 指纹轮询（computeFingerprint），页面变化自动恢复并
//     广播 resumed 事件。
//   - 下载：will-download → {userData}/browser-downloads/{sessionId}/。
//
// 纯 node 可测部分（buildClickBoxScript / buildAxTreeCollectorScript 等）为字符串模板
// 工厂，不触碰 Electron；Electron 依赖在方法内按需 require，保证 node --test 可加载本模块。

const path = require('path')
const fs = require('fs')
const os = require('os')
const { buildSnapshot, computeFingerprint, pickSelector, isWhitelisted } = require('./browser-common.cjs')

// 需要先刷新 ref 缓存的动作（动作脚本按 ref 解析元素）
const REF_ACTIONS = new Set(['click', 'type', 'select', 'scroll', 'hover', 'wait'])

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

// 下载监听按分区只挂一次：webContents.session 对同一 persist: 分区是单例，
// 窗口重建（CDP attach 失败）/会话切回会复用同一 session，重复挂载会叠加
// will-download 处理器（重复 setSavePath + 监听泄漏）。用分区字符串去重。
const DOWNLOAD_LISTENER_PARTITIONS = new Set()

// will-download 处理器（纯 node 可测）：落盘 + 路径回传 {type:'download', path, filename, status}
// + 注册表状态跟踪（downloads Map：updated 进度 / done 终态）。registry 可选，缺省仅回传事件。
function createDownloadHandler(sessionId, dlDir, onEvent, registry) {
  return (_e, item) => {
    try {
      fs.mkdirSync(dlDir, { recursive: true })
      const savePath = path.join(dlDir, item.getFilename())
      item.setSavePath(savePath)
      const key = (item.getURL && item.getURL()) || savePath
      if (registry) {
        const entry = {
          filename: item.getFilename(), path: savePath, size: 0, received: 0,
          status: 'downloading', startedAt: Date.now(),
        }
        registry.set(key, entry)
        const update = () => {
          entry.received = (item.getReceivedBytes && item.getReceivedBytes()) || 0
          entry.size = (item.getTotalBytes && item.getTotalBytes()) || 0
        }
        if (item.on) item.on('updated', update)
        if (item.once) item.once('done', (_e2, state) => {
          update()
          entry.status = state === 'completed' ? 'done' : state
          entry.completedAt = Date.now()
        })
      }
      console.log('[browser-executor] download →', savePath)
      if (typeof onEvent === 'function') {
        onEvent(sessionId, { type: 'download', path: savePath, filename: item.getFilename(), status: 'started' })
      }
    } catch (err) {
      console.warn('[browser-executor] download save failed:', err.message)
    }
  }
}

// 白名单复检公共谓词（will-navigate / did-redirect-navigation 共用）
function isBlockedUrl(url) {
  return !!(url && !isWhitelisted(url))
}

// 下载类链接判定：download/attachment 路径段 或 常见文档扩展名。
// 命中者 click 走 webContents.downloadURL 真导航（可靠触发 will-download），
// window.open 弹窗也按此路由到受管窗口下载（堵住"新窗口下载静默丢失"）。
function isDownloadishUrl(url) {
  if (!url) return false
  const u = String(url)
  return /(^|[\/?&=.])(download|attachment)([/?&=.]|$)/i.test(u) ||
    /\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|txt|csv)([?#].*)?$/i.test(u)
}

// ---------------------------------------------------------------------------
// 页面上下文脚本工厂（纯函数，字符串模板；node --test 可测）
// 注意：注入脚本内禁用模板字符串嵌套（外层是模板字面量，${ 会被插值）
// ---------------------------------------------------------------------------

// 按 ref 解析命中盒（元素中心点）。selector 为 pickSelector 生成的 fallback。
function buildClickBoxScript(ref, selector) {
  const fallback = selector ? ` || (document.querySelector(${JSON.stringify(selector)}) || null)` : ''
  return `(() => {
  const el = (window.__brRefs && window.__brRefs[${ref}])${fallback};
  if (!el) return { ok: false, error: 'ref ${ref} 不存在（页面已变化？请重新取快照）' };
  const r = el.getBoundingClientRect();
  if (!r || (r.width === 0 && r.height === 0)) return { ok: false, error: 'ref ${ref} 不可见（元素被隐藏或已移除）' };
  return { ok: true, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
})()`
}

// a11y 树收集：收集可交互/信息节点（隐藏节点裁剪），存 window.__brRefs 元素引用，
// 返回 { nodes:[{role,name,value,checked,href,path_hint,visible,attrs}], readyState,
//         loading, alerts, captcha, captcha_img, title, url, scrollY }。
// ref 编号 = 节点在返回数组中的位置（1-based），与 buildSnapshot 的 ref 编号一致。
function buildAxTreeCollectorScript(maxNodes) {
  return `(() => {
  const MAX = ${maxNodes | 0};
  // 登录页登录方式切换 tab 常是无 role 的 div/span（如广东统一身份认证 login-type-tab），
  // 常规选择器不覆盖 → 快照看不到 tab 无法切换。补 class 特征选择器；roleOf 归 text 后
  // 由 isClickable 判定，可点者经 buildSnapshot 进 interactives（tag=menu-item）。
  const SEL = 'a[href],button,input,select,textarea,[role],h1,h2,h3,h4,h5,h6,p,label,td,th,li,[class*="tab"],[class*="login-type"],[class*="tabs__item"],[class*="nav-item"],[class*="dropdown"] [class*="item"],[class*="option"],[class*="select-option"]';
  const refs = (window.__brRefs = {});
  const nodes = [];
  const seen = new Set();
  // 悬浮层判定：下拉/弹层容器（.gd-select-dropdown / .el-select-dropdown / [role=listbox] /
  // popper 等）内的元素。此类层通常渲染在 body 末端且默认隐藏，展开时可见。
  // 命中者即使无 onclick/cursor:pointer，也视为可点选项（解决下拉菜单选项不进快照）。
  function isInsideOverlay(el) {
    let p = el.parentElement;
    let n = 0;
    while (p && n < 6) {
      const cls = String(p.className || '');
      if (/dropdown|listbox|popper|select__menu|select-popover|picker-panel|el-popover|gd-select__menu/i.test(cls)) return true;
      if (p.getAttribute && p.getAttribute('role') === 'listbox' || p.getAttribute && p.getAttribute('role') === 'menu') return true;
      p = p.parentElement;
      n += 1;
    }
    return false;
  }
  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    let cs = null;
    try { cs = window.getComputedStyle(el); } catch (e) { return false; }
    if (!cs) return false;
    if (cs.visibility === 'hidden' || cs.display === 'none') return false;
    const op = parseFloat(cs.opacity);
    if (isNaN(op) || op === 0) return false;
    return true;
  }
  function roleOf(el) {
    const r = el.getAttribute && el.getAttribute('role');
    if (r) return r;
    const tag = el.tagName;
    if (tag === 'A' && el.getAttribute('href')) return 'link';
    if (tag === 'BUTTON') return 'button';
    if (tag === 'SELECT') return 'combobox';
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'INPUT') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'submit' || t === 'button' || t === 'image') return 'button';
      return 'textbox';
    }
    if (tag === 'H1' || tag === 'H2' || tag === 'H3' || tag === 'H4' || tag === 'H5' || tag === 'H6') return 'heading';
    if (tag === 'P' || tag === 'LABEL' || tag === 'TD' || tag === 'TH' || tag === 'LI') return 'text';
    // 悬浮层（下拉/弹层）内无 role 的项视为 option：gd-select / el-select 的选项
    // 常是 class 含 item/option 的 li/div，无 aria 语义，快照需要它们可点可读。
    if (isInsideOverlay(el) && (tag === 'LI' || tag === 'DIV' || /item|option/i.test(String(el.className || '')))) return 'option';
    return 'text';
  }
  // 无 href 的 JS 驱动节点（菜单父项/自定义下拉）可点性启发：原生 handler / pointer 光标 /
  // 内含子交互控件 / 子菜单（LI>UL|OL）。命中者由 buildSnapshot 归入 interactives（tag=menu-item）。
  function isClickable(el) {
    if (isInsideOverlay(el)) return true;
    if (el.onclick || el.onmousedown || el.onkeydown) return true;
    let cs = null;
    try { cs = window.getComputedStyle(el); } catch (e) { return false; }
    if (cs && cs.cursor === 'pointer') return true;
    if (el.querySelectorAll('a[href],button,[role="button"],select,textarea,input,[onclick]').length > 0) return true;
    if (el.tagName === 'LI' && el.querySelector(':scope > ul, :scope > ol')) return true;
    return false;
  }
  // 下载类链接：download 属性 或 href 命中 download/attachment 路径/文档扩展名。
  // 快照标记 download:true → click 走 downloadURL 真导航而非派发鼠标事件。
  function isDownloadLink(el) {
    if (el.getAttribute && el.getAttribute('download') !== null) return true;
    const href = (el.href || el.getAttribute('href') || '');
    return /(^|[\/?&=.])(download|attachment)([/?&=.]|$)/i.test(href) || /\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|txt|csv)([?#].*)?$/i.test(href);
  }
  function nameOf(el) {
    const g = (el.getAttribute && el.getAttribute.bind(el)) || function () { return null; };
    const aria = g('aria-label');
    if (aria && String(aria).trim()) return String(aria).trim();
    const lb = g('aria-labelledby');
    if (lb) {
      const refEl = document.getElementById(String(lb).split(' ')[0]);
      if (refEl && refEl.textContent) return refEl.textContent.trim().slice(0, 80);
    }
    const title = g('title');
    if (title && String(title).trim()) return String(title).trim();
    const ph = g('placeholder');
    if (ph && String(ph).trim()) return String(ph).trim();
    if (el.tagName === 'SELECT') {
      if (el.selectedOptions && el.selectedOptions[0] && el.selectedOptions[0].textContent) return el.selectedOptions[0].textContent.trim().slice(0, 80);
      return '下拉选择';
    }
    const text = (el.innerText || el.textContent || '').trim();
    if (text && text.length <= 80) return text;
    if (el.tagName === 'INPUT') {
      const n = g('name') || el.id;
      if (n) return '输入框 ' + n;
    }
    return (el.tagName || '').toLowerCase();
  }
  function attrsOf(el) {
    const out = {};
    if (el.id) out.id = el.id;
    const name = el.getAttribute && el.getAttribute('name');
    if (name) out.name = name;
    const ph = el.getAttribute && el.getAttribute('placeholder');
    if (ph) out.placeholder = ph;
    const al = el.getAttribute && el.getAttribute('aria-label');
    if (al) out['aria-label'] = al;
    const dt = el.getAttribute && el.getAttribute('data-testid');
    if (dt) out['data-testid'] = dt;
    return out;
  }
  function pathHintOf(el) {
    const tag = (el.tagName || '').toLowerCase();
    let p = el.parentElement;
    let depth = 0;
    while (p && depth < 2) {
      const id = p.id || '';
      const cls = typeof p.className === 'string' ? p.className.split(' ')[0] : '';
      if (id || cls) return tag + ' · ' + (p.tagName || '').toLowerCase() + (id ? '#' + id : '.' + cls);
      p = p.parentElement;
      depth += 1;
    }
    return tag;
  }
  function detectCaptcha() {
    const list = document.querySelectorAll('img, iframe, [class*="captcha"], [class*="verify"], [class*="geetest"], [id*="captcha"], [id*="verify"]');
    for (let i = 0; i < list.length; i++) {
      const el = list[i];
      if (el.tagName === 'IMG') {
        const hay = ((el.getAttribute('alt') || '') + ' ' + (el.getAttribute('src') || '')).toLowerCase();
        if (/captcha|verify|code|slide|滑块|验证码/.test(hay)) return true;
      }
      if (el.tagName === 'IFRAME') {
        const src = (el.getAttribute('src') || '').toLowerCase();
        if (/captcha|geetest|recaptcha|verify/.test(src)) return true;
      }
      const cls = ((el.getAttribute && el.getAttribute('class')) || '').toLowerCase();
      const id = ((el.getAttribute && el.getAttribute('id')) || '').toLowerCase();
      if (/captcha|verify|geetest|滑块|验证码/.test(cls + ' ' + id)) return true;
    }
    const body = document.body && document.body.innerText ? document.body.innerText.slice(0, 2000).toLowerCase() : '';
    if (/验证码|captcha|请完成验证/.test(body)) return true;
    return false;
  }
  // 验证码缩略图：captcha=true 时定位可见验证码 img（data: 开头 或 alt/class/id 含
  // captcha/verify/验证码），绘制到 canvas 缩放至宽 ≤96px（保持纵横比）输出 PNG base64
  // （去掉 "data:image/png;base64," 前缀）。跨域图会污染 canvas → toDataURL 抛
  // SecurityError，捕获后跳过该候选；无候选/失败返回 null。
  function captchaImage() {
    const list = document.querySelectorAll('img, [class*="captcha"], [class*="verify"], [id*="captcha"], [id*="verify"]');
    for (let i = 0; i < list.length; i++) {
      const el = list[i];
      if (!el || el.tagName !== 'IMG' || !isVisible(el)) continue;
      const src = el.getAttribute('src') || '';
      const hay = ((el.getAttribute('alt') || '') + ' ' + (el.getAttribute('class') || '') + ' ' + (el.id || '')).toLowerCase();
      if (!(src.indexOf('data:') === 0 || /captcha|verify|验证码/.test(hay))) continue;
      const w = el.naturalWidth || el.width || 0;
      const h = el.naturalHeight || el.height || 0;
      if (!w || !h) continue;
      try {
        const cw = Math.min(96, w);
        const ch = Math.max(1, Math.round(h * cw / w));
        const cv = document.createElement('canvas');
        cv.width = cw; cv.height = ch;
        const ctx = cv.getContext('2d');
        if (!ctx) continue;
        ctx.drawImage(el, 0, 0, cw, ch);
        const url = cv.toDataURL('image/png');
        return url.indexOf('data:image/png;base64,') === 0 ? url.slice(22) : url;
      } catch (e) { /* 跨域 canvas 污染，试下一个候选 */ }
    }
    return null;
  }
  function collectAlerts() {
    const out = [];
    const list = document.querySelectorAll('[role="alert"], [aria-live], .alert, .message, .toast, .el-message, .el-alert');
    for (let i = 0; i < list.length; i++) {
      const t = (list[i].innerText || list[i].textContent || '').trim();
      if (t && t.length <= 120 && out.indexOf(t) < 0) out.push(t);
      if (out.length >= 5) break;
    }
    return out;
  }
  const candidates = document.querySelectorAll(SEL);
  for (let i = 0; i < candidates.length; i++) {
    const el = candidates[i];
    if (seen.has(el)) continue;
    seen.add(el);
    if (nodes.length >= MAX) break;
    if (!isVisible(el)) continue;
    const role = roleOf(el);
    const node = { role: role, name: nameOf(el), visible: true, path_hint: pathHintOf(el) };
    if (role === 'link') {
      node.href = el.href || el.getAttribute('href') || '';
      if (isDownloadLink(el)) node.download = true;
    }
    if (role === 'textbox' || role === 'combobox') {
      if (role === 'combobox' && el.tagName === 'SELECT' && el.selectedOptions && el.selectedOptions[0]) {
        node.value = el.selectedOptions[0].textContent || '';
      } else {
        node.value = el.value != null ? String(el.value) : '';
      }
    }
    if (role === 'checkbox' || role === 'radio') node.checked = !!el.checked;
    if (role === 'text' && isClickable(el)) node.clickable = true;
    node.attrs = attrsOf(el);
    nodes.push(node);
    refs[nodes.length] = el;
  }
  // loading 语义：仅当初始加载未完成（readyState）或存在【可见】的 spinner（rect>0 且非
  // display:none/visibility:hidden/opacity:0）。去掉"DOM 残留 loading class 即 loading"的误报。
  let loading = document.readyState !== 'complete';
  if (!loading) {
    const spinners = document.querySelectorAll('.loading, .spinner, [class*="loading"], [class*="spinner"]');
    for (let i = 0; i < spinners.length; i++) {
      if (isVisible(spinners[i])) { loading = true; break; }
    }
  }
  // 登录态启发（best-effort）：登出标记（退出/注销/logout）→ true；需登录标记
  // （请登录/未登录/操作超时/登录已过期）→ false；无信号 → null。
  const bodyText = document.body && document.body.innerText ? document.body.innerText : '';
  const logged_in = /退出|注销|安全退出|logout/i.test(bodyText)
    ? true
    : /请登录|未登录|操作超时|登录已过期|重新登录/i.test(bodyText) ? false : null;
  const hasCaptcha = detectCaptcha();
  return {
    nodes: nodes,
    readyState: document.readyState,
    loading: loading,
    logged_in: logged_in,
    alerts: collectAlerts(),
    captcha: hasCaptcha,
    captcha_img: hasCaptcha ? captchaImage() : null,
    title: document.title || '',
    url: location.href || '',
    scrollY: window.pageYOffset || 0,
  };
})()`
}

// select：按 ref 设置 <select> 选项并派发 change
function buildSelectScript(ref, value, selector) {
  const fallback = selector ? ` || (document.querySelector(${JSON.stringify(selector)}) || null)` : ''
  const want = JSON.stringify(String(value))
  return `(() => {
  const el = (window.__brRefs && window.__brRefs[${ref}])${fallback};
  if (!el || el.tagName !== 'SELECT') return { ok: false, error: 'ref ${ref} 不是下拉框' };
  const opts = Array.prototype.slice.call(el.options);
  const idx = opts.findIndex(function (o) { return o.value === ${want} || (o.textContent || '').trim() === ${want}; });
  if (idx < 0) return { ok: false, error: '下拉框无选项: ' + ${want} };
  el.selectedIndex = idx;
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true };
})()`
}

// scroll：按 ref 将元素滚动到视口中央
function buildScrollToRefScript(ref, selector) {
  const fallback = selector ? ` || (document.querySelector(${JSON.stringify(selector)}) || null)` : ''
  return `(() => {
  const el = (window.__brRefs && window.__brRefs[${ref}])${fallback};
  if (!el) return { ok: false, error: 'ref ${ref} 不存在' };
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  return { ok: true };
})()`
}

// 增量滚动：优先滚 window；若 scrollY 未变化（页面用内层滚动容器），
// 回退到页面最大可滚动元素（scrollHeight - clientHeight 最大者）滚动。
function buildScrollDeltaScript(delta) {
  const d = Number(delta) | 0
  return `(() => {
  const before = window.pageYOffset || 0;
  window.scrollBy(0, ${d});
  if ((window.pageYOffset || 0) !== before) return { ok: true, method: 'window' };
  let best = null, bestDelta = 0;
  const all = document.querySelectorAll('*');
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    const sh = el.scrollHeight, ch = el.clientHeight;
    if (ch > 0 && sh > ch && sh - ch > bestDelta) { best = el; bestDelta = sh - ch; }
  }
  if (best) { best.scrollTop += ${d}; return { ok: true, method: 'container' }; }
  return { ok: false, error: '无可滚动区域' };
})()`
}

// 指纹采集：title/href/textLen/inputCount → computeFingerprint（人工接管恢复检测）
function buildFingerprintCollectScript() {
  return `(() => {
  const inputs = document.querySelectorAll('input, textarea, select, [contenteditable="true"]');
  let textLen = 0;
  for (let i = 0; i < inputs.length; i++) {
    const el = inputs[i];
    if (el.value) textLen += String(el.value).length;
    if (el.tagName === 'SELECT' && el.selectedOptions && el.selectedOptions[0] && el.selectedOptions[0].textContent) textLen += el.selectedOptions[0].textContent.length;
  }
  return { title: document.title || '', href: location.href || '', textLen: textLen, inputCount: inputs.length };
})()`
}

// 内联 base64 上限：≤512KB 直接随 js 结果回传；更大由主进程 finalizeJsResult 落临时文件。
const JS_B64_INLINE_LIMIT = 512 * 1024

// js 动作注入脚本：await 表达式 + 结果归一化（ArrayBuffer/TypedArray→base64、DOM 元素→摘要、
// Map/Set→对象/数组、循环/深链→深度截断、异常→{ok:false,error}）。
// 注意：外层是模板字面量，注入代码内禁用 ${ 嵌套（唯一插值是表达式本身）。
function buildJsWrapperScript(expression) {
  const expr = String(expression == null ? '' : expression).trim()
  if (!expr) throw new Error('js 缺少表达式')
  return `(() => {
  function __brNorm(v, depth) {
    if (depth > 6) return '[深度截断]';
    if (v === null) return null;
    const t = typeof v;
    if (t === 'string' || t === 'number' || t === 'boolean' || t === 'undefined') return v;
    if (t === 'bigint') return String(v) + 'n';
    if (t === 'function') return '[function ' + (v.name || 'anonymous') + ']';
    if (v instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && v instanceof SharedArrayBuffer)) {
      const size = v.byteLength;
      const bytes = new Uint8Array(v);
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return { __br_type: 'binary', size: size, b64: btoa(bin) };
    }
    if (ArrayBuffer.isView(v)) {
      const ab = v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength);
      const size = ab.byteLength;
      const bytes = new Uint8Array(ab);
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return { __br_type: 'binary', size: size, b64: btoa(bin) };
    }
    if (v instanceof Date) return v.toISOString();
    if (v instanceof Map) { const out = {}; v.forEach(function (val, key) { out['' + key] = __brNorm(val, depth + 1); }); return out; }
    if (v instanceof Set) return Array.from(v).map(function (x) { return __brNorm(x, depth + 1); });
    if (v && v.nodeType) {
      const r = v.getBoundingClientRect ? v.getBoundingClientRect() : null;
      return {
        __br_type: 'node', tag: (v.tagName || '').toLowerCase(), id: v.id || '',
        cls: (typeof v.className === 'string' ? v.className : '').split(' ').slice(0, 3),
        text: (v.innerText || v.textContent || '').trim().slice(0, 120),
        href: v.getAttribute && v.getAttribute('href') || '',
        value: v.value !== undefined ? String(v.value).slice(0, 120) : undefined,
        rect: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null,
      };
    }
    if (Array.isArray(v)) return v.map(function (x) { return __brNorm(x, depth + 1); });
    if (v && typeof v === 'object') {
      const out = {};
      const keys = Object.keys(v).slice(0, 100);
      for (let i = 0; i < keys.length; i++) out[keys[i]] = __brNorm(v[keys[i]], depth + 1);
      return out;
    }
    return String(v);
  }
  return (async function () {
    try {
      const r = await (${expr});
      return { ok: true, value: __brNorm(r, 0) };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  })();
})()`
}

// js 结果收尾：把 >limit 的 binary 节点写临时文件并替换为 {__br_type:'file', path, size}；
// ≤limit 的保留内联 base64。纯 node 可测（tmpDir 注入）。
function finalizeJsResult(raw, sessionId, { limit = JS_B64_INLINE_LIMIT, tmpDir = os.tmpdir() } = {}) {
  if (!raw || raw.ok !== true) return raw
  let counter = 0
  const walk = (v) => {
    if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = walk(v[i]); return v }
    if (v && typeof v === 'object' && v.__br_type === 'binary') {
      if (v.size <= limit) return v
      if (typeof v.b64 !== 'string' || !v.b64) return { __br_type: 'binary', size: v.size, b64: null, error: '二进制过大且无数据' }
      counter += 1
      const dir = path.join(tmpDir, 'yfworking-browser-js')
      fs.mkdirSync(dir, { recursive: true })
      const file = path.join(dir, `${String(sessionId || 's').replace(/[^A-Za-z0-9_-]/g, '_')}-${Date.now()}-${counter}.bin`)
      fs.writeFileSync(file, Buffer.from(v.b64, 'base64'))
      return { __br_type: 'file', path: file, size: v.size }
    }
    if (v && typeof v === 'object') {
      for (const k of Object.keys(v)) v[k] = walk(v[k])
      return v
    }
    return v
  }
  return walk(raw)
}

// ---------------------------------------------------------------------------
// BrowserExecutor
// ---------------------------------------------------------------------------
class BrowserExecutor {
  constructor({ onEvent } = {}) {
    this.onEvent = typeof onEvent === 'function' ? onEvent : () => {}
    this.win = null              // 当前自动化窗口（v1 单窗口）
    this.sessionId = null        // 窗口绑定的会话（partition 后缀）
    this.humanMode = false       // 人工接管中
    this.mode = 'normal'         // normal | imitation（拟真行为 Task 7 细化）
    this.lastSnapshot = null     // 上一版快照（diff 基线）
    this.refSelectors = {}       // ref → pickSelector fallback 选择器
    this.refHrefs = {}           // ref → 绝对 URL（下载类链接 click 用 downloadURL）
    this.refDownload = {}        // ref → 是否下载类链接
    this.fpTimer = null          // 指纹轮询定时器
    this.fpBase = null           // 暂停时的基线指纹
    this.busy = false            // 单动作在途（防并发 CDP 串扰）
    this.downloads = new Map()   // url → {filename,path,size,received,status,startedAt}（快照 downloads 字段）
    this.expiredNotified = false // 登录过期一次性上报幂等标记
  }

  // 等待某 URL 下载出现终态（downloadURL 触发的下载）；超时返回当前状态（仍可轮询快照）
  async waitForDownload(url, timeout = 15000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const entry = this.downloads.get(url)
      if (entry && entry.status !== 'downloading') return entry
      await sleep(300)
    }
    const entry = this.downloads.get(url)
    if (entry) return entry
    throw new Error('下载未触发: ' + url)
  }

  // ---------- 状态 / 控制 ----------

  getStatus() {
    const win = this.win
    const alive = !!(win && !win.isDestroyed())
    return {
      windowOpen: alive,
      url: alive ? (win.webContents.getURL() || null) : null,
      mode: this.mode,
      humanMode: this.humanMode,
    }
  }

  async openWindow(sessionId) {
    const win = await this.ensureWindow(sessionId)
    if (win && !win.isDestroyed()) {
      win.show()
      win.focus()
      this.onEvent(this.sessionId, { type: 'status', text: '浏览器窗口已打开' })
    }
    return { ok: true }
  }

  async onControl(command) {
    if (command === 'pause') {
      this.enterHumanMode()
      return 'paused'
    }
    if (command === 'resume') {
      this.exitHumanMode()
      return 'resumed'
    }
    return command
  }

  // ---------- 窗口生命周期 ----------

  async ensureWindow(sessionId, retry = 0) {
    const { BrowserWindow } = require('electron')
    if (this.win && !this.win.isDestroyed()) {
      if (this.sessionId === sessionId) return this.win
      // v1 单窗口：会话切换时销毁旧窗口换新分区重建（spec §9 不做多窗口并行自动化）
      console.log('[browser-executor] switching session window →', sessionId)
      this.destroyWindow()
    }
    this.sessionId = sessionId
    this.lastSnapshot = null
    this.refSelectors = {}
    const partition = 'persist:automation-' + sessionId
    const win = new BrowserWindow({
      width: 1100,
      height: 780,
      title: 'YFWorking 浏览器自动化',
      icon: path.join(__dirname, '..', 'public', 'icon.png'),
      show: true,
      webPreferences: {
        partition,
        contextIsolation: true,
        sandbox: false,
        backgroundThrottling: false,
      },
    })
    this.win = win
    win.on('closed', () => {
      if (this.win === win) {
        this.win = null
        this.sessionId = null
        this.humanMode = false
        this.stopFingerprintPoll()
      }
    })
    // 下载落盘：{userData}/browser-downloads/{sessionId}/ + 路径回传（v1 通道）。
    // 同一 persist: 分区只挂一次监听（DOWNLOAD_LISTENER_PARTITIONS 去重），
    // 避免 CDP attach 失败重建窗口或会话切回时叠加 will-download 处理器。
    if (!DOWNLOAD_LISTENER_PARTITIONS.has(partition)) {
      DOWNLOAD_LISTENER_PARTITIONS.add(partition)
      win.webContents.session.on('will-download', createDownloadHandler(sessionId, this.downloadsDir(sessionId), this.onEvent.bind(this), this.downloads))
    }
    // target=_blank 弹窗：下载类 URL → downloadURL 路由到受管窗口（will-download 进注册表，
    // 堵住"新窗口下载静默丢失"）；白名单内普通 URL → 同窗口加载；其余拒绝（v1 无多标签页管理）。
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url && isDownloadishUrl(url)) {
        win.webContents.downloadURL(url)
        return { action: 'deny' }
      }
      if (url && isWhitelisted(url)) {
        win.loadURL(url).catch(() => {})
      }
      return { action: 'deny' }
    })
    // 主框架导航复检（spec §5）：白名单外拒绝。
    // will-navigate 只覆盖渲染进程发起的主框架导航（客户端跳转）；
    // did-redirect-navigation 补上服务端 3xx 重定向复检（见下）。
    // 两者都不拦截 loadURL/goBack 等程序化导航——goto 的拦截在动作层。
    win.webContents.on('will-navigate', (e, url) => {
      if (isBlockedUrl(url)) {
        console.warn('[browser-executor] blocked non-whitelisted navigation:', url)
        this.onEvent(this.sessionId, { type: 'status', text: '已拦截白名单外导航: ' + url })
        e.preventDefault()
      }
    })
    // 服务端重定向复检：did-redirect-navigation 覆盖 loadURL 后的 HTTP 3xx 跳转
    // （will-navigate 不触发于服务端重定向，白名单域名经 3xx 跳转到外域会绕过复检）
    win.webContents.on('did-redirect-navigation', (e, url) => {
      if (isBlockedUrl(url)) {
        console.warn('[browser-executor] blocked non-whitelisted redirect:', url)
        this.onEvent(this.sessionId, { type: 'status', text: '已拦截白名单外重定向: ' + url })
        e.preventDefault()
      }
    })
    // CDP 会话：attach 失败销毁重建重试 1 次
    try {
      win.webContents.debugger.attach('1.3')
    } catch (err) {
      console.warn('[browser-executor] CDP attach failed, rebuild window once:', err.message)
      this.destroyWindow()
      if (retry === 0) return this.ensureWindow(sessionId, 1)
      throw new Error('CDP attach 失败（已重试一次）: ' + (err && err.message || err))
    }
    console.log('[browser-executor] window ready, partition:', partition)
    return win
  }

  destroyWindow() {
    this.stopFingerprintPoll()
    this.humanMode = false
    this.fpBase = null
    this.expiredNotified = false
    const win = this.win
    this.win = null
    this.sessionId = null
    if (win && !win.isDestroyed()) {
      try { win.destroy() } catch (err) { console.warn('[browser-executor] window destroy failed:', err.message) }
    }
  }

  async closeSession(sessionId) {
    const win = this.win
    if (win && !win.isDestroyed()) {
      if (sessionId && this.sessionId !== sessionId) return { ok: true }
      try {
        await win.webContents.session.clearStorageData()
        console.log('[browser-executor] session storage cleared:', sessionId)
      } catch (err) {
        console.warn('[browser-executor] clearStorageData failed:', err.message)
      }
      this.downloads.clear()
      this.expiredNotified = false
      this.onEvent(sessionId, { type: 'closed' })
      this.destroyWindow()
    }
    return { ok: true }
  }

  downloadsDir(sessionId) {
    const { app } = require('electron')
    const safe = String(sessionId || 'default').replace(/[^A-Za-z0-9_-]/g, '_')
    return path.join(app.getPath('userData'), 'browser-downloads', safe)
  }

  // ---------- 执行入口 ----------

  async exec(sessionId, action, params = {}) {
    if (action !== 'resume' && this.humanMode) {
      return { ok: false, code: 'paused', snapshot: await this.snapshotFor(sessionId), error: '人工接管中，等待继续' }
    }
    if (this.busy) {
      return { ok: false, snapshot: await this.snapshotFor(sessionId), error: '上一动作执行中，请稍候' }
    }
    let win
    try {
      win = await this.ensureWindow(sessionId)
    } catch (e) {
      return { ok: false, snapshot: null, error: String(e && e.message || e) }
    }
    // 拟真模式开关（opt-in；拟真输入行为 Task 7 细化）
    const nextMode = params && params.mode === 'imitation' ? 'imitation' : 'normal'
    if (nextMode !== this.mode) {
      this.mode = nextMode
      this.onEvent(this.sessionId, { type: 'mode', mode: this.mode })
    }
    this.busy = true
    try {
      if (REF_ACTIONS.has(action)) await this.collect(win)
      this.onEvent(this.sessionId, { type: 'status', text: this.actionLabel(action, params) })
      const result = await this.withTimeout(action, () => this.runAction(win, action, params))
      // 快照的 executeJavaScript 在页面导航中可能永不 settle（Electron 已知行为），
      // 必须单独加超时：动作 30s 超时后页面仍在加载时，snapshot 挂死会让整个
      // exec 永不返回 → bridge pending 挂起 → 内核 60s 超时。10s 兜底吞掉。
      const snapshot = await this.withTimeout('snapshot', () => this.snapshot(win), 10000).catch(() => null)
      if (result && result.ok === false) {
        return { ok: false, code: result.code || undefined, snapshot, error: result.error || '动作未完成' }
      }
      const out = { ok: true, snapshot, error: null }
      // js 等动作携带结构化结果（data），随快照一并回传
      if (result && result.data !== undefined) out.data = result.data
      return out
    } catch (e) {
      return { ok: false, snapshot: await this.withTimeout('snapshot', () => this.snapshot(win), 10000).catch(() => null), error: String(e && e.message || e) }
    } finally {
      this.busy = false
    }
  }

  // 单动作超时（默认 30s）；pause_for_human 不超时
  withTimeout(action, fn, timeoutMs = 30000) {
    if (action === 'pause_for_human') return fn()
    let timer = null
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`动作超时 (${timeoutMs}ms)`)), timeoutMs)
    })
    return Promise.race([fn(), timeout]).finally(() => clearTimeout(timer))
  }

  async runAction(win, action, params) {
    switch (action) {
      case 'goto': return this.goto(win, params)
      case 'back': return this.back(win)
      case 'forward': return this.forward(win)
      case 'refresh': return this.refresh(win)
      case 'snapshot': return { ok: true }
      case 'click': return this.click(win, params)
      case 'type': return this.type(win, params)
      case 'select': return this.select(win, params)
      case 'scroll': return this.scroll(win, params)
      case 'hover': return this.hover(win, params)
      case 'js': return this.runJs(win, params)
      case 'wait': return this.wait(win, params)
      case 'pause_for_human': return this.pauseForHuman(win, params)
      case 'resume': return this.onControl('resume')
      case 'close': return this.closeAction(win)
      default: throw new Error('未知动作: ' + action)
    }
  }

  actionLabel(action, params = {}) {
    switch (action) {
      case 'goto': return '正在导航到 ' + (params.url || '')
      case 'back': return '正在返回上一页'
      case 'forward': return '正在前进'
      case 'refresh': return '正在刷新页面'
      case 'snapshot': return '正在读取页面快照'
      case 'click': return '正在点击 ref ' + params.ref
      case 'type': return '正在输入文字到 ref ' + params.ref
      case 'select': return '正在选择 ref ' + params.ref
      case 'scroll': return '正在滚动页面'
      case 'hover': return '正在悬停 ref ' + params.ref
      case 'wait': return '正在等待 (' + (params.ms != null ? params.ms + 'ms' : 'ref ' + params.ref) + ')'
      case 'pause_for_human': return '暂停，等待人工操作'
      case 'close': return '正在隐藏浏览器窗口（会话保留）'
      default: return '正在执行 ' + action
    }
  }

  // ---------- 动作实现 ----------

  async goto(win, params) {
    const url = String(params && params.url || '')
    if (!url) throw new Error('goto 缺少 url')
    if (!isWhitelisted(url)) throw new Error('目标域名不在白名单（默认 *.gov.cn/localhost），已拒绝导航: ' + url)
    try {
      await win.loadURL(url)
    } catch (err) {
      // 部分站点导航抛 ERR_ABORTED（重定向/下载等），页面可能已生效，交由快照判断
      console.warn('[browser-executor] goto warning:', err && err.message || err)
    }
    return { ok: true }
  }

  async back(win) {
    const nav = win.webContents.navigationHistory
    if (nav && typeof nav.goBack === 'function') nav.goBack()
    else win.webContents.goBack()
    await this.waitForNavigation(win)
    return { ok: true }
  }

  async forward(win) {
    const nav = win.webContents.navigationHistory
    if (nav && typeof nav.goForward === 'function') nav.goForward()
    else win.webContents.goForward()
    await this.waitForNavigation(win)
    return { ok: true }
  }

  async refresh(win) {
    win.webContents.reload()
    await this.waitForNavigation(win)
    return { ok: true }
  }

  // 等待导航完成（back/forward/refresh 后）：返回前确保新文档已加载，
  // 否则 exec 的快照会取到旧页面（或 executeJavaScript 在导航中途报错）。
  //  - did-finish-load 触发，或 URL 变化且 readyState === 'complete' → 完成
  //  - 300ms 内未触发 did-start-loading（back/forward 无历史）→ 未发生导航，直接返回
  //  - 超时（默认 30s，与 exec 的 withTimeout 一致）→ 抛错交由 exec 转 error
  async waitForNavigation(win, timeoutMs = 30000) {
    const wc = win.webContents
    const startUrl = wc.getURL()
    const start = Date.now()
    const deadline = start + timeoutMs
    let started = false
    let finished = false
    const onStart = () => { started = true }
    const onFinish = () => { finished = true }
    wc.on('did-start-loading', onStart)
    wc.once('did-finish-load', onFinish)
    try {
      while (Date.now() < deadline) {
        await sleep(50)
        if (finished) return true
        if (!started && Date.now() - start > 300) return false
        const url = wc.getURL()
        if (url !== startUrl) {
          const ready = await wc.executeJavaScript('document.readyState').catch(() => null)
          if (ready === 'complete') return true
        }
      }
      throw new Error('导航等待超时 (' + timeoutMs + 'ms)')
    } finally {
      wc.removeListener('did-start-loading', onStart)
      wc.removeListener('did-finish-load', onFinish)
    }
  }

  async click(win, params) {
    const ref = params && params.ref
    if (ref == null) throw new Error('click 缺少 ref')
    // 下载类链接：downloadURL 真导航（可靠触发 will-download 进注册表），
    // 等待终态后随 data 返回文件路径；不派发鼠标事件（避免默认行为差异）。
    if (this.refDownload[ref] && this.refHrefs[ref]) {
      const url = this.refHrefs[ref]
      const before = this.downloads.size
      win.webContents.downloadURL(url)
      let entry
      try { entry = await this.waitForDownload(url) } catch {
        // URL 重定向导致注册表键不一致时，取窗口期内新增的最新条目
        entry = this.downloads.size > before ? Array.from(this.downloads.values()).pop() : null
      }
      return {
        ok: true,
        data: { download: { url, path: entry && entry.path || null, status: entry && entry.status || 'unknown' } },
      }
    }
    const box = await this.clickBox(win, ref)
    await this.dispatchMouse(win, 'click', box)
    return { ok: true }
  }

  async type(win, params) {
    const ref = params && params.ref
    if (ref == null) throw new Error('type 缺少 ref')
    const text = String(params.text == null ? '' : params.text)
    await this.typeText(win, ref, text, !!params.clear)
    return { ok: true }
  }

  async select(win, params) {
    const ref = params && params.ref
    if (ref == null) throw new Error('select 缺少 ref')
    const res = await win.webContents.executeJavaScript(buildSelectScript(ref, params.value, this.refSelectors[ref] || null))
    if (!res || !res.ok) throw new Error(res && res.error || 'select ref ' + ref + ' 失败')
    return { ok: true }
  }

  async scroll(win, params) {
    const ref = params && params.ref
    if (ref != null) {
      const res = await win.webContents.executeJavaScript(buildScrollToRefScript(ref, this.refSelectors[ref] || null))
      if (!res || !res.ok) throw new Error(res && res.error || 'scroll ref ' + ref + ' 失败')
    } else {
      const delta = Number(params && params.delta != null ? params.delta : 400)
      if (!isFinite(delta) || delta === 0) throw new Error('scroll 缺少有效 ref 或 delta')
      const res = await win.webContents.executeJavaScript(buildScrollDeltaScript(delta))
      if (!res || !res.ok) throw new Error(res && res.error || 'scroll 失败')
    }
    return { ok: true }
  }

  async hover(win, params) {
    const ref = params && params.ref
    if (ref == null) throw new Error('hover 缺少 ref')
    const box = await this.clickBox(win, ref)
    await this.dispatchMouse(win, 'move', box)
    // 悬停后留出渲染/子菜单展开时间，避免紧随其后的快照读到展开前状态
    await sleep(250)
    return { ok: true }
  }

  // js：页面上下文执行表达式，结果归一化回传（awaitPromise + returnByValue 语义）。
  // 二进制 ≤512KB 内联 base64；更大由 finalizeJsResult 落临时文件返回路径。
  async runJs(win, params) {
    const expression = params && params.expression
    if (expression == null || !String(expression).trim()) throw new Error('js 缺少 expression')
    const raw = await win.webContents.executeJavaScript(buildJsWrapperScript(expression), true)
    const result = finalizeJsResult(raw, this.sessionId)
    if (!result || result.ok === false) {
      return { ok: false, error: result && result.error || 'js 执行失败' }
    }
    return { ok: true, data: result.value }
  }

  // wait：固定 ms 等待 或 按 ref 轮询元素出现（≤30s）
  async wait(win, params) {
    const ms = Number(params && params.ms != null ? params.ms : 0)
    const ref = params && params.ref
    if (ref != null) {
      const deadline = Date.now() + 30000
      while (Date.now() < deadline) {
        const data = await this.collect(win)
        if ((data.nodes || []).length >= Number(ref)) return { ok: true }
        await sleep(500)
      }
      throw new Error('等待元素 ref ' + ref + ' 超时 (30s)')
    }
    if (ms > 0) await sleep(Math.min(ms, 30000))
    return { ok: true }
  }

  async pauseForHuman(_win, _params) {
    this.enterHumanMode()
    return { ok: false, code: 'paused', error: '人工接管中，等待继续' }
  }

  async closeAction(win) {
    // 隐藏保留窗口（登录态/页面存活），仅 closeSession 销毁；
    // closed 事件通知 GUI 收起状态胶囊（后续 browser:event 会自动重新出现）
    if (win && !win.isDestroyed()) win.hide()
    this.onEvent(this.sessionId, { type: 'status', text: '浏览器窗口已隐藏（会话保留）' })
    this.onEvent(this.sessionId, { type: 'closed' })
    return { ok: true }
  }

  // ---------- 可信输入 ----------

  async clickBox(win, ref) {
    const res = await win.webContents.executeJavaScript(buildClickBoxScript(ref, this.refSelectors[ref] || null))
    if (!res || !res.ok) throw new Error(res && res.error || 'ref ' + ref + ' 不可点击')
    return { cx: res.cx, cy: res.cy }
  }

  async dispatchMouse(win, kind, box) {
    const cdp = win.webContents.debugger
    if (kind === 'click') {
      await cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.cx, y: box.cy, button: 'left', clickCount: 1 })
      await cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.cx, y: box.cy, button: 'left', clickCount: 1 })
    } else if (kind === 'move') {
      await cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.cx, y: box.cy })
    }
  }

  // typeText 按 ref 协议：ref → buildClickBoxScript 命中盒点击聚焦 + Ctrl+A 清空 + insertText
  async typeText(win, ref, text, clear) {
    const cdp = win.webContents.debugger
    const box = await this.clickBox(win, ref)
    await this.dispatchMouse(win, 'click', box)
    if (clear) {
      const ctrl = { modifiers: 2 }
      await cdp.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, ...ctrl })
      await cdp.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, ...ctrl })
      await cdp.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, ...ctrl })
      await cdp.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: 0 })
      await cdp.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, modifiers: 0 })
      await cdp.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, modifiers: 0 })
    }
    // insertText 逐字符插入：兼容中文；拟真模式（逐键 keyDown/char/keyUp + 随机延迟）Task 7
    for (const ch of String(text)) {
      await cdp.sendCommand('Input.insertText', { text: ch })
    }
    return { ok: true }
  }

  // ---------- 快照 ----------

  // 页面上下文收集 + 主进程 ref→fallback 选择器缓存
  async collect(win) {
    const data = await win.webContents.executeJavaScript(buildAxTreeCollectorScript(300))
    const nodes = (data && data.nodes) || []
    const selectors = {}
    const hrefs = {}
    const downloads = {}
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]
      selectors[i + 1] = pickSelector(n && n.attrs)
      if (n && n.href) hrefs[i + 1] = n.href
      if (n && n.download === true) downloads[i + 1] = true
    }
    this.refSelectors = selectors
    this.refHrefs = hrefs
    this.refDownload = downloads
    return data
  }

  async snapshot(win) {
    // 点击/切换登录方式后异步渲染稳定：先 collect 一次 → 短等 250ms → 再 collect 一次
    // 取后值（collect 幂等，第二次会覆盖 refSelectors，无副作用）。仅 snapshot 加此等待，
    // wait 动作的 collect 循环不受影响；snapshot 已被 exec 的 withTimeout(10s) 保护。
    let data = await this.collect(win)
    await sleep(250)
    data = await this.collect(win)
    const nodes = (data && data.nodes) || []
    if (nodes.length > 0) {
      // 页级字段挂在首节点上（buildSnapshot 从 axTree[0] 读取）
      nodes[0].readyState = data.readyState
      nodes[0].loading = data.loading
      nodes[0].captcha = data.captcha
      nodes[0].captcha_img = data.captcha_img || null
      nodes[0].alerts = data.alerts
      nodes[0].logged_in = data.logged_in ?? null
    }
    // 登录过期一次性上报（幂等标记，避免每帧快照刷屏）；agent 读到
    // logged_in=false + 过期文本后自行点击"重新登录"恢复。
    if (data.logged_in === false && !this.expiredNotified) {
      this.expiredNotified = true
      this.onEvent(this.sessionId, { type: 'status', text: '检测到登录过期（操作超时/未登录），快照 logged_in=false，请点击"重新登录"后继续' })
    }
    const size = win.getContentSize()
    const snap = buildSnapshot({
      axTree: nodes,
      url: data.url,
      title: data.title,
      viewport: { w: size[0], h: size[1] },
      scrollY: data.scrollY || 0,
      prevSnapshot: this.lastSnapshot,
      downloads: Array.from(this.downloads.values()).map(({ filename, path, size, received, status }) =>
        ({ filename, path, size: size || 0, received: received || 0, status })),
    })
    this.lastSnapshot = snap
    return snap
  }

  async snapshotFor(_sessionId) {
    const win = this.win
    if (!win || win.isDestroyed()) return null
    try { return await this.snapshot(win) } catch (e) { return null }
  }

  // ---------- 人工接管 ----------

  enterHumanMode() {
    if (this.humanMode) return
    this.humanMode = true
    this.onEvent(this.sessionId, { type: 'paused' })
    this.onEvent(this.sessionId, { type: 'mode', mode: 'human' })
    this.startFingerprintPoll()
  }

  exitHumanMode() {
    if (!this.humanMode && !this.fpTimer) return
    this.humanMode = false
    this.stopFingerprintPoll()
    this.fpBase = null
    this.onEvent(this.sessionId, { type: 'mode', mode: this.mode })
    this.onEvent(this.sessionId, { type: 'resumed' })
  }

  // 500ms 轮询页面指纹（title/href/textLen/inputCount）：
  // 指纹相对暂停时基线变化 → 判定人工完成 → 自动恢复
  startFingerprintPoll() {
    this.stopFingerprintPoll()
    const win = this.win
    this.fpBase = null
    if (!win || win.isDestroyed()) return
    win.webContents.executeJavaScript(buildFingerprintCollectScript())
      .then((data) => { this.fpBase = computeFingerprint(data) })
      .catch(() => { /* 页面未就绪，下一轮采集 */ })
    this.fpTimer = setInterval(() => { void this.tickFingerprint() }, 500)
  }

  async tickFingerprint() {
    const win = this.win
    if (!win || win.isDestroyed()) return
    try {
      const data = await win.webContents.executeJavaScript(buildFingerprintCollectScript())
      const fp = computeFingerprint(data)
      if (this.fpBase !== null && fp !== this.fpBase) {
        console.log('[browser-executor] fingerprint changed — human takeover finished, resuming')
        this.exitHumanMode()
      }
    } catch (e) { /* 导航中，忽略本轮 */ }
  }

  stopFingerprintPoll() {
    if (this.fpTimer) {
      clearInterval(this.fpTimer)
      this.fpTimer = null
    }
  }
}

module.exports = { BrowserExecutor, buildClickBoxScript, buildAxTreeCollectorScript, buildSelectScript, buildScrollToRefScript, buildScrollDeltaScript, buildFingerprintCollectScript, buildJsWrapperScript, finalizeJsResult, JS_B64_INLINE_LIMIT, createDownloadHandler, isBlockedUrl, isDownloadishUrl }
