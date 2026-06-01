/**
 * Sandbox runner lifecycle (registration, handshake, heartbeat, auth).
 *
 * A "runner" is a compute node (DinD host, later a K8s namespace) that runs
 * sandbox containers. This is the sandbox subsystem's own registry — it shares
 * nothing with cluster nodes or gpu-fleet hosts.
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '@/lib/core/logger';
import { getDatabase } from '@/lib/database';
import type { ISandboxRunner } from '@/lib/database/provider.interface';
import {
  generateAgentToken,
  generateRegistrationToken,
  hashToken,
  tokensMatchByHash,
} from './agentAuth';

const log = createLogger('sandbox:runner');

const REGISTRATION_TTL_MS = 60 * 60 * 1000; // 1 hour

async function withTenantDb(tenantDbName: string) {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db;
}

export interface CreateRunnerResult {
  runner: ISandboxRunner;
  registrationToken: string;
  expiresAt: Date;
}

export async function createRunner(args: {
  tenantDbName: string;
  tenantId: string;
  name: string;
  createdBy: string;
}): Promise<CreateRunnerResult> {
  const db = await withTenantDb(args.tenantDbName);
  const registrationToken = generateRegistrationToken();
  const expiresAt = new Date(Date.now() + REGISTRATION_TTL_MS);
  const now = new Date();
  const runner = await db.createSandboxRunner({
    id: randomUUID(),
    tenantId: args.tenantId,
    name: args.name,
    status: 'pending',
    labels: {},
    inventory: null,
    agentTokenHash: null,
    agentTokenVersion: 0,
    registrationTokenHash: hashToken(registrationToken),
    registrationTokenExpiresAt: expiresAt,
    lastSeenAt: null,
    lastEventSequence: 0,
    terminalEnabled: true,
    createdBy: args.createdBy,
    createdAt: now,
    updatedAt: now,
  });
  log.info('sandbox runner created', { runnerId: runner.id });
  return { runner, registrationToken, expiresAt };
}

export async function listRunners(tenantDbName: string): Promise<ISandboxRunner[]> {
  const db = await withTenantDb(tenantDbName);
  return db.listSandboxRunners();
}

export async function getRunner(tenantDbName: string, id: string): Promise<ISandboxRunner | null> {
  const db = await withTenantDb(tenantDbName);
  return db.getSandboxRunner(id);
}

export async function deleteRunner(tenantDbName: string, id: string): Promise<boolean> {
  const db = await withTenantDb(tenantDbName);
  return db.deleteSandboxRunner(id);
}

export async function rotateRunnerToken(
  tenantDbName: string,
  id: string,
): Promise<{ registrationToken: string; expiresAt: Date } | null> {
  const db = await withTenantDb(tenantDbName);
  const runner = await db.getSandboxRunner(id);
  if (!runner) return null;
  const registrationToken = generateRegistrationToken();
  const expiresAt = new Date(Date.now() + REGISTRATION_TTL_MS);
  await db.updateSandboxRunner(id, {
    registrationTokenHash: hashToken(registrationToken),
    registrationTokenExpiresAt: expiresAt,
    // Invalidate the previous agent token so the old agent must re-pair.
    agentTokenHash: null,
    agentTokenVersion: runner.agentTokenVersion + 1,
    status: 'pending',
  });
  return { registrationToken, expiresAt };
}

/**
 * Exchange a registration token for a long-lived agent token. Scans runners by
 * registration-token hash (low cardinality control-plane operation).
 */
export async function completeHandshake(args: {
  tenantDbName: string;
  registrationToken: string;
  inventory?: Record<string, unknown> | null;
}): Promise<{ runner: ISandboxRunner; agentToken: string } | null> {
  const db = await withTenantDb(args.tenantDbName);
  const candidateHash = hashToken(args.registrationToken);
  const runners = await db.listSandboxRunners();
  const runner = runners.find(
    (r) => r.registrationTokenHash && r.registrationTokenHash === candidateHash,
  );
  if (!runner) return null;
  if (
    runner.registrationTokenExpiresAt &&
    runner.registrationTokenExpiresAt.getTime() < Date.now()
  ) {
    return null;
  }
  if (
    !runner.registrationTokenHash ||
    !tokensMatchByHash(args.registrationToken, runner.registrationTokenHash)
  ) {
    return null;
  }

  const agentToken = generateAgentToken();
  const updated = await db.updateSandboxRunner(runner.id, {
    agentTokenHash: hashToken(agentToken),
    agentTokenVersion: runner.agentTokenVersion + 1,
    registrationTokenHash: null,
    registrationTokenExpiresAt: null,
    status: 'online',
    inventory: args.inventory ?? runner.inventory,
    lastSeenAt: new Date(),
  });
  log.info('sandbox runner handshake complete', { runnerId: runner.id });
  return { runner: updated ?? runner, agentToken };
}

/** Authenticate a runner agent by its bearer agent token. */
export async function authenticateAgent(
  tenantDbName: string,
  bearerToken: string,
): Promise<ISandboxRunner | null> {
  const db = await withTenantDb(tenantDbName);
  const runner = await db.findSandboxRunnerByAgentTokenHash(hashToken(bearerToken));
  if (!runner || !runner.agentTokenHash) return null;
  if (!tokensMatchByHash(bearerToken, runner.agentTokenHash)) return null;
  return runner;
}

export async function touchHeartbeat(
  tenantDbName: string,
  runnerId: string,
  inventory?: Record<string, unknown> | null,
): Promise<void> {
  const db = await withTenantDb(tenantDbName);
  await db.updateSandboxRunner(runnerId, {
    status: 'online',
    lastSeenAt: new Date(),
    ...(inventory !== undefined ? { inventory } : {}),
  });
}
