/**
 * Tenant lifecycle seam - COMMUNITY (open-source) edition.
 *
 * A hosted deployment can react to a tenant being created (for example to provision platform-provided records).
 * Core only announces the event; with no listener registered `notifyTenantCreated` does nothing.
 *
 * Leaf module: no imports, so the overlay can import it at load.
 */

export interface TenantCreatedEvent {
  tenantId: string;
  tenantSlug: string;
  tenantDbName: string;
}

export type TenantCreatedListener = (event: TenantCreatedEvent) => void | Promise<void>;

const listeners: TenantCreatedListener[] = [];

/** Called by the overlay at load. Listeners run in registration order. */
export function registerTenantCreatedListener(fn: TenantCreatedListener): void {
  listeners.push(fn);
}

/**
 * Runs every listener one after the other. A throw or rejection is logged and never reaches the caller, and the
 * returned promise never rejects: call sites use `void notifyTenantCreated(...)`.
 */
export async function notifyTenantCreated(event: TenantCreatedEvent): Promise<void> {
  for (const listener of [...listeners]) {
    try {
      await listener(event);
    } catch (error) {
      console.error('tenant-lifecycle: a tenant-created listener failed', error);
    }
  }
}

/** Tests only. */
export function resetTenantCreatedListenersForTests(): void {
  listeners.length = 0;
}
