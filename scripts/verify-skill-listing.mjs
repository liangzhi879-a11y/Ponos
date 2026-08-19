// 宿主清单瘦身回归验证（Task 1 产物 + Task 4 扩展点）：node scripts/verify-skill-listing.mjs
// bridge.mjs 模块加载即 httpServer.listen(PORT)（L1413），注入 YFW_BRIDGE_PORT=0 落到随机端口避免占用
process.env.YFW_BRIDGE_PORT = '0'

const bridge = await import('../server/bridge.mjs')
const skills = bridge.listInstalledSkills()
const listing = bridge.appendSkillList('')

let failed = 0
const check = (cond, label) => {
  if (cond) console.log('ok: ' + label)
  else { console.error('FAIL: ' + label); failed++ }
}

// ── 层级断言（Task 3 技能库标注后 + 经验系统优化 P1 符号链接实体化） ──
// code-review-and-quality 原为符号链接（→ ~/.agents/skills），bridge 枚举时被过滤；
// 2026-08-14 经验系统优化 P1 已复制实体到 ~/.yfworking/skills 并删除链接，
// 现为真实目录、正常参与枚举，子技能计数为 53，互逆检查无需豁免。
const parents = skills.filter(s => s.subskills.length)
const children = skills.filter(s => s.parent)
const independents = skills.filter(s => !s.parent && !s.subskills.length)
console.log(`\n父技能 ${parents.length} / 子技能 ${children.length} / 独立 ${independents.length}`)
check(parents.length === 5, `父技能 = 5（实际 ${parents.length}）`)
check(children.length === 53, `子技能 = 53（实际 ${children.length}）`)
check(independents.length === 6, `独立技能 = 6（实际 ${independents.length}）`)

// ── 结构断言（中间态=全部独立披露 63 条；Task 3 后=父+独立 11 条） ──
const allNames = new Set(skills.map(s => s.name))
const lines = listing.split('\n').filter(l => l.startsWith('- '))
const lineNames = lines.map(l => l.match(/^- ([^：]+)/)?.[1]?.trim() || l.slice(2).split('：')[0])
check(lines.length === parents.length + independents.length, `清单行数 = 父+独立（${lines.length} = ${parents.length + independents.length}）`)
check(lineNames.every(n => allNames.has(n)), '清单每行首 token 均为真实技能名')
check(!/\bv\d+\.\d+\.\d+/.test(listing), '清单无版本号残留（vX.Y.Z 已剥离）')

// 子技能名不得作为独立行首出现；父条目须内联全部子技能名
const childNames = new Set(children.map(s => s.name))
check(!lines.some(l => childNames.has(l.match(/^- ([^：]+)/)?.[1]?.trim())), '子技能名不在清单独立成条')
for (const p of parents) {
  const line = lines.find(l => l.startsWith('- ' + p.name))
  const missing = p.subskills.filter(n => !line || !line.includes(n))
  check(!missing.length, `父技能 ${p.name} 条目内联全部 ${p.subskills.length} 子名（缺失 ${missing.join(',') || '无'}）`)
}

// 互逆一致性：父 subskills = 声明该父 parent 的子技能集合
const parentOf = {}
for (const c of children) parentOf[c.parent] = (parentOf[c.parent] || []).concat(c.name)
for (const p of parents) {
  const declared = [...p.subskills].sort()
  const actual = [...(parentOf[p.name] || [])].sort()
  check(JSON.stringify(declared) === JSON.stringify(actual), `父 ${p.name} 的 subskills 与子技能 parent 互逆一致`)
}
// 父技能不得有 parent
check(parents.every(p => !p.parent), '父技能均无 parent')

// 孤儿断言：子技能声明的 parent 必须存在且本身是无 parent 的父技能（不存在 → 孤儿）
for (const key of Object.keys(parentOf)) {
  const target = skills.find(s => s.name === key)
  check(!!target && !target.parent, `parent 声明 "${key}" 指向存在的无 parent 父技能`)
}

// ── 体积断言 ──
console.log(`\n宿主清单字符数：${listing.length}（改造前 11,073）`)
check(listing.length < 4000, '宿主清单 < 4000 字符')
if (failed) { console.error(`\n${failed} 项失败`); process.exit(1) }
console.log('\n全部通过')
// bridge.mjs 加载即 listen（L1413），事件循环被 httpServer 挂住——必须显式退出
process.exit(0)
