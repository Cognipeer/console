/**
 * Slack incoming webhook channel (Block Kit): header, section fields, context
 * footer and a button to the incident. The severity colour bar uses an
 * attachment that carries the blocks.
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
  critical: '#d93025',
  warning: '#f2a60c',
  info: '#2a6fdb',
  ok: '#1ea672',
};

/** Slack limits: header 150 chars, a section holds at most 10 fields of 2000 chars, a text block 3000. */
const MAX_HEADER = 150;
const MAX_FIELD = 1_900;
const MAX_FIELDS_PER_SECTION = 10;
const MAX_SECTION_TEXT = 2_900;

/** Slack mrkdwn only needs these three escaped. */
export function escapeSlack(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function buildSlackPayload(message: ChannelMessage): Record<string, unknown> {
  const blocks: Array<Record<string, unknown>> = [
    { type: 'header', text: { type: 'plain_text', text: truncate(message.title, MAX_HEADER), emoji: false } },
  ];
  if (message.summary) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: truncate(escapeSlack(message.summary), MAX_SECTION_TEXT) } });
  }
  for (let i = 0; i < message.fields.length; i += MAX_FIELDS_PER_SECTION) {
    blocks.push({
      type: 'section',
      fields: message.fields.slice(i, i + MAX_FIELDS_PER_SECTION).map((field) => ({
        type: 'mrkdwn',
        text: truncate(`*${escapeSlack(field.label)}*\n${escapeSlack(field.value)}`, MAX_FIELD),
      })),
    });
  }
  if (message.url && /^https?:\/\//i.test(message.url)) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: truncate(message.urlLabel || 'Open', 75), emoji: false },
          url: message.url,
        },
      ],
    });
  }
  if (message.footer) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: truncate(escapeSlack(message.footer), MAX_SECTION_TEXT) }] });
  }
  return {
    text: message.title,
    attachments: [{ color: SEVERITY_COLORS[message.severity ?? 'info'] ?? SEVERITY_COLORS.info, blocks }],
  };
}

export class SlackAlertChannel implements IAlertDispatcher {
  readonly type = 'slack';

  async dispatch(n: AlertNotification, channel: IAlertChannel, ctx: AlertContext): Promise<DispatchResult[]> {
    return this.sendMessage(buildNotificationMessage(n), channel, ctx);
  }

  async sendMessage(message: ChannelMessage, channel: IAlertChannel, _ctx: AlertContext): Promise<DispatchResult[]> {
    void _ctx;
    if (channel.type !== 'slack') return [];
    const target = channelTarget(channel);
    const opened = unsealOrFail(channel, 'slack');
    if ('failure' in opened) return [opened.failure];
    const result = toDispatchResult('slack', target, await postJson(opened.channel.url, buildSlackPayload(message)));
    logDelivery(channel, result);
    return [result];
  }
}
