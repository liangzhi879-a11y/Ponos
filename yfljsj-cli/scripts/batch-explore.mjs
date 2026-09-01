#!/usr/bin/env node
// Task 7：批量探测全部接口必填字段（安全：只发空 body/缺字段请求）→ 写回命令表 + 探测报告。
// 用法：node yfljsj-cli/scripts/batch-explore.mjs（需先 auth login，读 ~/.yfljsj/config.json）
// 复用 Task 4 probeFields（逐接口空 body → 解析参数校验报错 → 迭代补字段）。
// 危险路径（delete/remove/clear/drop）跳过，避免误触删改类接口。
import { loadApis, probeFields, writeApis, guessType } from '../yfljsj.mjs'
import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const DANGEROUS = /delete|remove|clear|drop/i
// 网关共享校验模板噪音字段（Source/column 非业务字段名）→ 探测结果不沉淀进命令表
const NOISE_FIELD_RE = /^source$|^column$/i

/**
 * 批量探测：遍历命令表全部命令，跳过危险路径；探出必填字段写回命令表 params。
 * 可注入 probe/reportPath/write 便于测试（真机缺省走 probeFields/writeApis）。
 * @returns {{ results: Array<{module,action,fields?|skipped?|error?}>, withFields: number, msg: string }}
 */
export async function runBatchExplore({
  apis = loadApis(),
  probe = probeFields,
  reportPath = 'yfljsj-cli/explore-report.json',
  write = writeApis,
} = {}) {
  const results = []
  for (const [mk, m] of Object.entries(apis.modules)) {
    for (const c of m.commands) {
      if (DANGEROUS.test(c.path)) {
        results.push({ module: mk, action: c.action, skipped: 'dangerous' })
        continue
      }
      try {
        const { fields } = await probe(c.path, { method: c.method, service: m.service })
        if (fields.length) {
          for (const f of fields) {
            if (NOISE_FIELD_RE.test(f)) continue // 噪音字段不入命令表
            if (!c.params[f]) c.params[f] = { type: guessType(f), required: true, desc: '' }
          }
          results.push({ module: mk, action: c.action, fields })
        }
      } catch (e) {
        results.push({ module: mk, action: c.action, error: String(e.message).slice(0, 60) })
      }
    }
  }
  write(apis)
  writeFileSync(reportPath, JSON.stringify(results, null, 1))
  // 统计
  const withFields = results.filter((r) => r.fields?.length)
  const msg = `探测完成: ${results.length} 接口，${withFields.length} 个探出必填字段`
  return { results, withFields: withFields.length, msg }
}

// 直接执行（import 时跳过，测试可注入 mock probe 复用 runBatchExplore）
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  runBatchExplore()
    .then(({ msg }) => {
      console.log(msg)
    })
    .catch((e) => {
      console.error((e && e.stack) || e)
      process.exit(1)
    })
}
