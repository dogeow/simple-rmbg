import path from 'path'
import fs from 'fs'
import {
  env,
  AutoModel,
  AutoModelForImageSegmentation,
  AutoProcessor,
  RawImage,
  type PreTrainedModel,
} from '@huggingface/transformers'
import sharp from 'sharp'
import { ProxyAgent, setGlobalDispatcher } from 'undici'

// 模型与处理器在本进程内缓存为单例，避免每次请求重复加载（约几十 MB）。
// 首次调用会联网下载模型到本地缓存目录，之后离线可用。
env.cacheDir = path.join(process.cwd(), '.cache')

function normalizeRemoteHost(value: string): string {
  return value.endsWith('/') ? value : `${value}/`
}

const remoteHosts = Array.from(
  new Set(
    [
      process.env.HF_ENDPOINT,
      process.env.MODEL_REMOTE_HOST,
      'https://hf-mirror.com/',
      'https://huggingface.co/',
    ]
      .filter((v): v is string => Boolean(v))
      .map(normalizeRemoteHost)
  )
)

env.remoteHost = remoteHosts[0] ?? env.remoteHost

const proxyUrl = process.env.MODEL_PROXY_URL ?? process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY
if (proxyUrl) {
  // 统一接管 Node fetch/undici 出站请求，确保模型下载走代理。
  setGlobalDispatcher(new ProxyAgent(proxyUrl))
}

const MODEL_LOCAL_ONLY = ['1', 'true', 'yes', 'on'].includes(
  (process.env.MODEL_LOCAL_ONLY ?? '').toLowerCase()
)

type Processor = Awaited<ReturnType<typeof AutoProcessor.from_pretrained>>
export type RmbgModelVersion = '1.4' | '2.0'

type ModelSpec = {
  id: string
  localPath: string
  displayName: string
  modelType: 'custom' | 'birefnet'
  processorConfig: {
    do_normalize: boolean
    do_pad: boolean
    do_rescale: boolean
    do_resize: boolean
    image_mean: number[]
    image_std: number[]
    resample: number
    rescale_factor: number
    size: { width: number; height: number }
  }
}

const DEFAULT_MODEL_VERSION: RmbgModelVersion =
  process.env.MODEL_VERSION === '2.0' ? '2.0' : '1.4'

const MODEL_SPECS: Record<RmbgModelVersion, ModelSpec> = {
  '1.4': {
    id: 'briaai/RMBG-1.4',
    displayName: 'RMBG-1.4',
    localPath: path.resolve(
      process.env.MODEL_1_4_LOCAL_PATH ??
        (DEFAULT_MODEL_VERSION === '1.4' ? process.env.MODEL_LOCAL_PATH : undefined) ??
        path.join(process.cwd(), 'models', 'RMBG-1.4')
    ),
    modelType: 'custom',
    processorConfig: {
      do_normalize: true,
      do_pad: false,
      do_rescale: true,
      do_resize: true,
      image_mean: [0.5, 0.5, 0.5],
      image_std: [1, 1, 1],
      resample: 2,
      rescale_factor: 1 / 255,
      size: { width: 1024, height: 1024 },
    },
  },
  '2.0': {
    id: 'briaai/RMBG-2.0',
    displayName: 'RMBG-2.0',
    localPath: path.resolve(
      process.env.MODEL_2_0_LOCAL_PATH ??
        (DEFAULT_MODEL_VERSION === '2.0' ? process.env.MODEL_LOCAL_PATH : undefined) ??
        path.join(process.cwd(), 'models', 'RMBG-2.0')
    ),
    modelType: 'birefnet',
    processorConfig: {
      do_normalize: true,
      do_pad: false,
      do_rescale: true,
      do_resize: true,
      image_mean: [0.485, 0.456, 0.406],
      image_std: [0.229, 0.224, 0.225],
      resample: 2,
      rescale_factor: 1 / 255,
      size: { width: 1024, height: 1024 },
    },
  },
}

const modelPromises = new Map<RmbgModelVersion, Promise<{ model: PreTrainedModel; processor: Processor; spec: ModelSpec }>>()

function normalizeModelVersion(input: string | null | undefined): RmbgModelVersion {
  return input === '2.0' ? '2.0' : '1.4'
}

async function loadModelFrom(source: string, localFilesOnly: boolean, spec: ModelSpec) {
  const modelOptions = {
    config: { model_type: spec.modelType } as never,
    local_files_only: localFilesOnly,
  }
  const model = spec.modelType === 'custom'
    ? await AutoModel.from_pretrained(source, modelOptions)
    : await AutoModelForImageSegmentation.from_pretrained(source, modelOptions)

  const processor = await AutoProcessor.from_pretrained(source, {
    config: spec.processorConfig as never,
    local_files_only: localFilesOnly,
  })

  return { model, processor, spec }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRetryableNetworkError(err: unknown): boolean {
  const msg = getErrorMessage(err).toLowerCase()
  return (
    msg.includes('fetch failed') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('connect timeout') ||
    msg.includes('socket hang up') ||
    msg.includes('network')
  )
}

async function loadModelWithRetry(version: RmbgModelVersion, maxAttempts = 4) {
  const spec = MODEL_SPECS[version]
  const hasLocalModel = fs.existsSync(spec.localPath)
  if (hasLocalModel) {
    try {
      return await loadModelFrom(spec.localPath, true, spec)
    } catch (err) {
      if (MODEL_LOCAL_ONLY) {
        throw new Error(`[local_only path=${spec.localPath}] ${getErrorMessage(err)}`)
      }
    }
  } else if (MODEL_LOCAL_ONLY) {
    throw new Error(`已启用 MODEL_LOCAL_ONLY，但本地模型目录不存在: ${spec.localPath}`)
  }

  let lastError: unknown = null
  for (const host of remoteHosts) {
    env.remoteHost = host
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await loadModelFrom(spec.id, false, spec)
      } catch (err) {
        lastError = new Error(`[host=${host}] ${getErrorMessage(err)}`)
        if (attempt === maxAttempts || !isRetryableNetworkError(err)) {
          break
        }
        // 退避重试：2s, 4s, 8s...
        await sleep(2 ** attempt * 1000)
      }
    }
  }
  throw lastError
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause
    if (cause instanceof Error && cause.message) {
      return `${err.message}; cause: ${cause.message}`
    }
    return err.message
  }
  return String(err)
}

/** 触发模型加载（用于健康检查 / 预热）。 */
export function getModel(version: RmbgModelVersion = DEFAULT_MODEL_VERSION) {
  const normalizedVersion = normalizeModelVersion(version)
  let modelPromise = modelPromises.get(normalizedVersion)
  if (!modelPromise) {
    const spec = MODEL_SPECS[normalizedVersion]
    modelPromise = loadModelWithRetry(normalizedVersion).catch((err) => {
      // 下载或初始化失败时清空缓存，允许后续请求重试加载。
      modelPromises.delete(normalizedVersion)
      throw new Error(
        `${spec.displayName} 模型加载失败: ${getErrorMessage(err)}。可将模型放到 ${spec.localPath} 并设置 MODEL_LOCAL_ONLY=true`
      )
    })
    modelPromises.set(normalizedVersion, modelPromise)
  }
  return modelPromise
}

export function getModelRuntimeInfo(version: RmbgModelVersion = DEFAULT_MODEL_VERSION) {
  const normalizedVersion = normalizeModelVersion(version)
  const spec = MODEL_SPECS[normalizedVersion]
  return {
    modelId: spec.id,
    modelVersion: normalizedVersion,
    availableVersions: Object.keys(MODEL_SPECS),
    localPath: spec.localPath,
    localPathExists: fs.existsSync(spec.localPath),
    localOnly: MODEL_LOCAL_ONLY,
    remoteHosts,
    currentRemoteHost: env.remoteHost,
  }
}

export type BackgroundOption = 'transparent' | string // 'transparent' 或 CSS 颜色 / #rrggbb

export interface RemoveBackgroundResult {
  png: Buffer
  width: number
  height: number
}

export interface RemoveBackgroundOptions {
  bg?: BackgroundOption
  modelVersion?: RmbgModelVersion
  mainObjectOnly?: boolean
  focusBox?: { x: number; y: number; width: number; height: number } // 0~1 归一化保留框
  excludeBox?: { x: number; y: number; width: number; height: number } // 0~1 归一化删除框
}

function colorDistSq(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number) {
  return (r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2
}

function getColorStats(r: number, g: number, b: number) {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const sat = max > 0 ? (max - min) / max : 0
  const lum = (r + g + b) / 3
  return { sat, lum, max, min }
}

/** 包装盒相关色：深橙、浅橙、奶白底、暖黄、亮黄（含 LIMIT 字样区） */
function isPackagingLikeColor(r: number, g: number, b: number): boolean {
  const { sat, lum } = getColorStats(r, g, b)

  // 亮黄纸盒（R、G 高，B 明显更低）
  if (r > 125 && g > 95 && b < Math.min(r, g) * 0.92 && g >= r * 0.62) return true
  // 深橙盒身
  if (sat > 0.28 && r > 120 && r > b * 1.2 && r >= g * 0.68) return true
  // 浅橙/奶白底（高亮暖色，不是中性银灰）
  if (lum > 145 && sat < 0.38 && r > g * 0.92 && r > b * 1.05 && r > 130) return true
  // 暖黄橙
  if (sat > 0.18 && r > 110 && g > b && r >= g * 0.72) return true

  return false
}

/** 包装盒上的深黑字/描边（收紧，避免车身缝隙、阴影被当成墨字） */
function isPackagingInk(r: number, g: number, b: number): boolean {
  const { sat, lum, max } = getColorStats(r, g, b)
  if (lum > 72 || max > 100) return false
  if (sat > 0.45) return false
  return true
}

/** 烫金/亮黄立体字（如 LIMITED.VER），偏暖色 */
function isEmbossedPackagingText(r: number, g: number, b: number): boolean {
  const { sat, lum } = getColorStats(r, g, b)
  if (lum < 100 || lum > 240) return false
  if (sat < 0.28) return false
  if (r > 155 && g > 105 && b < g * 0.82 && r >= g * 0.78) return true
  return false
}

function isInStrictExcludeBox(
  x: number,
  y: number,
  box: { x1: number; y1: number; x2: number; y2: number }
) {
  return x >= box.x1 && x <= box.x2 && y >= box.y1 && y <= box.y2
}

function getStrictExcludeBoxPixels(
  excludeBox: { x: number; y: number; width: number; height: number },
  width: number,
  height: number
) {
  const x1 = Math.floor(Math.min(1, Math.max(0, excludeBox.x)) * (width - 1))
  const y1 = Math.floor(Math.min(1, Math.max(0, excludeBox.y)) * (height - 1))
  const x2 = Math.ceil(
    Math.min(1, Math.max(0, excludeBox.x + Math.max(0.01, excludeBox.width))) * (width - 1)
  )
  const y2 = Math.ceil(
    Math.min(1, Math.max(0, excludeBox.y + Math.max(0.01, excludeBox.height))) * (height - 1)
  )
  return { x1, y1, x2, y2 }
}

function isSimilarToTargetColor(
  r: number,
  g: number,
  b: number,
  targetR: number,
  targetG: number,
  targetB: number,
  maxDistSq: number
) {
  return colorDistSq(r, g, b, targetR, targetG, targetB) <= maxDistSq
}

/** 阻挡 flood 蔓延到车身金属/车窗等（即使与包装盒在图上相邻） */
function blocksPackagingFlood(
  r: number,
  g: number,
  b: number,
  maskValue: number
): boolean {
  if (shouldProtectInExcludeBox(r, g, b, maskValue)) return true
  const { sat, lum } = getColorStats(r, g, b)
  // 模型认为是主体 + 中性色（银/灰/黑玻璃）→ 不当作包装盒扩展
  if (maskValue >= 165 && sat < 0.3 && lum >= 40 && lum <= 220) return true
  if (maskValue >= 175 && !isPackagingLikeColor(r, g, b)) return true
  return false
}

/** 仅保护明确的车身部位：中性银灰、黄绿贴纸（不含包装盒上的白/暖色） */
function shouldProtectInExcludeBox(
  r: number,
  g: number,
  b: number,
  maskValue: number
): boolean {
  const { sat, lum } = getColorStats(r, g, b)

  // 包装盒颜色一律不保护
  if (isPackagingLikeColor(r, g, b)) return false

  // 模型高置信前景 + 非包装盒色 → 车身/主体，一律不擦
  if (maskValue >= 165 && sat < 0.35 && lum >= 50 && lum <= 235) {
    return true
  }

  // 银色金属：中等亮度、低饱和、RGB 接近（中性灰，非暖白）
  if (
    maskValue >= 168 &&
    sat < 0.24 &&
    lum >= 75 &&
    lum <= 200 &&
    Math.abs(r - g) < 30 &&
    Math.abs(g - b) < 35
  ) {
    return true
  }

  // 车身黄绿贴纸
  if (maskValue >= 155 && sat > 0.38 && g >= r * 0.9 && b < r * 0.7 && r < 245) {
    return true
  }

  return false
}

/**
 * 从红框采样目标色，在全图做同色连通扩展（删掉挨着的整块包装盒，不是只删框内矩形）。
 */
function buildExcludeEraseMask(
  rgba: Buffer,
  maskData: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  excludeBox: { x: number; y: number; width: number; height: number },
  mainObjectMask: Uint8Array | null
): Uint8Array {
  const strict = getStrictExcludeBoxPixels(excludeBox, width, height)
  const { x1, y1, x2, y2 } = strict

  let sumR = 0
  let sumG = 0
  let sumB = 0
  let sampleN = 0
  for (let y = y1; y <= y2; y++) {
    const row = y * width
    for (let x = x1; x <= x2; x++) {
      const idx = row + x
      const o = idx * 4
      const r = rgba[o]
      const g = rgba[o + 1]
      const b = rgba[o + 2]
      // 只用包装盒色采样，避免黑字/阴影把目标色拉偏导致误删车身
      if (!isPackagingLikeColor(r, g, b)) continue
      sumR += r
      sumG += g
      sumB += b
      sampleN++
    }
  }

  if (sampleN === 0) {
    for (let y = y1; y <= y2; y++) {
      const row = y * width
      for (let x = x1; x <= x2; x++) {
        const o = (row + x) * 4
        sumR += rgba[o]
        sumG += rgba[o + 1]
        sumB += rgba[o + 2]
        sampleN++
      }
    }
  }

  const targetR = sampleN > 0 ? sumR / sampleN : 200
  const targetG = sampleN > 0 ? sumG / sampleN : 180
  const targetB = sampleN > 0 ? sumB / sampleN : 60
  const colorToleranceSq = 42 * 42 * 3

  const erase = new Uint8Array(width * height)
  const visited = new Uint8Array(width * height)
  const queue: number[] = []

  const tryEnqueue = (idx: number) => {
    if (visited[idx]) return
    const o = idx * 4
    const r = rgba[o]
    const g = rgba[o + 1]
    const b = rgba[o + 2]
    const m = maskData[idx]
    if (blocksPackagingFlood(r, g, b, m)) return
    const y = Math.floor(idx / width)
    const x = idx - y * width
    const inStrict = isInStrictExcludeBox(x, y, strict)
    const ink = isPackagingInk(r, g, b) || isEmbossedPackagingText(r, g, b)
    const similar = isSimilarToTargetColor(r, g, b, targetR, targetG, targetB, colorToleranceSq)
    const packaging = isPackagingLikeColor(r, g, b)
    if (ink) {
      if (m >= 158) return
      if (!inStrict && m >= 115) return
    } else if (!similar || (!packaging && m >= 130)) {
      return
    }
    visited[idx] = 1
    erase[idx] = 1
    queue.push(idx)
  }

  // 种子：仅红框内包装盒色 + 文字
  for (let y = y1; y <= y2; y++) {
    const row = y * width
    for (let x = x1; x <= x2; x++) {
      const idx = row + x
      const o = idx * 4
      const r = rgba[o]
      const g = rgba[o + 1]
      const b = rgba[o + 2]
      const m = maskData[idx]
      if (shouldProtectInExcludeBox(r, g, b, m)) continue
      if (
        isPackagingInk(r, g, b) ||
        isEmbossedPackagingText(r, g, b) ||
        isPackagingLikeColor(r, g, b)
      ) {
        if (!visited[idx]) {
          visited[idx] = 1
          erase[idx] = 1
          queue.push(idx)
        }
        continue
      }
      tryEnqueue(idx)
    }
  }

  // 全图同色连通扩展（墨字不得穿过模型高置信主体）
  let head = 0
  while (head < queue.length) {
    const cur = queue[head++]
    const y = Math.floor(cur / width)
    const x = cur - y * width
    const neighbors = [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
      [x - 1, y - 1],
      [x + 1, y - 1],
      [x - 1, y + 1],
      [x + 1, y + 1],
    ]
    for (const [nx, ny] of neighbors) {
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue
      tryEnqueue(ny * width + nx)
    }
  }

  sanitizeExcludeEraseMask(erase, rgba, maskData, mainObjectMask, strict, width, height)
  return erase
}

/** 去掉误标到车身/主体上的 erase 像素 */
function sanitizeExcludeEraseMask(
  erase: Uint8Array,
  rgba: Buffer,
  maskData: Uint8Array | Uint8ClampedArray,
  mainObjectMask: Uint8Array | null,
  strict: { x1: number; y1: number; x2: number; y2: number },
  width: number,
  height: number
) {
  for (let idx = 0; idx < erase.length; idx++) {
    if (!erase[idx]) continue
    const y = Math.floor(idx / width)
    const x = idx - y * width
    const inStrict = isInStrictExcludeBox(x, y, strict)
    const o = idx * 4
    const r = rgba[o]
    const g = rgba[o + 1]
    const b = rgba[o + 2]
    const m = maskData[idx]

    if (shouldProtectInExcludeBox(r, g, b, m)) {
      erase[idx] = 0
      continue
    }

    if (m >= 168 && !isPackagingLikeColor(r, g, b)) {
      erase[idx] = 0
      continue
    }

    if (mainObjectMask?.[idx] && m >= 155 && !isPackagingLikeColor(r, g, b)) {
      erase[idx] = 0
      continue
    }

    const ink = isPackagingInk(r, g, b) || isEmbossedPackagingText(r, g, b)
    if (ink && !inStrict && m >= 115) {
      erase[idx] = 0
    }
  }
}

/** 仅在红框内（略外扩）做轻量收尾，不碰车身 */
function cleanupExcludeRegion(
  composited: Buffer,
  rgba: Buffer,
  maskData: Uint8Array | Uint8ClampedArray,
  mainObjectMask: Uint8Array | null,
  excludeBox: { x: number; y: number; width: number; height: number },
  width: number,
  height: number
) {
  const strict = getStrictExcludeBoxPixels(excludeBox, width, height)
  const padX = Math.max(2, Math.ceil((strict.x2 - strict.x1) * 0.08))
  const padY = Math.max(2, Math.ceil((strict.y2 - strict.y1) * 0.08))
  const px1 = Math.max(0, strict.x1 - padX)
  const py1 = Math.max(0, strict.y1 - padY)
  const px2 = Math.min(width - 1, strict.x2 + padX)
  const py2 = Math.min(height - 1, strict.y2 + padY)

  for (let y = py1; y <= py2; y++) {
    const row = y * width
    for (let x = px1; x <= px2; x++) {
      const idx = row + x
      const o = idx * 4
      if (composited[o + 3] < 4) continue

      const r = rgba[o]
      const g = rgba[o + 1]
      const b = rgba[o + 2]
      const m = maskData[idx]
      const inStrict = isInStrictExcludeBox(x, y, strict)
      if (shouldProtectInExcludeBox(r, g, b, m)) continue
      if (!inStrict && m >= 168 && !isPackagingLikeColor(r, g, b)) continue
      if (!inStrict && mainObjectMask?.[idx] && m >= 155 && !isPackagingLikeColor(r, g, b)) continue

      const ink = isPackagingInk(r, g, b)
      const emboss = isEmbossedPackagingText(r, g, b)
      const packaging = isPackagingLikeColor(r, g, b)

      if (inStrict) {
        composited[o + 3] = 0
        continue
      }

      if (packaging || ink || emboss) {
        composited[o + 3] = 0
        continue
      }

      if (composited[o + 3] < 40) {
        composited[o + 3] = 0
      }
    }
  }
}

function applyExcludeEraseMask(
  keepMask: Uint8Array | null,
  composited: Buffer | null,
  eraseMask: Uint8Array
) {
  for (let i = 0; i < eraseMask.length; i++) {
    if (!eraseMask[i]) continue
    if (keepMask) keepMask[i] = 0
    if (composited) composited[i * 4 + 3] = 0
  }
}

function getPrimaryOutputTensor(modelOutput: unknown, outputNames?: string[]): {
  mul: (value: number) => { to: (dtype: string) => unknown }
} {
  const candidates: unknown[] = []
  const asTensor = (candidate: unknown) => {
    if (!candidate || typeof candidate !== 'object') return null
    const indexed = (candidate as Record<number, unknown>)[0]
    if (indexed && typeof indexed === 'object' && 'mul' in indexed) {
      return indexed as ReturnType<typeof getPrimaryOutputTensor>
    }
    if ('mul' in candidate) {
      return candidate as ReturnType<typeof getPrimaryOutputTensor>
    }
    return null
  }

  if (modelOutput && typeof modelOutput === 'object') {
    const outputRecord = modelOutput as Record<string, unknown>
    if (outputNames) {
      for (const name of outputNames) candidates.push(outputRecord[name])
    }
    candidates.push(outputRecord.output, outputRecord.logits, outputRecord.alphas)
    candidates.push(...Object.values(outputRecord))
  } else {
    candidates.push(modelOutput)
  }

  for (const candidate of candidates) {
    if (!candidate) continue
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        const tensor = asTensor(item)
        if (tensor) return tensor
      }
    }
    const tensor = asTensor(candidate)
    if (tensor) return tensor
  }

  throw new Error('模型输出中没有找到可用的 alpha mask tensor')
}

function selectMainConnectedComponent(
  maskData: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  focusBox?: { x: number; y: number; width: number; height: number }
): Uint8Array {
  // “要的框”只用于指定要保留哪一块前景（整连通域），绝不按框做矩形裁剪。
  const effectiveMask: Uint8Array | Uint8ClampedArray = maskData
  const total = width * height
  const visited = new Uint8Array(total)
  const keep = new Uint8Array(total)
  const threshold = 140

  const centerX = (width - 1) / 2
  const centerY = (height - 1) / 2
  const maxCenterDist = Math.sqrt(centerX * centerX + centerY * centerY) || 1

  let bestScore = -Infinity
  let bestIndices: number[] = []
  const components: number[][] = []

  for (let idx = 0; idx < total; idx++) {
    if (visited[idx] || effectiveMask[idx] < threshold) continue

    const queue: number[] = [idx]
    const indices: number[] = []
    visited[idx] = 1
    let head = 0
    let sumX = 0
    let sumY = 0

    while (head < queue.length) {
      const cur = queue[head++]
      indices.push(cur)
      const y = Math.floor(cur / width)
      const x = cur - y * width
      sumX += x
      sumY += y

      // 4 邻域，减少细小噪点误连
      const left = x > 0 ? cur - 1 : -1
      const right = x + 1 < width ? cur + 1 : -1
      const up = y > 0 ? cur - width : -1
      const down = y + 1 < height ? cur + width : -1

      if (left >= 0 && !visited[left] && effectiveMask[left] >= threshold) {
        visited[left] = 1
        queue.push(left)
      }
      if (right >= 0 && !visited[right] && effectiveMask[right] >= threshold) {
        visited[right] = 1
        queue.push(right)
      }
      if (up >= 0 && !visited[up] && effectiveMask[up] >= threshold) {
        visited[up] = 1
        queue.push(up)
      }
      if (down >= 0 && !visited[down] && effectiveMask[down] >= threshold) {
        visited[down] = 1
        queue.push(down)
      }
    }

    if (indices.length === 0) continue
    components.push(indices)
    const cx = sumX / indices.length
    const cy = sumY / indices.length
    const centerDist = Math.sqrt((cx - centerX) ** 2 + (cy - centerY) ** 2) / maxCenterDist
    const centerBonus = 1 - Math.min(1, centerDist)
    // 主体分数：面积优先，中心度次之（包装盒通常更靠边）
    const score = indices.length + centerBonus * 0.25 * total

    if (score > bestScore) {
      bestScore = score
      bestIndices = indices
    }
  }

  if (focusBox && components.length > 0) {
    const boxX = Math.floor(Math.min(1, Math.max(0, focusBox.x)) * (width - 1))
    const boxY = Math.floor(Math.min(1, Math.max(0, focusBox.y)) * (height - 1))
    const boxX2 = Math.ceil(
      Math.min(1, Math.max(0, focusBox.x + Math.max(0.01, focusBox.width))) * (width - 1)
    )
    const boxY2 = Math.ceil(
      Math.min(1, Math.max(0, focusBox.y + Math.max(0.01, focusBox.height))) * (height - 1)
    )
    const boxCx = (boxX + boxX2) / 2
    const boxCy = (boxY + boxY2) / 2

    let bestOverlap = -1
    let minDist = Infinity
    let pickedByOverlap = false

    for (const indices of components) {
      let overlap = 0
      let sumX = 0
      let sumY = 0
      for (const p of indices) {
        const y = Math.floor(p / width)
        const x = p - y * width
        sumX += x
        sumY += y
        if (x >= boxX && x <= boxX2 && y >= boxY && y <= boxY2) {
          overlap++
        }
      }

      const cx = sumX / indices.length
      const cy = sumY / indices.length
      const dist = (cx - boxCx) ** 2 + (cy - boxCy) ** 2

      if (overlap > bestOverlap) {
        bestOverlap = overlap
        bestIndices = indices
        minDist = dist
        pickedByOverlap = overlap > 0
      } else if (overlap === bestOverlap && overlap > 0 && dist < minDist) {
        minDist = dist
        bestIndices = indices
      }
    }

    // 框内没有命中任何前景时，选质心离框中心最近的连通域（仍保留完整轮廓，不裁矩形）
    if (!pickedByOverlap) {
      minDist = Infinity
      for (const indices of components) {
        let sumX = 0
        let sumY = 0
        for (const p of indices) {
          const y = Math.floor(p / width)
          sumX += p - y * width
          sumY += y
        }
        const dist = (sumX / indices.length - boxCx) ** 2 + (sumY / indices.length - boxCy) ** 2
        if (dist < minDist) {
          minDist = dist
          bestIndices = indices
        }
      }
    }
  }

  for (const i of bestIndices) keep[i] = 1
  return keep
}

/**
 * 去除图片背景，仅保留主体（物品）。
 * @param input 原始图片二进制
 * @param bg 背景：'transparent'（默认，透明 PNG）或纯色（如 'white' / '#ffffff'）
 */
export async function removeBackground(
  input: Buffer | Uint8Array,
  options: RemoveBackgroundOptions = {}
): Promise<RemoveBackgroundResult> {
  const bg = options.bg ?? 'transparent'
  const modelVersion = options.modelVersion ?? DEFAULT_MODEL_VERSION
  const mainObjectOnly = options.mainObjectOnly ?? true
  const focusBox = options.focusBox
  const excludeBox = options.excludeBox
  const { model, processor } = await getModel(modelVersion)

  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input)

  // 取原图 RGBA 原始像素（含 EXIF 旋转校正），作为合成基底
  const { data: rgba, info } = await sharp(buffer)
    .rotate()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const { width, height } = info

  // 模型输入：读取并预处理
  const image = await RawImage.fromBlob(new Blob([new Uint8Array(buffer)]))
  const modelInputs = await processor(image)
  const sessions = (model as PreTrainedModel & {
    sessions?: { model?: { inputNames?: string[]; outputNames?: string[] } }
  }).sessions
  const inputNames = sessions?.model?.inputNames
  const outputNames = sessions?.model?.outputNames
  if (inputNames && !inputNames.includes('pixel_values') && inputNames.length === 1) {
    const inputRecord = modelInputs as Record<string, unknown>
    inputRecord[inputNames[0]] = inputRecord.pixel_values
  }
  const modelOutput = await model(modelInputs)
  const outputTensor = getPrimaryOutputTensor(modelOutput, outputNames)

  // 输出为 [1,1,H,W] 的概率图，转为 0-255 的灰度 mask 并缩放回原尺寸
  let mask = RawImage.fromTensor(outputTensor.mul(255).to('uint8') as never)
  mask = await mask.resize(width, height)
  const maskData = mask.data
  const mainObjectMask = mainObjectOnly
    ? selectMainConnectedComponent(maskData, width, height, focusBox)
    : null

  const excludeEraseMask = excludeBox
    ? buildExcludeEraseMask(rgba, maskData, width, height, excludeBox, mainObjectMask)
    : null

  if (mainObjectMask && excludeEraseMask) {
    applyExcludeEraseMask(mainObjectMask, null, excludeEraseMask)
  }

  // 用 mask 覆盖原图的 alpha 通道
  const composited = Buffer.from(rgba)
  for (let i = 0; i < maskData.length; i++) {
    composited[i * 4 + 3] = mainObjectMask ? (mainObjectMask[i] ? maskData[i] : 0) : maskData[i]
  }

  if (excludeEraseMask) {
    applyExcludeEraseMask(null, composited, excludeEraseMask)
  }

  if (excludeBox) {
    cleanupExcludeRegion(composited, rgba, maskData, mainObjectMask, excludeBox, width, height)
  }

  const base = sharp(composited, { raw: { width, height, channels: 4 } })

  const png =
    bg === 'transparent'
      ? await base.png().toBuffer()
      : await base.flatten({ background: bg }).png().toBuffer()

  return { png, width, height }
}
