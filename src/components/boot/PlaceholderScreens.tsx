// src/components/boot/PlaceholderScreens.tsx —— 驾驶舱占位壳（无头联调用）
// Task 6：AuthPlaceholder 已由 AuthScreen（src/components/auth）替换并删除；
// CockpitPlaceholder 仍作占位，Task 8 以 CockpitScreen 替换。
// Task 6b（D11-D13）：登录移入独立认证小窗（?auth=1），主窗口视图机无 login——
// 原「返回登录」按钮（setView('login')）删除，占位只保留进工作界面单向入口。
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
      </div>
    </div>
  )
}
