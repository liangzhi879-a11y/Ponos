import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { readFileSync } from 'fs'

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'))

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
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
