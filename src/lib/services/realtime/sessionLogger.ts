/**
 * Realtime session logger — persists one row per connection so the realtime
 * dashboard gets the same observability the other modules have.
 *
 * Writes are fire-and-forget (they must never sit on the audio path); the
 * counters use atomic increments so concurrent responses don't lose updates.
 */

import { createLogger } from '@/lib/core/logger';
import { fireAndForget } from '@/lib/core/asyncTask';
import { getDatabase } from '@/lib/database';
import type { RealtimeSessionLogDelta, RealtimeSessionTransport } from '@/lib/database';
import type { RealtimeContext } from './types';

const logger = createLogger('realtime:session-log');

export class RealtimeSessionLogger {
  private readonly ctx: RealtimeContext;
  private readonly startedAt = new Date();
  /** Resolves to the DB row id once the create lands. */
  private logId: Promise<string | null>;
  private finalized = false;

  constructor(
    ctx: RealtimeContext,
    info: {
      sessionId: string;
      transport: RealtimeSessionTransport;
      realtimeModelKey?: string;
      chatModelKey?: string;
      clientInfo?: Record<string, unknown>;
    },
  ) {
    this.ctx = ctx;
    this.logId = (async () => {
      try {
        const db = await getDatabase();
        await db.switchToTenant(ctx.tenantDbName);
        const record = await db.createRealtimeSessionLog({
          tenantId: ctx.tenantId,
          projectId: ctx.projectId,
          sessionId: info.sessionId,
          realtimeModelKey: info.realtimeModelKey,
          chatModelKey: info.chatModelKey,
          transport: info.transport,
          status: 'active',
          responseCount: 0,
          inputAudioSeconds: 0,
          usageInputTokens: 0,
          usageOutputTokens: 0,
          usageTotalTokens: 0,
          clientInfo: info.clientInfo,
          startedAt: this.startedAt,
        });
        return record._id ? String(record._id) : null;
      } catch (error) {
        logger.warn('Realtime session log create failed', { error });
        return null;
      }
    })();
  }

  increment(delta: RealtimeSessionLogDelta): void {
    fireAndForget('realtime-session-log-inc', async () => {
      const id = await this.logId;
      if (!id) return;
      const db = await getDatabase();
      await db.switchToTenant(this.ctx.tenantDbName);
      await db.incrementRealtimeSessionLog(id, delta);
    });
  }

  setChatModel(chatModelKey: string): void {
    fireAndForget('realtime-session-log-model', async () => {
      const id = await this.logId;
      if (!id) return;
      const db = await getDatabase();
      await db.switchToTenant(this.ctx.tenantDbName);
      await db.updateRealtimeSessionLog(id, { chatModelKey });
    });
  }

  setFirstTokenLatency(latencyMs: number): void {
    fireAndForget('realtime-session-log-latency', async () => {
      const id = await this.logId;
      if (!id) return;
      const db = await getDatabase();
      await db.switchToTenant(this.ctx.tenantDbName);
      await db.updateRealtimeSessionLog(id, { firstTokenLatencyMs: Math.round(latencyMs) });
    });
  }

  finalize(status: 'ended' | 'error', errorMessage?: string): void {
    if (this.finalized) return;
    this.finalized = true;
    const endedAt = new Date();
    fireAndForget('realtime-session-log-end', async () => {
      const id = await this.logId;
      if (!id) return;
      const db = await getDatabase();
      await db.switchToTenant(this.ctx.tenantDbName);
      await db.updateRealtimeSessionLog(id, {
        status,
        errorMessage,
        endedAt,
        durationMs: endedAt.getTime() - this.startedAt.getTime(),
      });
    });
  }
}
