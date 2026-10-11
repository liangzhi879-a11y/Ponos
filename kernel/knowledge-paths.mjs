// kernel/knowledge-paths.mjs —— 知识库的**路径助手**（零依赖）
//
// 为什么单独成模块（2026-09-30）：`knowledgeRoot` 同时被
//   `kernel/knowledge.mjs`（知识内核）与 `kernel/knowledge-backend-sqlite.mjs`（SQLite 后端）使用，
// 若由 knowledge.mjs 导出，就形成 **backend-sqlite ⇄ knowledge 的静态环**，
// 被架构门禁 `kernel-tests/arch-graph-cycles.test.mjs` 判为**架构腐化**（该测试明确要求：
// "引入新环应优先解开，而不是直接加进基线"）。
// 把纯路径逻辑下沉到零依赖模块，是解环的最小改动：两边都依赖它，它谁也不依赖。
//
// 本模块**只放纯函数**（不做 IO、不读配置），任何需要文件系统或状态的东西都不属于这里。
import { join } from 'node:path'

/** 知识库根目录（`<configDir>/knowledge`） */
export function knowledgeRoot(configDir) {
  return join(configDir || '', 'knowledge')
}
