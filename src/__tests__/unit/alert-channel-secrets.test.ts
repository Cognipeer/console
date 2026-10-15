import { describe, expect, it } from 'vitest';
import {
  keyHint,
  maskChannels,
  newChannelId,
  sealChannels,
  unsealChannel,
  urlHint,
} from '@/lib/services/alerts/channels/channelSecrets';
import type { IAlertChannel } from '@/lib/database';

const SLACK_URL = 'https://hooks.slack.com/services/T000/B000/XXXXsecretABCD';
const TEAMS_URL = 'https://example.webhook.office.com/webhookb2/aaaa-bbbb/IncomingWebhook/cccc/dddd';
const HOOK_URL = 'https://hooks.example.com/alerts/receive?token=very-secret-token';
const ROUTING_KEY = 'R0123456789abcdefghijklmnopqrstuw';

describe('hints', () => {
  it('shows the host and only the tail of the path', () => {
    expect(urlHint(SLACK_URL)).toBe('https://hooks.slack.com/…/ABCD');
    expect(urlHint(HOOK_URL)).toBe('https://hooks.example.com/…/eive');
    expect(urlHint(HOOK_URL)).not.toContain('very-secret-token');
    expect(urlHint('not a url')).toBe('… url');
  });

  it('shows the last four characters of a key', () => {
    expect(keyHint(ROUTING_KEY)).toBe(`…${ROUTING_KEY.slice(-4)}`);
    expect(keyHint(ROUTING_KEY)).not.toContain(ROUTING_KEY.slice(0, 12));
  });

  it('creates channel ids of the form ch_ + 12 hex', () => {
    expect(newChannelId()).toMatch(/^ch_[0-9a-f]{12}$/);
    expect(newChannelId()).not.toBe(newChannelId());
  });
});

describe('sealChannels', () => {
  it('assigns ids, seals secrets and keeps email recipients in the clear', async () => {
    const sealed = await sealChannels([
      { type: 'email', recipients: [' ops@example.com ', ''] },
      { type: 'webhook', url: HOOK_URL, secret: 'whsec' },
      { type: 'slack', url: SLACK_URL },
      { type: 'teams', url: TEAMS_URL },
      { type: 'pagerduty', routingKey: ROUTING_KEY },
    ]);
    expect(sealed).toHaveLength(5);
    for (const channel of sealed) expect(channel.id).toMatch(/^ch_[0-9a-f]{12}$/);
    expect(new Set(sealed.map((c) => c.id)).size).toBe(5);
    expect(sealed[0]).toMatchObject({ type: 'email', recipients: ['ops@example.com'] });
    expect(sealed[1]).toMatchObject({ type: 'webhook', hasSecret: true, urlHint: 'https://hooks.example.com/…/eive' });
    expect(sealed[2]).toMatchObject({ type: 'slack', urlHint: 'https://hooks.slack.com/…/ABCD' });
    expect(sealed[4]).toMatchObject({ type: 'pagerduty', keyHint: keyHint(ROUTING_KEY) });

    // the stored shape holds credentials only inside `sealed`
    const stored = JSON.stringify(sealed);
    for (const secret of [SLACK_URL, TEAMS_URL, HOOK_URL, 'whsec', ROUTING_KEY, 'very-secret-token']) {
      expect(stored).not.toContain(secret);
    }
    expect(unsealChannel(sealed[1]!)).toMatchObject({ type: 'webhook', url: HOOK_URL, secret: 'whsec' });
    expect(unsealChannel(sealed[2]!)).toMatchObject({ type: 'slack', url: SLACK_URL });
    expect(unsealChannel(sealed[3]!)).toMatchObject({ type: 'teams', url: TEAMS_URL });
    expect(unsealChannel(sealed[4]!)).toMatchObject({ type: 'pagerduty', routingKey: ROUTING_KEY });
    expect(unsealChannel(sealed[0]!)).toMatchObject({ type: 'email', recipients: ['ops@example.com'] });
  });

  it('keeps stored secrets for a channel id whose secret fields are omitted', async () => {
    const [webhook, slack, pagerduty] = await sealChannels([
      { type: 'webhook', url: HOOK_URL, secret: 'whsec' },
      { type: 'slack', url: SLACK_URL },
      { type: 'pagerduty', routingKey: ROUTING_KEY },
    ]);
    const updated = await sealChannels(
      [
        { id: webhook!.id, type: 'webhook' },
        { id: slack!.id, type: 'slack' },
        { id: pagerduty!.id, type: 'pagerduty' },
      ],
      [webhook!, slack!, pagerduty!],
    );
    expect(updated.map((c) => c.id)).toEqual([webhook!.id, slack!.id, pagerduty!.id]);
    expect(unsealChannel(updated[0]!)).toMatchObject({ url: HOOK_URL, secret: 'whsec' });
    expect(unsealChannel(updated[1]!)).toMatchObject({ url: SLACK_URL });
    expect(unsealChannel(updated[2]!)).toMatchObject({ routingKey: ROUTING_KEY });
  });

  it('replaces only the fields that were supplied and can clear a webhook secret', async () => {
    const [webhook] = await sealChannels([{ type: 'webhook', url: HOOK_URL, secret: 'whsec' }]);
    const [newUrl] = await sealChannels([{ id: webhook!.id, type: 'webhook', url: 'https://other.example.com/x' }], [webhook!]);
    expect(unsealChannel(newUrl!)).toMatchObject({ url: 'https://other.example.com/x', secret: 'whsec' });
    const [cleared] = await sealChannels([{ id: webhook!.id, type: 'webhook', secret: '' }], [webhook!]);
    expect(cleared).toMatchObject({ hasSecret: false });
    expect(unsealChannel(cleared!)).toEqual({ id: webhook!.id, type: 'webhook', url: HOOK_URL });
  });

  it('does not carry secrets over to a different channel type or an unknown id', async () => {
    const [slack] = await sealChannels([{ type: 'slack', url: SLACK_URL }]);
    await expect(sealChannels([{ id: slack!.id, type: 'teams' }], [slack!])).rejects.toThrow(/url/);
    await expect(sealChannels([{ id: 'ch_000000000000', type: 'slack' }], [slack!])).rejects.toThrow(/url/);
  });

  it('generates a fresh id for malformed or duplicate ids', async () => {
    const out = await sealChannels([
      { id: 'ch_aaaaaaaaaaaa', type: 'email', recipients: [] },
      { id: 'ch_aaaaaaaaaaaa', type: 'email', recipients: [] },
      { id: 'not-an-id', type: 'email', recipients: [] },
    ]);
    expect(out[0]!.id).toBe('ch_aaaaaaaaaaaa');
    expect(out[1]!.id).not.toBe('ch_aaaaaaaaaaaa');
    expect(out[2]!.id).toMatch(/^ch_[0-9a-f]{12}$/);
  });

  it('rejects secret channels that have nothing to deliver to', async () => {
    await expect(sealChannels([{ type: 'webhook' }])).rejects.toThrow(/url/);
    await expect(sealChannels([{ type: 'pagerduty' }])).rejects.toThrow(/routing key/);
  });
});

describe('maskChannels', () => {
  it('drops every sealed payload and keeps ids and hints', async () => {
    const sealed = await sealChannels([
      { type: 'email', recipients: ['a@example.com'] },
      { type: 'webhook', url: HOOK_URL, secret: 'whsec' },
      { type: 'slack', url: SLACK_URL },
      { type: 'teams', url: TEAMS_URL },
      { type: 'pagerduty', routingKey: ROUTING_KEY },
    ]);
    const masked = maskChannels(sealed);
    expect(masked).toHaveLength(5);
    for (const channel of masked) expect('sealed' in channel).toBe(false);
    expect(masked[0]).toEqual({ id: sealed[0]!.id, type: 'email', recipients: ['a@example.com'] });
    expect(masked[1]).toMatchObject({ id: sealed[1]!.id, type: 'webhook', hasSecret: true });
    const serialised = JSON.stringify(masked);
    for (const secret of [SLACK_URL, TEAMS_URL, HOOK_URL, 'whsec', ROUTING_KEY]) {
      expect(serialised).not.toContain(secret);
    }
    // the stored channels are untouched
    expect((sealed[1] as { sealed?: string }).sealed).toBeTruthy();
  });

  it('copes with legacy channels without ids and with missing input', () => {
    const legacy: IAlertChannel[] = [{ type: 'email', recipients: ['x@example.com'] }];
    expect(maskChannels(legacy)).toEqual([{ type: 'email', recipients: ['x@example.com'] }]);
    expect(maskChannels(undefined)).toEqual([]);
    expect(maskChannels(null)).toEqual([]);
  });
});
