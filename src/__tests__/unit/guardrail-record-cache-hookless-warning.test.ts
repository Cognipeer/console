/**
 * A stored guardrail without a usable `hooks` config enforces nothing
 * (`readHooks` resolves it to an empty config). The record cache logs a warning
 * when it loads such a record that is enabled, once per load, so the gap shows
 * up in the logs instead of passing silently.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  findGuardrailByKey: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(async () => ({})),
  runWithTenantScope: vi.fn(async (_tenant: string, fn: (db: unknown) => unknown) => fn({
    findGuardrailByKey: hoisted.findGuardrailByKey,
  })),
}));

vi.mock('@/lib/core/cache', () => ({
  getCache: vi.fn(async () => ({
    get: vi.fn(async () => undefined),
    set: vi.fn(async () => undefined),
  })),
}));

vi.mock('@/lib/core/logger', () => ({
  createLogger: () => ({ warn: hoisted.warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { getCachedGuardrail, resetRecordCaches } from '@/lib/services/guardrail/hooks/recordCache';
import { hasUsableHooks, readHooks } from '@/lib/services/guardrail/hooks/contract';

const HOOKS = { contractVersion: 2, policies: [], bindings: {} };

describe('guardrail record cache: enabled records without hooks', () => {
  beforeEach(() => {
    resetRecordCaches();
    hoisted.findGuardrailByKey.mockReset();
    hoisted.warn.mockReset();
  });

  it('warns once per load for an enabled record without hooks', async () => {
    hoisted.findGuardrailByKey.mockResolvedValue({ key: 'g1', enabled: true });

    const record = await getCachedGuardrail('tenant_a', 'g1', 'p1');
    await getCachedGuardrail('tenant_a', 'g1', 'p1');

    expect(record).toMatchObject({ key: 'g1' });
    expect(hoisted.findGuardrailByKey).toHaveBeenCalledTimes(1);
    expect(hoisted.warn).toHaveBeenCalledTimes(1);
    expect(hoisted.warn).toHaveBeenCalledWith(
      'Enabled guardrail has no usable hooks and enforces nothing',
      { key: 'g1', projectId: 'p1' },
    );
  });

  it('stays quiet for a disabled record, a record with hooks, and a miss', async () => {
    hoisted.findGuardrailByKey.mockResolvedValueOnce({ key: 'off', enabled: false });
    await getCachedGuardrail('tenant_a', 'off', null);

    hoisted.findGuardrailByKey.mockResolvedValueOnce({ key: 'ok', enabled: true, hooks: HOOKS });
    await getCachedGuardrail('tenant_a', 'ok', null);

    hoisted.findGuardrailByKey.mockResolvedValueOnce(null);
    await getCachedGuardrail('tenant_a', 'missing', null);

    expect(hoisted.warn).not.toHaveBeenCalled();
  });

  it('hasUsableHooks agrees with readHooks', () => {
    expect(hasUsableHooks({ hooks: HOOKS as never })).toBe(true);
    expect(hasUsableHooks({})).toBe(false);
    expect(hasUsableHooks({ hooks: null })).toBe(false);
    expect(hasUsableHooks({ hooks: { contractVersion: 2 } as never })).toBe(false);
    expect(readHooks({}).policies).toEqual([]);
  });
});
