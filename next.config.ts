import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  serverExternalPackages: ['ioredis', 'winston', 'async_hooks', '@cognipeer/agent-sdk'],
  turbopack: {
    root: path.resolve(process.cwd(), '..'),
  },
  experimental: {
    serverActions: {
      bodySizeLimit: (process.env.NEXT_BODY_SIZE_LIMIT || '10mb') as `${number}mb`,
    },
  },
};

export default nextConfig;
