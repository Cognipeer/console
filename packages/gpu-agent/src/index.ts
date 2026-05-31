/**
 * Agent entrypoint.
 *
 * Three startup paths:
 *   1. Persisted agent token exists           → straight to reconciler.
 *   2. COGNIPEER_REGISTRATION_TOKEN present   → single-host handshake.
 *   3. COGNIPEER_FLEET_TOKEN present          → fleet handshake (pending_claim).
 *
 * Once handshake succeeds the token is persisted and the registration env
 * vars are no longer consulted until the operator forces a re-handshake
 * (delete /var/lib/cognipeer-gpu-agent/agent-token).
 */

import { loadConfig, persistAgentToken } from './config';
import { ConsoleApiClient } from './api/client';
import { collectInventory } from './system/inventory';
import { waitForDockerReady } from './system/docker';
import { Reconciler } from './reconciler';
import { logger } from './logger';

const DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 15;
const DEFAULT_COMMAND_POLL_WAIT_SECONDS = 25;

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const tokenRef = { current: config.persistedAgentToken };

  // After a host reboot systemd may start the agent before docker.sock is
  // ready. Block until docker responds to ping so inventory/deployment
  // restoration doesn't crash and put systemd into Restart= rate-limit mode.
  // We allow a long window (2 minutes) because docker on slow boots can take
  // a while; if it never comes back the supervisor restart loop is still
  // strictly better than the agent crashing on its first dockerode call.
  try {
    await waitForDockerReady({ timeoutMs: 120_000, pollIntervalMs: 2_000 });
  } catch (error) {
    logger.error('docker daemon never became reachable; continuing anyway', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const client = new ConsoleApiClient({
    consoleUrl: config.consoleUrl,
    tenantSlug: config.tenantSlug,
    agentTokenRef: tokenRef,
  });

  let heartbeatIntervalSeconds = DEFAULT_HEARTBEAT_INTERVAL_SECONDS;
  let commandPollWaitSeconds = DEFAULT_COMMAND_POLL_WAIT_SECONDS;

  if (!tokenRef.current) {
    const { inventory, slices } = await collectInventory({
      hostnameOverride: config.hostnameOverride,
      agentVersion: config.agentVersion,
    });

    if (config.fleetToken) {
      logger.info('fleet handshake starting', {
        consoleUrl: config.consoleUrl,
        tenantSlug: config.tenantSlug,
        accelerator: inventory.accelerator,
      });
      const response = await client.fleetHandshake({
        fleetToken: config.fleetToken,
        agentVersion: config.agentVersion,
        inventory,
        slices,
      });
      tokenRef.current = response.agentToken;
      persistAgentToken(config.stateDir, response.agentToken);
      heartbeatIntervalSeconds = response.heartbeatIntervalSeconds;
      commandPollWaitSeconds = response.commandPollWaitSeconds;
      logger.info('fleet handshake complete; host is pending_claim until an admin promotes it', {
        hostId: response.hostId,
      });
    } else if (config.registrationToken) {
      logger.info('single-host handshake starting', {
        consoleUrl: config.consoleUrl,
        tenantSlug: config.tenantSlug,
      });
      const response = await client.handshake({
        registrationToken: config.registrationToken,
        agentVersion: config.agentVersion,
        inventory,
        slices,
      });
      tokenRef.current = response.agentToken;
      persistAgentToken(config.stateDir, response.agentToken);
      heartbeatIntervalSeconds = response.heartbeatIntervalSeconds;
      commandPollWaitSeconds = response.commandPollWaitSeconds;
      logger.info('handshake complete', { hostId: response.hostId });
    } else {
      throw new Error(
        'No persisted agent token and neither COGNIPEER_REGISTRATION_TOKEN nor ' +
          'COGNIPEER_FLEET_TOKEN is set. See the onboarding wizard in the console UI.',
      );
    }
  }

  const reconciler = new Reconciler({
    client,
    heartbeatIntervalSeconds,
    commandPollWaitSeconds,
    agentVersion: config.agentVersion,
    hostnameOverride: config.hostnameOverride,
    consoleUrl: config.consoleUrl,
    tenantSlug: config.tenantSlug,
    agentTokenRef: tokenRef,
    stateDir: config.stateDir,
  });
  await reconciler.run();
}

bootstrap().catch((error) => {
  logger.error('agent crashed', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
