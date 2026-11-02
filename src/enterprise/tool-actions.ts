/**
 * Managed tool actions seam — COMMUNITY (open-source) edition.
 *
 * An action whose `executionType` is `'connector_action'` is not an HTTP call
 * Console makes itself: it is one of the actions a connector package offers,
 * and the enterprise Connectors module runs it (with the connector's own
 * credential, which never reaches the Tools service). That module registers
 * its executor here.
 *
 * Nothing is registered in the community edition, so a call on such an action
 * fails closed (see `executeToolAction` in services/tools/toolService.ts).
 * The community build never creates one: only the Connectors module does.
 *
 * Leaf module on purpose: only types are imported, so the overlay registry can
 * import it at load time without creating a cycle, and it is a separate
 * community file (NOT replaced by the overlay), so the `registry.ts` seam shape
 * and SEAM_CONTRACT_VERSION do not change because of it.
 * Never read a registered value at module scope: resolve it at call time.
 */
import type { ITool, IToolAction } from '@/lib/database';

export interface ManagedToolActionCall {
  tool: ITool;
  action: IToolAction;
  args: Record<string, unknown>;
  signal?: AbortSignal;
}

/**
 * Runs one action of a connector-managed tool. It throws when the call cannot
 * be made at all (the connector is off, not connected, the action is no longer
 * offered); the message is shown to the caller and the model, so it says what
 * to do and holds no secret. An error the vendor or package reports comes back
 * as `{ isError: true, result }` instead.
 */
export type ManagedToolActionExecutor = (
  call: ManagedToolActionCall,
) => Promise<{ result: unknown; isError?: boolean }>;

let executor: ManagedToolActionExecutor | null = null;

export function registerToolActionExecutor(fn: ManagedToolActionExecutor): void {
  executor = fn;
}

export function getToolActionExecutor(): ManagedToolActionExecutor | null {
  return executor;
}

/** Tests only: forget the registered executor (the enterprise registry registers one when it loads). */
export function __resetToolActionExecutorForTests(): void {
  executor = null;
}
