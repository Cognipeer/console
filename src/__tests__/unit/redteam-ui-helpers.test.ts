import { describe, expect, it } from 'vitest';
import {
  appendPage,
  attemptIdError,
  attemptKeyFor,
  highestAttemptSuffix,
  inconclusiveReasons,
  isFailedAttempt,
  mergePolledPage,
  missingProbeKeys,
  nextAttemptId,
  partialLabel,
  pct,
  reviewBlockedReason,
  selectedDisabledProbes,
  splitPatternLines,
} from '@/components/redteam/helpers';
import { formatFireTime, nextFireTimes } from '@/components/redteam/cronPreview';
import type { RedTeamAttemptView } from '@/components/redteam/types';

const attempt = (patch: Partial<RedTeamAttemptView> = {}): RedTeamAttemptView => ({
  attemptKey: 'p1::a1',
  probeKey: 'p1',
  attemptId: 'a1',
  family: 'f',
  category: 'LLM01-prompt-injection',
  severity: 'high',
  outcome: 'safe',
  decidedBy: 'refusal',
  confidence: 0.9,
  transcript: [],
  signals: [],
  ...patch,
});

describe('red-team screen helpers', () => {
  it('shows a missing rate as a dash and a real one as a percentage', () => {
    expect(pct(null)).toBe('—');
    expect(pct(undefined)).toBe('—');
    expect(pct(0)).toBe('0%');
    expect(pct(0.256)).toBe('26%');
  });

  it('keys an attempt by probe and id when the payload carries no key', () => {
    expect(attemptKeyFor(attempt())).toBe('p1::a1');
    expect(attemptKeyFor({ attemptKey: '', probeKey: 'p2', attemptId: 'a9' })).toBe('p2::a9');
  });

  it('treats an error without a transcript turn as failed, and a partial one as judged', () => {
    expect(isFailedAttempt(attempt({ error: 'boom' }))).toBe(true);
    expect(isFailedAttempt(attempt({ error: 'boom', partial: true }))).toBe(false);
    expect(isFailedAttempt(attempt())).toBe(false);
  });

  it('blocks review while the scan is active, for restricted attempts and for failed ones', () => {
    expect(reviewBlockedReason({ status: 'running' }, attempt())).toBe('run-active');
    expect(reviewBlockedReason({ status: 'pending' }, attempt())).toBe('run-active');
    expect(reviewBlockedReason({ status: 'completed' }, attempt({ restricted: true }))).toBe('restricted');
    expect(reviewBlockedReason({ status: 'completed' }, attempt({ error: 'x' }))).toBe('failed');
    expect(reviewBlockedReason({ status: 'cancelled' }, attempt())).toBeNull();
    expect(reviewBlockedReason({ status: 'completed' }, attempt({ error: 'x', partial: true }))).toBeNull();
  });

  it('reads inconclusive reasons, defaulting an old flagged run to judge errors', () => {
    expect(inconclusiveReasons(undefined)).toEqual([]);
    expect(inconclusiveReasons({ inconclusive: false })).toEqual([]);
    expect(inconclusiveReasons({ inconclusive: true })).toEqual(['judge-errors']);
    expect(inconclusiveReasons({ inconclusive: true, inconclusiveReasons: ['target-errors', 'judge-errors'] })).toEqual([
      'target-errors',
      'judge-errors',
    ]);
  });

  it('labels a partial attempt with the turns that completed', () => {
    expect(partialLabel({ transcript: [{ user: 'a', assistant: 'b' }] })).toBe('partial — target error after 1 turn');
    expect(partialLabel({ transcript: [{ user: 'a', assistant: 'b' }, { user: 'c', assistant: 'd' }] })).toBe(
      'partial — target error after 2 turns',
    );
  });

  it('hands out the largest numeric suffix + 1 as the next attempt id, never reusing a removed one', () => {
    expect(nextAttemptId([])).toBe('attempt-1');
    expect(nextAttemptId(['attempt-1', 'attempt-2'])).toBe('attempt-3');
    // attempt-2 was removed earlier: the next id is still 4, not 2 or 3.
    expect(nextAttemptId(['attempt-1', 'attempt-3'])).toBe('attempt-4');
    expect(nextAttemptId(['custom', 'x-7'])).toBe('attempt-8');
  });

  it('checks an attempt id against the save rules', () => {
    expect(attemptIdError('attempt-1', ['attempt-2'])).toBeNull();
    expect(attemptIdError('', [])).toMatch(/required/);
    expect(attemptIdError('has space', [])).toMatch(/letters, digits/);
    expect(attemptIdError('a'.repeat(65), [])).toMatch(/letters, digits/);
    expect(attemptIdError('attempt-1', ['attempt-1'])).toMatch(/already uses/);
  });

  it('splits forbidden patterns on newlines, not commas', () => {
    expect(splitPatternLines('foo, bar\n\n  baz(\\d+)  \r\n')).toEqual(['foo, bar', 'baz(\\d+)']);
  });

  it('lists selected probe keys the catalog no longer has', () => {
    expect(missingProbeKeys(['a', 'custom:gone', 'b'], ['a', 'b', 'c'])).toEqual(['custom:gone']);
  });

  it('does not count a disabled custom probe as deleted', () => {
    expect(missingProbeKeys(['a', 'custom:off', 'custom:gone'], ['a'], ['custom:off'])).toEqual(['custom:gone']);
    expect(selectedDisabledProbes(['a', 'custom:off'], [{ key: 'custom:off', name: 'Off' }, { key: 'custom:other', name: 'Other' }]))
      .toEqual([{ key: 'custom:off', name: 'Off' }]);
    expect(selectedDisabledProbes(['a'], undefined)).toEqual([]);
  });

  it('never reuses an attempt id removed earlier in the session', () => {
    expect(nextAttemptId(['attempt-1', 'attempt-2'], 'attempt-', 3)).toBe('attempt-4');
    expect(nextAttemptId(['attempt-5'], 'attempt-', 3)).toBe('attempt-6');
    expect(highestAttemptSuffix(['attempt-2', 'x'], 4)).toBe(4);
    expect(highestAttemptSuffix(['attempt-7'])).toBe(7);
  });

  it('merges a polled first page into the loaded rows', () => {
    const prev = [{ id: 'c', v: 1 }, { id: 'b', v: 1 }, { id: 'a', v: 1 }];
    const page = [{ id: 'd', v: 1 }, { id: 'c', v: 2 }];
    expect(mergePolledPage(prev, page)).toEqual([{ id: 'd', v: 1 }, { id: 'c', v: 2 }, { id: 'b', v: 1 }, { id: 'a', v: 1 }]);
    expect(mergePolledPage(prev, page, 2)).toEqual([{ id: 'd', v: 1 }, { id: 'c', v: 2 }, { id: 'b', v: 1 }, { id: 'a', v: 1 }]);
  });

  it('replaces the rows when the polled page is shorter than its limit', () => {
    const prev = [{ id: 'c' }, { id: 'b' }, { id: 'a' }];
    expect(mergePolledPage(prev, [{ id: 'c' }, { id: 'a' }], 50)).toEqual([{ id: 'c' }, { id: 'a' }]);
  });

  it('drops rows already loaded when appending a page', () => {
    const prev = [{ id: 'a' }, { id: 'b' }];
    expect(appendPage(prev, [{ id: 'b' }, { id: 'c' }, { id: 'c' }])).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  });
});

describe('cron preview', () => {
  const from = new Date('2026-11-09T10:00:00Z');

  it('lists the next three fire times in UTC', () => {
    const times = nextFireTimes('0 3 * * *', 3, from);
    expect(times.map(formatFireTime)).toEqual([
      '2026-11-10 03:00 UTC',
      '2026-11-11 03:00 UTC',
      '2026-11-12 03:00 UTC',
    ]);
  });

  it('returns nothing for an expression that does not parse', () => {
    expect(nextFireTimes('not a cron', 3, from)).toEqual([]);
    expect(nextFireTimes('', 3, from)).toEqual([]);
  });
});
