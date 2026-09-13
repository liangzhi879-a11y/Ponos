// 应用智控：纯工具函数（占位符插值与必填校验）
//
// 独立成文件是刻意的：`app-runner.cjs`（执行器）与 `app-runner-desktop.cjs`（desktop 三级
// 执行）都要用这两个函数，若放在 app-runner.cjs 再由 desktop 侧 require，就形成
// app-runner ⇄ app-runner-desktop 循环依赖（CJS 下表现为函数为 undefined，且报错极隐晦）。
'use strict'

/** 替换 ${name} 占位符（未提供则替换为空串，与 plan 约定一致） */
function interpolate(input, args = {}) {
  if (typeof input !== 'string') return input
  return input.replace(/\$\{(\w+)\}/g, (_m, k) => (args[k] == null ? '' : String(args[k])))
}

/** 校验必填参数；缺参一律**不执行任何动作**并返回错误清单 */
function checkRequired(params = [], args = {}) {
  const errors = []
  for (const p of params || []) {
    if (p?.required && (args?.[p.name] == null || args[p.name] === '')) {
      errors.push(`缺少必填参数：${p.name}`)
    }
  }
  return { ok: errors.length === 0, errors }
}

module.exports = { interpolate, checkRequired }
