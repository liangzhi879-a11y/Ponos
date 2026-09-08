// src/components/boot/PlaceholderScreens.tsx —— 登录/驾驶舱占位壳（无头联调用）
// Task 6：AuthPlaceholder 已由 AuthScreen（src/components/auth）替换并删除；
// CockpitPlaceholder 仍作占位，Task 8 以 CockpitScreen 替换。
// 占位文案为一次性脚手架，直接中文字面量（许可证见 task-5-brief Step 3），不进 i18n。
import { Button } from '@/components/ui'
import { useViewStore } from '@/stores/viewStore'

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
        <Button variant="ghost" onClick={() => setView('login')}>← 返回登录</Button>
      </div>
    </div>
  )
}
