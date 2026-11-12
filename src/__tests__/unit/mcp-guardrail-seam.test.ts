import { describe, expect, it } from 'vitest';

import type { IMcpServer } from '@/lib/database';

import { mcpGuardrailHook } from '@/enterprise/registry';
import { consoleMcpGuardrailHook, ensureMcpGuardrailHook } from '@/lib/services/guardrail/hooks/mcpHook';
import { resolveMcpGuardrailBinding } from '@/lib/services/mcp/mcpService';

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

  it('reads the mode and the guardrail key of the binding', () => {
    expect(resolveMcpGuardrailBinding(server({
      key: 'b',
      guardrail: { mode: 'monitor', guardrailKey: 'tool-policy' },
    }))).toEqual({ mode: 'monitor', guardrailKey: 'tool-policy' });
  });

  it('leaves the key absent for a binding that names none, so the tenant default applies', () => {
    expect(resolveMcpGuardrailBinding(server({ key: 'c', guardrail: { mode: 'enforce' } }))).toEqual({
      mode: 'enforce',
      guardrailKey: undefined,
    });
  });

  it("keeps an 'off' binding off rather than arming it", () => {
    expect(resolveMcpGuardrailBinding(server({ key: 'd', guardrail: { mode: 'off' } })).mode).toBe('off');
  });

  it('does not read any column but `guardrail`', () => {
    const row = server({ key: 'e', aegis: { mode: 'enforce', shieldId: 'shield_1' } } as Partial<IMcpServer>);
    expect(resolveMcpGuardrailBinding(row)).toEqual({ mode: 'off', guardrailKey: undefined });
  });

  /**
   * The Mongo/Cosmos row shape. The driver runs without `ignoreUndefined`, so
   * a create that spelled `guardrail: undefined` persisted the column as BSON
   * `null` — and `null !== undefined` armed every such server in 'enforce'
   * (`toGuardrailMode(undefined, true)`). SQLite maps its NULL to `undefined`,
   * which is why the "no binding at all" case above never caught it.
   */
  it("reads a BSON-null column (Mongo's spelling of absent) as no binding, not as 'enforce'", () => {
    const row = server({ key: 'g', guardrail: null as never });
    expect(resolveMcpGuardrailBinding(row)).toEqual({ mode: 'off', guardrailKey: undefined });
  });
});
