'use client'

import { useCallback, useEffect, useState } from 'react'
import Dropzone from '@/components/Dropzone'
import ResultView from '@/components/ResultView'

type Bg = 'transparent' | 'white'
type Box = { x: number; y: number; width: number; height: number }
type DrawMode = 'include' | 'exclude'
type ModelVersion = '1.4' | '2.0'

export default function Home() {
  const [file, setFile] = useState<File | null>(null)
  const [originalUrl, setOriginalUrl] = useState<string | null>(null)
  const [resultUrl, setResultUrl] = useState<string | null>(null)
  const [bg, setBg] = useState<Bg>('transparent')
  const [modelVersion, setModelVersion] = useState<ModelVersion>('1.4')
  const [mainObjectOnly, setMainObjectOnly] = useState(true)
  const [includeBox, setIncludeBox] = useState<Box | null>(null)
  const [excludeBox, setExcludeBox] = useState<Box | null>(null)
  const [drawMode, setDrawMode] = useState<DrawMode>('include')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    return () => {
      if (originalUrl) URL.revokeObjectURL(originalUrl)
      if (resultUrl) URL.revokeObjectURL(resultUrl)
    }
  }, [originalUrl, resultUrl])

  const process = useCallback(
    async (
      target: File,
      background: Bg,
      selectedModelVersion: ModelVersion,
      onlyMainObject: boolean,
      keepBox: Box | null,
      removeBox: Box | null
    ) => {
      setLoading(true)
      setError(null)
      setResultUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev)
        return null
      })

      try {
        const form = new FormData()
        form.append('image', target)
        form.append('bg', background)
        form.append('model_version', selectedModelVersion)
        form.append('main_object_only', String(onlyMainObject))

        if (onlyMainObject && keepBox) {
          form.append('focus_box_x', String(keepBox.x))
          form.append('focus_box_y', String(keepBox.y))
          form.append('focus_box_w', String(keepBox.width))
          form.append('focus_box_h', String(keepBox.height))
        }

        if (onlyMainObject && removeBox) {
          form.append('exclude_box_x', String(removeBox.x))
          form.append('exclude_box_y', String(removeBox.y))
          form.append('exclude_box_w', String(removeBox.width))
          form.append('exclude_box_h', String(removeBox.height))
        }

        const res = await fetch('/api/remove-bg', { method: 'POST', body: form })
        if (!res.ok) {
          const data = await res.json().catch(() => null)
          throw new Error(data?.error ?? `请求失败：HTTP ${res.status}`)
        }

        const blob = await res.blob()
        setResultUrl(URL.createObjectURL(blob))
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setLoading(false)
      }
    },
    []
  )

  const handleFile = useCallback(
    (f: File) => {
      setFile(f)
      setOriginalUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev)
        return URL.createObjectURL(f)
      })
      void process(f, bg, modelVersion, mainObjectOnly, includeBox, excludeBox)
    },
    [bg, excludeBox, includeBox, mainObjectOnly, modelVersion, process]
  )

  const handleBgChange = useCallback(
    (next: Bg) => {
      setBg(next)
      if (file) void process(file, next, modelVersion, mainObjectOnly, includeBox, excludeBox)
    },
    [excludeBox, file, includeBox, mainObjectOnly, modelVersion, process]
  )

  const handleModelChange = useCallback(
    (next: ModelVersion) => {
      setModelVersion(next)
      if (file) void process(file, bg, next, mainObjectOnly, includeBox, excludeBox)
    },
    [bg, excludeBox, file, includeBox, mainObjectOnly, process]
  )

  const handleMainObjectToggle = useCallback(
    (next: boolean) => {
      setMainObjectOnly(next)
      if (file) void process(file, bg, modelVersion, next, includeBox, excludeBox)
    },
    [bg, excludeBox, file, includeBox, modelVersion, process]
  )

  const handlePickBox = useCallback(
    (box: Box) => {
      if (drawMode === 'include') {
        setIncludeBox(box)
        if (file && mainObjectOnly) {
          void process(file, bg, modelVersion, true, box, excludeBox)
        }
      } else {
        setExcludeBox(box)
        if (file && mainObjectOnly) {
          void process(file, bg, modelVersion, true, includeBox, box)
        }
      }
    },
    [bg, drawMode, excludeBox, file, includeBox, mainObjectOnly, modelVersion, process]
  )

  const reset = useCallback(() => {
    setFile(null)
    setOriginalUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return null
    })
    setResultUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return null
    })
    setIncludeBox(null)
    setExcludeBox(null)
    setError(null)
  }, [])

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-8 px-5 py-10 sm:py-16">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">去背景 · 物品抠图</h1>
        <p className="text-sm text-neutral-400">
          本地 RMBG 模型，专注物品/商品抠图，只保留主体。也提供{' '}
          <code className="rounded bg-neutral-800 px-1.5 py-0.5 text-xs text-neutral-200">POST /api/remove-bg</code>{' '}
          接口。
        </p>
      </header>

      {!originalUrl ? (
        <Dropzone onFile={handleFile} disabled={loading} />
      ) : (
        <div className="flex flex-col gap-5">
          <ResultView
            originalUrl={originalUrl}
            resultUrl={resultUrl}
            loading={loading}
            includeBox={includeBox}
            excludeBox={excludeBox}
            drawMode={drawMode}
            onPickBox={handlePickBox}
          />

          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1 rounded-lg border border-neutral-800 p-1">
              <button
                type="button"
                onClick={() => handleModelChange('1.4')}
                disabled={loading}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
                  modelVersion === '1.4' ? 'bg-neutral-700 text-white' : 'text-neutral-400 hover:text-neutral-200'
                }`}
              >
                RMBG-1.4
              </button>
              <button
                type="button"
                onClick={() => handleModelChange('2.0')}
                disabled={loading}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
                  modelVersion === '2.0' ? 'bg-neutral-700 text-white' : 'text-neutral-400 hover:text-neutral-200'
                }`}
              >
                RMBG-2.0
              </button>
            </div>

            <div className="flex items-center gap-1 rounded-lg border border-neutral-800 p-1">
              <button
                type="button"
                onClick={() => setDrawMode('include')}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  drawMode === 'include' ? 'bg-emerald-700 text-white' : 'text-neutral-400 hover:text-neutral-200'
                }`}
              >
                画要的框
              </button>
              <button
                type="button"
                onClick={() => setDrawMode('exclude')}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  drawMode === 'exclude' ? 'bg-red-700 text-white' : 'text-neutral-400 hover:text-neutral-200'
                }`}
              >
                画不要的框
              </button>
            </div>

            <div className="flex items-center gap-1 rounded-lg border border-neutral-800 p-1">
              <button
                type="button"
                onClick={() => handleBgChange('transparent')}
                disabled={loading}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
                  bg === 'transparent' ? 'bg-neutral-700 text-white' : 'text-neutral-400 hover:text-neutral-200'
                }`}
              >
                透明背景
              </button>
              <button
                type="button"
                onClick={() => handleBgChange('white')}
                disabled={loading}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
                  bg === 'white' ? 'bg-neutral-700 text-white' : 'text-neutral-400 hover:text-neutral-200'
                }`}
              >
                白色背景
              </button>
            </div>

            <a
              href={resultUrl ?? undefined}
              download={`removed-bg-${bg}.png`}
              aria-disabled={!resultUrl || loading}
              className={`rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-neutral-950 transition-colors hover:bg-emerald-400 ${
                !resultUrl || loading ? 'pointer-events-none opacity-50' : ''
              }`}
            >
              下载 PNG
            </a>

            <label className="inline-flex items-center gap-2 rounded-lg border border-neutral-700 px-3 py-2 text-sm text-neutral-300">
              <input
                type="checkbox"
                checked={mainObjectOnly}
                disabled={loading}
                onChange={(e) => handleMainObjectToggle(e.target.checked)}
                className="h-4 w-4 accent-emerald-500"
              />
              只保留主物体
            </label>

            <button
              type="button"
              onClick={() => {
                setIncludeBox(null)
                setExcludeBox(null)
                if (file) void process(file, bg, modelVersion, mainObjectOnly, null, null)
              }}
              disabled={loading}
              className="rounded-lg border border-neutral-700 px-4 py-2 text-sm font-medium text-neutral-300 transition-colors hover:bg-neutral-800 disabled:opacity-50"
            >
              清空框选
            </button>

            <button
              type="button"
              onClick={reset}
              disabled={loading}
              className="rounded-lg border border-neutral-700 px-4 py-2 text-sm font-medium text-neutral-300 transition-colors hover:bg-neutral-800 disabled:opacity-50"
            >
              换一张
            </button>
          </div>

          {error && (
            <p className="rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-300">
              {error}
            </p>
          )}

          <p className="text-xs text-neutral-500">
            绿色框 = 指定保留哪个物体；红色框 = 画在包装盒/文字上，会删同色相连纸盒并擦掉框内黑字、金字残影。车身银灰/贴纸会自动保留。
          </p>
        </div>
      )}

      <footer className="mt-auto pt-6 text-xs text-neutral-600">首次使用会下载所选模型，之后可离线运行。</footer>
    </main>
  )
}
