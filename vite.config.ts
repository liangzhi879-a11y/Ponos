import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { readFileSync } from 'fs'

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'))

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BRIDGE_PORT__: JSON.stringify(process.env.YFW_BRIDGE_PORT || '51517'),
  },
  plugins: [react()],
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 350,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            // 按 node_modules 之后的相对路径精确匹配（2026-09-09 修复）：旧规则用
            // 全路径子串匹配，`@assistant-ui/react/*` 与 `@assistant-ui/core/dist/react/*`
            // 因含 "react/" 子串被误分进 vendor-react，assistant-ui 横跨 vendor-react/
            // vendor-radix 两 chunk 与 radix 循环引用 → 模块初始化时 React 绑定
            // undefined → 全应用黑屏（reading 'forwardRef'）。
            const rel = id.slice(id.indexOf('node_modules') + 'node_modules'.length + 1)
            if (rel.startsWith('react/') || rel.startsWith('react-dom/') || rel.startsWith('scheduler/')) return 'vendor-react'
            // 'radix-ui'（assistant-ui 依赖的整合包装包）与 @radix-ui 子模块同组
            if (rel.includes('@radix-ui') || rel.includes('radix-ui')) return 'vendor-radix'
            // assistant-ui 独立成组：内部跨包互相引用，与 react/radix 仅单向依赖
            if (rel.includes('@assistant-ui')) return 'vendor-assistant'
            if (rel.includes('react-markdown') || rel.includes('remark-gfm') || rel.includes('unified') || rel.includes('micromark') || rel.includes('mdast') || rel.includes('hast') || rel.includes('unist') || rel.includes('vfile') || rel.includes('bail') || rel.includes('is-plain-obj') || rel.includes('trough')) return 'vendor-markdown'
            if (rel.includes('lucide-react')) return 'vendor-icons'
            if (rel.includes('zustand')) return 'vendor-store'
          }
        },
      },
    },
  },
  server: {
    host: '0.0.0.0',
    port: Number(process.env.YFW_VITE_PORT || '5197'),
    strictPort: true,
  },
  preview: {
    host: '0.0.0.0',
    port: Number(process.env.YFW_VITE_PREVIEW_PORT || '4197'),
  },
})
