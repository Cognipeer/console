/**
 * Unit tests — license `plan` claim (normalize at activation, read defensively at request time).
 */

import { describe, it, expect } from 'vitest';
import { normalizePlanClaim, readStoredPlanClaim } from '@/lib/license/planClaim';

const FULL = {
  v: 1,
  id: 'team',
  name: 'Team',
  capacityPacks: 2,
  seats: { console: 5, portal: 50 },
  limits: {
    apiRequestsPerMinute: 300,
    concurrent: {
      agentSessions: 10,
      flows: 4,
      jobs: 2,
      crawlers: 3,
      browserSessions: 3,
      realtimeSessions: 2,
      sandboxes: 1,
    },
    monthly: { searches: 1000, flowRuns: 500, crawlerPages: 2000, sandboxHours: 20 },
    storageGb: 12.5,
    realtimeMaxSessionMinutes: 30,
    sandboxMaxSize: { cpu: 1.5, memoryMb: 2048 },
  },
  credits: { includedPerMonth: 100 },
} as const;

describe('normalizePlanClaim', () => {
  it('returns undefined when there is no claim', () => {
    expect(normalizePlanClaim(undefined)).toBeUndefined();
    expect(normalizePlanClaim(null)).toBeUndefined();
  });

  it('accepts a minimal claim with only an id', () => {
    expect(normalizePlanClaim({ id: 'free' })).toEqual({ id: 'free' });
  });

  it('accepts and keeps a full claim', () => {
    expect(normalizePlanClaim(FULL)).toEqual(FULL);
  });

  it('keeps 0 (none allowed) and drops empty sections', () => {
    const claim = normalizePlanClaim({
      id: 'p',
      seats: {},
      limits: { concurrent: {}, monthly: { searches: 0 } },
      credits: {},
    });
    expect(claim).toEqual({ id: 'p', limits: { monthly: { searches: 0 } } });
  });

  it('trims the id and name', () => {
    expect(normalizePlanClaim({ id: ' team ', name: '  Team ' })).toEqual({ id: 'team', name: 'Team' });
  });

  it('ignores unknown keys at every level', () => {
    const claim = normalizePlanClaim({
      id: 'team',
      future: true,
      seats: { console: 1, guests: 9 },
      limits: { storageGb: 1, teleport: 3, concurrent: { agentSessions: 2, hovercraft: 1 } },
    });
    expect(claim).toEqual({
      id: 'team',
      seats: { console: 1 },
      limits: { storageGb: 1, concurrent: { agentSessions: 2 } },
    });
  });

  it('refuses a claim that is not an object', () => {
    expect(() => normalizePlanClaim('team')).toThrow(/plan must be an object/);
    expect(() => normalizePlanClaim([])).toThrow(/plan must be an object/);
  });

  it.each([undefined, '', 'Team', '-x', 'a b', 'x'.repeat(41), 5])('refuses a bad id %#', (id) => {
    expect(() => normalizePlanClaim({ id })).toThrow(/plan\.id/);
  });

  it('refuses a bad name', () => {
    expect(() => normalizePlanClaim({ id: 'p', name: '' })).toThrow(/plan\.name/);
    expect(() => normalizePlanClaim({ id: 'p', name: 'n'.repeat(61) })).toThrow(/plan\.name/);
  });

  it.each(['shadow', 'on', 'strict', 5])('ignores a legacy plan.enforcement (%s): a saas deployment always enforces', (enforcement) => {
    expect(normalizePlanClaim({ id: 'p', enforcement })).toEqual({ id: 'p' });
    expect(readStoredPlanClaim({ id: 'p', enforcement })).toEqual({ id: 'p' });
  });

  it.each([
    ['capacityPacks', { capacityPacks: -1 }],
    ['seats.console', { seats: { console: -1 } }],
    ['seats.portal', { seats: { portal: 'many' } }],
    ['limits.apiRequestsPerMinute', { limits: { apiRequestsPerMinute: Number.NaN } }],
    ['limits.concurrent.agentSessions', { limits: { concurrent: { agentSessions: 1.5 } } }],
    ['limits.concurrent.crawlers', { limits: { concurrent: { crawlers: -1 } } }],
    ['limits.concurrent.sandboxes', { limits: { concurrent: { sandboxes: '2' } } }],
    ['limits.monthly.searches', { limits: { monthly: { searches: 1e12 } } }],
    ['limits.monthly.sandboxHours', { limits: { monthly: { sandboxHours: Infinity } } }],
    ['limits.storageGb', { limits: { storageGb: -0.5 } }],
    ['limits.realtimeMaxSessionMinutes', { limits: { realtimeMaxSessionMinutes: 2.5 } }],
    ['credits.includedPerMonth', { credits: { includedPerMonth: -10 } }],
  ])('names the field path %s in the message', (path, extra) => {
    expect(() => normalizePlanClaim({ id: 'p', ...extra })).toThrow(`plan.${path}`);
  });

  it('refuses sections that are not objects, naming the section', () => {
    expect(() => normalizePlanClaim({ id: 'p', seats: 5 })).toThrow(/plan\.seats must be an object/);
    expect(() => normalizePlanClaim({ id: 'p', limits: [] })).toThrow(/plan\.limits must be an object/);
    expect(() => normalizePlanClaim({ id: 'p', limits: { monthly: 'x' } })).toThrow(
      /plan\.limits\.monthly must be an object/,
    );
  });

  it('allows a fractional storageGb and cpu but not fractional memory', () => {
    expect(normalizePlanClaim({ id: 'p', limits: { storageGb: 0.25 } })?.limits?.storageGb).toBe(0.25);
    expect(() =>
      normalizePlanClaim({ id: 'p', limits: { sandboxMaxSize: { cpu: 1, memoryMb: 512.5 } } }),
    ).toThrow(/sandboxMaxSize\.memoryMb/);
  });

  it('needs both cpu and memoryMb for sandboxMaxSize', () => {
    expect(() => normalizePlanClaim({ id: 'p', limits: { sandboxMaxSize: { cpu: 2 } } })).toThrow(
      /sandboxMaxSize needs both cpu and memoryMb/,
    );
    expect(() => normalizePlanClaim({ id: 'p', limits: { sandboxMaxSize: { memoryMb: 512 } } })).toThrow(
      /sandboxMaxSize needs both cpu and memoryMb/,
    );
    expect(() => normalizePlanClaim({ id: 'p', limits: { sandboxMaxSize: {} } })).toThrow(
      /sandboxMaxSize needs both cpu and memoryMb/,
    );
    expect(
      normalizePlanClaim({ id: 'p', limits: { sandboxMaxSize: { cpu: 2, memoryMb: 512 } } })?.limits?.sandboxMaxSize,
    ).toEqual({ cpu: 2, memoryMb: 512 });
  });
});

describe('readStoredPlanClaim', () => {
  it('reads a valid stored claim', () => {
    expect(readStoredPlanClaim(FULL)).toEqual(FULL);
  });

  it('reads absent values as undefined', () => {
    expect(readStoredPlanClaim(undefined)).toBeUndefined();
    expect(readStoredPlanClaim(null)).toBeUndefined();
  });

  it.each([42, 'x', [], { id: '' }, { id: 'p', seats: { console: -1 } }, { id: 'p', limits: { sandboxMaxSize: { cpu: 1 } } }])(
    'never throws on a malformed record %#',
    (value) => {
      expect(() => readStoredPlanClaim(value)).not.toThrow();
      expect(readStoredPlanClaim(value)).toBeUndefined();
    },
  );
});
