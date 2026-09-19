// Task 4 实验夹具：绕过主 Agent，直接用内核 API 拉起一个 reviewer 子 Agent 评审样本文件。
// 目的：让"审查者所用模型"成为唯一变量（对照组与实验组共用此夹具、同一 prompt、同一工具集）。
// 用法：node run-reviewer.mjs --model <id> --sample <a|b|c> --out <file>
// 协议 env（PONOS_BASE_URL / PONOS_AUTH_TOKEN）由调用方通过 settings.json 注入，见 run-task4.sh。
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createEngine } from '../../../kernel/engine.mjs'
import { createSessionStore } from '../../../kernel/session.mjs'
import { makeWire } from '../../../kernel/protocol.mjs'

const argv = process.argv.slice(2)
const arg = (k, d = '') => {
  const i = argv.indexOf(k)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}

const model = arg('--model')
const sample = arg('--sample')
const outFile = arg('--out')
const here = dirname(fileURLToPath(import.meta.url))
const samplesDir = join(here, 'samples')
const target = join(samplesDir, `sample-${sample}.mjs`)

// 与对照组逐字相同的评审要求（差异只在模型）
const PROMPT = `独立代码评审任务。请阅读文件 ${target}，找出其中的缺陷（正确性、健壮性、资源管理类问题）。

要求：
1. 逐条列出，每条给出：位置（函数名/行号）、问题是什么、为什么是问题（给出具体触发输入或场景）、建议修法。
2. 按严重度排序（严重 / 中等 / 轻微）。
3. 只报你确信的问题；不确定的请标注"存疑"。
4. 不要修改任何文件，不要运行测试，不要查看该文件以外的其他文件。

输出格式：先一句总评，再编号列表。请直接给结论，不要过程叙述。`

const configDir = mkdtempSync(join(tmpdir(), 'ponos-t4-'))
const wire = makeWire({ write() {} })
const session = createSessionStore({ configDir, cwd: samplesDir, sessionId: `t4-${sample}-${model.replace(/\W+/g, '')}` })
const engine = createEngine({
  opts: { model, configDir, cwd: samplesDir, addDirs: [samplesDir], skipPermissions: true },
  wire,
  session,
})
engine.setSystemPrompt('你是 Ponos-turbo 内核。')

const t0 = Date.now()
let out, err
try {
  const r = await engine.spawnSubAgent(
    { subagent_type: 'reviewer', prompt: PROMPT },
    { toolUseId: `t4-${sample}` },
  )
  out = r.content
  err = r.isError ? 'isError=true' : ''
} catch (e) {
  out = ''
  err = String(e && e.message ? e.message : e)
}
const meta = `model=${model} sample=${sample} duration_ms=${Date.now() - t0} error=${err || 'none'}`
const body = `===META===\n${meta}\n===REVIEW===\n${out}\n`
if (outFile) writeFileSync(outFile, body, 'utf-8')
process.stdout.write(body)
rmSync(configDir, { recursive: true, force: true })
