/**
 * The reconciler is the agent's main loop. Each iteration:
 *   1. Heartbeats (and ships fresh slice state)
 *   2. Drains any queued commands and applies them
 *   3. Pushes any pending events back to the console
 *
 * Commands are imperative ("apply this spec") and we treat them as idempotent
 * — the docker-side helpers always remove an existing container with the same
 * name before recreating, so retrying after a partial failure is safe.
 */

import { setTimeout as delay } from 'node:timers/promises';
import type {
  DeploymentRuntimeStatus,
  GpuFleetCommand,
  GpuFleetEvent,
  GpuSliceReport,
} from '@cognipeer/gpu-fleet-protocol';
import { ConsoleApiClient } from './api/client';
import { persistSequence, readPersistedSequence } from './config';
import {
  applyDeploymentContainer,
  inspectRestoredDeployment,
  listCognipeerContainers,
  readContainerLogs,
  removeDeploymentContainer,
  stopDeploymentContainer,
} from './system/docker';
import { probeDeploymentHealth } from './system/health';
import { collectInventory } from './system/inventory';
import { logger } from './logger';
import { resolveRuntimeAdapter } from './runtimes';
import { openTerminalSession } from './terminal';
import { applyMigLayout } from './system/mig';

interface ReconcilerOptions {
  client: ConsoleApiClient;
  heartbeatIntervalSeconds: number;
  commandPollWaitSeconds: number;
  agentVersion: string;
  hostnameOverride: string | null;
  /** Needed by the terminal dial-back. */
  consoleUrl: string;
  tenantSlug: string;
  /** Mutable; reconciler reads `.current` so token rotation is picked up. */
  agentTokenRef: { current: string | null };
  /** Local state dir — used to persist the event sequence across restarts. */
  stateDir: string;
}

interface KnownDeployment {
  containerId: string | null;
  spec: GpuFleetCommand & { kind: 'apply-deployment' };
  lastHealthyAt: string | null;
  restartCount: number;
  lastError: string | null;
}

export class Reconciler {
  private readonly options: ReconcilerOptions;
  /** Latest known deployment specs, keyed by deploymentId. */
  private readonly deployments = new Map<string, KnownDeployment>();
  /** Outgoing events waiting to be flushed at the end of the tick. */
  private readonly outbox: GpuFleetEvent[] = [];
  /** Monotonically increasing event sequence — sequence numbers from the agent. */
  /**
   * Monotonic per-host event sequence. Loaded from disk on startup so it
   * keeps growing across restarts — the console dedupes events whose
   * sequence is ≤ its watermark, so resetting to 1 silently discards
   * every event emitted after a restart.
   */
  private sequence: number;
  private lastProcessedCommandId: string | null = null;
  /**
   * Command IDs already accepted in this process. Server-side filtering to
   * `status = 'pending'` should be enough but a stuck `delivered` command
   * could re-appear if the server side is buggy or migrating. This set is
   * cheap insurance — apply-deployment is the expensive command and you
   * really don't want two `docker pull`s racing for the same image.
   * Bounded at 500 entries; oldest dropped on overflow.
   */
  private readonly processedCommandIds = new Set<string>();
  /**
   * In-flight apply operations indexed by deploymentId. Lets a later
   * `remove-deployment` command cancel an ongoing pull/start. Without
   * this, deleting a deployment while its 10 GB image is downloading
   * would let the pull run to completion (wasting bandwidth + disk).
   */
  private readonly inFlightApplies = new Map<string, AbortController>();
  private slicesCache: GpuSliceReport[] = [];
  private startedAt = Date.now();

  constructor(options: ReconcilerOptions) {
    this.options = options;
    this.sequence = readPersistedSequence(options.stateDir);
  }

  async run(): Promise<void> {
    // Rebuild the deployments Map from whatever cognipeer containers already
    // exist on this host. After a host reboot Docker's `restart: unless-stopped`
    // policy brings the containers back automatically, but the agent itself
    // starts with an empty Map. Without this restoration step:
    //   - Heartbeats report `deployments: []` → the console UI thinks the
    //     deployments are gone even though they're running.
    //   - runHealthProbes() never probes them → no healthy event flows back.
    //   - The operator's only recourse is a manual restart, which used to
    //     also re-pull the image (see the reclaimImage fix on the console
    //     side). Restoration eliminates both of those friction points.
    await this.restoreKnownDeployments();

    // Seed inventory once at start so the slice cache + console agree.
    const initial = await collectInventory({
      hostnameOverride: this.options.hostnameOverride,
      agentVersion: this.options.agentVersion,
    });
    this.slicesCache = initial.slices;
    try {
      await this.options.client.pushInventory({
        inventory: initial.inventory,
        slices: initial.slices,
      });
    } catch (error) {
      logger.warn('initial inventory push failed', { error: errorMessage(error) });
    }

    // eslint-disable-next-line no-constant-condition
    while (true) {
      await this.tick();
      await delay(this.options.heartbeatIntervalSeconds * 1000);
    }
  }

  /**
   * Walk every `cognipeer-llm-*` container on the host and rebuild the
   * in-memory deployments Map from container labels + docker inspect data.
   * Best-effort: a container we can't inspect (e.g. labels missing because
   * something else used our prefix) is logged and skipped.
   */
  private async restoreKnownDeployments(): Promise<void> {
    let snapshots: Awaited<ReturnType<typeof listCognipeerContainers>> = [];
    try {
      snapshots = await listCognipeerContainers();
    } catch (error) {
      logger.warn('container restoration: list failed', { error: errorMessage(error) });
      return;
    }
    if (snapshots.length === 0) return;

    let restored = 0;
    for (const snap of snapshots) {
      try {
        const restoredSpec = await inspectRestoredDeployment(snap.id);
        if (!restoredSpec) continue;
        // We synthesize an apply-deployment command shape because the rest of
        // the reconciler expects `KnownDeployment.spec` to look like the
        // wrapper from a real apply command. The id is prefixed so we can
        // tell it from a server-issued one in logs.
        const syntheticCommand: GpuFleetCommand & { kind: 'apply-deployment' } = {
          id: `restored:${restoredSpec.deploymentId}`,
          kind: 'apply-deployment',
          issuedAt: new Date().toISOString(),
          spec: restoredSpec.spec,
        };
        this.deployments.set(restoredSpec.deploymentId, {
          containerId: restoredSpec.containerId,
          spec: syntheticCommand,
          lastHealthyAt: null,
          restartCount: restoredSpec.restartCount,
          lastError: null,
        });
        restored += 1;
      } catch (error) {
        logger.warn('container restoration: inspect failed', {
          containerId: snap.id,
          error: errorMessage(error),
        });
      }
    }
    if (restored > 0) {
      logger.info('rebuilt deployments map from existing containers', {
        restored,
        scanned: snapshots.length,
      });
    }
  }

  private async tick(): Promise<void> {
    // Refresh inventory on every tick. nvidia-smi etc. are cheap (<100ms)
    // and inlining the result in the heartbeat lets the console pick up
    // accelerator changes (e.g. NVIDIA driver becoming available after a
    // reboot) without a separate manual inventory refresh.
    let freshInventory: import('@cognipeer/gpu-fleet-protocol').HostInventory | undefined;
    try {
      const probe = await collectInventory({
        hostnameOverride: this.options.hostnameOverride,
        agentVersion: this.options.agentVersion,
      });
      freshInventory = probe.inventory;
      this.slicesCache = probe.slices;
    } catch {
      // Inventory probe failures don't break the tick — heartbeat still
      // fires with the cached slice list so the host stays online.
    }

    try {
      await this.options.client.heartbeat({
        lastProcessedCommandId: this.lastProcessedCommandId,
        agentVersion: this.options.agentVersion,
        uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
        slices: this.slicesCache,
        deployments: this.snapshotDeployments(),
        inventoryDirty: false,
        inventory: freshInventory,
      });
    } catch (error) {
      logger.warn('heartbeat failed', { error: errorMessage(error) });
    }

    try {
      const { commands } = await this.options.client.pollCommands(
        this.options.commandPollWaitSeconds,
      );
      for (const command of commands) {
        await this.applyCommand(command);
      }
    } catch (error) {
      logger.warn('command poll failed', { error: errorMessage(error) });
    }

    if (this.outbox.length > 0) {
      const batch = this.outbox.splice(0, this.outbox.length);
      try {
        await this.options.client.pushEvents({ events: batch });
      } catch (error) {
        logger.warn('event push failed, requeuing', { error: errorMessage(error) });
        this.outbox.unshift(...batch);
      }
    }

    await this.runHealthProbes();
  }

  private async applyCommand(command: GpuFleetCommand): Promise<void> {
    // Defense-in-depth idempotency: if the server somehow re-delivers a
    // command we already started (legacy `delivered`-in-fetch behaviour,
    // restart races, …), skip it silently. The matching command-completed
    // / command-failed event from the original execution still flows.
    if (this.processedCommandIds.has(command.id)) {
      logger.debug('skipping already-processed command', { commandId: command.id });
      return;
    }
    this.processedCommandIds.add(command.id);
    if (this.processedCommandIds.size > 500) {
      // Bounded eviction — oldest first via insertion order.
      const oldest = this.processedCommandIds.values().next().value;
      if (oldest !== undefined) this.processedCommandIds.delete(oldest);
    }
    this.lastProcessedCommandId = command.id;
    this.emit({
      kind: 'command-accepted',
      sequence: this.nextSequence(),
      occurredAt: new Date().toISOString(),
      commandId: command.id,
    });

    try {
      switch (command.kind) {
        case 'apply-deployment': {
          const adapter = resolveRuntimeAdapter(command.spec.runtime);
          const prepared = adapter.prepare(command.spec);
          // Reserve the deployment slot immediately so heartbeats list it
          // even while the slow docker pull is in flight.
          this.deployments.set(prepared.deploymentId, {
            containerId: null,
            spec: { ...command, spec: prepared },
            lastHealthyAt: null,
            restartCount: 0,
            lastError: null,
          });
          // Tell the console we're in the pull phase. Critical for UX —
          // otherwise the deployment looks stuck at "pending" for minutes
          // while a multi-GB image downloads.
          this.emit({
            kind: 'deployment-state-changed',
            sequence: this.nextSequence(),
            occurredAt: new Date().toISOString(),
            deploymentId: prepared.deploymentId,
            state: 'pulling',
            containerId: null,
          });
          // Run the long-running docker work in the BACKGROUND so the tick
          // loop can keep heartbeating + polling commands. We track the
          // result via events the agent emits from inside the async work.
          void this.runApplyDeployment(prepared, command);
          break;
        }
        case 'stop-deployment': {
          await stopDeploymentContainer(command.deploymentId);
          this.emit({
            kind: 'deployment-state-changed',
            sequence: this.nextSequence(),
            occurredAt: new Date().toISOString(),
            deploymentId: command.deploymentId,
            state: 'stopped',
            containerId: this.deployments.get(command.deploymentId)?.containerId ?? null,
          });
          break;
        }
        case 'remove-deployment': {
          // If an apply is still in flight for this deployment, cancel it
          // first — otherwise the pull keeps running for several minutes
          // after the user clicked Delete.
          const inFlight = this.inFlightApplies.get(command.deploymentId);
          if (inFlight) {
            logger.info('aborting in-flight apply (remove-deployment received)', {
              deploymentId: command.deploymentId,
            });
            inFlight.abort();
            // runApplyDeployment's catch block fires `command-failed` for
            // the apply command and clears inFlightApplies via finally.
          }
          // Restart pairs (remove → apply) send reclaimImage=false so the
          // image stays warm; deletes default to true.
          const reclaimImage = command.reclaimImage ?? true;
          await removeDeploymentContainer(command.deploymentId, { reclaimImage });
          this.deployments.delete(command.deploymentId);
          break;
        }
        case 'collect-logs': {
          const logs = await readContainerLogs(command.deploymentId, command.tailLines);
          this.emit({
            kind: 'log-snapshot',
            sequence: this.nextSequence(),
            occurredAt: new Date().toISOString(),
            deploymentId: command.deploymentId,
            logs,
          });
          break;
        }
        case 'open-terminal-session': {
          const token = this.options.agentTokenRef.current;
          if (!token) throw new Error('agent token missing');
          // Don't await — the terminal session runs until its socket closes
          // or TTL fires. The command is "complete" once we've dialed back.
          void openTerminalSession(command, {
            consoleUrl: this.options.consoleUrl,
            tenantSlug: this.options.tenantSlug,
            agentToken: token,
          });
          break;
        }
        case 'apply-mig-profile': {
          // Stop any deployments the console flagged for drain first. We don't
          // wait for `docker stop` to be 100% clean because MIG reconfigure is
          // destructive anyway — but giving each container a graceful window
          // lets vLLM finish in-flight tokens.
          for (const deploymentId of command.drainDeploymentIds) {
            await stopDeploymentContainer(deploymentId).catch(() => undefined);
            this.deployments.delete(deploymentId);
          }
          const slices = await applyMigLayout(command.layout);
          this.emit({
            kind: 'mig-layout-applied',
            sequence: this.nextSequence(),
            occurredAt: new Date().toISOString(),
            gpuUuid: command.layout.gpuUuid,
            sliceUuids: slices.map((s) => s.uuid),
          });
          // Push a fresh slice list so the console UI shows the new layout
          // without waiting for the next heartbeat tick.
          this.slicesCache = mergeSlices(this.slicesCache, command.layout.gpuUuid, slices);
          break;
        }
        case 'reboot-agent': {
          // Emit completion BEFORE exiting so the console sees the ack.
          // systemd/launchd's Restart= directive will respawn us within
          // 5 seconds. The agent token is persisted so re-handshake just
          // rotates inventory + slices and resumes.
          this.emit({
            kind: 'command-completed',
            sequence: this.nextSequence(),
            occurredAt: new Date().toISOString(),
            commandId: command.id,
          });
          // Flush outbox now — process.exit doesn't await pending I/O.
          if (this.outbox.length > 0) {
            try {
              const batch = this.outbox.splice(0, this.outbox.length);
              await this.options.client.pushEvents({ events: batch });
            } catch {
              // best-effort
            }
          }
          logger.info('reboot-agent command received, exiting for supervisor restart');
          // Give stdout a tick to flush, then bail.
          setTimeout(() => process.exit(0), 200);
          return; // skip the outer command-completed emit below
        }
        case 'pull-image':
          logger.warn('command kind not implemented in agent (phase 1)', {
            kind: command.kind,
          });
          throw new Error(`command kind '${command.kind}' not yet supported`);
        default: {
          const _exhaustive: never = command;
          void _exhaustive;
          throw new Error('unknown command kind');
        }
      }
      // apply-deployment is async via runApplyDeployment, which emits its
      // own command-completed / command-failed. Skip the synchronous one.
      if (command.kind !== 'apply-deployment') {
        this.emit({
          kind: 'command-completed',
          sequence: this.nextSequence(),
          occurredAt: new Date().toISOString(),
          commandId: command.id,
        });
      }
    } catch (error) {
      this.emit({
        kind: 'command-failed',
        sequence: this.nextSequence(),
        occurredAt: new Date().toISOString(),
        commandId: command.id,
        error: errorMessage(error),
        retryable: false,
      });
    }
  }

  /**
   * Background driver for the apply-deployment command. Runs docker pull
   * + run + initial probe asynchronously so the main tick loop can keep
   * heartbeating. State transitions are reported as events.
   */
  private async runApplyDeployment(
    spec: import('@cognipeer/gpu-fleet-protocol').DeploymentSpec,
    command: GpuFleetCommand & { kind: 'apply-deployment' },
  ): Promise<void> {
    // Register an abort controller for this deployment so a later
    // remove-deployment command can cancel the in-flight pull.
    const abortController = new AbortController();
    this.inFlightApplies.set(spec.deploymentId, abortController);
    try {
      const containerId = await applyDeploymentContainer(spec, {
        signal: abortController.signal,
        onPullProgress: (p) => {
          this.emit({
            kind: 'image-pull-progress',
            sequence: this.nextSequence(),
            occurredAt: new Date().toISOString(),
            deploymentId: spec.deploymentId,
            image: spec.image,
            percent: p.percent,
            bytesDownloaded: p.bytesDownloaded,
            bytesTotal: p.bytesTotal,
            status: p.status,
          });
        },
      });
      const known = this.deployments.get(spec.deploymentId);
      if (known) known.containerId = containerId;
      this.emit({
        kind: 'deployment-state-changed',
        sequence: this.nextSequence(),
        occurredAt: new Date().toISOString(),
        deploymentId: spec.deploymentId,
        state: 'starting',
        containerId,
      });
      this.emit({
        kind: 'command-completed',
        sequence: this.nextSequence(),
        occurredAt: new Date().toISOString(),
        commandId: command.id,
      });
    } catch (error) {
      const message = errorMessage(error);
      const known = this.deployments.get(spec.deploymentId);
      if (known) known.lastError = message;
      this.emit({
        kind: 'deployment-state-changed',
        sequence: this.nextSequence(),
        occurredAt: new Date().toISOString(),
        deploymentId: spec.deploymentId,
        state: 'failed',
        containerId: known?.containerId ?? null,
        message,
      });
      this.emit({
        kind: 'command-failed',
        sequence: this.nextSequence(),
        occurredAt: new Date().toISOString(),
        commandId: command.id,
        error: message,
        retryable: false,
      });
    } finally {
      this.inFlightApplies.delete(spec.deploymentId);
    }
  }

  private async runHealthProbes(): Promise<void> {
    for (const [id, known] of this.deployments) {
      const spec = known.spec.spec;
      const adapter = resolveRuntimeAdapter(spec.runtime);
      const ok = await probeDeploymentHealth({
        port: spec.port,
        healthPath: adapter.healthPath(spec),
        timeoutMs: 3_000,
      });
      const wasHealthy = known.lastHealthyAt != null;
      if (ok && !wasHealthy) {
        known.lastHealthyAt = new Date().toISOString();
        this.emit({
          kind: 'deployment-state-changed',
          sequence: this.nextSequence(),
          occurredAt: new Date().toISOString(),
          deploymentId: id,
          state: 'healthy',
          containerId: known.containerId,
        });
      } else if (!ok && wasHealthy) {
        known.lastHealthyAt = null;
        this.emit({
          kind: 'deployment-state-changed',
          sequence: this.nextSequence(),
          occurredAt: new Date().toISOString(),
          deploymentId: id,
          state: 'unhealthy',
          containerId: known.containerId,
          message: 'health probe failed',
        });
      }
    }
  }

  private snapshotDeployments(): DeploymentRuntimeStatus[] {
    const containers = new Map<string, { restartCount: number; state: string }>();
    // Cheap async-skip: we let the docker call happen lazily — at heartbeat
    // time the cached map from listCognipeerContainers() is good enough for
    // Phase 1 telemetry.
    void listCognipeerContainers; // referenced for future enrichment
    return [...this.deployments.entries()].map(([deploymentId, known]) => {
      const container = containers.get(deploymentId);
      const state: DeploymentRuntimeStatus['state'] = known.lastHealthyAt
        ? 'healthy'
        : known.containerId
          ? 'starting'
          : 'pending';
      return {
        deploymentId,
        state,
        containerId: known.containerId,
        lastHealthyAt: known.lastHealthyAt,
        restartCount: container?.restartCount ?? known.restartCount,
        lastError: known.lastError,
      };
    });
  }

  private emit(event: GpuFleetEvent): void {
    this.outbox.push(event);
  }

  private nextSequence(): number {
    const n = this.sequence++;
    // Best-effort persist after every increment. The write is small (a
    // single int) and synchronous; failures are swallowed inside
    // persistSequence so this never throws into the event-emit path.
    persistSequence(this.options.stateDir, this.sequence);
    return n;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Replace all slice entries belonging to `gpuUuid` with the freshly probed
 * list. Used after a MIG reconfigure so the next heartbeat carries an
 * accurate view without doing a full inventory walk.
 */
function mergeSlices(
  existing: GpuSliceReport[],
  gpuUuid: string,
  fresh: GpuSliceReport[],
): GpuSliceReport[] {
  return [...existing.filter((s) => s.gpuUuid !== gpuUuid), ...fresh];
}
