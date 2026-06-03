'use client'

interface ResultViewProps {
  originalUrl: string
  resultUrl: string | null
  loading: boolean
}

export default function ResultView({ originalUrl, resultUrl, loading }: ResultViewProps) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <figure className="flex flex-col gap-2">
        <figcaption className="text-xs font-medium text-neutral-400">原图</figcaption>
        <div className="flex aspect-square items-center justify-center overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900">
          <img src={originalUrl} alt="原图" className="max-h-full max-w-full object-contain" />
        </div>
      </figure>

      <figure className="flex flex-col gap-2">
        <figcaption className="text-xs font-medium text-neutral-400">去背景结果</figcaption>
        <div className="checkerboard relative flex aspect-square items-center justify-center overflow-hidden rounded-xl border border-neutral-800">
          {loading && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-neutral-950/60 backdrop-blur-sm">
              <span className="h-8 w-8 animate-spin rounded-full border-2 border-neutral-600 border-t-emerald-400" />
              <span className="text-xs text-neutral-300">正在抠图…</span>
            </div>
          )}
          {resultUrl ? (
            <img src={resultUrl} alt="去背景结果" className="max-h-full max-w-full object-contain" />
          ) : (
            !loading && <span className="text-xs text-neutral-500">结果将显示在这里</span>
          )}
        </div>
      </figure>
    </div>
  )
}
