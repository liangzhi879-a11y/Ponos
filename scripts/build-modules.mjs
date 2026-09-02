// 构建所有 ui-renderer 模块到 dist/modules/<id>/
import { build } from 'vite'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// root 指向 modules/：让 vite 按 "入口相对 root 的路径" 决定 html 输出位置，
// 从而 launcher/index.html -> dist/modules/launcher/index.html（而非嵌套的多余层级）。
// outDir 用绝对路径覆盖，避免相对新 root 解析到 modules/dist/modules。
await build({
  configFile: path.join(root, 'vite.modules.config.ts'),
  root: path.join(root, 'modules'),
  build: { outDir: path.join(root, 'dist/modules') },
})
console.log('[modules] build done -> dist/modules/')
