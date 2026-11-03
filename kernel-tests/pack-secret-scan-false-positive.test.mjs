// 源码打包的密钥扫描：把**源码文件名**误判成令牌，导致打包被阻塞、真告警被噪声淹没。
//
// 【怎么发现的（本轮"需求问题体系融入 DevKit"过程中的副产品）】
//   把 `需求问题体系/` 纳入 DevKit 边界后，跑
//   `node scripts/pack-source-zip.mjs --dry-run` 验证排除是否生效，
//   结果**退出码 1** —— 不是因为我改的路径，而是密钥扫描报了 4 处命中：
//     shared/app-control-commands.mjs:23   （import 路径）
//     shared/screen-contract.cjs:15        （注释里引用文件名）
//     shared/screen-exclusions-data.cjs:7  （注释里引用文件名）
//     src/components/apps/AppCoverage.tsx:8（注释里引用文件名）
//   四处命中的都是同一个**源码文件名** `app-control-commands`，**没有一处是凭据**。
//
// 【根因】规则 `(?:app|glpat)[-_][A-Za-z0-9_-]{16,}` 两处不妥：
//   ① 后缀**允许连字符** ⇒ `app-control-commands` 里的 `control-commands` 正好 16 字符，
//      必然命中"自然语言标识符"；
//   ② `glpat` 与上一条规则（`glpat[-_][A-Za-z0-9_-]{20,}`）**重复**，本规则实际只服务 `app-`
//      却没做针对性收紧。
//
// 【后果】① `pack-source-zip` 退出码 1 ⇒ **CI 里源码打包直接失败**；
//   ② 更要命的是噪声化 —— 脚本自己的注释写着「误报一多，真命中就没人看了」，
//      而它自己就在制造误报。真出现 app key 泄露时，人和 CI 都会习惯性忽略。
//
// 【修法】后缀不再允许连字符（`[A-Za-z0-9_]{16,}`），并去掉重复的 `glpat` 分支（上一条已覆盖）。
//   **不加 entropy 过滤**：那会漏掉"全小写/全数字"形态的真 key；
//   只收窄字符集既能消掉自然语言误报，又不漏检任何真 key 形态。
//
// 【★ 为什么本文件的所有用例都带条件 skip】
//   `scripts/pack-source-zip.mjs` 被 `.git/info/exclude` **有意排除**（本机专属交付工具，
//   注释写明「只在本地用，不入库，也不需要入库……免得别的会话 git add -A 时顺手带走」）。
//   ⇒ 在别人的**干净检出**里该文件不存在。
//   我第一版直接 `import ... from '../scripts/pack-source-zip.mjs'` 静态导入，
//   实测把文件改走后测试**直接崩**（ERR_MODULE_NOT_FOUND，pass 0 / fail），
//   即"引用未入库文件"会让干净检出的门禁变红。
//   ⇒ 改为动态导入 + 缺失即 skip：本机跑完整用例，别人检出静默跳过且不红。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SCRIPT_URL = new URL('../scripts/pack-source-zip.mjs', import.meta.url)
const available = existsSync(SCRIPT_URL)
const skip = available ? false : '本机专属工具 scripts/pack-source-zip.mjs 未入库（.git/info/exclude），跳过'

const scanSecrets = available ? (await import(SCRIPT_URL.href)).scanSecrets : null
const scan = (rel, text) => scanSecrets(rel, Buffer.from(text, 'utf8'))

test('★★ 已知 4 处误报必须消失（都是源码文件名 app-control-commands）', { skip }, () => {
  const cases = [
    ['shared/app-control-commands.mjs', "} from './app-control-commands.cjs'"],
    ['shared/screen-contract.cjs', ' * 同 `shared/app-control-commands.cjs` 先例'],
    ['shared/screen-exclusions-data.cjs', ' * 同 `shared/app-control-commands.cjs`（CJS + ESM 转发层）'],
    ['src/components/apps/AppCoverage.tsx', '// 唯一实现在 `shared/app-control-commands.cjs`'],
  ]
  for (const [rel, text] of cases) {
    assert.deepEqual(scan(rel, text), [],
      `${rel} 里的 app-control-commands 是**源码文件名**，不是凭据 —— `
      + '误报会让 pack-source-zip 退出码 1（CI 打包失败），并淹没真告警')
  }
})

test('★★ 真 app key 形态必须仍然检出（双向守卫：不能为了消误报而漏检）', { skip }, () => {
  const real = [
    'app-AbCdEf1234567890XyZwVu',      // 混合大小写
    'app_AbCdEf1234567890XyZwVu',      // 下划线分隔
    'app-abcdef1234567890abcdef',      // 全小写（entropy 方案会漏掉这种，故不加 entropy）
    'app-1234567890abcdef1234',        // 全数字+小写
  ]
  for (const s of real) {
    const hits = scan('config/app_config.json', `{"token": "${s}"}`)
    assert.ok(hits.some((h) => /app/.test(h)),
      `真实 app key 形态 ${s} 必须被检出 —— 否则是**漏检**，比误报更危险`)
  }
})

test('★ GitLab PAT 仍由既有规则覆盖（去掉重复分支后不得漏检）', { skip }, () => {
  const hits = scan('docs/setup.md', 'token: glpat-AbCdEf1234567890XyZw')
  assert.ok(hits.length > 0, 'glpat- 形态必须仍被检出（由上一条规则负责，删重复分支不影响）')
})

test('★ 其它凭据模式不受影响（回归守卫）', { skip }, () => {
  assert.ok(scan('a.env', 'OPENAI_KEY=sk-proj-AbCdEf1234567890XyZwVuAb').length > 0, 'sk- 长令牌')
  assert.ok(scan('a.mjs', 'const k = "AKIAIOSFODNN7EXAMPLE"').length > 0, 'AWS Access Key')
  // ★ 用 .mjs：`.pem` 不在 TEXT_EXT 扫描范围内（脚本只扫文本类扩展名），
  //   第一版我拿 a.pem 当文件名，测的其实是"该文件不被扫描"——是用例问题，不是实现问题。
  assert.ok(scan('a.mjs', '-----BEGIN RSA PRIVATE KEY-----').length > 0, 'PEM 私钥')
  assert.ok(scan('a.json', '{"api_key": "AbCdEf1234567890XyZw"}').length > 0, '赋值的凭据字段')
})

test('★ 自然语言标识符不得命中（同类误报的普遍化校验）', { skip }, () => {
  for (const id of ['app-control-commands', 'app-window-manager', 'app-coverage-report', 'app-main-process']) {
    assert.deepEqual(scan('README.md', `见 \`shared/${id}\` 实现`), [],
      `${id} 是自然语言标识符（连字符分隔单词），不是令牌`)
  }
})

test('★★ 端到端：dry-run 必须能以退出码 0 结束（打包不得被误报阻塞）', { skip }, async () => {
  const { execFileSync } = await import('node:child_process')
  const ROOT = fileURLToPath(new URL('../', import.meta.url))
  let code = 0
  let out = ''
  try {
    out = execFileSync(process.execPath, ['scripts/pack-source-zip.mjs', '--dry-run'], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28,
    })
  } catch (e) {
    code = e.status ?? 1
    out = String(e.stdout || '') + String(e.stderr || '')
  }
  assert.equal(code, 0,
    'pack-source-zip --dry-run 必须退出 0 —— 修前它因误报而退出 1（CI 里源码打包直接失败）。'
    + `\n命中摘要：\n${out.split('\n').filter((l) => l.includes('令牌')).slice(0, 8).join('\n')}`)
})
