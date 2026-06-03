'use client'

import { type PointerEvent, useCallback, useEffect, useRef, useState } from 'react'

type Box = { x: number; y: number; width: number; height: number }

interface ResultViewProps {
  originalUrl: string
  resultUrl: string | null
  loading: boolean
  includeBox: Box | null
  excludeBox: Box | null
  drawMode: 'include' | 'exclude'
  onPickBox: (box: Box) => void
}

export default function ResultView({
  originalUrl,
  resultUrl,
  loading,
  includeBox,
  excludeBox,
  drawMode,
  onPickBox,
}: ResultViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const [draftBox, setDraftBox] = useState<Box | null>(null)
  const [displayRect, setDisplayRect] = useState<Box>({ x: 0, y: 0, width: 1, height: 1 })
  const dragStart = useRef<{ x: number; y: number } | null>(null)
  const latestDraftBox = useRef<Box | null>(null)

  const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

  const buildBox = (start: { x: number; y: number }, end: { x: number; y: number }): Box => ({
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  })

  const getDisplayedImageRect = useCallback((container: HTMLDivElement) => {
    const cw = container.clientWidth
    const ch = container.clientHeight
    const img = imageRef.current
    if (!img || !img.naturalWidth || !img.naturalHeight) {
      return { x: 0, y: 0, width: cw, height: ch }
    }

    const imageRatio = img.naturalWidth / img.naturalHeight
    const containerRatio = cw / ch

    if (containerRatio > imageRatio) {
      const height = ch
      const width = height * imageRatio
      return { x: (cw - width) / 2, y: 0, width, height }
    }

    const width = cw
    const height = width / imageRatio
    return { x: 0, y: (ch - height) / 2, width, height }
  }, [])

  const updateDisplayRect = useCallback(() => {
    const container = containerRef.current
    if (!container) return
    setDisplayRect(getDisplayedImageRect(container))
  }, [getDisplayedImageRect])

  useEffect(() => {
    updateDisplayRect()
    const container = containerRef.current
    if (!container) return

    const observer = new ResizeObserver(updateDisplayRect)
    observer.observe(container)
    return () => observer.disconnect()
  }, [originalUrl, updateDisplayRect])

  const toImageNormalizedPoint = (e: PointerEvent<HTMLDivElement>) => {
    const containerRect = e.currentTarget.getBoundingClientRect()
    const imageRect = getDisplayedImageRect(e.currentTarget)

    const localX = e.clientX - containerRect.left
    const localY = e.clientY - containerRect.top

    const x = (localX - imageRect.x) / imageRect.width
    const y = (localY - imageRect.y) / imageRect.height
    return { x: clamp01(x), y: clamp01(y) }
  }

  const draftClass =
    drawMode === 'include'
      ? 'border-emerald-400 bg-emerald-400/10'
      : 'border-red-400 bg-red-400/10'

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <figure className="flex flex-col gap-2">
        <figcaption className="text-xs font-medium text-neutral-400">
          原图（当前模式：{drawMode === 'include' ? '要的框' : '不要的框'}）
        </figcaption>
        <div
          ref={containerRef}
          className="relative flex aspect-square cursor-crosshair items-center justify-center overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900"
          onPointerDown={(e) => {
            const { x, y } = toImageNormalizedPoint(e)
            dragStart.current = { x, y }
            const initial = { x, y, width: 0, height: 0 }
            latestDraftBox.current = initial
            setDraftBox(initial)
            e.currentTarget.setPointerCapture(e.pointerId)
          }}
          onPointerMove={(e) => {
            if (!dragStart.current) return
            const { x, y } = toImageNormalizedPoint(e)
            const next = buildBox(dragStart.current, { x, y })
            latestDraftBox.current = next
            setDraftBox(next)
          }}
          onPointerUp={(e) => {
            if (!dragStart.current) return
            const { x, y } = toImageNormalizedPoint(e)
            const computed = buildBox(dragStart.current, { x, y })
            const finalBox = computed.width > 0 || computed.height > 0 ? computed : latestDraftBox.current

            dragStart.current = null
            e.currentTarget.releasePointerCapture(e.pointerId)
            latestDraftBox.current = null

            if (finalBox) {
              const minSize = 0.04
              const safeBox =
                finalBox.width < minSize || finalBox.height < minSize
                  ? {
                      x: clamp01(finalBox.x - minSize / 2),
                      y: clamp01(finalBox.y - minSize / 2),
                      width: minSize,
                      height: minSize,
                    }
                  : finalBox
              onPickBox(safeBox)
            }

            setDraftBox(null)
          }}
        >
          <img
            ref={imageRef}
            src={originalUrl}
            alt="原图"
            onLoad={updateDisplayRect}
            className="pointer-events-none max-h-full max-w-full object-contain"
          />

          {includeBox && (
            <span
              className="pointer-events-none absolute border-2 border-emerald-400 bg-emerald-400/8"
              style={{
                left: displayRect.x + includeBox.x * displayRect.width,
                top: displayRect.y + includeBox.y * displayRect.height,
                width: includeBox.width * displayRect.width,
                height: includeBox.height * displayRect.height,
              }}
            />
          )}

          {excludeBox && (
            <span
              className="pointer-events-none absolute border-2 border-red-400 bg-red-400/8"
              style={{
                left: displayRect.x + excludeBox.x * displayRect.width,
                top: displayRect.y + excludeBox.y * displayRect.height,
                width: excludeBox.width * displayRect.width,
                height: excludeBox.height * displayRect.height,
              }}
            />
          )}

          {draftBox && (
            <span
              className={`pointer-events-none absolute border-2 ${draftClass}`}
              style={{
                left: displayRect.x + draftBox.x * displayRect.width,
                top: displayRect.y + draftBox.y * displayRect.height,
                width: draftBox.width * displayRect.width,
                height: draftBox.height * displayRect.height,
              }}
            />
          )}
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
