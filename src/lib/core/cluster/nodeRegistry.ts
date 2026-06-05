/**
 * Node Registry
 *
 * Manages this process's identity in the cluster: registration,
 * periodic heartbeat, and graceful deregistration. Other processes
 * may use `listNodes()` etc. to inspect the topology.
 *
 * Heartbeats are written to the `nodes` table (main DB). When Redis
 * is later added as a heartbeat layer the public API here remains
 * unchanged — only the storage swaps.
 */

import os from 'node:os';
import { getConfig } from '../config';
import { createLogger } from '../logger';
import { getDatabase, type INodeRecord, type NodeRole, type NodeStatus } from '@/lib/database';

const log = createLogger('cluster.node-registry');

let resolvedNodeName: string | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let staleSweepTimer: NodeJS.Timeout | null = null;
let registered = false;

function readPackageVersion(): string {
  try {
    // Best-effort; never required to succeed.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require('../../../../package.json') as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Returns this node's name (env-configured or derived from hostname/pid).
 * Stable for the lifetime of the process.
 */
export function getThisNodeName(): string {
  if (resolvedNodeName) return resolvedNodeName;
  const cfg = getConfig();
  if (cfg.node.name.trim().length > 0) {
    resolvedNodeName = cfg.node.name.trim();
  } else {
    resolvedNodeName = `${os.hostname()}-${process.pid}`;
  }
  return resolvedNodeName;
}

export function getThisNodeRole(): NodeRole {
  return getConfig().node.role;
}

/** Cluster startup: insert/refresh this node's row and start heartbeats. */
export async function registerThisNode(): Promise<INodeRecord> {
  const cfg = getConfig();
  const db = await getDatabase();
  const name = getThisNodeName();

  const record = await db.upsertNode({
    name,
    role: cfg.node.role,
    url: cfg.node.url ? cfg.node.url.trim() : null,
    tags: cfg.node.tags,
    status: 'online',
    startedAt: new Date(),
    version: readPackageVersion(),
    hostname: os.hostname(),
    pid: process.pid,
  });

  registered = true;

  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    void heartbeatOnce();
  }, cfg.node.heartbeatMs);
  heartbeatTimer.unref();

  // Periodically mark abandoned nodes offline. Cheap and lock-free: every
  // running node attempts the sweep; idempotent UPDATE means duplicates
  // are harmless.
  if (staleSweepTimer) clearInterval(staleSweepTimer);
  staleSweepTimer = setInterval(() => {
    void sweepStaleNodes();
  }, Math.max(cfg.node.heartbeatMs, 30_000));
  staleSweepTimer.unref();

  log.info('Node registered in cluster', {
    name,
    role: cfg.node.role,
    url: cfg.node.url || null,
  });

  return record;
}

async function heartbeatOnce(): Promise<void> {
  try {
    const db = await getDatabase();
    await db.heartbeatNode(getThisNodeName(), new Date());
  } catch (error) {
    log.warn('Heartbeat failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function sweepStaleNodes(): Promise<void> {
  try {
    const cfg = getConfig();
    const cutoff = new Date(Date.now() - cfg.node.offlineAfterMs);
    const db = await getDatabase();
    const changed = await db.markStaleNodesOffline(cutoff);
    if (changed > 0) {
      log.info('Marked stale nodes offline', { count: changed });
    }
  } catch (error) {
    log.warn('Stale-node sweep failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Cluster shutdown: stop timers and mark this node offline. */
export async function deregisterThisNode(): Promise<void> {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (staleSweepTimer) {
    clearInterval(staleSweepTimer);
    staleSweepTimer = null;
  }
  if (!registered) return;
  try {
    const db = await getDatabase();
    await db.setNodeStatus(getThisNodeName(), 'offline');
  } catch (error) {
    log.warn('Failed to mark node offline on shutdown', {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    registered = false;
  }
}

export async function listClusterNodes(filters: { status?: NodeStatus } = {}): Promise<INodeRecord[]> {
  const db = await getDatabase();
  return db.listNodes(filters);
}

export async function findClusterNode(name: string): Promise<INodeRecord | null> {
  const db = await getDatabase();
  return db.findNode(name);
}

/** Useful for tests. */
export function resetNodeRegistryForTests(): void {
  resolvedNodeName = null;
  registered = false;
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (staleSweepTimer) {
    clearInterval(staleSweepTimer);
    staleSweepTimer = null;
  }
}
