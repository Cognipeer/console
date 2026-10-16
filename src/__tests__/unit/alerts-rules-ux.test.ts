/** Pure half of the rules / channel library UX: list query, mute presets, noise helpers, library form, rule form additions. */
import { describe, expect, it } from 'vitest';
import { messages } from '@/lib/i18n/messages';
import { DEFAULT_ALERT_CATALOG } from '@/components/alerts/alertCatalog';
import type { AlertRuleDto, LibraryChannelDto } from '@/components/alerts/alertTypes';
import { channelsFromStored, libraryRefsFromStored } from '@/components/alerts/channelItems';
import {
  applyBacktestSuggestion,
  buildBacktestBody,
  buildRulePayload,
  channelsSignature,
  checkRule,
  defaultValues,
  duplicateRuleSeed,
  isValidRunbookUrl,
  valuesFromRule,
} from '@/components/alerts/ruleForm';
import {
  DEFAULT_RULE_FILTERS,
  HOUR_MS,
  MAX_MUTE_MS,
  backtestMedianDurationMs,
  buildRulesQuery,
  dailySeries,
  isMuted,
  isNoisy,
  muteUntilForPreset,
  statusBadge,
  validateMuteUntil,
} from '@/components/alerts/rules/ruleListUi';
import {
  buildCreateLibraryBody,
  buildUpdateLibraryBody,
  emptyLibraryForm,
  libraryFormFromEntry,
  libraryDestinationHint,
  usedByNames,
  validateLibraryForm,
} from '@/components/alerts/channels/libraryUi';

const catalog = DEFAULT_ALERT_CATALOG;

describe('rules list query', () => {
  it('always asks for stats and sorts noisiest first by default', () => {
    expect(buildRulesQuery(DEFAULT_RULE_FILTERS)).toBe('include=stats&sort=-fired7d');
  });

  it('sends only the filters that are set and trims the search', () => {
    const query = new URLSearchParams(buildRulesQuery({ status: 'muted', owner: 'me', q: '  p95  ', sort: 'name' }));
    expect(query.get('status')).toBe('muted');
    expect(query.get('owner')).toBe('me');
    expect(query.get('q')).toBe('p95');
    expect(query.get('sort')).toBe('name');
  });
});

describe('mute helpers', () => {
  const now = Date.parse('2026-10-16T10:00:00.000Z');

  it('counts a preset from now', () => {
    expect(Date.parse(muteUntilForPreset('4h', now)) - now).toBe(4 * HOUR_MS);
    expect(Date.parse(muteUntilForPreset('7d', now)) - now).toBe(7 * 24 * HOUR_MS);
  });

  it('mirrors the server limits for a custom end', () => {
    expect(validateMuteUntil(new Date(now + HOUR_MS), now)).toBeNull();
    expect(validateMuteUntil(new Date(now - 1), now)).toBe('past');
    expect(validateMuteUntil(new Date(now + MAX_MUTE_MS + 1), now)).toBe('tooFar');
    expect(validateMuteUntil(new Date(now + MAX_MUTE_MS), now)).toBeNull();
    expect(validateMuteUntil('nonsense', now)).toBe('invalid');
    expect(validateMuteUntil(null, now)).toBe('invalid');
  });

  it('trusts the server flag and falls back to mutedUntil', () => {
    const future = new Date(now + HOUR_MS).toISOString();
    expect(isMuted({ mutedUntil: future }, { status: 'ok', muted: false, noData: false }, now)).toBe(false);
    expect(isMuted({ mutedUntil: future }, null, now)).toBe(true);
    expect(isMuted({ mutedUntil: new Date(now - HOUR_MS).toISOString() }, null, now)).toBe(false);
    expect(isMuted({}, null, now)).toBe(false);
  });
});

describe('noise helpers', () => {
  it('pads and cleans the 7-day series', () => {
    expect(dailySeries(undefined)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(dailySeries({ fired7d: 3, daily7d: [1, -2, Number.NaN, 2] })).toEqual([1, 0, 0, 2, 0, 0, 0]);
  });

  it('calls a rule noisy from ten fires in a week', () => {
    expect(isNoisy({ fired7d: 9, daily7d: [] })).toBe(false);
    expect(isNoisy({ fired7d: 10, daily7d: [] })).toBe(true);
    expect(isNoisy(undefined)).toBe(false);
  });

  it('maps a primary status to a badge', () => {
    expect(statusBadge('firing').tone).toBe('err');
    expect(statusBadge('noData').key).toBe('noData');
    expect(statusBadge('ok').tone).toBe('ok');
  });

  it('takes the median duration of the replayed incidents that resolved', () => {
    const at = (min: number) => new Date(Date.UTC(2026, 9, 1, 0, min)).toISOString();
    expect(backtestMedianDurationMs([])).toBeNull();
    expect(backtestMedianDurationMs([{ entityKey: 'a', firedAt: at(0) }])).toBeNull();
    expect(
      backtestMedianDurationMs([
        { entityKey: 'a', firedAt: at(0), resolvedAt: at(5) },
        { entityKey: 'a', firedAt: at(10), resolvedAt: at(20) },
        { entityKey: 'b', firedAt: at(30), resolvedAt: at(33) },
      ]),
    ).toBe(5 * 60_000);
  });
});

describe('rule form: library references, runbook and backtest', () => {
  const stored: AlertRuleDto['channels'] = [
    { id: 'ch_aaaaaaaaaaaa', type: 'email', recipients: ['ops@example.com'] },
    { id: 'ch_bbbbbbbbbbbb', type: 'library', libraryId: 'lib1' },
  ];
  const rule = {
    _id: 'r1',
    name: 'R',
    metric: 'agent_error_rate',
    condition: { operator: 'gt', threshold: 5, mode: 'threshold' },
    windowMinutes: 15,
    cooldownMinutes: 60,
    enabled: true,
    entity: { entityType: 'agent', mode: 'all' },
    channels: stored,
    runbookUrl: 'https://wiki.example.com/rb',
  } as AlertRuleDto;

  it('splits a stored channel list into inline channels and library references', () => {
    expect(channelsFromStored(stored).map((channel) => channel.type)).toEqual(['email']);
    expect(libraryRefsFromStored(stored)).toEqual([{ id: 'ch_bbbbbbbbbbbb', libraryId: 'lib1' }]);
    const values = valuesFromRule(rule, catalog);
    expect(values.libraryRefs).toEqual([{ id: 'ch_bbbbbbbbbbbb', libraryId: 'lib1' }]);
    expect(values.runbookUrl).toBe('https://wiki.example.com/rb');
  });

  it('sends the references next to the inline channels, keeping their rule-local id', () => {
    const body = buildRulePayload(valuesFromRule(rule, catalog), { catalog, isEdit: true });
    expect(body.channels).toEqual([
      { id: 'ch_aaaaaaaaaaaa', type: 'email', recipients: ['ops@example.com'] },
      { id: 'ch_bbbbbbbbbbbb', type: 'library', libraryId: 'lib1' },
    ]);
    expect(body.runbookUrl).toBe('https://wiki.example.com/rb');
  });

  it('clears a stored runbook on edit and omits it on create when empty', () => {
    const values = { ...valuesFromRule(rule, catalog), runbookUrl: '' };
    expect(buildRulePayload(values, { catalog, isEdit: true }).runbookUrl).toBe('');
    expect('runbookUrl' in buildRulePayload(values, { catalog, isEdit: false })).toBe(false);
  });

  it('accepts a rule whose only channel is a library reference, and counts references toward the limit', () => {
    const base = { ...defaultValues(catalog), name: 'x', channels: [] };
    expect(checkRule(base, catalog).channels).toBe(false);
    expect(checkRule({ ...base, libraryRefs: [{ libraryId: 'lib1' }] }, catalog).channels).toBe(true);
    const many = Array.from({ length: 11 }, (_, index) => ({ libraryId: `lib${index}` }));
    expect(checkRule({ ...base, libraryRefs: many }, catalog).channels).toBe(false);
  });

  it('notices a changed reference list through the signature', () => {
    const values = valuesFromRule(rule, catalog);
    const before = channelsSignature(values.channels, values.libraryRefs);
    expect(channelsSignature(values.channels, [])).not.toBe(before);
    expect(channelsSignature(values.channels, values.libraryRefs)).toBe(before);
  });

  it('carries email channels and library references into a duplicate', () => {
    const { seed, droppedChannels } = duplicateRuleSeed(
      { ...rule, channels: [...stored, { id: 'ch_cccccccccccc', type: 'slack', urlHint: '…abcd' }] },
      'Copy',
    );
    expect(seed.channels).toEqual([
      { type: 'email', recipients: ['ops@example.com'] },
      { type: 'library', libraryId: 'lib1' },
    ]);
    expect(droppedChannels).toBe(1);
    expect(seed.runbookUrl).toBe('https://wiki.example.com/rb');
  });

  it('validates a runbook address like the server does', () => {
    expect(isValidRunbookUrl('')).toBe(true);
    expect(isValidRunbookUrl('https://wiki.example.com/a b')).toBe(false);
    expect(isValidRunbookUrl('ftp://example.com')).toBe(false);
    expect(isValidRunbookUrl('javascript:alert(1)')).toBe(false);
    expect(isValidRunbookUrl('http://example.com/x')).toBe(true);
    expect(isValidRunbookUrl(`https://example.com/${'a'.repeat(2048)}`)).toBe(false);
  });

  it('builds the backtest body from the preview shape and applies a suggested threshold', () => {
    const values = { ...valuesFromRule(rule, catalog), name: 'ignored' };
    const body = buildBacktestBody(values, { catalog, isEdit: true });
    expect(body.days).toBe(7);
    const draft = body.rule as Record<string, unknown>;
    expect(draft.metric).toBe('agent_error_rate');
    expect('name' in draft).toBe(false);
    expect('channels' in draft).toBe(false);
    expect(applyBacktestSuggestion(values, { threshold: 8 })).toMatchObject({ mode: 'threshold', threshold: 8 });
  });

  it('sends the form cooldown with the backtest (the server assumes 60 minutes without it), but not with the live preview', () => {
    const values = valuesFromRule(rule, catalog);
    const rows = (cooldownMinutes: string) => ({ ...values, cooldownMinutes });
    const cooldownOf = (cooldownMinutes: string) => (buildBacktestBody(rows(cooldownMinutes), { catalog, isEdit: true }).rule as Record<string, unknown>).cooldownMinutes;
    expect(cooldownOf('15')).toBe(15);
    expect(cooldownOf('1440')).toBe(1440);
    // "None" is a real choice: 0, never a missing field
    expect(cooldownOf('0')).toBe(0);
    // the save payload reads the same value; the preview shape does not carry one, so editing it does not refetch the preview
    expect(buildRulePayload(rows('15'), { catalog, isEdit: true }).cooldownMinutes).toBe(15);
    expect('cooldownMinutes' in buildRulePayload(rows('15'), { catalog, isEdit: true, preview: true })).toBe(false);
    // a change of the cooldown makes an earlier backtest result stale
    expect(JSON.stringify(buildBacktestBody(rows('15'), { catalog, isEdit: true }))).not.toBe(JSON.stringify(buildBacktestBody(rows('30'), { catalog, isEdit: true })));
  });
});

describe('channel library form', () => {
  const entry: LibraryChannelDto = {
    id: 'lib1',
    name: 'On-call Slack',
    kind: 'slack',
    config: { type: 'slack', urlHint: 'https://hooks.slack.com/…abcd' },
    usedBy: [
      { ruleId: 'r1', ruleName: 'A' },
      { ruleId: 'r2', ruleName: 'A' },
      { ruleId: 'r3', ruleName: 'B' },
    ],
  };

  it('validates the name and the destination', () => {
    expect(validateLibraryForm(emptyLibraryForm('email'))).toEqual({ code: 'nameRequired' });
    // like the server, and like the field's hint ("leave empty to notify the workspace owners and admins"), no recipient is fine
    expect(validateLibraryForm({ ...emptyLibraryForm('email'), name: 'x' })).toBeNull();
    expect(validateLibraryForm({ ...emptyLibraryForm('email'), name: 'x', recipients: ['bad'] })).toMatchObject({ code: 'invalidEmail' });
    expect(validateLibraryForm({ ...emptyLibraryForm('email'), name: 'x', recipients: ['a@b.co'] })).toBeNull();
    expect(validateLibraryForm({ ...emptyLibraryForm('slack'), name: 'x' })).toEqual({ code: 'urlRequired' });
    expect(validateLibraryForm({ ...emptyLibraryForm('slack'), name: 'x', url: 'http://insecure' })).toEqual({ code: 'urlInvalid' });
    expect(validateLibraryForm({ ...emptyLibraryForm('slack'), name: 'x'.repeat(81), url: 'https://h.example/x' })).toEqual({ code: 'nameTooLong' });
  });

  it('sends the plaintext config on create, without the rule-local id and type', () => {
    expect(buildCreateLibraryBody({ ...emptyLibraryForm('webhook'), name: ' Hook ', url: ' https://h.example/x ', secret: 's3cret' })).toEqual({
      name: 'Hook',
      kind: 'webhook',
      config: { url: 'https://h.example/x', secret: 's3cret' },
    });
  });

  it('keeps a stored destination on edit unless a new one was typed', () => {
    const form = libraryFormFromEntry(entry);
    expect(validateLibraryForm(form, entry)).toBeNull();
    expect(buildUpdateLibraryBody({ ...form, name: 'Renamed' }, entry)).toEqual({ name: 'Renamed' });
    expect(buildUpdateLibraryBody({ ...form, replace: true, url: 'https://hooks.slack.com/new' }, entry)).toEqual({
      name: 'On-call Slack',
      config: { url: 'https://hooks.slack.com/new' },
    });
  });

  it('sends an email channel without recipients as an empty list, on create and on edit', () => {
    expect(buildCreateLibraryBody({ ...emptyLibraryForm('email'), name: ' Admins ' })).toEqual({
      name: 'Admins',
      kind: 'email',
      config: { recipients: [] },
    });
    const email: LibraryChannelDto = { ...entry, kind: 'email', config: { type: 'email', recipients: ['a@b.co'] } };
    const cleared = { ...libraryFormFromEntry(email), recipients: [] };
    expect(validateLibraryForm(cleared, email)).toBeNull();
    expect(buildUpdateLibraryBody(cleared, email)).toEqual({ name: 'On-call Slack', config: { recipients: [] } });
  });

  it('always sends the recipients of an email channel on edit', () => {
    const email: LibraryChannelDto = { ...entry, kind: 'email', config: { type: 'email', recipients: ['a@b.co'] } };
    expect(buildUpdateLibraryBody(libraryFormFromEntry(email), email)).toEqual({ name: 'On-call Slack', config: { recipients: ['a@b.co'] } });
  });

  it('lists a using rule once and describes the destination', () => {
    expect(usedByNames(entry)).toEqual(['A', 'B']);
    expect(libraryDestinationHint(entry)).toBe('https://hooks.slack.com/…abcd');
    expect(libraryDestinationHint({ ...entry, kind: 'email', config: { type: 'email', recipients: ['a@b.co', 'c@d.co'] } })).toBe('a@b.co, c@d.co');
  });
});

describe('rules UX messages', () => {
  it('has the same keys in en and tr', () => {
    const flat = (value: unknown, prefix = ''): string[] =>
      value && typeof value === 'object'
        ? Object.entries(value).flatMap(([key, child]) => flat(child, `${prefix}${key}.`))
        : [prefix];
    const en = messages.en.alerts as Record<string, unknown>;
    const tr = messages.tr.alerts as Record<string, unknown>;
    for (const block of ['rulesUx', 'libraryUx']) {
      expect(flat(tr[block]).sort()).toEqual(flat(en[block]).sort());
    }
  });
});
