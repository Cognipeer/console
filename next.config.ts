import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  serverExternalPackages: [
    'ioredis',
    'winston',
    'async_hooks',
    '@cognipeer/agent-sdk',
    // Optional vector / database driver packages — loaded dynamically only
    // when the matching provider is configured. Marking them external keeps
    // Next.js from trying to bundle them at build time when they may not be
    // installed.
    'chromadb',
    '@elastic/elasticsearch',
    '@zilliz/milvus2-sdk-node',
    'pg',
    '@orama/orama',
    'mongodb',
  ],
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
