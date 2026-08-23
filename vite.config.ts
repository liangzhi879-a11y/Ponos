import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { APP_VERSION } from './version.mjs'

export default defineConfig({
  define: {
    // 界面版本显示跟随 version.mjs 的 APP_VERSION（turbo 内核版应用线），
    // 与根 package.json 的 GUI 发布线（2.7.0，electron-builder 打包名）解耦。
    // YFW_APP_VERSION env 可临时覆盖（如发布稳定版）。
    __APP_VERSION__: JSON.stringify(process.env.YFW_APP_VERSION || APP_VERSION),
    __BRIDGE_PORT__: JSON.stringify(process.env.YFW_BRIDGE_PORT || '51309'),
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
            if (id.includes('react-dom') || id.includes('scheduler')) return 'vendor-react'
            if (id.includes('react/') || id.includes('react/jsx')) return 'vendor-react'
            if (id.includes('@radix-ui')) return 'vendor-radix'
            if (id.includes('framer-motion')) return 'vendor-framer'
            if (id.includes('react-markdown') || id.includes('remark-gfm') || id.includes('unified') || id.includes('micromark') || id.includes('mdast') || id.includes('hast') || id.includes('unist') || id.includes('vfile') || id.includes('bail') || id.includes('is-plain-obj') || id.includes('trough')) return 'vendor-markdown'
            if (id.includes('lucide-react')) return 'vendor-icons'
            if (id.includes('zustand')) return 'vendor-store'
          }
        },
      },
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
  },
})
