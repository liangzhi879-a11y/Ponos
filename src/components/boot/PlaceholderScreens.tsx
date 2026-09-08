// src/components/boot/PlaceholderScreens.tsx —— 登录/驾驶舱占位壳（无头联调用）
// Task 6 以 AuthScreen 替换 AuthPlaceholder；Task 8 以 CockpitScreen 替换 CockpitPlaceholder。
// 占位文案为一次性脚手架，直接中文字面量（许可证见 task-5-brief Step 3），不进 i18n。
import { Button } from '@/components/ui'
import { useViewStore } from '@/stores/viewStore'
import { useAuthStore, type AuthPhase } from '@/stores/authStore'

const AUTH_PHASE_LABEL: Record<AuthPhase, string> = {
  unknown: '未探测',
  uninitialized: '未初始化（首设向导待 Task 6）',
  locked: '已锁定',
  ok: '认证通过',
  'setup-done': '已设置口令',
}

export function AuthPlaceholder() {
  const phase = useAuthStore(s => s.phase)
  const setView = useViewStore(s => s.setView)
  return (
    <div className="h-full w-full flex flex-col items-center justify-center gap-6 bg-app text-primary">
      <div className="text-center">
        <p className="text-sm font-semibold text-secondary">登录屏占位（Task 6 实现 AuthScreen）</p>
        <p className="mt-2 text-xs text-tertiary">authStore.phase = {phase} · {AUTH_PHASE_LABEL[phase]}</p>
      </div>
      <div className="flex items-center gap-3">
        <Button onClick={() => setView('cockpit')}>下一步 → 驾驶舱占位</Button>
        <Button variant="ghost" onClick={() => setView('work')}>跳过 → 工作界面</Button>
      </div>
    </div>
  )
}

export function CockpitPlaceholder() {
  const setView = useViewStore(s => s.setView)
  return (
    <div className="h-full w-full flex flex-col items-center justify-center gap-6 bg-app text-primary">
      <div className="text-center">
        <p className="text-sm font-semibold text-secondary">驾驶舱占位（Task 8 实现 CockpitScreen）</p>
        <p className="mt-2 text-xs text-tertiary">点击下方按钮进入工作界面；hub 球过渡由 Task 8 LogoMorph 接线</p>
      </div>
      <div className="flex items-center gap-3">
        <Button onClick={() => setView('work')}>进入工作界面 →</Button>
        <Button variant="ghost" onClick={() => setView('login')}>← 返回登录占位</Button>
      </div>
    </div>
  )
}
