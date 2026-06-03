'use client'

import { useCallback, useRef, useState } from 'react'

interface DropzoneProps {
  onFile: (file: File) => void
  disabled?: boolean
}

const ACCEPT = 'image/jpeg,image/png,image/webp'

export default function Dropzone({ onFile, disabled }: DropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  const handleFiles = useCallback(
    (files: FileList | null) => {
      const file = files?.[0]
      if (file) onFile(file)
    },
    [onFile]
  )

  return (
    <div
      role="button"
      tabIndex={0}
      aria-disabled={disabled}
      onClick={() => !disabled && inputRef.current?.click()}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !disabled) {
          e.preventDefault()
          inputRef.current?.click()
        }
      }}
      onDragOver={(e) => {
        e.preventDefault()
        if (!disabled) setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        if (!disabled) handleFiles(e.dataTransfer.files)
      }}
      className={`flex w-full cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-14 text-center transition-colors ${
        dragging ? 'border-emerald-400 bg-emerald-400/5' : 'border-neutral-700 hover:border-neutral-500'
      } ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
    >
      <svg
        className="mb-3 h-10 w-10 text-neutral-500"
        fill="none"
        viewBox="0 0 24 24"
        strokeWidth={1.5}
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5"
        />
      </svg>
      <p className="text-sm font-medium text-neutral-200">点击或拖拽图片到此处</p>
      <p className="mt-1 text-xs text-neutral-500">支持 JPEG / PNG / WebP，最大 15MB</p>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        disabled={disabled}
        onChange={(e) => handleFiles(e.target.files)}
      />
    </div>
  )
}
