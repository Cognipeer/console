/**
 * Generic webhook channel: a signed JSON POST.
 *
 *   { type: 'alert.fired' | 'alert.resolved' | 'alert.renotify' | 'alert.test', id, occurredAt, data }
 *
 * Same headers and signature scheme as the webhook subscriptions
 * (`x-cognipeer-signature: t=<unix>,v1=<hmac>`), so a receiver verifies both
 * with one routine. Redirects are not followed.
 */

import { randomBytes } from 'node:crypto';
import { sendSignedWebhook } from '@/lib/services/webhooks/webhookDeliverer';
import type { IAlertChannel } from '@/lib/database';
import { buildNotificationMessage } from './message';
import { channelTarget, channelTimeoutMs, logDelivery, scrubSecrets, unsealOrFail } from './channelHttp';
import type {
  AlertContext,
  AlertNotification,
  ChannelMessage,
  DispatchResult,
  IAlertDispatcher,
} from './types';

function newEventId(): string {
  return `alr_${randomBytes(12).toString('hex')}`;
}

export class WebhookAlertChannel implements IAlertDispatcher {
  readonly type = 'webhook';

  async dispatch(n: AlertNotification, channel: IAlertChannel, _ctx: AlertContext): Promise<DispatchResult[]> {
    void _ctx;
    return this.post(channel, `alert.${n.kind}`, {
      ...n,
      // the rendered one-liner saves receivers from rebuilding it
      summary: buildNotificationMessage(n).summary,
    });
  }

  async sendMessage(message: ChannelMessage, channel: IAlertChannel, _ctx: AlertContext): Promise<DispatchResult[]> {
    void _ctx;
    return this.post(channel, 'notice', message);
  }

  private async post(channel: IAlertChannel, type: string, data: unknown): Promise<DispatchResult[]> {
    if (channel.type !== 'webhook') return [];
    const target = channelTarget(channel);
    const opened = unsealOrFail(channel, 'webhook');
    if ('failure' in opened) return [opened.failure];
    const { url, secret } = opened.channel;

    const id = newEventId();
    const body = JSON.stringify({ type, id, occurredAt: new Date().toISOString(), data });
    const sent = await sendSignedWebhook({
      url,
      body,
      eventName: type,
      eventId: id,
      userAgent: 'Cognipeer-Alerts/1',
      ...(secret ? { secret } : {}),
      timeoutMs: channelTimeoutMs(),
      followRedirects: false,
    });
    const result: DispatchResult = sent.ok
      ? { type: 'webhook', target, success: true }
      : {
          type: 'webhook',
          target,
          success: false,
          error: scrubSecrets(sent.error ?? 'Delivery failed', [url, secret]),
        };
    logDelivery(channel, result);
    return [result];
  }
}
