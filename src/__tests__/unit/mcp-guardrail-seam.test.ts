import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IMcpServer } from '@/lib/database';

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('@/lib/core/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/core/logger')>();
  return {
    ...actual,
    createLogger: (name: string) => {
      const real = actual.createLogger(name);
      return name === 'mcp-service' ? { ...real, warn } : real;
    },
  };
});

import { mcpGuardrailHook } from '@/enterprise/registry';
import { consoleMcpGuardrailHook, ensureMcpGuardrailHook } from '@/lib/services/guardrail/hooks/mcpHook';
import { projectMcpGuardrailBinding, resolveMcpGuardrailBinding } from '@/lib/services/mcp/mcpService';

/**
 * Captured at THIS module's load, after the whole graph above has been
 * imported and before any test body runs. It is the regression guard for the
 * enterprise boot crash: importing `mcpService` must not touch the seam,
 * because in the overlay build that import happens while `registry.ts` is
 * still in its own (hoisted) import phase, so the ref does not exist yet and
 * a module-scope read dies with
 *   TypeError: Cannot read properties of undefined (reading 'current')
 * Reading it here rather than inside the test keeps the assertion honest no
 * matter what order the cases run in.
 */
const seamAtModuleLoad = mcpGuardrailHook.current;

function server(patch: Partial<IMcpServer>): IMcpServer {
  return {
    tenantId: 'tenant-1',
    key: 'acme-api',
    name: 'Acme API',
    tools: [],
    upstreamAuth: { type: 'none' },
    status: 'active',
    endpointSlug: 'slug',
    createdBy: 'user-1',
    ...patch,
  } as IMcpServer;
}

describe('mcp guardrail seam', () => {
  beforeEach(() => warn.mockClear());

  it('is left untouched by module load and filled by the community bridge on first use', () => {
    expect(seamAtModuleLoad).toBeNull();
    expect(ensureMcpGuardrailHook()).toBe(consoleMcpGuardrailHook);
    expect(mcpGuardrailHook.current).toBe(consoleMcpGuardrailHook);
  });

  it('hands back whatever already claimed the seam, so an overlay still wins', () => {
    const overlayHook = {
      beforeToolCall: async () => ({ allowed: true }),
      afterToolCall: async () => ({ allowed: true }),
    };
    const claimed = mcpGuardrailHook.current;
    mcpGuardrailHook.current = overlayHook;
    try {
      expect(ensureMcpGuardrailHook()).toBe(overlayHook);
    } finally {
      mcpGuardrailHook.current = claimed;
    }
  });

  it('leaves a server with no binding at all unguarded', () => {
    expect(resolveMcpGuardrailBinding(server({ key: 'a' }))).toEqual({
      mode: 'off',
      guardrailKey: undefined,
    });
  });

  it('lifts a legacy aegis mode without a shieldId', () => {
    expect(resolveMcpGuardrailBinding(server({ key: 'b', aegis: { mode: 'monitor' } }))).toEqual({
      mode: 'monitor',
      guardrailKey: undefined,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("folds a legacy 'off' onto 'off' rather than arming it", () => {
    expect(resolveMcpGuardrailBinding(server({ key: 'c', aegis: { mode: 'off' } })).mode).toBe('off');
  });

  it('prefers the guardrail field over the legacy one', () => {
    const b = resolveMcpGuardrailBinding(server({
      key: 'd',
      aegis: { mode: 'enforce', shieldId: 'shield_dead' },
      guardrail: { mode: 'monitor', guardrailKey: 'tool-policy' },
    }));
    expect(b).toEqual({ mode: 'monitor', guardrailKey: 'tool-policy' });
    // The new field answers the question, so nothing is being dropped.
    expect(warn).not.toHaveBeenCalled();
  });

  it('drops a stale shieldId and warns exactly once per server', () => {
    const stale = server({ key: 'e', name: 'Stale', aegis: { mode: 'enforce', shieldId: 'shield_123' } });
    expect(resolveMcpGuardrailBinding(stale)).toEqual({ mode: 'enforce', guardrailKey: undefined });
    resolveMcpGuardrailBinding(stale);
    resolveMcpGuardrailBinding(stale);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toMatchObject({
      serverKey: 'e',
      serverName: 'Stale',
      staleShieldId: 'shield_123',
      mode: 'enforce',
    });
  });

  it('does not warn about a stale shieldId on a server that is switched off', () => {
    resolveMcpGuardrailBinding(server({ key: 'f', aegis: { mode: 'off', shieldId: 'shield_999' } }));
    expect(warn).not.toHaveBeenCalled();
  });

  /**
   * The Mongo/Cosmos row shape. The driver runs without `ignoreUndefined`, so
   * a create that spelled `aegis: undefined, guardrail: undefined` persisted
   * BOTH columns as BSON `null` — and `null !== undefined` armed every such
   * server in 'enforce' (`toGuardrailMode(undefined, true)`). SQLite maps its
   * NULL to `undefined`, which is why the "no binding at all" case above never
   * caught it.
   */
  it("reads BSON-null columns (Mongo's spelling of absent) as no binding, not as 'enforce'", () => {
    const row = server({ key: 'g', aegis: null as never, guardrail: null as never });
    expect(resolveMcpGuardrailBinding(row)).toEqual({ mode: 'off', guardrailKey: undefined });
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not let a null guardrail column shadow a legacy aegis binding', () => {
    const row = server({ key: 'h', guardrail: null as never, aegis: { mode: 'monitor' } });
    expect(resolveMcpGuardrailBinding(row)).toEqual({ mode: 'monitor', guardrailKey: undefined });
  });
});

/**
 * The write-side mirror of the resolver: for one release both columns are
 * written, each derived from the other when only one is sent, and a key the
 * caller did not send is OMITTED rather than written as `undefined` — the
 * shape the resolver above has to defend against on Mongo.
 */
describe('projectMcpGuardrailBinding', () => {
  it('writes NOTHING for a body that names neither column (no BSON null on Mongo)', () => {
    expect(Object.keys(projectMcpGuardrailBinding({}))).toEqual([]);
    expect(Object.keys(projectMcpGuardrailBinding({ aegis: undefined, guardrail: undefined }))).toEqual([]);
  });

  it('projects a guardrail-only write onto the legacy aegis column (mode only), so a rollback keeps enforcing', () => {
    const out = projectMcpGuardrailBinding({ guardrail: { mode: 'enforce', guardrailKey: 'tool-policy' } });
    expect(out).toEqual({
      guardrail: { mode: 'enforce', guardrailKey: 'tool-policy' },
      aegis: { mode: 'enforce' },
    });
    // Never a shieldId: those are dead references, and one would re-arm the warning.
    expect(out.aegis).not.toHaveProperty('shieldId');
  });

  it('translates a legacy aegis-only write (pre-2.0 SDK) onto guardrail, so it is not outranked by a stored one', () => {
    expect(projectMcpGuardrailBinding({ aegis: { mode: 'monitor' } })).toEqual({
      aegis: { mode: 'monitor' },
      guardrail: { mode: 'monitor' },
    });
  });

  it('keeps the stored guardrailKey when a legacy client only changes the mode', () => {
    const out = projectMcpGuardrailBinding(
      { aegis: { mode: 'enforce' } },
      { guardrail: { mode: 'off', guardrailKey: 'tool-policy' } },
    );
    expect(out.guardrail).toEqual({ mode: 'enforce', guardrailKey: 'tool-policy' });
    expect(out.aegis).toEqual({ mode: 'enforce' });
  });

  it('tolerates a BSON-null stored guardrail column when translating a legacy write', () => {
    const out = projectMcpGuardrailBinding({ aegis: { mode: 'monitor' } }, { guardrail: null as never });
    expect(out.guardrail).toEqual({ mode: 'monitor' });
  });

  it('writes both as sent when both are sent (guardrail still wins at read time)', () => {
    const out = projectMcpGuardrailBinding({
      aegis: { mode: 'enforce' },
      guardrail: { mode: 'monitor', guardrailKey: 'tool-policy' },
    });
    expect(out).toEqual({ aegis: { mode: 'enforce' }, guardrail: { mode: 'monitor', guardrailKey: 'tool-policy' } });
    expect(resolveMcpGuardrailBinding(server({ key: 'i', ...out })).mode).toBe('monitor');
  });

  it('round-trips through the resolver in both directions without a stale-shield warning', () => {
    warn.mockClear();
    const fromLegacy = projectMcpGuardrailBinding({ aegis: { mode: 'enforce' } });
    expect(resolveMcpGuardrailBinding(server({ key: 'j', ...fromLegacy }))).toEqual({
      mode: 'enforce',
      guardrailKey: undefined,
    });
    const fromGuardrail = projectMcpGuardrailBinding({ guardrail: { mode: 'monitor', guardrailKey: 'k' } });
    // What the OLDER binary reads after a rollback: the legacy column alone.
    expect(resolveMcpGuardrailBinding(server({ key: 'k', aegis: fromGuardrail.aegis })).mode).toBe('monitor');
    expect(warn).not.toHaveBeenCalled();
  });
});
