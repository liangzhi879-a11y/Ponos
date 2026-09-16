// src/lib/skillTree.ts —— 技能「父级/子级」归属与分类的**纯逻辑**（2026-09-15，P1 批次二 C）。
//
// ## 为什么抽出来
//
// 这段逻辑原先内联在 `SkillsPanel.tsx` 里（约 5 处各自判断），有两个后果：
//   ① **判据不一致**（见下）；② `.tsx` 无法被 `node --test` 直接 import（本仓库无 vitest/tsx，
//   实测 `ERR_UNKNOWN_FILE_EXTENSION`），故这些分支**一条都测不到**——同 `skillDetail.ts`、
//   `agentTools.ts`、`chatScopeMigration.ts` 的抽出动机。
//
// ## 抽出来时发现并修掉的两个真缺陷（都在"父级子级分类浏览"范围内）
//
// ### 缺陷 1：父级判据两处不一致 ⇒ 子技能可能整片不显示
//   一处写 `(s.subskills||[]).length > 0`，另一处写 `... || all.some(c => c.parent === s.id)`。
//   若某父级**自己没写 `subskills`**，只有子技能用 `parent:` 反指它（这在本仓库是**官方支持的写法**，
//   见 `yfwx-project-eval` 的 `parent: yfwx-suite`），则渲染路径会把它当普通技能 ⇒ 子技能不渲染。
//   现在统一为 `isParentSkill()`（双来源合并），只有一处真相。
//
// ### 缺陷 2：声明了 `parent` 但父级未安装 ⇒ 技能在界面上**彻底消失**
//   原过滤 `!s.parent` 把子技能一律排除在顶层之外，而渲染时 `if (s.parent) return null` 又跳过它们，
//   于是"父级不存在"的子技能既不是顶层、也不会成为任何人的子项 —— **用户看不到它**，
//   既不能查看详情也不能用（且无任何提示）。现在这类"孤儿"显式留在顶层。
//   触发场景是现实的：父技能被卸载 / 父子分处不同技能根 / 拼写错误 —— 都属于静默失败。
//
// ## 与「分类文件夹」的区别（别把两个概念混起来）
//
// `parent` = **技能层级**（谁是谁的子项，作者在 SKILL.md 里声明，权威）。
// `folder`（Working/Coding 或用户自建）= **应用侧的分组标签**，纯界面组织，与技能文件无关。
// 两者独立：一个技能可以同属 `folder: Working` 且 `parent: yfwx-suite`。

export type SkillLike = {
  id: string
  /** 子技能在 SKILL.md 里声明的父级 id（显式声明，权威） */
  parent?: string
  /** 父技能在 SKILL.md 里声明的子技能 id 列表（另一种来源） */
  subskills?: string[]
}

/** 前缀启发式：与既有行为保持一致（改口径会让老用户的技能全部换组）。 */
const WORKING_PREFIX = /^(gxtz-|yfwdoc-|yfwweb-|yfwx-)/

export function defaultFolderOf(skillId: string): string {
  return WORKING_PREFIX.test(skillId) ? 'Working' : 'Coding'
}

/**
 * 技能所属分类：**用户显式指派优先，其次前缀启发式**。
 * @param map 应用侧的人工指派表（`uiStore.skillFolderMap`）
 */
export function resolveFolder(skillId: string, map?: Record<string, string>): string {
  const assigned = map?.[skillId]
  return (assigned && assigned.trim()) ? assigned : defaultFolderOf(skillId)
}

/**
 * 该技能是否为「父级」（应作为可展开项渲染）。
 * **双来源合并**（缺陷 1 的修复）：自己声明了 `subskills`，或有子技能声明它为自己的 `parent`。
 */
export function isParentSkill(skill: SkillLike, all: SkillLike[]): boolean {
  if ((skill.subskills || []).length > 0) return true
  return all.some((c) => c.parent === skill.id && c.id !== skill.id)
}

/**
 * 某父级的子技能 id 清单（双来源合并、去重、过滤掉不存在的、排除自指）。
 * 自指必须排除：`parent: <自己>` 的坏数据会让技能成为自己的子项 ⇒ 递归/重复渲染。
 */
export function childIdsOf(skill: SkillLike, all: SkillLike[]): string[] {
  const ids = new Set<string>(skill.subskills || [])
  for (const c of all) if (c.parent === skill.id) ids.add(c.id)
  ids.delete(skill.id)
  return [...ids].filter((id) => all.some((x) => x.id === id))
}

/**
 * 「孤儿」= 声明了 `parent`，但那个父级**不在这里**（未安装/拼写错/分处不同根），
 * 且它也不是任何技能的 `subskills` 成员。
 *
 * 这类技能必须留在顶层显示（缺陷 2 的修复）——否则它既不渲染为子项、又被顶层过滤掉，
 * 结果是**在界面上彻底消失**，且没有任何提示。
 */
export function isOrphanChild(skill: SkillLike, all: SkillLike[]): boolean {
  if (!skill.parent) return false
  if (all.some((x) => x.id === skill.parent)) return false
  if (all.some((x) => (x.subskills || []).includes(skill.id))) return false
  return true
}

/**
 * 计算顶层可见技能（即分类文件夹里直接平铺的那些）。
 *
 * 规则：
 *   · 没有 `parent` 的技能 → 顶层（另有搜索行为：自身命中、或它的某个子技能命中，都保留它，
 *     因为子技能的命中必须能把它带出来，否则"搜到了却看不到"）；
 *   · **孤儿**（`parent` 指向不存在的技能）→ 顶层，且只按自身是否命中过滤。
 * @param matches 搜索谓词（无搜索时传 `() => true`）
 */
export function topLevelSkills<T extends SkillLike>(skills: T[], matches: (s: T) => boolean): T[] {
  return skills.filter((s) => {
    if (!s.parent) {
      if (matches(s)) return true
      // 子技能命中 → 带出父级（搜索体验：命中在子项时也要能找到入口）
      return (s.subskills || []).some((cid) => {
        const child = skills.find((x) => x.id === cid)
        return !!child && matches(child)
      })
    }
    return isOrphanChild(s, skills) && matches(s)
  })
}

/**
 * 取某父级下**当前应显示**的子技能。
 * @param filterActive 是否处于搜索态（搜索时只显示命中的子项；父级自身命中则显示全部子项）
 */
export function childrenToShow<T extends SkillLike>(
  parent: T, all: T[], matches: (s: T) => boolean, filterActive: boolean,
): T[] {
  const ids = childIdsOf(parent, all)
  const kids = ids.map((id) => all.find((x) => x.id === id)).filter((x): x is T => !!x)
  if (!filterActive) return kids
  if (matches(parent)) return kids
  return kids.filter((c) => matches(c))
}
