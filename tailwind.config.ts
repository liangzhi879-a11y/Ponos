import { Config } from 'tailwindcss'
import typography from '@tailwindcss/typography'

const config: Config = {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}', './modules/**/*.{ts,tsx,html}'],
  darkMode: ['class', '[class*="theme-"]'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: 'var(--brand-50)',
          100: 'var(--brand-100)',
          200: 'var(--brand-200)',
          300: 'var(--brand-300)',
          400: 'var(--brand-400)',
          // 500 及以下真实使用透明度修饰类（bg-brand-500/15 等）：用 color-mix +
          // <alpha-value> 让 Tailwind 原生编译，全主题生效（玻璃主题的
          // var(--brand-500) 本身是 color-mix，可嵌套）。
          500: 'color-mix(in srgb, var(--brand-500) calc(<alpha-value> * 100%), transparent)',
          600: 'var(--brand-600)',
          700: 'var(--brand-700)',
          800: 'var(--brand-800)',
          900: 'var(--brand-900)',
          950: 'var(--brand-950)',
        },
        // Semantic surface scale + DEFAULT for bg-surface
        surface: {
          DEFAULT: 'color-mix(in srgb, var(--bg-surface) calc(<alpha-value> * 100%), transparent)',
          50: 'var(--s-50)',
          100: 'var(--s-100)',
          200: 'var(--s-200)',
          300: 'var(--s-300)',
          400: 'var(--s-400)',
          500: 'var(--s-500)',
          600: 'var(--s-600)',
          700: 'var(--s-700)',
          800: 'var(--s-800)',
          900: 'var(--s-900)',
          950: 'var(--s-950)',
        },
        // Top-level semantic background tokens used throughout the app
        // （用 color-mix 包装，使 bg-app/40、bg-elevated/20 等修饰类全主题可编译）
        app: 'color-mix(in srgb, var(--bg-app) calc(<alpha-value> * 100%), transparent)',
        elevated: 'color-mix(in srgb, var(--bg-elevated) calc(<alpha-value> * 100%), transparent)',
        hover: 'var(--bg-hover)',
        active: 'var(--bg-active)',
        input: 'color-mix(in srgb, var(--bg-input) calc(<alpha-value> * 100%), transparent)',
        toolbar: 'color-mix(in srgb, var(--bg-toolbar) calc(<alpha-value> * 100%), transparent)',
        modal: 'var(--bg-modal)',
        popover: 'var(--bg-popover)',
        tooltip: 'var(--bg-tooltip)',
        code: 'var(--bg-code)',
        prose: 'var(--bg-prose)',
        kbd: 'var(--bg-kbd)',
        // Top-level semantic text tokens
        primary: 'var(--text-primary)',
        secondary: 'var(--text-secondary)',
        // text-tertiary/60 等修饰类：color-mix 包装后可编译
        tertiary: 'color-mix(in srgb, var(--text-tertiary) calc(<alpha-value> * 100%), transparent)',
        inverse: 'var(--text-inverse)',
        // Code-block text — designed to contrast with --bg-code
        'code-text': 'var(--code-text)',
        // Accent tokens（bg-accent/10、text-accent/80 等修饰类需要 alpha-value）
        accent: {
          DEFAULT: 'color-mix(in srgb, var(--accent-default) calc(<alpha-value> * 100%), transparent)',
          hover: 'var(--accent-hover)',
          subtle: 'var(--accent-subtle)',
        },
        // Semantic status colors (used for diff highlight, status icons, etc.)
        // `<alpha-value>` placeholder is required so Tailwind's `/N` opacity
        // modifiers (e.g. `bg-warning/8`) compile correctly.
        warning: 'rgb(var(--warning-rgb) / <alpha-value>)',
        success: 'rgb(var(--success-rgb) / <alpha-value>)',
        error: 'rgb(var(--error-rgb) / <alpha-value>)',
      },
      borderColor: {
        // DEFAULT 只被 preflight（*,::before,::after 的 border-color）消费——
        // theme() 对 borderColor 恒等返回、不替换 <alpha-value>，包装成 color-mix
        // 会产出非法权重（数字 1 而非百分比）被浏览器整条丢弃，边框色回落到
        // currentColor（≈文字色），非 glass 主题全应用边框发白。DEFAULT 必须保持
        // 纯变量；`default` 命名键继续用 color-mix 包装供 border-default/50 编译
        // （`border/50` 即 DEFAULT 简写 + /N 在 Tailwind v3 中本就不编译）。
        DEFAULT: 'var(--border-default)',
        default: 'color-mix(in srgb, var(--border-default) calc(<alpha-value> * 100%), transparent)',
        subtle: 'color-mix(in srgb, var(--border-subtle) calc(<alpha-value> * 100%), transparent)',
        strong: 'color-mix(in srgb, var(--border-strong) calc(<alpha-value> * 100%), transparent)',
        kbd: 'color-mix(in srgb, var(--kbd-border) calc(<alpha-value> * 100%), transparent)',
      },
      fontFamily: {
        sans: [
          'Inter',
          'Sora',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'PingFang SC',
          'Microsoft YaHei',
          'sans-serif',
        ],
        display: [
          'Sora',
          'Inter',
          'system-ui',
          'sans-serif',
        ],
        mono: [
          'JetBrains Mono',
          'Cascadia Code',
          'Fira Code',
          'ui-monospace',
          'monospace',
        ],
      },
      boxShadow: {
        // 语义浮层阴影：shadow-modal / shadow-popover 需注册为真阴影，
        // 否则 Tailwind 按 shadow-{color} 解析（--tw-shadow-color: var(--bg-modal)），
        // 无 box-shadow 声明，浮层零阴影。
        modal: 'var(--shadow-modal)',
        popover: 'var(--shadow-popover)',
        'accent-sm': '0 1px 2px var(--accent-subtle)',
        'accent-md': '0 4px 12px var(--accent-subtle)',
        'accent-lg': '0 8px 24px var(--accent-subtle)',
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'slide-up': {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-down': {
          from: { opacity: '0', transform: 'translateY(-8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-left': {
          from: { opacity: '0', transform: 'translateX(-8px)' },
          to: { opacity: '1', transform: 'translateX(0)' },
        },
        'scale-in': {
          from: { opacity: '0', transform: 'scale(0.96)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.18s ease-out',
        'slide-up': 'slide-up 0.22s cubic-bezier(0.16, 1, 0.3, 1)',
        'slide-down': 'slide-down 0.22s cubic-bezier(0.16, 1, 0.3, 1)',
        'slide-left': 'slide-left 0.22s cubic-bezier(0.16, 1, 0.3, 1)',
        'scale-in': 'scale-in 0.15s ease-out',
      },
    },
  },
  plugins: [typography],
}

export default config
