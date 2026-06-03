type OutputTensor = {
  mul: (value: number) => { to: (dtype: string) => unknown }
}

function asTensor(candidate: unknown): OutputTensor | null {
  if (!candidate || typeof candidate !== 'object') return null
  const indexed = (candidate as Record<number, unknown>)[0]
  if (indexed && typeof indexed === 'object' && 'mul' in indexed) {
    return indexed as OutputTensor
  }
  if ('mul' in candidate) {
    return candidate as OutputTensor
  }
  return null
}

export function getPrimaryOutputTensor(modelOutput: unknown, outputNames?: string[]): OutputTensor {
  const candidates: unknown[] = []

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
