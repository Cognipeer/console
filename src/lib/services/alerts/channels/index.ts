/**
 * Channel registry and dispatch.
 *
 * To add a new channel type:
 *  1. Create a dispatcher implementing IAlertDispatcher
 *  2. Register it here with `registerChannel()`
 */

import { createLogger } from '@/lib/core/logger';
import type { IAlertChannel } from '@/lib/database';
import { channelTarget, channelTimeoutMs } from './channelHttp';
import { EmailAlertChannel } from './emailChannel';
import { CHANNEL_MISSING, resolveLibraryChannels } from './libraryResolve';
import { PagerDutyAlertChannel } from './pagerDutyChannel';
import { SlackAlertChannel } from './slackChannel';
import { TeamsAlertChannel } from './teamsChannel';
import { WebhookAlertChannel } from './webhookChannel';
import type {
  AlertContext,
  AlertNotification,
  ChannelMessage,
  DispatchResult,
  IAlertDispatcher,
} from './types';

const log = createLogger('alert-channels');
const registry = new Map<string, IAlertDispatcher>();

export function registerChannel(dispatcher: IAlertDispatcher): void {
  registry.set(dispatcher.type, dispatcher);
}

export function getChannel(type: string): IAlertDispatcher | undefined {
  return registry.get(type);
}

export function getAllChannels(): IAlertDispatcher[] {
  return Array.from(registry.values());
}

// Auto-register built-in channels
registerChannel(new EmailAlertChannel());
registerChannel(new WebhookAlertChannel());
registerChannel(new SlackAlertChannel());
registerChannel(new TeamsAlertChannel());
registerChannel(new PagerDutyAlertChannel());

function failure(channel: IAlertChannel, error: string): DispatchResult {
  return { type: String((channel as { type?: unknown }).type ?? 'unknown'), target: safeTarget(channel), success: false, error };
}

function safeTarget(channel: IAlertChannel): string {
  try {
    return channelTarget(channel);
  } catch {
    return String((channel as { type?: unknown }).type ?? 'unknown');
  }
}

/** One channel, bounded by the per-channel timeout; whatever goes wrong becomes a failed result. */
async function runChannel(
  channel: IAlertChannel,
  run: (dispatcher: IAlertDispatcher) => Promise<DispatchResult[]> | undefined,
  missing: string,
): Promise<DispatchResult[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const dispatcher = getChannel(channel?.type);
    if (!dispatcher) return [failure(channel, `No dispatcher for channel type "${channel?.type}"`)];
    const pending = run(dispatcher);
    if (!pending) return [failure(channel, missing)];

    const timeoutMs = channelTimeoutMs();
    const timeout = new Promise<DispatchResult[]>((resolve) => {
      timer = setTimeout(
        () => resolve([failure(channel, `Timed out after ${timeoutMs} ms`)]),
        timeoutMs,
      );
    });
    // a dispatcher that settles after the timeout must not surface as an unhandled rejection
    pending.catch(() => undefined);
    return await Promise.race([pending, timeout]);
  } catch (error) {
    log.warn('Alert channel dispatch failed', {
      channelId: channel?.id,
      type: channel?.type,
      // the message of an unexpected error may carry request details: log its kind only
      error: error instanceof Error ? error.name : typeof error,
    });
    return [failure(channel, 'Delivery failed unexpectedly')];
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Deliver a notification on every channel in parallel. Never throws. */
export async function dispatchNotification(
  notification: AlertNotification,
  channels: IAlertChannel[],
  ctx: AlertContext,
): Promise<DispatchResult[]> {
  try {
    // library references become their stored channel (rule-local id kept); a gone entry is a failed delivery
    const resolved = await resolveLibraryChannels(channels ?? [], ctx);
    const lists = await Promise.all(
      resolved.map(async (entry) => {
        const channel = entry.missing ? entry.ref : entry.channel;
        const results = entry.missing
          ? [{ ...failure(entry.ref, CHANNEL_MISSING), reason: CHANNEL_MISSING }]
          : await runChannel(channel, (dispatcher) => dispatcher.dispatch(notification, channel, ctx), 'unsupported');
        const at = new Date();
        return results.map((result) => ({
          ...result,
          channelId: result.channelId ?? channel?.id,
          ...(entry.entry ? { channelName: entry.entry.name } : {}),
          kind: notification.kind,
          at,
        }));
      }),
    );
    return lists.flat();
  } catch {
    return [];
  }
}

/** Deliver a generic message (digests) on one channel. Never throws. */
export async function sendChannelMessage(
  message: ChannelMessage,
  channel: IAlertChannel,
  ctx: AlertContext,
): Promise<DispatchResult[]> {
  return runChannel(
    channel,
    (dispatcher) => dispatcher.sendMessage?.(message, channel, ctx),
    `${channel?.type} channels do not receive messages`,
  );
}

export { buildNotificationMessage } from './message';
export { CHANNEL_MISSING } from './libraryResolve';
export { resolveAlertEmailRecipients } from './emailChannel';
export {
  keyHint,
  maskChannels,
  newChannelId,
  sealChannels,
  unsealChannel,
  urlHint,
} from './channelSecrets';
export type { UnsealedAlertChannel } from './channelSecrets';
export {
  assertPublicChannelUrl,
  ChannelUrlError,
  isValidPagerDutyRoutingKey,
  PAGERDUTY_ROUTING_KEY_PATTERN,
} from './channelUrl';
export type { IAlertDispatcher, AlertContext, AlertNotification, ChannelMessage, DispatchResult } from './types';
