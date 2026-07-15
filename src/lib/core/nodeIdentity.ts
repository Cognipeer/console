/**
 * This process's stable node identity (env-configured name, or derived
 * from hostname/pid). Deliberately lives outside `cluster/nodeRegistry`
 * so the database layer can read it too, without a
 * database -> cluster -> database import cycle
 * (`cluster/nodeRegistry` imports `@/lib/database` for heartbeats).
 */

import os from 'node:os';
import { getConfig } from './config';

let resolvedNodeName: string | null = null;

export function getThisNodeIdentity(): string {
  if (resolvedNodeName) return resolvedNodeName;
  const cfg = getConfig();
  resolvedNodeName =
    cfg.node.name.trim().length > 0 ? cfg.node.name.trim() : `${os.hostname()}-${process.pid}`;
  return resolvedNodeName;
}

/** Useful for tests. */
export function resetNodeIdentityForTests(): void {
  resolvedNodeName = null;
}
