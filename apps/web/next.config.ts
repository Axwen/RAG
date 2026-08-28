import type { NextConfig } from 'next'

/**
 * Web 前端配置。
 *
 * T0 只保证可构建、可启动、有健康入口。产品路由与设计评审在 T16a/T16b。
 * `API_BASE_URL` 是服务端可见变量，不放入客户端包；浏览器一律走同源 API 代理。
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: 'standalone',
  // Next 16's CLI typecheck path cannot parse the TypeScript 5.9 config in
  // this workspace; use the compiler API while the root typecheck remains
  // the authoritative full-project check.
  experimental: {
    useTypeScriptCli: false,
  },
}

export default nextConfig
