import path from 'node:path';

// Plain JavaScript on purpose. For a next.config.ts the production server
// first verifies the TypeScript setup: it loads the compiler and, in an image
// without dev dependencies, runs `npm install typescript` on every start.

// The E2E/load-test Docker image is built with E2E_BUILD=1. It only needs a
// *runnable* server, not a type-clean one — so we skip the strict build-time
// type/lint gate there to avoid being blocked by environment-specific
// (@types/node version) or pre-existing type errors. Normal `npm run build`
// stays fully strict.
const e2eBuild = process.env.E2E_BUILD === '1';

/** @type {import('next').NextConfig} */
const nextConfig = {
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
    // Cedar policy engine (WASM). Server-only, loaded lazily by src/lib/iam via
    // the CJS entry; never bundle the .wasm into a Next chunk.
    '@cedar-policy/cedar-wasm',
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
    // PII v2's local NER layer (services/pii/ner.ts). Same reason as
    // @napi-rs/canvas above: onnxruntime-node ships a platform-specific
    // `.node` binary webpack cannot parse, and @huggingface/transformers
    // dynamically resolves onnxruntime-node/onnxruntime-web/sharp backends
    // in a way webpack's static analysis can't follow either. Node's own
    // `require` handles both fine at runtime; externalizing just skips
    // webpack's bundling attempt.
    'onnxruntime-node',
    '@huggingface/transformers',
    // The `cognipeer_guardrail` guardrail family (services/guardrail/families/
    // cognipeerGuardrail.ts). Same reason as onnxruntime-node above, plus its
    // own: the package locates its bundled model.onnx via
    // `path.join(__dirname, '..', 'model')` at RUNTIME, which only resolves
    // correctly when the package is loaded unbundled — webpack rewrites
    // `__dirname` for anything it bundles.
    '@cognipeer/guardrail',
    // The 'cognipeer' PII engine (services/pii/cognipeerEngine.ts) — same
    // reason as @cognipeer/guardrail directly above.
    '@cognipeer/pii',
    // Azure Blob file provider (providers/contracts/azure): imported lazily on first use, so keep it out of the bundle.
    '@azure/storage-blob',
  ],
  turbopack: {
    root: path.resolve(process.cwd(), '..'),
  },
  // People, groups and API tokens are managed in the IAM center (Principals). The pages
  // they used to live on are gone; old links and bookmarks land on the same place.
  // Temporary (307) for now: browsers cache a permanent redirect for a long time.
  async redirects() {
    return [
      {
        source: '/dashboard/members',
        destination: '/dashboard/iam?tab=principals&principalType=user',
        permanent: false,
      },
      {
        source: '/dashboard/members/:userId',
        destination: '/dashboard/iam?tab=principals&principalType=user&principalId=:userId',
        permanent: false,
      },
      {
        source: '/dashboard/tenant-settings',
        destination: '/dashboard/iam?tab=principals&principalType=user',
        permanent: false,
      },
      {
        source: '/dashboard/tenant-settings/projects',
        destination: '/dashboard/projects',
        permanent: false,
      },
      {
        source: '/dashboard/tenant-settings/projects/:projectId',
        destination: '/dashboard/projects/:projectId',
        permanent: false,
      },
    ];
  },
  experimental: {
    // Next 15 defaults this to true: on start the production server evaluates
    // every module of every page (123 routes here) before the first request,
    // which is most of the boot-time heap. Pages load on their first request
    // instead.
    preloadEntriesOnStart: false,
    serverActions: {
      bodySizeLimit: process.env.NEXT_BODY_SIZE_LIMIT || '10mb',
    },
  },
};

export default nextConfig;
