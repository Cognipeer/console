/**
 * Microsoft Teams channel: an Adaptive Card 1.4 posted to a Teams incoming
 * webhook / Workflows URL.
 */

import type { IAlertChannel } from '@/lib/database';
import { buildNotificationMessage } from './message';
import { channelTarget, logDelivery, postJson, toDispatchResult, unsealOrFail } from './channelHttp';
import { truncate } from './format';
import type {
  AlertContext,
  AlertNotification,
  ChannelMessage,
  DispatchResult,
  IAlertDispatcher,
} from './types';

const SEVERITY_COLORS: Record<string, string> = {
  critical: 'Attention',
  warning: 'Warning',
  info: 'Accent',
  ok: 'Good',
};

/**
 * Teams renders a markdown subset (links, emphasis, lists) in TextBlocks and
 * Facts. Entity keys, error messages and rule names come from tracing clients
 * or users, so they are escaped to render as literal text, never as a link.
 * Line-leading list markers are escaped too; backslash-escapes are standard
 * markdown, so other punctuation is left alone to keep cards readable.
 */
export function escapeTeamsMarkdown(text: string): string {
  return text
    .replace(/[\\`*_~[\]()<>|]/g, '\\$&')
    .replace(/(^|\n)([ \t]*)(?:([-+#])|(\d+)\.)(?=\s|$)/g, (_m, nl: string, ws: string, bullet?: string, digits?: string) =>
      bullet ? `${nl}${ws}\\${bullet}` : `${nl}${ws}${digits}\\.`);
}

const esc = (text: string, max: number): string => escapeTeamsMarkdown(truncate(text, max));

export function buildTeamsPayload(message: ChannelMessage): Record<string, unknown> {
  const body: Array<Record<string, unknown>> = [
    {
      type: 'TextBlock',
      text: esc(message.title, 300),
      weight: 'Bolder',
      size: 'Large',
      wrap: true,
      color: SEVERITY_COLORS[message.severity ?? 'info'] ?? 'Default',
    },
  ];
  if (message.summary) body.push({ type: 'TextBlock', text: esc(message.summary, 1_000), wrap: true, spacing: 'Small' });
  if (message.fields.length > 0) {
    body.push({
      type: 'FactSet',
      facts: message.fields.map((field) => ({ title: esc(field.label, 80), value: esc(field.value, 600) })),
    });
  }
  if (message.footer) {
    body.push({ type: 'TextBlock', text: esc(message.footer, 300), size: 'Small', isSubtle: true, wrap: true, spacing: 'Medium' });
  }
  const content: Record<string, unknown> = {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.4',
    msteams: { width: 'Full' },
    body,
  };
  if (message.url && /^https?:\/\//i.test(message.url)) {
    content.actions = [{ type: 'Action.OpenUrl', title: truncate(message.urlLabel || 'Open', 60), url: message.url }];
  }
  return {
    type: 'message',
    attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content }],
  };
}

export class TeamsAlertChannel implements IAlertDispatcher {
  readonly type = 'teams';

  async dispatch(n: AlertNotification, channel: IAlertChannel, ctx: AlertContext): Promise<DispatchResult[]> {
    return this.sendMessage(buildNotificationMessage(n), channel, ctx);
  }

  async sendMessage(message: ChannelMessage, channel: IAlertChannel, _ctx: AlertContext): Promise<DispatchResult[]> {
    void _ctx;
    if (channel.type !== 'teams') return [];
    const target = channelTarget(channel);
    const opened = unsealOrFail(channel, 'teams');
    if ('failure' in opened) return [opened.failure];
    const result = toDispatchResult('teams', target, await postJson(opened.channel.url, buildTeamsPayload(message)));
    logDelivery(channel, result);
    return [result];
  }
}
