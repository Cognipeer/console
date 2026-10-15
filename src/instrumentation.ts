/**
 * Next.js instrumentation hook — delegates to the shared Node bootstrap.
 */
import { isBootstrapStarted } from '@/server/bootstrapMarker';

export async function register() {
  // Keep the bootstrap import inside this block: Next also compiles this file
  // for the edge runtime and drops the import there only under this check.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // The custom server (src/server/index.ts) starts the bootstrap before Next
    // prepares. This hook runs in Next's own bundle, with its own copy of every
    // module, so calling bootstrapApplication() here would boot the process a
    // second time. Only a bare `next start`, with no custom server, boots here.
    if (isBootstrapStarted()) return;
    const { bootstrapApplication } = await import('@/server/bootstrap');
    await bootstrapApplication();
  }
}
