/**
 * Sandbox runner agent entrypoint.
 *
 * Boot sequence:
 *   1. Load config; obtain an agent token (persisted, or via handshake with a
 *      one-time REGISTRATION_TOKEN).
 *   2. Start a heartbeat loop.
 *   3. Run the reconciler loop: poll commands -> apply -> report events.
 *
 * Required env: TENANT_SLUG, CONSOLE_URL, and one of AGENT_TOKEN /
 * AGENT_TOKEN_FILE / REGISTRATION_TOKEN.
 */

import os from 'node:os';
import { loadConfig, persistToken, readPersistedToken } from './config';
import { ConsoleClient } from './api/client';
import { createRuntime } from './runtimes';
import { createReconciler } from './reconciler';
import { logger } from './logger';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function inventory(): Record<string, unknown> {
  return {
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    cpuCores: os.cpus().length,
    memoryMb: Math.round(os.totalmem() / 1024 / 1024),
    supportedRuntimes: ['runc', process.env.GVISOR_AVAILABLE ? 'gvisor' : null].filter(Boolean),
    agentVersion: '0.1.0',
  };
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const client = new ConsoleClient(cfg);

  let token = readPersistedToken(cfg);
  if (!token) {
    if (!cfg.registrationToken) {
      throw new Error('No AGENT_TOKEN and no REGISTRATION_TOKEN provided; cannot pair with console.');
    }
    logger.info('performing handshake', { tenant: cfg.tenantSlug });
    const result = await client.handshake(cfg.registrationToken, inventory());
    token = result.agentToken;
    persistToken(cfg, token);
    logger.info('handshake complete', { runnerId: result.runnerId });
  }
  client.setAgentToken(token);

  const runtime = createRuntime(cfg);
  const reconciler = createReconciler(client, runtime, cfg);

  // Heartbeat loop.
  const beat = async () => {
    try {
      await client.heartbeat(inventory());
    } catch (error) {
      logger.warn('heartbeat failed', { error: error instanceof Error ? error.message : String(error) });
    }
  };
  await beat();
  setInterval(beat, cfg.heartbeatIntervalSeconds * 1000);

  logger.info('runner agent started', { tenant: cfg.tenantSlug, console: cfg.consoleUrl });
  // Reconciler loop.
  for (;;) {
    try {
      await reconciler.tick();
    } catch (error) {
      logger.error('reconciler tick failed', { error: error instanceof Error ? error.message : String(error) });
      await sleep(2000);
    }
  }
}

main().catch((err) => {
  logger.error('fatal', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
