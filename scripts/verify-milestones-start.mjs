// MILESTONE-START 解析验证（TDD，见 docs/superpowers/plans/2026-08-14-plan-execute-mode.md Task 1）
import { extractMilestoneMarks } from '../server/milestones.mjs'

let failed = 0
const check = (cond, label) => {
  if (cond) console.log('ok: ' + label)
  else { console.error('FAIL: ' + label); failed++ }
}

// START 解析
const t1 = extractMilestoneMarks('开始执行<!--MILESTONE-START 1/3 需求分析-->然后写代码')
check(JSON.stringify(t1.starts) === JSON.stringify([{ index: 1, total: 3, name: '需求分析' }]),
  'START 解析 1/3 需求分析')
const t2 = extractMilestoneMarks('<!--MILESTONE-START 2/3 方案设计--><!--MILESTONE-START 3/3 编码实现-->')
check(t2.starts.length === 2 && t2.starts[1].name === '编码实现', '多个 START 顺序解析')

// 剥离：START 标记不出现在 stripped
check(!t1.stripped.includes('MILESTONE-START') && t1.stripped.includes('开始执行') && t1.stripped.includes('然后写代码'),
  'START 标记从对话流剥离，周围文本保留')

// 现有功能不回归
const t3 = extractMilestoneMarks('<!--MILESTONES 3 需求分析|方案设计|编码实现-->')
check(t3.milestones?.total === 3, 'MILESTONES 声明不回归')
const t4 = extractMilestoneMarks('完成<!--MILESTONE-OK 1/3 需求分析-->')
check(t4.oks.length === 1 && t4.stripped === '完成', 'MILESTONE-OK 不回归')

// 乱序/超界/畸形不崩溃
check(extractMilestoneMarks('<!--MILESTONE-START 9/3 越界-->').starts[0].index === 9, '超界 START 不崩溃')
check(extractMilestoneMarks('<!--MILESTONE-START abc/3 畸形-->').starts.length === 0, '畸形 START 忽略')
check(extractMilestoneMarks('<!--MILESTONE-START 1/3 名称缺失 -->').starts[0]?.name === '名称缺失', 'START 名称空格 trim')

if (failed) { console.error(`\n${failed} 项失败`); process.exit(1) }
console.log('\n全部通过')
