import { describe, expect, it } from 'vitest';
import {
  BUILTIN_VIEWS,
  DEFAULT_FILTERS,
  FILTER_RESET,
  PREVIEW_HIDDEN_COLUMNS,
  SIDE_PREVIEW_MIN_WIDTH,
  activeView,
  changedIds,
  checkUntil,
  columnsBesidePreview,
  filtersToQuery,
  formatDurationMs,
  groupIncidents,
  hasActiveFilters,
  listQuery,
  loadSavedViews,
  moveFocus,
  newSavedView,
  parseFilters,
  parseLocalDateTime,
  resolveShortcut,
  sameView,
  savedViewsKey,
  snoozePresetUntil,
  storeSavedViews,
  toLocalDateTimeValue,
  visibleOrder,
} from '@/components/alerts/inbox/inboxModel';
import {
  deliveriesBeyondRetention,
  deliveryCodeKey,
  groupDeliveries,
  incidentChartRange,
  incidentFlags,
  safeExternalUrl,
  type DeliveryDto,
} from '@/components/alerts/incident/incidentModel';
import type { IncidentDto } from '@/components/alerts/alertTypes';

function incident(over: Partial<IncidentDto>): IncidentDto {
  return {
    _id: 'i1', ruleName: 'Rule', ruleId: 'r1', alertEventId: 'e1', metric: 'errorRate', threshold: 1, actualValue: 2,
    severity: 'warning', status: 'open', notes: [], firedAt: '2026-10-15T10:00:00.000Z', ...over,
  };
}

describe('inbox filters in the URL', () => {
  it('round-trips and omits defaults', () => {
    const filters = { ...DEFAULT_FILTERS, status: 'all' as const, severity: 'critical' as const, assignee: 'me', sort: '-severity' as const, q: ' foo ', snoozed: 'false' as const };
    const params = filtersToQuery(filters, { range: '7d' });
    expect(params.get('status')).toBe('all');
    expect(params.get('q')).toBe('foo');
    expect(params.get('range')).toBe('7d');
    expect(parseFilters(params)).toEqual({ ...filters, q: 'foo' });
    expect(filtersToQuery(DEFAULT_FILTERS).toString()).toBe('status=open');
  });

  it('rejects unknown values and defaults to the open tab', () => {
    const parsed = parseFilters(new URLSearchParams('status=bogus&sort=nope&severity=x&snoozed=maybe'));
    expect(parsed.status).toBe('open');
    expect(parsed.sort).toBe('-firedAt');
    expect(parsed.severity).toBe('');
    expect(parsed.snoozed).toBe('');
  });

  it('a highlight link shows every status; a view id seeds a built-in view', () => {
    expect(parseFilters(new URLSearchParams('highlight=abc')).status).toBe('all');
    const mine = parseFilters(new URLSearchParams('view=mine'));
    expect(mine.assignee).toBe('me');
    expect(mine.status).toBe('all');
    // raw params win over the view marker
    expect(parseFilters(new URLSearchParams('view=mine&status=open')).assignee).toBe('');
  });

  it('builds the server query with paging and without client-only keys', () => {
    const params = listQuery({ ...DEFAULT_FILTERS, status: 'all', group: 'rule', assignee: 'unassigned' }, 3, 25);
    expect(params.get('status')).toBeNull();
    expect(params.get('assignee')).toBe('unassigned');
    expect(params.get('group')).toBeNull();
    expect(params.get('skip')).toBe('50');
    expect(params.get('limit')).toBe('25');
  });

  it('tells a narrowed list from a plain status tab, and resets exactly what narrows it', () => {
    expect(hasActiveFilters(DEFAULT_FILTERS)).toBe(false);
    // the tab, the order and the grouping do not narrow the list
    expect(hasActiveFilters({ ...DEFAULT_FILTERS, status: 'all', sort: '-severity', group: 'rule' })).toBe(false);
    expect(hasActiveFilters({ ...DEFAULT_FILTERS, q: '   ' })).toBe(false);
    for (const narrowed of [{ q: 'x' }, { severity: 'critical' }, { module: 'agents' }, { ruleId: 'r1' }, { entityKey: 'a' }, { assignee: 'me' }, { snoozed: 'true' }] as const) {
      expect(hasActiveFilters({ ...DEFAULT_FILTERS, ...narrowed })).toBe(true);
    }
    const all = { ...DEFAULT_FILTERS, status: 'resolved' as const, severity: 'critical' as const, module: 'agents', ruleId: 'r1', entityKey: 'a', q: 'x', assignee: 'me', snoozed: 'true' as const, sort: '-severity' as const, group: 'rule' as const };
    const cleared = { ...all, ...FILTER_RESET };
    expect(hasActiveFilters(cleared)).toBe(false);
    expect(cleared).toMatchObject({ status: 'resolved', sort: '-severity', group: 'rule' });
  });

  it('detects the active view regardless of grouping', () => {
    const filters = { ...parseFilters(new URLSearchParams('view=snoozed')), group: 'entity' as const };
    expect(activeView(filters, BUILTIN_VIEWS)?.id).toBe('snoozed');
    expect(sameView(filters, DEFAULT_FILTERS)).toBe(false);
    expect(activeView({ ...DEFAULT_FILTERS, q: 'x' }, BUILTIN_VIEWS)).toBeNull();
  });
});

describe('the preview beside the list', () => {
  const columns = ['incident', 'entity', 'severity', 'status', 'assignee', 'value', 'fired', 'duration'].map((key) => ({ key }));

  it('drops the columns the preview pane repeats, only while it sits beside the list', () => {
    expect(columnsBesidePreview(columns, false)).toBe(columns);
    const beside = columnsBesidePreview(columns, true).map((column) => column.key);
    expect(beside).toEqual(['incident', 'entity', 'severity', 'status', 'value', 'fired']);
    for (const key of PREVIEW_HIDDEN_COLUMNS) expect(beside).not.toContain(key);
  });

  it('needs room for a readable list next to the 360 px pane', () => {
    // a 1440 px laptop screen leaves about 1090 px beside the sidebar; a 1366 px one about 1010 px
    expect(SIDE_PREVIEW_MIN_WIDTH).toBeLessThanOrEqual(1090);
    expect(SIDE_PREVIEW_MIN_WIDTH).toBeGreaterThan(1010);
  });
});

describe('saved views storage', () => {
  const memory = () => {
    const data = new Map<string, string>();
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
  };

  it('saves and reloads', () => {
    const storage = memory();
    const key = savedViewsKey('host', 'u1');
    const view = newSavedView(' My view ', { ...DEFAULT_FILTERS, severity: 'critical', group: 'rule' }, 'v1');
    expect(storeSavedViews(storage, key, [view])).toBe(true);
    const loaded = loadSavedViews(storage, key);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.name).toBe('My view');
    expect(loaded[0]!.filters.severity).toBe('critical');
  });

  it('survives corrupt, missing and throwing stores', () => {
    expect(loadSavedViews(null, 'k')).toEqual([]);
    expect(loadSavedViews({ getItem: () => '{not json', setItem: () => undefined }, 'k')).toEqual([]);
    expect(loadSavedViews({ getItem: () => '[1,{"id":1}]', setItem: () => undefined }, 'k')).toEqual([]);
    const throwing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(loadSavedViews(throwing, 'k')).toEqual([]);
    expect(storeSavedViews(throwing, 'k', [])).toBe(false);
  });
});

describe('live refresh and grouping', () => {
  it('flags new and changed rows only after a first load', () => {
    const a = incident({ _id: 'a', updatedAt: '1' });
    const b = incident({ _id: 'b', updatedAt: '1' });
    expect(changedIds(null, [a]).size).toBe(0);
    expect(changedIds([], [a]).size).toBe(0);
    const next = [incident({ _id: 'a', updatedAt: '2', status: 'acknowledged' }), b, incident({ _id: 'c' })];
    expect([...changedIds([a, b], next)].sort()).toEqual(['a', 'c']);
  });

  it('groups by rule with the worst severity first and entity counts', () => {
    const rows = [
      incident({ _id: '1', ruleId: 'r1', severity: 'info', entityType: 'agent', entityKey: 'x', firedAt: '2026-10-15T10:00:00Z' }),
      incident({ _id: '2', ruleId: 'r2', severity: 'critical', entityType: 'agent', entityKey: 'y', firedAt: '2026-10-14T10:00:00Z' }),
      incident({ _id: '3', ruleId: 'r1', severity: 'warning', entityType: 'agent', entityKey: 'z', firedAt: '2026-10-16T10:00:00Z' }),
    ];
    const groups = groupIncidents(rows, 'rule');
    expect(groups.map((g) => g.key)).toEqual(['r2', 'r1']);
    expect(groups[1]!.worstSeverity).toBe('warning');
    expect(groups[1]!.entityCount).toBe(2);
    expect(groups[1]!.latestFiredAt).toBe('2026-10-16T10:00:00Z');
    expect(visibleOrder(rows, 'rule', new Set(['r2'])).map((r) => r._id)).toEqual(['1', '3']);
    expect(visibleOrder(rows, 'none')).toBe(rows);
  });
});

describe('snooze presets and validation', () => {
  it('tomorrow is 09:00 local on the next day', () => {
    const now = new Date(2026, 9, 15, 17, 30);
    const until = snoozePresetUntil('tomorrow', now);
    expect([until.getDate(), until.getHours(), until.getMinutes()]).toEqual([16, 9, 0]);
    expect(snoozePresetUntil('4h', now).getTime() - now.getTime()).toBe(4 * 3_600_000);
  });

  it('checks the window the server accepts', () => {
    const now = Date.now();
    expect(checkUntil(null, now)).toBe('invalid');
    expect(checkUntil(new Date(now - 1000), now)).toBe('past');
    expect(checkUntil(new Date(now + 31 * 86_400_000), now)).toBe('tooFar');
    expect(checkUntil(new Date(now + 3_600_000), now)).toBe('ok');
  });

  it('reads and writes datetime-local values', () => {
    const date = new Date(2026, 0, 5, 7, 4);
    expect(toLocalDateTimeValue(date)).toBe('2026-01-05T07:04');
    expect(parseLocalDateTime('2026-01-05T07:04')?.getTime()).toBe(date.getTime());
    expect(parseLocalDateTime('')).toBeNull();
    expect(parseLocalDateTime('nonsense')).toBeNull();
  });
});

describe('durations and keyboard', () => {
  it('formats compactly', () => {
    expect(formatDurationMs(null)).toBe('—');
    expect(formatDurationMs(20_000)).toBe('<1m');
    expect(formatDurationMs(42 * 60_000)).toBe('42m');
    expect(formatDurationMs(185 * 60_000)).toBe('3h 5m');
    expect(formatDurationMs(48 * 3_600_000)).toBe('2d');
  });

  it('maps keys, ignoring typing, modifiers and controls that own the key', () => {
    expect(resolveShortcut({ key: 'j' })).toBe('next');
    expect(resolveShortcut({ key: '?' })).toBe('help');
    expect(resolveShortcut({ key: 'j', targetTag: 'INPUT' })).toBeNull();
    expect(resolveShortcut({ key: 'a', targetEditable: true })).toBeNull();
    expect(resolveShortcut({ key: 'r', metaKey: true })).toBeNull();
    expect(resolveShortcut({ key: 'Enter', targetTag: 'BUTTON' })).toBeNull();
    expect(resolveShortcut({ key: 'Escape', targetTag: 'INPUT' })).toBe('escape');
    expect(resolveShortcut({ key: 'j', targetTag: 'INPUT', targetType: 'checkbox' })).toBe('next');
    expect(resolveShortcut({ key: 'j', targetTag: 'INPUT', targetType: 'text' })).toBeNull();
    expect(resolveShortcut({ key: 'q' })).toBeNull();
  });

  it('moves focus within bounds', () => {
    expect(moveFocus([], null, 1)).toBeNull();
    expect(moveFocus(['a', 'b', 'c'], null, 1)).toBe('a');
    expect(moveFocus(['a', 'b', 'c'], null, -1)).toBe('c');
    expect(moveFocus(['a', 'b', 'c'], 'c', 1)).toBe('c');
    expect(moveFocus(['a', 'b', 'c'], 'b', -1)).toBe('a');
    expect(moveFocus(['a', 'b'], 'gone', 1)).toBe('a');
  });
});

describe('incident detail model', () => {
  it('only links http(s) runbooks', () => {
    expect(safeExternalUrl('https://wiki.example.com/runbook?a=1')).toBe('https://wiki.example.com/runbook?a=1');
    expect(safeExternalUrl('javascript:alert(1)')).toBeNull();
    expect(safeExternalUrl('data:text/html,x')).toBeNull();
    expect(safeExternalUrl('//evil.example')).toBeNull();
    expect(safeExternalUrl('https://a.example/ b')).toBeNull();
    expect(safeExternalUrl('/dashboard/x')).toBeNull();
    expect(safeExternalUrl(null)).toBeNull();
    expect(safeExternalUrl(`https://a.example/${'x'.repeat(2100)}`)).toBeNull();
  });

  it('builds a chart window around the firing', () => {
    const now = Date.parse('2026-10-16T12:00:00Z');
    const range = incidentChartRange({ firedAt: '2026-10-16T10:00:00Z' }, now)!;
    expect(range.fromMs).toBe(Date.parse('2026-10-16T06:00:00Z'));
    expect(range.toMs).toBe(now);
    const old = incidentChartRange({ firedAt: '2026-10-01T10:00:00Z', resolvedAt: '2026-10-01T10:30:00Z' }, now)!;
    expect(old.toMs - old.fromMs).toBeGreaterThanOrEqual(6 * 3_600_000);
    expect(incidentChartRange({ firedAt: 'bad' }, now)).toBeNull();
  });

  it('groups attempts per channel, problems first, oldest attempt first', () => {
    const rows: DeliveryDto[] = [
      { _id: '3', channelId: 'c1', channelKind: 'slack', channelName: 'Ops', trigger: 'resolve', status: 'sent', attemptAt: '2026-10-15T12:00:00Z' },
      { _id: '2', channelId: 'c2', channelKind: 'email', trigger: 'fire', status: 'failed', error: 'bounce', attemptAt: '2026-10-15T10:01:00Z' },
      { _id: '1', channelId: 'c1', channelKind: 'slack', channelName: 'Ops', trigger: 'fire', status: 'suppressed', reason: 'rule_muted', attemptAt: '2026-10-15T10:00:00Z' },
    ];
    const groups = groupDeliveries(rows);
    expect(groups.map((g) => g.key)).toEqual(['c2', 'c1']);
    expect(groups[1]!.attempts.map((a) => a._id)).toEqual(['1', '3']);
    expect(groups[1]).toMatchObject({ suppressed: 1, sent: 1, failed: 0, name: 'Ops' });
  });

  it('names the real kind of a channel when a held-back row only knows it is a shared (library) one', () => {
    const rows: DeliveryDto[] = [
      // newest first, as the API returns them: the held-back row of the reference comes first
      { _id: '2', channelId: 'c1', channelKind: 'library', channelName: null, trigger: 'renotify', status: 'suppressed', reason: 'rule_muted', attemptAt: '2026-10-15T11:00:00Z' },
      { _id: '1', channelId: 'c1', channelKind: 'slack', channelName: 'On-call Slack', trigger: 'fire', status: 'sent', attemptAt: '2026-10-15T10:00:00Z' },
    ];
    expect(groupDeliveries(rows)[0]).toMatchObject({ kind: 'slack', name: 'On-call Slack' });
    // with nothing that resolved it, the group stays a shared channel (the card words it)
    expect(groupDeliveries([rows[0]!])[0]).toMatchObject({ kind: 'library', name: null });
  });

  it('reads a delivery code wherever it was stored: the reason, or the error text of an older row', () => {
    expect(deliveryCodeKey({ reason: 'channel_missing', error: 'channel_missing' })).toBe('channel_missing');
    expect(deliveryCodeKey({ reason: null, error: 'channel_missing' })).toBe('channel_missing');
    expect(deliveryCodeKey({ reason: 'rule_muted', error: null })).toBe('rule_muted');
    expect(deliveryCodeKey({ reason: null, error: 'SMTP is down' })).toBeNull();
    expect(deliveryCodeKey({})).toBeNull();
  });

  it('tells an incident older than the delivery retention from a recent one', () => {
    const now = Date.parse('2026-10-16T12:00:00Z');
    expect(deliveriesBeyondRetention('2026-09-01T00:00:00Z', now)).toBe(true);
    expect(deliveriesBeyondRetention('2026-10-10T00:00:00Z', now)).toBe(false);
    expect(deliveriesBeyondRetention(undefined, now)).toBe(false);
    expect(deliveriesBeyondRetention('not a date', now)).toBe(false);
  });

  it('reads the snooze state', () => {
    const now = Date.parse('2026-10-16T12:00:00Z');
    expect(incidentFlags({ status: 'open', snoozedUntil: '2026-10-16T13:00:00Z', reopenCount: 2 }, now)).toMatchObject({ snoozed: true, reopenCount: 2 });
    expect(incidentFlags({ status: 'open', snoozedUntil: '2026-10-16T11:00:00Z' }, now).snoozed).toBe(false);
  });
});
