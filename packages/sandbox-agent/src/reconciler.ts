/**
 * Reconciler: drains the command queue, applies commands via the runtime, and
 * reports results back as events. Event sequence numbers are seeded from the
 * boot timestamp so they stay monotonic across agent restarts (the console
 * dedups by watermark).
 */

import type { SandboxCommand, SandboxEvent } from '@cognipeer/sandbox-protocol';
import type { ConsoleClient } from './api/client';
import type { SandboxRuntime } from './runtimes';
import type { AgentConfig } from './config';
import { openTerminalSession } from './terminal';
import { logger } from './logger';

export function createReconciler(client: ConsoleClient, runtime: SandboxRuntime, cfg: AgentConfig) {
  let seq = Date.now();
  const outbox: SandboxEvent[] = [];

  const emit = (event: Omit<SandboxEvent, 'sequence' | 'occurredAt'>): void => {
    outbox.push({ ...event, sequence: ++seq, occurredAt: new Date().toISOString() } as SandboxEvent);
  };

  async function handle(cmd: SandboxCommand): Promise<void> {
    emit({ kind: 'command-accepted', commandId: cmd.id });
    try {
      switch (cmd.kind) {
        case 'create-sandbox': {
          emit({ kind: 'instance-state-changed', instanceId: cmd.spec.instanceId, state: 'creating', containerId: null });
          const { containerId } = await runtime.create(cmd.spec);
          emit({ kind: 'instance-state-changed', instanceId: cmd.spec.instanceId, state: 'running', containerId });
          break;
        }
        case 'start-sandbox':
          await runtime.start(cmd.instanceId);
          emit({ kind: 'instance-state-changed', instanceId: cmd.instanceId, state: 'running', containerId: null });
          break;
        case 'stop-sandbox':
          await runtime.stop(cmd.instanceId);
          emit({ kind: 'instance-state-changed', instanceId: cmd.instanceId, state: 'stopped', containerId: null });
          break;
        case 'delete-sandbox':
          await runtime.remove(cmd.instanceId);
          emit({ kind: 'instance-state-changed', instanceId: cmd.instanceId, state: 'deleted', containerId: null });
          break;
        case 'collect-logs': {
          const logs = await runtime.logs(cmd.instanceId, cmd.tailLines);
          emit({ kind: 'log-snapshot', instanceId: cmd.instanceId, logs });
          break;
        }
        case 'open-terminal-session':
          openTerminalSession(cmd, client);
          break;
        case 'reboot-agent':
          emit({ kind: 'command-completed', commandId: cmd.id });
          await client.postEvents(outbox.splice(0));
          process.exit(0);
          return;
        default:
          break;
      }
      emit({ kind: 'command-completed', commandId: cmd.id });
    } catch (error) {
      emit({
        kind: 'command-failed',
        commandId: cmd.id,
        error: error instanceof Error ? error.message : String(error),
        retryable: false,
      });
    }
  }

  async function tick(): Promise<void> {
    const commands = await client.pollCommands(cfg.commandPollWaitSeconds);
    for (const cmd of commands) await handle(cmd);
    if (outbox.length > 0) {
      const batch = outbox.splice(0);
      try {
        await client.postEvents(batch);
      } catch (error) {
        // Re-queue on failure so we don't lose events.
        outbox.unshift(...batch);
        logger.warn('postEvents failed; will retry', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return { tick };
}
