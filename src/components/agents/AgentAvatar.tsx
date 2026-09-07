import type { Agent } from '@/lib/agents'

interface Props {
  agent: Pick<Agent, 'avatar' | 'name'>
  /** 尺寸（px），默认 28 */
  size?: number
  className?: string
}

/**
 * Agent 头像：有自定义 avatar 显示用户上传图，否则回退到默认企业 Logo。
 * 统一圆形展示。
 */
export function AgentAvatar({ agent, size = 28, className = '' }: Props) {
  const src = agent.avatar || `${import.meta.env.BASE_URL}logo.png`
  return (
    <img
      src={src}
      alt={agent.name}
      title={agent.name}
      width={size}
      height={size}
      className={`rounded-full object-cover shrink-0 bg-elevated glass-avatar ${className}`}
      style={{ width: size, height: size }}
      draggable={false}
    />
  )
}
