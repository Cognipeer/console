/**
 * Startup tells the operator which private networks `PROVIDER_PRIVATE_NETWORKS` opened (src/server/bootstrap.ts):
 * one line with the counts, a line for each entry that opens nothing, and the boot carries on whatever the report
 * does. The text of the lines is covered with the policy (provider-private-networks.test.ts); this file is the
 * wiring: the real bootstrap calls the report with a logger, once, before the engine self-test, from the real
 * configuration, and a report that fails does not stop the boot.
 *
 * Everything bootstrap would do after the report is cut off at the engine self-test, the first step after it, which
 * these tests make fail (the process exit that failure schedules is replaced).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const IMPORT_TIMEOUT_MS = 120_000;
const order = vi.hoisted(() => ({ steps: [] as string[] }));

type Line = [level: 'info' | 'warn' | 'error', message: string, meta: unknown];

/** A fresh copy of bootstrap (it keeps a module-level singleton) and of the policy module it reports from. */
async function freshBootstrap() {
  vi.resetModules();
  vi.doMock('@/server/env', () => ({ ensureServerEnvLoaded: () => undefined }));
  vi.doMock('@/lib/iam/selfTest', () => ({
    engineSelfTest: () => {
      order.steps.push('engine');
      return { ok: false, error: 'stopped by the test' };
    },
    engineHealth: () => ({}),
  }));
  const bootstrap = await import('@/server/bootstrap');
  const policy = await import('@/lib/security/providerPrivateNetworks');
  return { bootstrap, policy };
}

/** Replaces the report with one that writes the real report to `lines`, and notes when it ran. */
function recordReport(policy: Awaited<ReturnType<typeof freshBootstrap>>['policy']) {
  const real = policy.logProviderPrivateNetworks;
  const lines: Line[] = [];
  const loggers: unknown[] = [];
  const spy = vi.spyOn(policy, 'logProviderPrivateNetworks').mockImplementation((log) => {
    order.steps.push('report');
    loggers.push(log);
    real({
      info: (message, meta) => lines.push(['info', message, meta]),
      warn: (message, meta) => lines.push(['warn', message, meta]),
      error: (message, meta) => lines.push(['error', message, meta]),
    });
  });
  return { spy, lines, loggers };
}

const KEYS = ['PROVIDER_PRIVATE_NETWORKS', 'PROVIDER_PRIVATE_NETWORKS_DENY'] as const;
const saved: Partial<Record<(typeof KEYS)[number], string | undefined>> = {};
let exit: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  order.steps.length = 0;
  for (const key of KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
  exit.mockRestore();
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.doUnmock('@/lib/iam/selfTest');
  vi.doUnmock('@/server/env');
  vi.resetModules();
});

describe('the boot of the server', () => {
  it('reports the opened networks once, with its own logger, before the engine self-test', async () => {
    process.env.PROVIDER_PRIVATE_NETWORKS = 'org-a=10.50.0.0/16;*=100.64.10.0/24';
    process.env.PROVIDER_PRIVATE_NETWORKS_DENY = '10.50.9.0/24';
    const { bootstrap, policy } = await freshBootstrap();
    const { spy, lines, loggers } = recordReport(policy);

    await expect(bootstrap.bootstrapApplication()).rejects.toThrow(/Authorization engine self-test failed/);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(order.steps).toEqual(['report', 'engine']);
    // a logger, not a bag of values
    const logger = loggers[0] as Record<string, unknown>;
    expect([typeof logger.info, typeof logger.warn, typeof logger.error]).toEqual(['function', 'function', 'function']);
    // the real configuration reached the real report: the counts, and the deny range that lies inside an opened range
    expect(lines).toEqual([
      ['info', 'Provider private networks: 1 organization(s) with ranges of their own, 2 opened range(s) (1 for every organization), 1 deny range(s)',
        { tenants: 1, ranges: 2, wildcardRanges: 1, denyRanges: 1 }],
      ['warn', 'Opened private network ranges contain addresses that are never opened (the overlapping part stays refused)',
        { ranges: [{ range: '10.50.0.0/16', with: ['deny'] }] }],
    ]);
  }, IMPORT_TIMEOUT_MS);

  it('writes the counts line alone when nothing is configured', async () => {
    const { bootstrap, policy } = await freshBootstrap();
    const { lines } = recordReport(policy);
    await expect(bootstrap.bootstrapApplication()).rejects.toThrow(/Authorization engine self-test failed/);
    expect(lines.map(([level, message]) => [level, message])).toEqual([
      ['info', 'Provider private networks: 0 organization(s) with ranges of their own, 0 opened range(s) (0 for every organization), 0 deny range(s)'],
    ]);
  }, IMPORT_TIMEOUT_MS);

  it('adds an error line for an entry that opens nothing', async () => {
    process.env.PROVIDER_PRIVATE_NETWORKS = 'org-a=not-a-range;org-b=10.60.0.0/16';
    const { bootstrap, policy } = await freshBootstrap();
    const { lines } = recordReport(policy);
    await expect(bootstrap.bootstrapApplication()).rejects.toThrow(/Authorization engine self-test failed/);
    expect(lines.map(([level]) => level)).toEqual(['info', 'error']);
    expect(lines[0]![2]).toEqual({ tenants: 1, ranges: 1, wildcardRanges: 0, denyRanges: 0 });
    expect(lines[1]![2]).toEqual({ invalid: [expect.any(String)] });
  }, IMPORT_TIMEOUT_MS);

  it('adds an error line for a deny list that cannot be read: nothing is opened until it is fixed', async () => {
    process.env.PROVIDER_PRIVATE_NETWORKS = 'org-a=10.60.0.0/16';
    process.env.PROVIDER_PRIVATE_NETWORKS_DENY = 'not-a-range';
    const { bootstrap, policy } = await freshBootstrap();
    const { lines } = recordReport(policy);
    await expect(bootstrap.bootstrapApplication()).rejects.toThrow(/Authorization engine self-test failed/);
    expect(lines.map(([level]) => level)).toEqual(['info', 'error']);
    expect(lines[1]![1]).toContain('PROVIDER_PRIVATE_NETWORKS_DENY');
  }, IMPORT_TIMEOUT_MS);

  it('carries on when the report itself fails', async () => {
    const { bootstrap, policy } = await freshBootstrap();
    vi.spyOn(policy, 'logProviderPrivateNetworks').mockImplementation(() => {
      order.steps.push('report');
      throw new Error('the report could not be built');
    });

    // the next step ran: the engine self-test stopped the boot, not the report
    await expect(bootstrap.bootstrapApplication()).rejects.toThrow(/Authorization engine self-test failed: stopped by the test/);
    expect(order.steps).toEqual(['report', 'engine']);
  }, IMPORT_TIMEOUT_MS);
});
