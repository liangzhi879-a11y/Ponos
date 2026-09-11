// kernel/workflow.mjs —— 工作流模块兼容 re-export 层（实现见 workflow-dsl / dag / nodes / engine）
//
// 工作流 = 确定性 DAG 执行 + 节点级审计哈希链（与 skill 平权协同：同一发现机制
// workflow.yml 目录 + 平铺 .yml、共享 triggers 触发词；skill=灵活处理，workflow=严格输出）。
//
// DSL v2「edges 即真相」：
//   name/description/version/triggers   —— 元数据（triggers 与 skill 同 schema）
//   inputs: [{name, type, required}]    —— 入口参数（agentic 触发时注入）
//   nodes: [{id, type, label, position, config{...}, retry{...}}]
//   edges: [{id, source, target, sourceHandle?}]  —— 执行顺序唯一真相（无 edges = 旧格式）
// 节点执行器读扁平字段 → 加载期摊平 node.config（normalizeNode）。
//
// 模块分工（Task 1-5 拆分）：
//   workflow-dsl.mjs     解析 / 归一化 / 校验 / 发现 / 加载 / 旧格式迁移
//   workflow-dag.mjs     就绪集合调度器（条件边 / 跳过传播 / 重试 / 取消）
//   workflow-nodes.mjs   单节点执行器（含 loop/iterate 子图递归）
//   workflow-engine.mjs  引擎装配（run / 审计 / 事件 / stop / confirm / cron / webhook）
//
// 本文件保持既有 import 面不变（cli.mjs / tools.mjs / kernel-tests 无需改动）。

export {
  DSL_VERSION, parseYaml, renderTemplate, resolvePath, evalCondition,
  discoverWorkflows, discoverWorkflowsAll, matchAutoTrigger, loadWorkflow,
  normalizeWorkflow, validateWorkflow, migrateLegacy,
} from './workflow-dsl.mjs'
export { createWorkflowEngine, verifyRun } from './workflow-engine.mjs'
