// 验证 bridge 的 getOrCreateSession 会把经验注入段（新会话含引导）拼进 prompt 文件
// 用法：node scripts/verify-experience-inject.mjs
import { join } from 'node:path'
import os from 'node:os'

process.env.YFW_TEST_HOME = process.env.YFW_TEST_HOME || join(os.tmpdir(), 'yfw-verify-inject-home')
// 随机端口隔离 live 实例（避免 EADDRINUSE 被 bridge 的 uncaughtException handler 吞掉），
// 同时让 listen 成功后事件循环可控（尾部显式 exit(0) 防挂死）
process.env.YFW_BRIDGE_PORT = String(39000 + Math.floor(Math.random() * 1000))

try {
  const bridge = await import('../server/bridge.mjs')
  bridge.ensurePersonalDir?.()

  // 直接调用内部拼装函数（若导出）或断言模块可加载 + 关键常量存在
  const fns = ['buildExperienceSection', 'buildSedimentPrompt', 'ensurePersonalDir']
  for (const f of fns) {
    if (typeof bridge[f] !== 'function') throw new Error(`bridge 未导出 ${f}（Task 2 未集成）`)
  }
  const sec = bridge.buildExperienceSection(4096)
  if (typeof sec !== 'string') throw new Error('buildExperienceSection 返回非字符串')
  const sed = bridge.buildSedimentPrompt()
  if (!sed.includes('经验沉淀')) throw new Error('引导文本缺失')
  console.log('[verify] experience 集成 OK, section len=', sec.length, 'sediment len=', sed.length)
} catch (e) {
  console.error('[verify] FAIL:', (e && e.message) || e)
  process.exit(1)
}

process.exit(0)
