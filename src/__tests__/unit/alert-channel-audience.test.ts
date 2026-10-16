/**
 * The `audience` of an email alert channel (`project_admins`: also mail the rule's project admins, resolved when
 * the notification is sent): validated on write, kept by seal / mask / unseal and carried by the rule form's
 * channel model, so a save, a read and a copy of a rule never lose it. The send-time resolution itself is in
 * alert-email-project-admins.test.ts.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
  getTenantDatabase: vi.fn(),
}));
vi.mock('@/lib/services/alerts/channels', () => ({
  dispatchNotification: vi.fn(),
}));
vi.mock('@/lib/services/alerts/alertEvaluator', () => ({
  evaluateRuleTargets: vi.fn(),
}));
vi.mock('@/lib/services/entityMetrics/entityHealthService', () => ({
  listActiveEntityKeys: vi.fn(),
}));

import { normalizeChannelInput, validateRuleInput } from '@/lib/services/alerts/alertService';
import { AlertApiError } from '@/lib/services/alerts/alertApiError';
import { maskChannels, sealChannels, unsealChannel } from '@/lib/services/alerts/channels/channelSecrets';
import { channelToInput, channelsFromStored } from '@/components/alerts/channelItems';
import { duplicateRuleSeed } from '@/components/alerts/ruleForm';
import type { AlertRuleDto, MaskedChannel } from '@/components/alerts/alertTypes';
import type { AlertChannelInput, IAlertChannel } from '@/lib/database';

const CHANNEL_ID = 'ch_0123456789ab';
const SLACK_URL = 'https://hooks.slack.com/services/T000/B000/XXXXsecretABCD';

/** Input the API would never accept, as a caller could still send it. */
const asInput = (value: unknown) => value as AlertChannelInput;
const asStored = (value: unknown) => value as IAlertChannel;

function invalid(run: () => unknown): AlertApiError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AlertApiError);
    return error as AlertApiError;
  }
  throw new Error('expected an AlertApiError');
}

describe('normalizeChannelInput: audience', () => {
  it('accepts the project_admins audience on an email channel and keeps its recipients', () => {
    expect(normalizeChannelInput({ type: 'email', recipients: [' ops@acme.com ', 'ops@acme.com'], audience: 'project_admins' }, 0, null))
      .toEqual({ type: 'email', recipients: ['ops@acme.com'], audience: 'project_admins' });
  });

  it('accepts it with no listed recipient (the starter rules do exactly that)', () => {
    expect(normalizeChannelInput({ type: 'email', recipients: [], audience: 'project_admins' }, 0, null))
      .toEqual({ type: 'email', recipients: [], audience: 'project_admins' });
  });

  it('keeps the channel id next to the audience', () => {
    expect(normalizeChannelInput({ id: CHANNEL_ID, type: 'email', recipients: [], audience: 'project_admins' }, 0, null))
      .toEqual({ id: CHANNEL_ID, type: 'email', recipients: [], audience: 'project_admins' });
  });

  it.each([
    ['absent', {}],
    ['undefined', { audience: undefined }],
    ['null', { audience: null }],
  ])('omits the audience when it is %s', (_label, extra) => {
    const channel = normalizeChannelInput({ type: 'email', recipients: ['ops@acme.com'], ...extra }, 0, null);
    expect(channel).toEqual({ type: 'email', recipients: ['ops@acme.com'] });
    expect(channel).not.toHaveProperty('audience');
  });

  it.each([
    ['owners'],
    ['admins'],
    ['project_admin'],
    ['PROJECT_ADMINS'],
    [' project_admins'],
    [''],
    [true],
    [1],
    [['project_admins']],
    [{ value: 'project_admins' }],
  ])('rejects the audience %j with 400 invalid_channel', (audience) => {
    const error = invalid(() => normalizeChannelInput({ type: 'email', recipients: [], audience }, 2, null));
    expect(error).toMatchObject({ status: 400, code: 'invalid_channel' });
    expect(error.message).toContain('channels[2].audience');
  });

  it('still checks the recipients of a channel that has an audience', () => {
    expect(invalid(() => normalizeChannelInput({ type: 'email', recipients: ['nope'], audience: 'project_admins' }, 0, null)))
      .toMatchObject({ status: 400, code: 'invalid_channel' });
  });

  it('is an email-only setting: other channel types never carry it, whatever it says', () => {
    expect(normalizeChannelInput({ type: 'slack', url: SLACK_URL, audience: 'project_admins' }, 0, null))
      .toEqual({ type: 'slack', url: SLACK_URL });
    expect(normalizeChannelInput({ type: 'webhook', url: 'https://hooks.example.com/x', audience: 'owners' }, 0, null))
      .toEqual({ type: 'webhook', url: 'https://hooks.example.com/x' });
    expect(normalizeChannelInput({ type: 'library', libraryId: 'lib-1', audience: 'project_admins' }, 0, null))
      .toEqual({ type: 'library', libraryId: 'lib-1' });
  });

  it('is kept and checked through the rule validator, with the channel index in the message', () => {
    const base = {
      name: 'Agent errors',
      module: 'agents' as const,
      metric: 'agent_error_rate' as const,
      condition: { operator: 'gt' as const, threshold: 10 },
      windowMinutes: 15,
    };
    const rule = validateRuleInput(
      { ...base, channels: [{ type: 'email', recipients: [], audience: 'project_admins' }] },
      { mode: 'create' },
    );
    expect(rule.channels).toEqual([{ type: 'email', recipients: [], audience: 'project_admins' }]);

    const error = invalid(() => validateRuleInput(
      { ...base, channels: [{ type: 'email', recipients: [] }, { type: 'email', recipients: [], audience: 'everyone' }] },
      { mode: 'create' },
    ));
    expect(error).toMatchObject({ status: 400, code: 'invalid_channel' });
    expect(error.message).toContain('channels[1].audience');
  });
});

describe('sealChannels / maskChannels / unsealChannel: audience', () => {
  it('seals an email channel with its audience, in the clear like its recipients', async () => {
    const [channel] = await sealChannels([{ type: 'email', recipients: [' ops@acme.com '], audience: 'project_admins' }]);
    expect(channel).toEqual({ id: expect.stringMatching(/^ch_[0-9a-f]{12}$/), type: 'email', recipients: ['ops@acme.com'], audience: 'project_admins' });
  });

  it('drops an audience it does not know instead of storing it', async () => {
    const [channel] = await sealChannels([asInput({ type: 'email', recipients: [], audience: 'owners' })]);
    expect(channel).not.toHaveProperty('audience');
    expect(JSON.stringify(channel)).not.toContain('owners');
  });

  it('stores no audience key for a channel without one', async () => {
    const [channel] = await sealChannels([{ type: 'email', recipients: ['ops@acme.com'] }]);
    expect(channel).not.toHaveProperty('audience');
  });

  it('an edit decides the audience: sending it keeps it, leaving it out clears it', async () => {
    const [stored] = await sealChannels([{ type: 'email', recipients: [], audience: 'project_admins' }]);
    const [kept] = await sealChannels([{ id: stored.id, type: 'email', recipients: [], audience: 'project_admins' }], [stored]);
    expect(kept).toMatchObject({ id: stored.id, audience: 'project_admins' });
    const [cleared] = await sealChannels([{ id: stored.id, type: 'email', recipients: ['ops@acme.com'] }], [stored]);
    expect(cleared).toEqual({ id: stored.id, type: 'email', recipients: ['ops@acme.com'] });
    expect(cleared).not.toHaveProperty('audience');
  });

  it('masks a stored channel without losing the audience, and without any sealed payload', async () => {
    const sealed = await sealChannels([
      { type: 'email', recipients: ['ops@acme.com'], audience: 'project_admins' },
      { type: 'slack', url: SLACK_URL },
    ]);
    const masked = maskChannels(sealed);
    expect(masked[0]).toEqual({ id: sealed[0].id, type: 'email', recipients: ['ops@acme.com'], audience: 'project_admins' });
    expect(JSON.stringify(masked)).not.toContain(SLACK_URL);
    expect(masked[1]).not.toHaveProperty('audience');
  });

  it('masks an unknown stored audience away, and never copies it onto another channel type', () => {
    const masked = maskChannels([
      asStored({ id: 'ch_aaaaaaaaaaaa', type: 'email', recipients: ['a@acme.com'], audience: 'owners' }),
      asStored({ id: 'ch_bbbbbbbbbbbb', type: 'slack', urlHint: 'https://hooks.slack.com/…/ABCD', sealed: 'x', audience: 'project_admins' }),
      asStored({ id: 'ch_cccccccccccc', type: 'email', recipients: ['b@acme.com'] }),
    ]);
    expect(masked[0]).toEqual({ id: 'ch_aaaaaaaaaaaa', type: 'email', recipients: ['a@acme.com'] });
    expect(masked[1]).toEqual({ id: 'ch_bbbbbbbbbbbb', type: 'slack', urlHint: 'https://hooks.slack.com/…/ABCD' });
    expect(masked[2]).toEqual({ id: 'ch_cccccccccccc', type: 'email', recipients: ['b@acme.com'] });
  });

  it('unseals an email channel with its audience and drops one it does not know', () => {
    expect(unsealChannel({ id: 'ch_aaaaaaaaaaaa', type: 'email', recipients: ['a@acme.com'], audience: 'project_admins' }))
      .toEqual({ id: 'ch_aaaaaaaaaaaa', type: 'email', recipients: ['a@acme.com'], audience: 'project_admins' });
    expect(unsealChannel(asStored({ id: 'ch_aaaaaaaaaaaa', type: 'email', recipients: [], audience: 'owners' })))
      .toEqual({ id: 'ch_aaaaaaaaaaaa', type: 'email', recipients: [] });
    expect(unsealChannel({ id: 'ch_aaaaaaaaaaaa', type: 'email', recipients: [] })).not.toHaveProperty('audience');
  });

  it('survives write, read and write again (what the rule editor does)', async () => {
    const input = normalizeChannelInput({ type: 'email', recipients: [], audience: 'project_admins' }, 0, null);
    const [stored] = await sealChannels([input]);
    const [shown] = maskChannels([stored]);
    // the editor sends back what it read
    const [again] = await sealChannels([normalizeChannelInput(shown, 0, null)], [stored]);
    expect(again).toEqual(stored);
  });
});

describe('the rule form channel model: audience', () => {
  const stored: MaskedChannel[] = [
    { id: 'ch_aaaaaaaaaaaa', type: 'email', recipients: [], audience: 'project_admins' },
    { id: 'ch_bbbbbbbbbbbb', type: 'email', recipients: ['ops@acme.com'] },
    { id: 'ch_cccccccccccc', type: 'slack', urlHint: 'https://hooks.slack.com/…/ABCD' },
  ];

  it('channelsFromStored keeps the audience of an email channel and adds none to the others', () => {
    const items = channelsFromStored(stored);
    expect(items[0]).toMatchObject({ id: 'ch_aaaaaaaaaaaa', type: 'email', recipients: [], audience: 'project_admins' });
    expect(items[1]).not.toHaveProperty('audience');
    expect(items[2]).not.toHaveProperty('audience');
  });

  it('channelsFromStored drops an audience it does not know', () => {
    const [item] = channelsFromStored([{ id: 'ch_aaaaaaaaaaaa', type: 'email', recipients: [], audience: 'owners' } as unknown as MaskedChannel]);
    expect(item).not.toHaveProperty('audience');
  });

  it('channelToInput sends the audience of an email channel, and nothing for a channel without one', () => {
    const [withAudience, plain] = channelsFromStored(stored);
    expect(channelToInput(withAudience)).toEqual({ id: 'ch_aaaaaaaaaaaa', type: 'email', recipients: [], audience: 'project_admins' });
    const sent = channelToInput(plain);
    expect(sent).toEqual({ id: 'ch_bbbbbbbbbbbb', type: 'email', recipients: ['ops@acme.com'] });
    expect(sent).not.toHaveProperty('audience');
  });

  it('channelToInput trims the recipients next to an audience and never sends an audience for another type', () => {
    expect(channelToInput({ key: 'k1', type: 'email', recipients: [' ops@acme.com ', ' '], audience: 'project_admins' }))
      .toEqual({ type: 'email', recipients: ['ops@acme.com'], audience: 'project_admins' });
    expect(channelToInput({ key: 'k2', type: 'slack', recipients: [], audience: 'project_admins', url: SLACK_URL }))
      .toEqual({ type: 'slack', url: SLACK_URL });
  });

  it('what the editor sends back is accepted by the server and means the same channel', () => {
    const [item] = channelsFromStored(stored);
    const back = normalizeChannelInput(channelToInput(item), 0, null);
    expect(back).toEqual({ id: 'ch_aaaaaaaaaaaa', type: 'email', recipients: [], audience: 'project_admins' });
  });

  describe('duplicateRuleSeed', () => {
    const rule: AlertRuleDto = {
      _id: 'rule-1',
      name: 'Agent error rate above 20%',
      module: 'agents',
      metric: 'agent_error_rate',
      condition: { operator: 'gt', threshold: 20, mode: 'threshold', forMinutes: 10, minSamples: 20 },
      windowMinutes: 30,
      cooldownMinutes: 120,
      enabled: true,
      entity: { entityType: 'agent', mode: 'all' },
      channels: [
        { id: 'ch_aaaaaaaaaaaa', type: 'email', recipients: [], audience: 'project_admins' },
        { id: 'ch_bbbbbbbbbbbb', type: 'email', recipients: ['ops@acme.com'] },
        { id: 'ch_cccccccccccc', type: 'library', libraryId: 'lib-1' },
        { id: 'ch_dddddddddddd', type: 'slack', urlHint: 'https://hooks.slack.com/…/ABCD' },
      ],
      starter: { key: 'agent-errors', version: 1 },
    };

    it('keeps the audience of an email channel in the copy', () => {
      const { seed, droppedChannels } = duplicateRuleSeed(rule, 'Copy');
      expect(seed.channels).toEqual([
        { type: 'email', recipients: [], audience: 'project_admins' },
        { type: 'email', recipients: ['ops@acme.com'] },
        { type: 'library', libraryId: 'lib-1' },
      ]);
      expect(seed.channels?.[1]).not.toHaveProperty('audience');
      // only the slack channel (its url cannot be read back) is dropped
      expect(droppedChannels).toBe(1);
    });

    it('does not pass the starter marker on: a copy is a customised rule of its own', () => {
      const { seed } = duplicateRuleSeed(rule, 'Copy');
      expect(seed).not.toHaveProperty('starter');
      expect(seed).toMatchObject({ name: 'Copy', metric: 'agent_error_rate', entity: { entityType: 'agent', mode: 'all' } });
    });
  });
});
