import { useEffect, useRef, useState } from 'react'
import { Wand2, LogIn, LogOut, Download, ImagePlus, Sparkles, X } from 'lucide-react'
import { useDoubaoStore } from '@/stores/doubaoStore'
import { useTranslation } from '@/i18n/useTranslation'
import { Button } from '@/components/ui/button'

export function DoubaoPanel({ onInsertImage }: { onInsertImage?: (att: { name: string; path: string; preview?: string }) => void }) {
  const { t } = useTranslation()
  const { status, generating, results, history, error, refreshStatus, generate, loadHistory, removeHistory } = useDoubaoStore()
  const [prompt, setPrompt] = useState('')
  const [ratio, setRatio] = useState('1:1')
  const [count, setCount] = useState(1)
  const [refImage, setRefImage] = useState<string | undefined>()
  const [refBase64, setRefBase64] = useState<string | undefined>()
  // M2 空态兜底：记录上轮请求的图片数量，生成成功但下载全失败时 results 为空且 error 为 null，据此提示处理失败
  const [lastGeneratedCount, setLastGeneratedCount] = useState(0)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { refreshStatus(); loadHistory() }, [])
  // objectURL 生命周期管理：换图/移除参考图/组件卸载时 revoke，避免内存泄漏
  useEffect(() => {
    return () => { if (refImage && refImage.startsWith('blob:')) URL.revokeObjectURL(refImage) }
  }, [refImage])

  const doGenerate = async () => {
    if (!prompt.trim()) return
    setLastGeneratedCount(count)
    await generate({ prompt, ratio, count, imageBase64: refBase64 })
  }

  // 参考图：本地文件 → objectURL 预览 + base64 上传（FileReader）
  const handleRefPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    setRefImage(URL.createObjectURL(f))
    const fr = new FileReader()
    fr.onload = () => { setRefBase64(String(fr.result).split(',')[1]) }
    fr.readAsDataURL(f)
    e.target.value = ''
  }

  // M2：上轮请求过图片（lastGeneratedCount > 0）但一张都没回来（results 为空、无错误信息、且非生成中）→ 提示处理失败
  const showFailedEmpty = lastGeneratedCount > 0 && results.length === 0 && !error && !generating

  return (
    <div className="w-[360px] p-3 space-y-3">
      {!status?.loggedIn ? (
        <div className="space-y-2">
          <p className="text-sm text-secondary">{t('doubao.loginRequired')}</p>
          <Button variant="primary" size="sm" onClick={async () => { await window.doubao?.openLogin(); refreshStatus() }}>
            <LogIn className="w-3.5 h-3.5 mr-1" /> {t('doubao.login')}
          </Button>
          <p className="text-xs text-tertiary">{t('doubao.notice')}</p>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between text-xs">
            <span className="text-secondary">{t('doubao.loggedIn')}</span>
            <Button variant="ghost" size="xs" onClick={() => window.doubao?.logout().then(refreshStatus)}>
              <LogOut className="w-3 h-3 mr-1" /> {t('doubao.logout')}
            </Button>
          </div>
          <textarea
            className="w-full h-20 bg-input rounded-lg p-2 text-sm resize-none outline-none"
            placeholder={t('doubao.prompt')} value={prompt} onChange={e => setPrompt(e.target.value)}
          />
          <div className="flex gap-2 text-xs">
            <select value={ratio} onChange={e => setRatio(e.target.value)} className="bg-input rounded px-1">
              <option value="1:1">1:1</option><option value="16:9">16:9</option><option value="9:16">9:16</option><option value="4:3">4:3</option><option value="3:4">3:4</option>
            </select>
            <select value={count} onChange={e => setCount(Number(e.target.value))} className="bg-input rounded px-1">
              {[1, 2, 4].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
          <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleRefPick} />
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="xs" onClick={() => fileInputRef.current?.click()}>
              <ImagePlus className="w-3.5 h-3.5 mr-1" /> {t('doubao.img2img')}
            </Button>
            {refImage && (
              <div className="relative">
                <img src={refImage} alt="ref" className="w-10 h-10 rounded object-cover border border-border" />
                <button
                  className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-black/60 text-white flex items-center justify-center"
                  onClick={() => { setRefImage(undefined); setRefBase64(undefined) }} title={t('doubao.uploadRef')}
                >
                  <X className="w-2.5 h-2.5" />
                </button>
              </div>
            )}
          </div>
          <Button variant="primary" size="sm" className="w-full" disabled={generating || !prompt.trim()} onClick={doGenerate}>
            <Sparkles className="w-3.5 h-3.5 mr-1" /> {generating ? t('doubao.generating') : t('doubao.generate')}
          </Button>
          {error && <p className="text-xs text-error">{error}</p>}
          {showFailedEmpty && <p className="text-xs text-error">{t('doubao.failed')}</p>}
          {results.length > 0 && (
            <div className="grid grid-cols-2 gap-2">
              {results.map(r => (
                <div key={r.id} className="relative group rounded-lg overflow-hidden border border-border">
                  <img src={r.imageUrl} alt={r.prompt} className="w-full h-24 object-cover" />
                  <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center gap-1">
                    <button onClick={() => onInsertImage?.({ name: r.prompt.slice(0, 20) + '.png', path: r.path || r.imageUrl, preview: r.imageUrl })} title={t('doubao.insert')}>
                      <Wand2 className="w-4 h-4 text-white" />
                    </button>
                    <a href={r.imageUrl} download title={t('doubao.download')}>
                      <Download className="w-4 h-4 text-white" />
                    </a>
                  </div>
                </div>
              ))}
            </div>
          )}
          {history.length > 0 && (
            <details className="text-xs">
              <summary className="text-secondary cursor-pointer">{t('doubao.history')}</summary>
              <ul className="mt-1 space-y-1 text-tertiary">
                {history.slice(0, 10).map(h => (
                  <li key={h.id} className="flex justify-between">
                    <span className="truncate">{h.prompt}</span>
                    <button onClick={() => removeHistory(h.id)}>×</button>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  )
}
