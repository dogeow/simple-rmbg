import { NextRequest, NextResponse } from 'next/server'
import {
  getModel,
  getModelRuntimeInfo,
  removeBackground,
  type BackgroundOption,
  type RmbgModelVersion,
} from '@/lib/bg-removal'

export const runtime = 'nodejs'
export const maxDuration = 120

const MAX_BYTES = 15 * 1024 * 1024 // 15MB
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp']

function normalizeBg(value: string | null | undefined): BackgroundOption {
  if (!value || value === 'transparent') return 'transparent'
  if (value === 'white') return '#ffffff'
  if (value === 'black') return '#000000'
  return value // 透传 CSS 颜色 / #rrggbb
}

function errorResponse(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status })
}

function parseBoolean(input: string | null | undefined, defaultValue: boolean): boolean {
  if (input == null) return defaultValue
  const v = input.toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(v)) return true
  if (['0', 'false', 'no', 'off'].includes(v)) return false
  return defaultValue
}

function parseOptionalNumber(input: string | null | undefined): number | null {
  if (input == null) return null
  const n = Number(input)
  return Number.isFinite(n) ? n : null
}

function parseModelVersion(input: string | null | undefined): RmbgModelVersion {
  return input === '2.0' ? '2.0' : '1.4'
}

function formatServerError(err: unknown): string {
  const base = err instanceof Error ? err.message : String(err)
  const lower = base.toLowerCase()
  if (base.includes('RMBG-2.0') && (lower.includes('fetch failed') || lower.includes('connect timeout'))) {
    return `${base}。RMBG-2.0 首次使用需要下载受访问条款保护的模型权重：请先在 Hugging Face 接受 briaai/RMBG-2.0 条款，并用 HF_TOKEN 启动服务；如果当前网络无法访问 Hugging Face，请把模型放到 models/RMBG-2.0 后设置 MODEL_LOCAL_ONLY=true。`
  }
  if (lower.includes('fetch failed') || lower.includes('connect timeout')) {
    return `${base}。模型首次下载失败，请检查网络/代理，或先手动下载模型到本地模型目录后重试。`
  }
  return base
}

/** 健康检查 / 模型预热 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const modelVersion = parseModelVersion(url.searchParams.get('model_version'))
  const runtime = getModelRuntimeInfo(modelVersion)
  try {
    await getModel(modelVersion)
    return NextResponse.json({
      status: 'ready',
      model: runtime.modelId,
      runtime,
    })
  } catch (err) {
    return NextResponse.json(
      {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        runtime,
      },
      { status: 503 }
    )
  }
}

export async function POST(req: NextRequest) {
  const url = new URL(req.url)
  const contentType = req.headers.get('content-type') ?? ''

  let bytes: Uint8Array
  let bg: BackgroundOption = 'transparent'
  let modelVersion = parseModelVersion(url.searchParams.get('model_version'))
  let format = url.searchParams.get('format') ?? 'png' // 'png' | 'json'
  let mainObjectOnly = parseBoolean(url.searchParams.get('main_object_only'), true)
  let focusBoxX = parseOptionalNumber(url.searchParams.get('focus_box_x'))
  let focusBoxY = parseOptionalNumber(url.searchParams.get('focus_box_y'))
  let focusBoxW = parseOptionalNumber(url.searchParams.get('focus_box_w'))
  let focusBoxH = parseOptionalNumber(url.searchParams.get('focus_box_h'))
  let excludeBoxX = parseOptionalNumber(url.searchParams.get('exclude_box_x'))
  let excludeBoxY = parseOptionalNumber(url.searchParams.get('exclude_box_y'))
  let excludeBoxW = parseOptionalNumber(url.searchParams.get('exclude_box_w'))
  let excludeBoxH = parseOptionalNumber(url.searchParams.get('exclude_box_h'))

  try {
    if (contentType.includes('multipart/form-data')) {
      const form = await req.formData()
      const file = form.get('image')
      if (!(file instanceof File)) {
        return errorResponse('缺少 image 文件字段')
      }
      if (file.type && !ALLOWED_TYPES.includes(file.type)) {
        return errorResponse(`不支持的文件类型: ${file.type}，仅支持 jpeg/png/webp`)
      }
      if (file.size > MAX_BYTES) {
        return errorResponse('图片过大，最大 15MB', 413)
      }
      bytes = new Uint8Array(await file.arrayBuffer())
      bg = normalizeBg((form.get('bg') as string) ?? url.searchParams.get('bg'))
      modelVersion = parseModelVersion(
        (form.get('model_version') as string) ?? url.searchParams.get('model_version')
      )
      format = (form.get('format') as string) ?? format
      mainObjectOnly = parseBoolean(
        (form.get('main_object_only') as string) ?? url.searchParams.get('main_object_only'),
        mainObjectOnly
      )
      focusBoxX = parseOptionalNumber(
        (form.get('focus_box_x') as string) ?? url.searchParams.get('focus_box_x')
      )
      focusBoxY = parseOptionalNumber(
        (form.get('focus_box_y') as string) ?? url.searchParams.get('focus_box_y')
      )
      focusBoxW = parseOptionalNumber(
        (form.get('focus_box_w') as string) ?? url.searchParams.get('focus_box_w')
      )
      focusBoxH = parseOptionalNumber(
        (form.get('focus_box_h') as string) ?? url.searchParams.get('focus_box_h')
      )
      excludeBoxX = parseOptionalNumber(
        (form.get('exclude_box_x') as string) ?? url.searchParams.get('exclude_box_x')
      )
      excludeBoxY = parseOptionalNumber(
        (form.get('exclude_box_y') as string) ?? url.searchParams.get('exclude_box_y')
      )
      excludeBoxW = parseOptionalNumber(
        (form.get('exclude_box_w') as string) ?? url.searchParams.get('exclude_box_w')
      )
      excludeBoxH = parseOptionalNumber(
        (form.get('exclude_box_h') as string) ?? url.searchParams.get('exclude_box_h')
      )
    } else if (contentType.includes('application/json')) {
      const body = (await req.json()) as {
        image_url?: string
        bg?: string
        model_version?: string
        format?: string
        main_object_only?: boolean | string
        focus_box_x?: number | string
        focus_box_y?: number | string
        focus_box_w?: number | string
        focus_box_h?: number | string
        exclude_box_x?: number | string
        exclude_box_y?: number | string
        exclude_box_w?: number | string
        exclude_box_h?: number | string
      }
      if (!body.image_url) {
        return errorResponse('缺少 image_url 字段')
      }
      const res = await fetch(body.image_url)
      if (!res.ok) {
        return errorResponse(`无法获取 image_url: HTTP ${res.status}`)
      }
      const buf = await res.arrayBuffer()
      if (buf.byteLength > MAX_BYTES) {
        return errorResponse('图片过大，最大 15MB', 413)
      }
      bytes = new Uint8Array(buf)
      bg = normalizeBg(body.bg ?? url.searchParams.get('bg'))
      modelVersion = parseModelVersion(body.model_version ?? url.searchParams.get('model_version'))
      format = body.format ?? format
      mainObjectOnly = parseBoolean(
        body.main_object_only == null ? undefined : String(body.main_object_only),
        mainObjectOnly
      )
      focusBoxX = parseOptionalNumber(body.focus_box_x == null ? undefined : String(body.focus_box_x))
      focusBoxY = parseOptionalNumber(body.focus_box_y == null ? undefined : String(body.focus_box_y))
      focusBoxW = parseOptionalNumber(body.focus_box_w == null ? undefined : String(body.focus_box_w))
      focusBoxH = parseOptionalNumber(body.focus_box_h == null ? undefined : String(body.focus_box_h))
      excludeBoxX = parseOptionalNumber(
        body.exclude_box_x == null ? undefined : String(body.exclude_box_x)
      )
      excludeBoxY = parseOptionalNumber(
        body.exclude_box_y == null ? undefined : String(body.exclude_box_y)
      )
      excludeBoxW = parseOptionalNumber(
        body.exclude_box_w == null ? undefined : String(body.exclude_box_w)
      )
      excludeBoxH = parseOptionalNumber(
        body.exclude_box_h == null ? undefined : String(body.exclude_box_h)
      )
    } else {
      // 原始二进制 body
      const buf = await req.arrayBuffer()
      if (buf.byteLength === 0) {
        return errorResponse('请求体为空，请上传图片')
      }
      if (buf.byteLength > MAX_BYTES) {
        return errorResponse('图片过大，最大 15MB', 413)
      }
      bytes = new Uint8Array(buf)
      bg = normalizeBg(url.searchParams.get('bg'))
      modelVersion = parseModelVersion(url.searchParams.get('model_version'))
    }
  } catch (err) {
    return errorResponse(`请求解析失败: ${err instanceof Error ? err.message : String(err)}`)
  }

  try {
    const { png, width, height } = await removeBackground(bytes, {
      bg,
      modelVersion,
      mainObjectOnly,
      focusBox:
        mainObjectOnly &&
        focusBoxX != null &&
        focusBoxY != null &&
        focusBoxW != null &&
        focusBoxH != null
          ? {
              x: Math.min(1, Math.max(0, focusBoxX)),
              y: Math.min(1, Math.max(0, focusBoxY)),
              width: Math.min(1, Math.max(0, focusBoxW)),
              height: Math.min(1, Math.max(0, focusBoxH)),
            }
          : undefined,
      excludeBox:
        mainObjectOnly &&
        excludeBoxX != null &&
        excludeBoxY != null &&
        excludeBoxW != null &&
        excludeBoxH != null
          ? {
              x: Math.min(1, Math.max(0, excludeBoxX)),
              y: Math.min(1, Math.max(0, excludeBoxY)),
              width: Math.min(1, Math.max(0, excludeBoxW)),
              height: Math.min(1, Math.max(0, excludeBoxH)),
            }
          : undefined,
    })

    if (format === 'json') {
      return NextResponse.json({
        width,
        height,
        format: 'png',
        data: `data:image/png;base64,${png.toString('base64')}`,
      })
    }

    return new NextResponse(new Uint8Array(png), {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'Content-Length': String(png.length),
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    return errorResponse(
      `处理失败: ${formatServerError(err)}`,
      500
    )
  }
}
