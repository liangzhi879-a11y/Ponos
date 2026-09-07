import { useRef, useState } from 'react'
import { ImagePlus, Check, RotateCcw } from 'lucide-react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogFooter,
  Button,
} from '@/components/ui'
interface Props {
  title?: string
  onConfirm: (dataUrl: string) => void
  onCancel: () => void
}

const PREVIEW = 200 // 预览容器尺寸（px）
const OUTPUT = 128  // 输出头像尺寸（px）

/**
 * 头像裁剪弹窗：上传图片 → 拖动/缩放调整 → 裁切为正方形头像。
 * 无第三方依赖，纯 canvas 实现。输出 128x128 PNG（保留透明）。
 */
export function AvatarCropDialog({ title = '设置头像', onConfirm, onCancel }: Props) {
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  const [scale, setScale] = useState(1)
  const [offX, setOffX] = useState(0)
  const [offY, setOffY] = useState(0)
  const dragRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const loadFile = (file: File) => {
    if (!file.type.startsWith('image/')) return
    const reader = new FileReader()
    reader.onload = () => {
      const image = new Image()
      image.onload = () => {
        setImg(image)
        setScale(1)
        setOffX(0)
        setOffY(0)
      }
      image.src = reader.result as string
    }
    reader.readAsDataURL(file)
  }

  // 拖动图片调整裁剪位置
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!img) return
    ;(e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId)
    dragRef.current = { startX: e.clientX, startY: e.clientY, baseX: offX, baseY: offY }
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return
    setOffX(dragRef.current.baseX + (e.clientX - dragRef.current.startX))
    setOffY(dragRef.current.baseY + (e.clientY - dragRef.current.startY))
  }
  const onPointerUp = () => { dragRef.current = null }

  const crop = (): string => {
    if (!img) return ''
    const canvas = document.createElement('canvas')
    canvas.width = OUTPUT
    canvas.height = OUTPUT
    const ctx = canvas.getContext('2d')
    if (!ctx) return ''
    const iw = img.naturalWidth
    const ih = img.naturalHeight
    // 视觉上 object-cover 填满 PREVIEW 方形容器 → 计算源裁剪区域
    const k = Math.max(PREVIEW / iw, PREVIEW / ih)
    const cw = PREVIEW / k
    const ch = PREVIEW / k
    const sx = (iw - cw) / 2
    const sy = (ih - ch) / 2
    // 与预览一致的变换：中心为基准，偏移 offX/offY，整体 scale
    ctx.translate(OUTPUT / 2, OUTPUT / 2)
    ctx.scale(scale, scale)
    ctx.drawImage(img, sx, sy, cw, ch, offX - PREVIEW / 2, offY - PREVIEW / 2, PREVIEW, PREVIEW)
    return canvas.toDataURL('image/png')
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel() }}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={e => {
              const f = e.target.files?.[0]
              if (f) loadFile(f)
              if (fileRef.current) fileRef.current.value = ''
            }}
          />

          {/* 裁剪预览区 */}
          <div
            className="relative w-[200px] h-[200px] mx-auto rounded-full overflow-hidden select-none cursor-move touch-none"
            style={{ background: 'repeating-conic-gradient(#e5e7eb 0% 25%, #f3f4f6 0% 50%) 0 0 / 16px 16px' }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            {img ? (
              <img
                src={img.src}
                alt="avatar preview"
                draggable={false}
                className="absolute left-1/2 top-1/2 max-w-none pointer-events-none glass-avatar"
                style={{
                  width: PREVIEW,
                  height: PREVIEW,
                  objectFit: 'cover',
                  transform: `translate(-50%, -50%) translate(${offX}px, ${offY}px) scale(${scale})`,
                }}
              />
            ) : (
              <button
                onClick={() => fileRef.current?.click()}
                className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-tertiary hover:text-primary transition-colors"
              >
                <ImagePlus className="w-6 h-6" />
                <span className="text-[11px]">选择图片</span>
              </button>
            )}
          </div>

          {img ? (
            <>
              {/* 缩放 */}
              <div className="flex items-center gap-2 mt-3">
                <span className="text-[10px] text-tertiary shrink-0">缩放</span>
                <input
                  type="range"
                  min={1}
                  max={4}
                  step={0.1}
                  value={scale}
                  onChange={e => setScale(parseFloat(e.target.value))}
                  className="flex-1 accent-brand-500"
                />
                <span className="text-[10px] text-tertiary shrink-0 w-8 text-right">{scale.toFixed(1)}x</span>
              </div>
              <p className="text-[10px] text-tertiary mt-1.5">拖动图片调整位置，滑块放大缩小</p>
              <div className="flex gap-2 mt-2">
                <Button
                  variant="ghost" size="sm" className="flex-1 text-tertiary"
                  onClick={() => { setScale(1); setOffX(0); setOffY(0) }}
                >
                  <RotateCcw className="w-3 h-3 mr-1" />重置
                </Button>
                <Button
                  variant="ghost" size="sm" className="flex-1 text-tertiary"
                  onClick={() => fileRef.current?.click()}
                >
                  <ImagePlus className="w-3 h-3 mr-1" />重选
                </Button>
              </div>
            </>
          ) : (
            <p className="text-center text-[10px] text-tertiary mt-2">支持 PNG / JPG 等常见图片格式</p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onCancel}>取消</Button>
          <Button variant="primary" size="sm" onClick={() => onConfirm(crop())} disabled={!img}>
            <Check className="w-3.5 h-3.5 mr-1" />确认
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
