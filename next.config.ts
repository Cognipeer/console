import type { NextConfig } from 'next';
import path from 'node:path';

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
    // BullMQ's ESM build re-exports `classes/child-processor.js`, which has
    // a dynamic `require(expression)` used only by its "sandboxed processor"
    // feature (running a job handler from a separate file in a child
    // process). We always pass an in-process function to `new Worker(...)`
    // (see bullmqQueueProvider.ts), so that code path never actually runs —
    // but webpack still can't statically analyze the expression and warns
    // "Critical dependency: the request of a dependency is an expression"
    // on every build. Marking it external skips webpack's bundling/analysis
    // entirely (Node's native `require` handles the dynamic path fine).
    'bullmq',
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
    // Server-only LDAP client (enterprise LDAP integration). Node-only deps;
    // keep it out of the Next.js bundle so `next build` doesn't try to resolve
    // it (it is imported only by the enterprise overlay's auth plugin).
    'ldapts',
    // @cognipeer/to-markdown → pdf-to-img → @napi-rs/canvas ships a
    // platform-specific `.node` native binary that webpack cannot parse
    // ("Unexpected character '�'"). Externalize ONLY the native package —
    // Node's own `require` loads it fine at runtime. Do NOT externalize
    // @cognipeer/to-markdown itself: its ESM build does
    // `import { fromBuffer } from 'file-type'` (CJS v16), whose named
    // export Node's cjs-module-lexer can't detect, so loading it unbundled
    // crashes the server at startup; webpack handles that interop.
    '@napi-rs/canvas',
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
