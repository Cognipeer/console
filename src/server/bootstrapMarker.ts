/**
 * Process-wide record that a bootstrap has started.
 *
 * `bootstrap.ts` keeps its run in a module-level promise, which exists once per
 * module INSTANCE. Under the custom server (src/server/index.ts) the process holds
 * two instances: the one the server imports, and the copy Next bundles for its
 * instrumentation hook (src/instrumentation.ts). The hook checks this marker so it
 * does not start a second bootstrap: a second set of database pools, cache and
 * queue, and every scheduler and queue consumer running twice. The key lives on
 * globalThis because the two copies share nothing else.
 *
 * Deliberately import-free, so the hook can read it without loading the
 * bootstrap module and everything it imports.
 */
const BOOTSTRAP_STARTED = Symbol.for('cognipeer.console.bootstrap-started');

type MarkerHost = typeof globalThis & { [BOOTSTRAP_STARTED]?: true };

export function markBootstrapStarted(): void {
  (globalThis as MarkerHost)[BOOTSTRAP_STARTED] = true;
}

export function isBootstrapStarted(): boolean {
  return (globalThis as MarkerHost)[BOOTSTRAP_STARTED] === true;
}
