/**
 * One bootstrap per process. Under the custom server (src/server/index.ts) Next's
 * instrumentation hook runs in Next's own bundle, which holds a second copy of
 * src/server/bootstrap.ts with its own module-level singleton. If the hook booted
 * that copy, the process ran every scheduler and queue consumer twice, on a second
 * set of database pools, cache and queue.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const { bootstrapApplication } = vi.hoisted(() => ({ bootstrapApplication: vi.fn(async () => undefined) }));
vi.mock('@/server/bootstrap', () => ({ bootstrapApplication }));

import { register } from '@/instrumentation';
import { isBootstrapStarted, markBootstrapStarted } from '@/server/bootstrapMarker';

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[Symbol.for('cognipeer.console.bootstrap-started')];
  bootstrapApplication.mockClear();
  vi.unstubAllEnvs();
});

describe('Next instrumentation hook', () => {
  it('leaves the process alone when the custom server already started the bootstrap', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    markBootstrapStarted();

    await register();

    expect(bootstrapApplication).not.toHaveBeenCalled();
  });

  it('bootstraps the process when nothing else did (a bare `next start`)', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');

    await register();

    expect(bootstrapApplication).toHaveBeenCalledTimes(1);
  });

  it('does nothing on the edge runtime', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'edge');

    await register();

    expect(bootstrapApplication).not.toHaveBeenCalled();
  });
});

describe('bootstrap marker', () => {
  it('is one flag for the whole process, whichever copy of the module set it', async () => {
    expect(isBootstrapStarted()).toBe(false);
    markBootstrapStarted();

    // a second, independent instance of the module, like the one Next bundles
    vi.resetModules();
    const other = await import('@/server/bootstrapMarker');

    expect(other.isBootstrapStarted()).toBe(true);
  });
});
