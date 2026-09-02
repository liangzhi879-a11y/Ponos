import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// 模块多入口构建：把各 ui-renderer 模块编译到 dist/modules/<id>/
// 注意：入口 input 随任务逐步增加（launcher 在 Task 8，chat 在 Task 9 加回）。
export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@ponos': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: 'dist/modules',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        launcher: path.resolve(__dirname, 'modules/launcher/index.html'),
        chat: path.resolve(__dirname, 'modules/chat/index.html'),
      },
      output: {
        entryFileNames: '[name]/index.js',
        chunkFileNames: '[name]/[name]-[hash].js',
        assetFileNames: '[name]/[name]-[hash][extname]',
      },
    },
  },
})
