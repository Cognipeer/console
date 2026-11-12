import type { IMcpServer } from '@/lib/database';
import { toGuardrailMode } from '@/lib/services/guardrail/hooks/contract';

// ── Guardrail binding ─────────────────────────────────────────────────────

export interface McpGuardrailBinding {
  /** Kept in the MCP vocabulary so it feeds `McpGuardrailContext.mode` directly. */
  mode: 'off' | 'monitor' | 'enforce';
  /** Absent = fall back to the tenant's default tool guardrail. */
  guardrailKey?: string;
}

/**
 * Which guardrail (if any) evaluates this server's tool calls.
 *
 * An absent binding leaves the server unguarded; a binding without a
 * `guardrailKey` selects the tenant's default tool guardrail.
 */
export function resolveMcpGuardrailBinding(server: IMcpServer): McpGuardrailBinding {
  // `?? undefined` and `!= null` on purpose. On Mongo/Cosmos an absent binding
  // is persisted as BSON `null` (the driver runs without `ignoreUndefined`),
  // while SQLite maps its NULL to `undefined`; both must read as "no binding".
  // A `!== undefined` test here armed every unbound Cosmos-backed server in
  // 'enforce' — `toGuardrailMode(undefined, true)` is 'enforce'.
  const binding = server.guardrail ?? undefined;
  // `toGuardrailMode` folds BOTH vocabularies ('off' and 'disabled') onto the
  // canonical three. `enabled` is "a binding exists at all": a server without
  // one stays unguarded rather than being armed by an upgrade.
  const mode = toGuardrailMode(binding?.mode, binding != null);

  return { mode: mode === 'disabled' ? 'off' : mode, guardrailKey: binding?.guardrailKey };
}
