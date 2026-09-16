// server/skill-detail-routes.mjs —— 技能详情（只读）的 HTTP 面（2026-09-15，P1 批次二 C）。
//
// ## 用户要求与设计决策的对应
//
// 需求原文：「每张卡片注明 skill 详情，展开可管理触发规则，管理关联脚本」。
// 决策 D2 = **只读展示 + 系统打开文件**：应用**不**写用户的 `SKILL.md`。
// 故这里的"管理"不是编辑接口，而是**把真实内容取出来给用户看**（触发规则、关联脚本清单、
// 来源目录与文件路径），改由用户在自己的编辑器里完成（界面按钮走 Electron `shell:open-path`
// 的既有 IPC `openInExplorer`，不需要新增 IPC）。好处：应用永不参与用户技能文件的格式演进
// ——本仓库的技能文件里承载了大量业务内容（gxtz-* 等），任何"应用规范化写入"都是格式风险。
//
// ## 为什么按需单独取，而不是并进 /skills 列表
//
// 列表要列几十个技能；而"关联脚本清单"需要逐个 `readdirSync` 技能目录并 `stat` 每个文件。
// 并进列表 = 打开技能页就做几十次系统调用（慢），而用户往往只展开其中一两个。
// 故详情走独立路由，仅在该卡片展开时请求。
//
// 纯 handler（本仓库纪律：测试不起 bridge），可直调测试。
import { loadSkillDetail } from '../kernel/skills.mjs'

/**
 * 处理 `/skill-detail?id=<skillId>` 的 GET。
 * @param {{method: string, pathname: string, searchParams?: URLSearchParams, roots: string[]}} ctx
 * @returns {Promise<{status: number, body: object} | null>} 未匹配返回 `null`（交给后续路由）
 */
export async function handleSkillDetailRoute(ctx) {
  const { method, pathname, searchParams, roots } = ctx || {}
  if (pathname !== '/skill-detail') return null
  if (method !== 'GET') return null
  const id = String(searchParams?.get?.('id') ?? '').trim()
  if (!id) return { status: 400, body: { ok: false, error: '缺少 id 参数（技能名）' } }
  let detail = null
  try {
    detail = loadSkillDetail({ roots: Array.isArray(roots) ? roots : [], id })
  } catch (e) {
    return { status: 500, body: { ok: false, error: `读取技能详情失败：${e?.message || e}` } }
  }
  // 404 而非 200+空对象：界面据此显示"该技能在磁盘上已不存在"（例如刚从别处删掉），
  // 而不是渲染一张空白的详情面板（用户会以为是界面坏了）。
  if (!detail) return { status: 404, body: { ok: false, error: `未找到技能「${id}」的 SKILL.md` } }
  return { status: 200, body: { ok: true, ...detail } }
}
