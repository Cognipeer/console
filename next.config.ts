import type { NextConfig } from "next";
import path from "node:path";

// The E2E/load-test Docker image is built with E2E_BUILD=1. It only needs a
// *runnable* server, not a type-clean one — so we skip the strict build-time
// type/lint gate there to avoid being blocked by environment-specific
// (@types/node version) or pre-existing type errors. Normal `npm run build`
// stays fully strict.
const e2eBuild = process.env.E2E_BUILD === '1';

const nextConfig: NextConfig = {
  typescript: { ignoreBuildErrors: e2eBuild },
  eslint: { ignoreDuringBuilds: e2eBuild },
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
