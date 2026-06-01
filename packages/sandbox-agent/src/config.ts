/**
 * Runner agent configuration, read from the environment.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface AgentConfig {
  consoleUrl: string;
  tenantSlug: string;
  registrationToken: string | null;
  /** Where the persisted agent token lives between restarts. */
  tokenFile: string;
  /** Host directory under which per-instance FUSE/work dirs are created. */
  workRoot: string;
  heartbeatIntervalSeconds: number;
  commandPollWaitSeconds: number;
}

export function loadConfig(): AgentConfig {
  const consoleUrl = process.env.CONSOLE_URL || 'http://localhost:3000';
  const tenantSlug = process.env.TENANT_SLUG || '';
  if (!tenantSlug) throw new Error('TENANT_SLUG is required');
  return {
    consoleUrl: consoleUrl.replace(/\/$/, ''),
    tenantSlug,
    registrationToken: process.env.REGISTRATION_TOKEN || null,
    tokenFile: process.env.AGENT_TOKEN_FILE || path.join(os.homedir(), '.cognipeer-sandbox-agent.token'),
    workRoot: process.env.SANDBOX_WORK_ROOT || '/var/lib/cognipeer-sandbox',
    heartbeatIntervalSeconds: Number(process.env.HEARTBEAT_INTERVAL_SECONDS || 30),
    commandPollWaitSeconds: Number(process.env.COMMAND_POLL_WAIT_SECONDS || 25),
  };
}

export function readPersistedToken(cfg: AgentConfig): string | null {
  if (process.env.AGENT_TOKEN) return process.env.AGENT_TOKEN;
  if (existsSync(cfg.tokenFile)) {
    try {
      return readFileSync(cfg.tokenFile, 'utf8').trim() || null;
    } catch {
      return null;
    }
  }
  return null;
}

export function persistToken(cfg: AgentConfig, token: string): void {
  try {
    writeFileSync(cfg.tokenFile, token, { mode: 0o600 });
  } catch {
    /* best effort */
  }
}
