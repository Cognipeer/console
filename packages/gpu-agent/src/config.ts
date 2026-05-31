/**
 * Configuration loaded from env + on-disk state file.
 *
 * `COGNIPEER_*` env vars are the source of truth at boot. After first
 * handshake the issued agent token is persisted to `<stateDir>/agent-token`
 * so the agent survives reboots without needing the registration token again.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface AgentConfig {
  consoleUrl: string;
  tenantSlug: string;
  /**
   * Per-host single-use token (legacy single-host onboarding). Mutually
   * exclusive with fleetToken below — whichever is set drives the handshake
   * path the agent picks.
   */
  registrationToken: string | null;
  /**
   * Tenant-wide fleet token. When set, agent self-registers as
   * `pending_claim` and an admin completes the binding from the UI.
   */
  fleetToken: string | null;
  /** Loaded from state dir; written after handshake. */
  persistedAgentToken: string | null;
  stateDir: string;
  agentVersion: string;
  /** Forced override of detected hostname. */
  hostnameOverride: string | null;
}

const DEFAULT_STATE_DIR = '/var/lib/cognipeer-gpu-agent';

function getStateDir(): string {
  const fromEnv = process.env.COGNIPEER_STATE_DIR;
  if (fromEnv) return fromEnv;
  if (process.getuid && process.getuid() === 0) return DEFAULT_STATE_DIR;
  return join(homedir(), '.cognipeer', 'gpu-agent');
}

function readPersistedToken(stateDir: string): string | null {
  const tokenPath = join(stateDir, 'agent-token');
  if (!existsSync(tokenPath)) return null;
  try {
    const raw = readFileSync(tokenPath, 'utf8').trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

export function persistAgentToken(stateDir: string, token: string): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(stateDir, 'agent-token'), token, { encoding: 'utf8', mode: 0o600 });
}

/**
 * Persisted event sequence — survives agent restarts so the console-side
 * `event.sequence <= watermark` dedupe doesn't drop everything we emit
 * after a service restart.
 */
export function readPersistedSequence(stateDir: string): number {
  const p = join(stateDir, 'sequence');
  if (!existsSync(p)) return 1;
  try {
    const n = Number.parseInt(readFileSync(p, 'utf8').trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : 1;
  } catch {
    return 1;
  }
}

export function persistSequence(stateDir: string, sequence: number): void {
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(stateDir, 'sequence'), String(sequence), { encoding: 'utf8', mode: 0o600 });
  } catch {
    // Non-fatal: a stale sequence on restart just means a few duplicate
    // events get rejected by the server.
  }
}

export function loadConfig(): AgentConfig {
  const consoleUrl = process.env.COGNIPEER_CONSOLE_URL?.replace(/\/$/, '');
  const tenantSlug = process.env.COGNIPEER_TENANT_SLUG;
  if (!consoleUrl) {
    throw new Error('COGNIPEER_CONSOLE_URL is required (e.g. https://console.example.com)');
  }
  if (!tenantSlug) {
    throw new Error('COGNIPEER_TENANT_SLUG is required');
  }
  const stateDir = getStateDir();

  return {
    consoleUrl,
    tenantSlug,
    registrationToken: process.env.COGNIPEER_REGISTRATION_TOKEN ?? null,
    fleetToken: process.env.COGNIPEER_FLEET_TOKEN ?? null,
    persistedAgentToken: readPersistedToken(stateDir),
    stateDir,
    agentVersion: process.env.COGNIPEER_AGENT_VERSION ?? '0.1.0',
    hostnameOverride: process.env.COGNIPEER_HOSTNAME ?? null,
  };
}
