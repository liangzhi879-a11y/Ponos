// 窗口壳：标题栏 + iframe 内容区。模块 UI 经 nodeIntegrationInSubFrames 获得 window.ponosRpc。
const q = new URLSearchParams(location.search)
const winKey = q.get('key')
const $ = s => document.querySelector(s)
const ICONS = { vortex: '◈', settings: '⚙', 'message-square': '≡', database: '▤' }

function iconChar(name) { return ICONS[name] || '◇' }

async function boot() {
  const r = await window.ponosRpc?.call('system.window.context', { key: winKey })
  if (r?.ok) {
    $('#icon').textContent = iconChar(r.result.icon)
    $('#title').textContent = r.result.name
    const conv = r.result.current
    $('#session').textContent = conv ? `会话 ${conv.slice(0, 6)}` : '默认会话'
    $('#frame').src = r.result.entryUrl
  } else {
    $('.shell-title').textContent = '加载失败'
  }
}

$('#btn-min').onclick = () => window.ponosRpc?.call('system.window.minimize', { key: winKey })
$('#btn-max').onclick = () => window.ponosRpc?.call('system.window.maximize', { key: winKey })
$('#btn-close').onclick = () => window.ponosRpc?.call('system.window.close', { key: winKey })
// 会话下拉骨架（P3 完整会话管理）：新建会话 = 打开同模块新实例
$('#btn-new').onclick = () => {
  const moduleId = q.get('module')
  const conv = crypto.randomUUID()
  window.ponosRpc?.call('system.window.open', { moduleId, params: { conversation: conv } })
}

boot()
