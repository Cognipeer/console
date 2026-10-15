/**
 * PagerDuty channel: Events API v2.
 *
 * fired / renotify -> `trigger`, resolved -> `resolve`, both keyed by
 * `dedup_key = cognipeer:<ruleId>:<entityKey|'_'>` so a re-notification
 * updates the open PagerDuty incident and a recovery closes it. A test sends a
 * trigger and then a resolve under its OWN throw-away key, so testing a
 * channel never touches the PagerDuty incident of a live rule.
 */

import { createHash, randomBytes } from 'node:crypto';
import { createLogger } from '@/lib/core/logger';
import type { IAlertChannel, IncidentSeverity } from '@/lib/database';
import { buildNotificationMessage } from './message';
import { channelTarget, logDelivery, postJson, toDispatchResult, unsealOrFail } from './channelHttp';
import { truncate } from './format';
import type { AlertContext, AlertNotification, DispatchResult, IAlertDispatcher } from './types';

const log = createLogger('alert-channels');

export const PAGERDUTY_EVENTS_URL = 'https://events.pagerduty.com/v2/enqueue';

const MAX_DEDUP_KEY = 255;
const PD_SEVERITY: Record<IncidentSeverity, 'critical' | 'warning' | 'info'> = {
  critical: 'critical',
  warning: 'warning',
  info: 'info',
};

export function pagerDutyDedupKey(ruleId: string, entityKey?: string | null, testNonce?: string): string {
  const entity = entityKey && entityKey.length > 0 ? entityKey : '_';
  const prefix = testNonce ? `cognipeer:test:${testNonce}` : 'cognipeer';
  const key = `${prefix}:${ruleId}:${entity}`;
  if (key.length <= MAX_DEDUP_KEY) return key;
  // an over-long entity key is replaced by its digest so two long keys never collide
  return `${prefix}:${ruleId}:${createHash('sha1').update(entity).digest('hex')}`.slice(0, MAX_DEDUP_KEY);
}

export function buildPagerDutyEvent(
  n: AlertNotification,
  routingKey: string,
  action: 'trigger' | 'resolve',
  dedupKey: string,
): Record<string, unknown> {
  if (action === 'resolve') {
    return { routing_key: routingKey, event_action: 'resolve', dedup_key: dedupKey };
  }
  const message = buildNotificationMessage(n);
  const link = n.incidentUrl || n.entityUrl || n.dashboardUrl;
  return {
    routing_key: routingKey,
    event_action: 'trigger',
    dedup_key: dedupKey,
    payload: {
      summary: truncate(`${message.title}: ${message.summary}`, 1_024),
      source: truncate(`cognipeer-console/${n.projectName || 'project'}`, 255),
      severity: PD_SEVERITY[n.severity] ?? 'warning',
      timestamp: new Date(n.firedAt).toISOString(),
      component: truncate(n.entity?.key || n.rule.metric, 255),
      group: n.rule.module,
      class: n.rule.metric,
      custom_details: Object.fromEntries(message.fields.map((f) => [f.label, f.value])),
    },
    client: 'Cognipeer Console',
    ...(n.dashboardUrl ? { client_url: n.dashboardUrl } : {}),
    ...(link ? { links: [{ href: link, text: message.urlLabel || 'Open in Cognipeer Console' }] } : {}),
  };
}

export class PagerDutyAlertChannel implements IAlertDispatcher {
  readonly type = 'pagerduty';

  async dispatch(n: AlertNotification, channel: IAlertChannel, _ctx: AlertContext): Promise<DispatchResult[]> {
    void _ctx;
    if (channel.type !== 'pagerduty') return [];
    const target = channelTarget(channel);
    const opened = unsealOrFail(channel, 'pagerduty');
    if ('failure' in opened) return [opened.failure];
    const { routingKey } = opened.channel;

    const isTest = n.kind === 'test';
    const dedupKey = pagerDutyDedupKey(
      n.rule.id,
      n.entity?.key,
      isTest ? randomBytes(4).toString('hex') : undefined,
    );
    const actions: Array<'trigger' | 'resolve'> =
      n.kind === 'resolved' ? ['resolve'] : isTest ? ['trigger', 'resolve'] : ['trigger'];

    let last: DispatchResult = { type: 'pagerduty', target, success: true };
    for (const action of actions) {
      const send = () => postJson(PAGERDUTY_EVENTS_URL, buildPagerDutyEvent(n, routingKey, action, dedupKey), {
        secrets: [routingKey],
        includeDetail: true,
      });
      if (isTest && action === 'resolve') {
        // The trigger was accepted, which is what a test proves. The clean-up
        // resolve must not eat the channel's time budget: send it in the
        // background and only log a failure.
        void send().then((posted) => {
          if (!posted.ok) log.warn('PagerDuty test resolve failed', { channelId: channel.id, error: posted.error });
        });
        break;
      }
      last = toDispatchResult('pagerduty', target, await send());
      if (!last.success) break;
    }
    logDelivery(channel, last);
    return [last];
  }
}
