/**
 * Tenant-scoped GPU fleet settings: fleet registration token, agent
 * distribution preferences, terminal session TTL.
 */

import { randomBytes } from 'node:crypto';
import { createLogger } from '@/lib/core/logger';
import {
  getDatabase,
  type AgentDistributionMode,
  type IGpuFleetSettings,
} from '@/lib/database';
import { hashToken, tokensMatchByHash } from './agentAuth';

const log = createLogger('gpu-fleet:settings');

const FLEET_TOKEN_BYTES = 32;

function generateFleetToken(): string {
  return `gpuflt_${randomBytes(FLEET_TOKEN_BYTES).toString('hex')}`;
}

const DEFAULT_SETTINGS_SHAPE = {
  fleetTokenHash: null,
  fleetTokenRotatedAt: null,
  fleetTokenRotatedBy: null,
  agentDistributionMode: 'console-served' as AgentDistributionMode,
  agentDistributionExternalUrlTemplate: null,
  terminalSessionTtlSeconds: 1800,
};

export async function getOrInitFleetSettings(
  tenantDbName: string,
  tenantId: string,
): Promise<IGpuFleetSettings> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const existing = await db.getGpuFleetSettings(tenantId);
  if (existing) return existing;
  return db.upsertGpuFleetSettings({ tenantId, ...DEFAULT_SETTINGS_SHAPE });
}

export interface RotateFleetTokenResult {
  token: string;
  rotatedAt: Date;
}

export async function rotateFleetToken(args: {
  tenantDbName: string;
  tenantId: string;
  rotatedBy: string;
}): Promise<RotateFleetTokenResult> {
  const db = await getDatabase();
  await db.switchToTenant(args.tenantDbName);
  const existing = await getOrInitFleetSettings(args.tenantDbName, args.tenantId);

  const token = generateFleetToken();
  const rotatedAt = new Date();
  await db.upsertGpuFleetSettings({
    ...existing,
    tenantId: args.tenantId,
    fleetTokenHash: hashToken(token),
    fleetTokenRotatedAt: rotatedAt,
    fleetTokenRotatedBy: args.rotatedBy,
  });
  log.info('fleet token rotated', { tenantId: args.tenantId, rotatedBy: args.rotatedBy });
  return { token, rotatedAt };
}

export async function disableFleetToken(args: {
  tenantDbName: string;
  tenantId: string;
  rotatedBy: string;
}): Promise<void> {
  const db = await getDatabase();
  await db.switchToTenant(args.tenantDbName);
  const existing = await getOrInitFleetSettings(args.tenantDbName, args.tenantId);
  await db.upsertGpuFleetSettings({
    ...existing,
    fleetTokenHash: null,
    fleetTokenRotatedAt: new Date(),
    fleetTokenRotatedBy: args.rotatedBy,
  });
  log.info('fleet token disabled', { tenantId: args.tenantId });
}

export async function updateAgentDistribution(args: {
  tenantDbName: string;
  tenantId: string;
  mode: AgentDistributionMode;
  externalUrlTemplate?: string | null;
}): Promise<IGpuFleetSettings> {
  const db = await getDatabase();
  await db.switchToTenant(args.tenantDbName);
  const existing = await getOrInitFleetSettings(args.tenantDbName, args.tenantId);
  return db.upsertGpuFleetSettings({
    ...existing,
    agentDistributionMode: args.mode,
    agentDistributionExternalUrlTemplate:
      args.externalUrlTemplate !== undefined ? args.externalUrlTemplate : existing.agentDistributionExternalUrlTemplate,
  });
}

/** Used by the fleet handshake handler. Returns true on match. */
export async function verifyFleetToken(
  tenantDbName: string,
  tenantId: string,
  candidate: string,
): Promise<boolean> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const settings = await db.getGpuFleetSettings(tenantId);
  if (!settings?.fleetTokenHash) return false;
  return tokensMatchByHash(candidate, settings.fleetTokenHash);
}
