/**
 * A save that races a cold read must WIN.
 *
 * Every read cache in the hook plane loads asynchronously. The race: the TTL
 * expires, request A starts loading guardrail G; an operator saves G (say,
 * softens `block` -> `flag`) and the save path calls the matching
 * `invalidate*`; A's read — issued BEFORE the write — then resolves with the
 * old row and writes it back into the cache for another TTL. Every request in
 * that window enforces the retracted policy while the UI shows the new one.
 *
 * The fix is the same in all three caches: the in-flight registration is the
 * load's write permit, invalidation revokes it, and a load whose permit is
 * gone returns its answer to its own caller but does not cache it. Deferred
 * promises, not timers: the interleaving each test pins is exact.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IGuardrail, IPiiPolicy } from '@/lib/database/provider.interface';

const hoisted = vi.hoisted(() => ({
  findGuardrailByKey: vi.fn(),
  findPiiPolicyByKey: vi.fn(),
  createPiiPolicy: vi.fn(),
  findMcpServerByKey: vi.fn(),
  findTenantById: vi.fn(),
  runHook: vi.fn(),
}));

const fakeDb = {
  findGuardrailByKey: hoisted.findGuardrailByKey,
  findPiiPolicyByKey: hoisted.findPiiPolicyByKey,
  createPiiPolicy: hoisted.createPiiPolicy,
  findMcpServerByKey: hoisted.findMcpServerByKey,
  findTenantById: hoisted.findTenantById,
};

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(async () => fakeDb),
  getTenantDatabase: vi.fn(async () => fakeDb),
  runWithTenantScope: vi.fn(
    async (_tenantDbName: string, fn: (db: typeof fakeDb) => unknown) => fn(fakeDb),
  ),
}));

/** The MCP bridge's only concern here is WHICH key it hands the engine. */
vi.mock('@/lib/services/guardrail/hooks/engine', () => ({
  runHook: hoisted.runHook,
  ensureDefaultToolGuardrail: vi.fn(async () => ({ key: 'tool-safety-default' })),
  DEFAULT_TOOL_GUARDRAIL_KEY: 'tool-safety-default',
}));

vi.mock('@/enterprise/registry', () => ({ mcpGuardrailHook: { current: null } }));

import type { McpGuardrailContext } from '@/enterprise/registry';
import { allowVerdict } from '@/lib/services/guardrail/hooks/contract';
import type { HookCall } from '@/lib/services/guardrail/hooks/contract';
import {
  ensureLiftedPiiPolicy,
  invalidateLiftedPiiPolicyCache,
} from '@/lib/services/guardrail/hooks/legacy';
import {
  consoleMcpGuardrailHook,
  invalidateMcpGuardrailBinding,
} from '@/lib/services/guardrail/hooks/mcpHook';
import {
  getCachedGuardrail,
  invalidateGuardrailCache,
  resetRecordCaches,
} from '@/lib/services/guardrail/hooks/recordCache';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** A promise a test resolves by hand, so resolution ORDER is scripted. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Let a load get as far as its awaited DB read. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 50; turn += 1) await Promise.resolve();
}

function guardrailRow(name: string): IGuardrail {
  return {
    _id: `gr-${name}`,
    tenantId: 'tenant-a',
    projectId: 'proj-a',
    key: 'g',
    name,
    type: 'preset',
    target: 'input',
    action: 'block',
    enabled: true,
    createdBy: 'user-1',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetRecordCaches();
  invalidateMcpGuardrailBinding();
  invalidateLiftedPiiPolicyCache();
});

afterEach(() => {
  resetRecordCaches();
  invalidateMcpGuardrailBinding();
  invalidateLiftedPiiPolicyCache();
});

// ═══════════════════════════════════════════════════════════════════════════

describe('RecordCache (getCachedGuardrail)', () => {
  it('does not let a load that started before an invalidation repopulate the cache', async () => {
    const stale = guardrailRow('stale');
    const fresh = guardrailRow('fresh');

    const load = deferred<IGuardrail | null>();
    hoisted.findGuardrailByKey.mockReturnValueOnce(load.promise);

    const first = getCachedGuardrail('t_db', 'g', 'proj-a');
    await settle();

    // The save lands while the read is parked on the database.
    invalidateGuardrailCache('t_db', 'g');
    load.resolve(stale);

    // The in-flight caller still gets the answer it asked for...
    expect(await first).toBe(stale);

    // ...but the NEXT reader must go to the database, not to a cache the
    // stale read repopulated behind the save.
    hoisted.findGuardrailByKey.mockResolvedValueOnce(fresh);
    expect(await getCachedGuardrail('t_db', 'g', 'proj-a')).toBe(fresh);
    expect(hoisted.findGuardrailByKey).toHaveBeenCalledTimes(2);
  });

  it('control: without an invalidation the loaded row IS cached', async () => {
    const row = guardrailRow('cached');
    hoisted.findGuardrailByKey.mockResolvedValueOnce(row);

    expect(await getCachedGuardrail('t_db', 'g', 'proj-a')).toBe(row);
    expect(await getCachedGuardrail('t_db', 'g', 'proj-a')).toBe(row);
    expect(hoisted.findGuardrailByKey).toHaveBeenCalledTimes(1);
  });

  it('an older load settling late does not evict the newer load that replaced it', async () => {
    const stale = guardrailRow('stale');
    const fresh = guardrailRow('fresh');

    const older = deferred<IGuardrail | null>();
    const newer = deferred<IGuardrail | null>();
    hoisted.findGuardrailByKey.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);

    const first = getCachedGuardrail('t_db', 'g', 'proj-a');
    await settle();
    invalidateGuardrailCache('t_db', 'g');
    const second = getCachedGuardrail('t_db', 'g', 'proj-a');
    await settle();

    // The OLDER read settles after the newer one started. Its `finally` must
    // not delete the newer in-flight entry, or the newer value would never be
    // cached either.
    older.resolve(stale);
    await settle();
    newer.resolve(fresh);

    expect(await first).toBe(stale);
    expect(await second).toBe(fresh);

    // Served from cache: the fresh row, with no third database read.
    expect(await getCachedGuardrail('t_db', 'g', 'proj-a')).toBe(fresh);
    expect(hoisted.findGuardrailByKey).toHaveBeenCalledTimes(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════

describe('MCP server binding cache (mcpHook)', () => {
  const ctx: McpGuardrailContext = {
    tenantId: 'tenant-a',
    projectId: 'proj-a',
    serverKey: 'srv',
    toolName: 'do_thing',
    mode: 'enforce',
  };

  interface ServerRow {
    key: string;
    projectId?: string;
    guardrail?: { guardrailKey?: string };
  }

  const server = (guardrailKey: string, projectId: string | undefined = 'proj-a'): ServerRow => ({
    key: 'srv',
    projectId,
    guardrail: { guardrailKey },
  });

  const lastKeys = (): string[] | undefined => {
    const calls = hoisted.runHook.mock.calls as Array<[HookCall]>;
    return calls[calls.length - 1]?.[0]?.guardrailKeys;
  };

  beforeEach(() => {
    hoisted.findTenantById.mockResolvedValue({ _id: 'tenant-a', dbName: 't_db' });
    hoisted.runHook.mockImplementation(async (call: HookCall) =>
      allowVerdict({
        hook: call.hook,
        traceId: 'trace',
        latencyMs: 0,
        guardrailKeys: call.guardrailKeys,
        guardrailKey: call.guardrailKeys[0],
      }),
    );
  });

  it('does not let a binding read that started before a rebind repopulate the cache', async () => {
    const load = deferred<ServerRow | null>();
    hoisted.findMcpServerByKey.mockReturnValueOnce(load.promise);

    const first = consoleMcpGuardrailHook.beforeToolCall(ctx, { q: 1 });
    await settle();

    // The operator rebinds the server while the read is in flight.
    invalidateMcpGuardrailBinding('t_db', 'srv');
    load.resolve(server('old-guard'));
    await first;
    expect(lastKeys()).toEqual(['old-guard']);

    // The next call must read the binding again and see the new key.
    hoisted.findMcpServerByKey.mockResolvedValueOnce(server('new-guard'));
    await consoleMcpGuardrailHook.beforeToolCall(ctx, { q: 1 });
    expect(lastKeys()).toEqual(['new-guard']);
    expect(hoisted.findMcpServerByKey).toHaveBeenCalledTimes(2);
  });

  it("control: a cached binding is reused, and the fallback asks for the tenant-wide row (`null`), never any project's", async () => {
    // Project-scoped miss, then the fallback. It must be the `null` spelling
    // (`projectId IS NULL`) — an unscoped lookup could answer with project B's
    // same-key server and evaluate A's calls against B's binding. With no
    // tenant-wide row the call falls back to the tenant default.
    hoisted.findMcpServerByKey
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    await consoleMcpGuardrailHook.beforeToolCall(ctx, {});
    expect(lastKeys()).toEqual(['tool-safety-default']);
    expect(hoisted.findMcpServerByKey).toHaveBeenNthCalledWith(1, 'srv', 'proj-a');
    expect(hoisted.findMcpServerByKey).toHaveBeenNthCalledWith(2, 'srv', null);

    // The (negative) binding is cached: no further reads for the second call.
    await consoleMcpGuardrailHook.beforeToolCall(ctx, {});
    expect(hoisted.findMcpServerByKey).toHaveBeenCalledTimes(2);
  });

  it('a tenant-wide server (no project) is found through the `null` fallback', async () => {
    invalidateMcpGuardrailBinding('t_db', 'srv');
    hoisted.findMcpServerByKey
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(server('wide-guard', undefined));

    await consoleMcpGuardrailHook.beforeToolCall(ctx, {});
    expect(lastKeys()).toEqual(['wide-guard']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════

describe('lifted PII policy memo (legacy.ensureLiftedPiiPolicy)', () => {
  const record: IGuardrail = {
    ...guardrailRow('legacy'),
    key: 'legacy-pii',
    policy: { pii: { enabled: true, action: 'redact', categories: { email: true } } },
  };
  const liftedKey = 'pii-migrated-legacy-pii';
  const policyRow = { key: liftedKey } as IPiiPolicy;

  it('does not let a provisioning run that started before an invalidation repopulate the memo', async () => {
    const load = deferred<IPiiPolicy | null>();
    hoisted.findPiiPolicyByKey.mockReturnValueOnce(load.promise);

    const first = ensureLiftedPiiPolicy('t_db', 'tenant-a', record);
    await settle();

    invalidateLiftedPiiPolicyCache('t_db', 'legacy-pii');
    load.resolve(policyRow);
    expect(await first).toBe(liftedKey);

    // A memo hit would return before touching the database at all; the
    // provisioning path being reached (project miss, tenant-wide miss, create)
    // is the proof that the stale run did not write itself back.
    hoisted.findPiiPolicyByKey.mockResolvedValue(null);
    hoisted.createPiiPolicy.mockResolvedValue(policyRow);
    expect(await ensureLiftedPiiPolicy('t_db', 'tenant-a', record)).toBe(liftedKey);
    expect(hoisted.createPiiPolicy).toHaveBeenCalledTimes(1);
    // The fallback asks for the TENANT-WIDE policy by name.
    expect(hoisted.findPiiPolicyByKey).toHaveBeenLastCalledWith(liftedKey, null);

    // Control: the second run's answer IS memoised.
    expect(await ensureLiftedPiiPolicy('t_db', 'tenant-a', record)).toBe(liftedKey);
    expect(hoisted.createPiiPolicy).toHaveBeenCalledTimes(1);
    expect(hoisted.findPiiPolicyByKey).toHaveBeenCalledTimes(3);
  });
});
