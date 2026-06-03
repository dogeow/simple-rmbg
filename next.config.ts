import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // sharp 与 @huggingface/transformers 含原生/二进制依赖，标记为服务端外部包，
  // 避免被打包进 bundle 导致运行异常。
  serverExternalPackages: ['sharp', '@huggingface/transformers'],
}

export default nextConfig
