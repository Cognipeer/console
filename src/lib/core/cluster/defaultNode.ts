/**
 * Default Node Resolution
 *
 * The "default node" is where new instance assignments land when the
 * admin hasn't picked one explicitly. Resolution order:
 *
 *   1. CLUSTER_DEFAULT_NODE_NAME env var.
 *   2. First node with role='main' (or 'all') that is online.
 *   3. This node's own name (fail-safe so single-process boots work).
 */

import { getConfig } from '../config';
import { getDatabase } from '@/lib/database';
import { getThisNodeName } from './nodeRegistry';

let cachedDefault: { name: string; expiresAt: number } | null = null;
const CACHE_TTL_MS = 10_000;

export async function resolveDefaultNodeName(): Promise<string> {
  const cfg = getConfig();
  if (cfg.node.defaultNodeName.trim().length > 0) {
    return cfg.node.defaultNodeName.trim();
  }

  if (cachedDefault && cachedDefault.expiresAt > Date.now()) {
    return cachedDefault.name;
  }

  let resolved = getThisNodeName();
  try {
    const db = await getDatabase();
    const nodes = await db.listNodes({ status: 'online' });
    const main = nodes.find((n) => n.role === 'main' || n.role === 'all');
    if (main) resolved = main.name;
  } catch {
    // Fall through to this-node name.
  }

  cachedDefault = { name: resolved, expiresAt: Date.now() + CACHE_TTL_MS };
  return resolved;
}

export function clearDefaultNodeCache(): void {
  cachedDefault = null;
}
