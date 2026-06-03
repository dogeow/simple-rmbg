export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause
    if (cause instanceof Error && cause.message) {
      return `${err.message}; cause: ${cause.message}`
    }
    return err.message
  }
  return String(err)
}

export function isRetryableNetworkError(err: unknown): boolean {
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
