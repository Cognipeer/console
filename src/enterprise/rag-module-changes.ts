/**
 * Knowledge Engine module changes seam — COMMUNITY (open-source) edition.
 *
 * Told after a module's access control is switched on or off, and after a
 * module is deleted. The enterprise Connectors module registers a listener
 * here: a connector whose source sends permissions into a module with access
 * control on offers agents no read tools, so its tools follow such a change.
 *
 * Nothing is registered in the community edition, and nothing is told.
 *
 * Leaf module on purpose: no imports, so the overlay registry can import it at
 * load time without creating a cycle, and it is a separate community file (NOT
 * replaced by the overlay), so the `registry.ts` seam shape and
 * SEAM_CONTRACT_VERSION do not change because of it.
 */

export interface RagModuleChange {
  tenantDbName: string;
  tenantId: string;
  projectId?: string;
  ragModuleKey: string;
  /** `access`: its access control was switched on or off; `deleted`: the module is gone. */
  change: 'access' | 'deleted';
  /** Who made the change, when known. */
  actorId?: string;
}

/** Brings what depends on the module in line. It runs after the change is stored, outside the request that made it. */
export type RagModuleChangeListener = (change: RagModuleChange) => Promise<void>;

let listener: RagModuleChangeListener | null = null;

export function registerRagModuleChangeListener(fn: RagModuleChangeListener): void {
  listener = fn;
}

export function getRagModuleChangeListener(): RagModuleChangeListener | null {
  return listener;
}

/** Tests only: forget the registered listener (the enterprise registry registers one when it loads). */
export function __resetRagModuleChangeListenerForTests(): void {
  listener = null;
}
