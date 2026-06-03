import path from 'path'
import fs from 'fs'
import {
  env,
  AutoModelForImageSegmentation,
  AutoProcessor,
  type PreTrainedModel,
} from '@huggingface/transformers'
import { ProxyAgent, setGlobalDispatcher } from 'undici'
import { getErrorMessage, isRetryableNetworkError, sleep } from './utils'

// 模型与处理器在本进程内缓存为单例，避免每次请求重复加载（约几十 MB）。
env.cacheDir = path.join(process.cwd(), '.cache')

function normalizeRemoteHost(value: string): string {
  return value.endsWith('/') ? value : `${value}/`
}

export const remoteHosts = Array.from(
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
  setGlobalDispatcher(new ProxyAgent(proxyUrl))
}

const MODEL_LOCAL_ONLY = ['1', 'true', 'yes', 'on'].includes(
  (process.env.MODEL_LOCAL_ONLY ?? '').toLowerCase()
)

type Processor = Awaited<ReturnType<typeof AutoProcessor.from_pretrained>>

type ModelSpec = {
  id: string
  localPath: string
  displayName: string
  modelType: 'birefnet'
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

const MODEL_SPEC: ModelSpec = {
  id: 'briaai/RMBG-2.0',
  displayName: 'RMBG-2.0',
  localPath: path.resolve(
    process.env.MODEL_2_0_LOCAL_PATH ??
      process.env.MODEL_LOCAL_PATH ??
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
}

let modelPromise: Promise<{ model: PreTrainedModel; processor: Processor; spec: ModelSpec }> | null =
  null

async function loadModelFrom(source: string, localFilesOnly: boolean, spec: ModelSpec) {
  const modelOptions = {
    config: { model_type: spec.modelType } as never,
    local_files_only: localFilesOnly,
  }
  const model = await AutoModelForImageSegmentation.from_pretrained(source, modelOptions)
  const processor = await AutoProcessor.from_pretrained(source, {
    config: spec.processorConfig as never,
    local_files_only: localFilesOnly,
  })
  return { model, processor, spec }
}

async function loadModelWithRetry(maxAttempts = 4) {
  const spec = MODEL_SPEC
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
        await sleep(2 ** attempt * 1000)
      }
    }
  }
  throw lastError
}

/** 触发模型加载（用于健康检查 / 预热）。 */
export function getModel() {
  if (!modelPromise) {
    const spec = MODEL_SPEC
    modelPromise = loadModelWithRetry().catch((err) => {
      modelPromise = null
      throw new Error(
        `${spec.displayName} 模型加载失败: ${getErrorMessage(err)}。可将模型放到 ${spec.localPath} 并设置 MODEL_LOCAL_ONLY=true`
      )
    })
  }
  return modelPromise
}

export function getModelRuntimeInfo() {
  const spec = MODEL_SPEC
  return {
    modelId: spec.id,
    localPath: spec.localPath,
    localPathExists: fs.existsSync(spec.localPath),
    localOnly: MODEL_LOCAL_ONLY,
    remoteHosts,
    currentRemoteHost: env.remoteHost,
  }
}
