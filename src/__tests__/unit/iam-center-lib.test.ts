/**
 * Pure parts of the Authorization center's library: tenant IAM settings and the
 * token expiry rule, request context, policy rows and references, audit CSV,
 * cursors and the explanation of decision reasons.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_IAM_SETTINGS,
  IamSettingsError,
  MAX_TOKEN_LIFETIME_DAYS,
  checkTokenExpiry,
  parseIamSettingsPatch,
} from '@/lib/iam/settings';
import { buildCedarContext, isIamChannel, toCedarDatetime } from '@/lib/iam/context';
import {
  countDirectReferences,
  describeManagedPolicy,
  listManagedPolicyViews,
  policyReferences,
  summarizeEffect,
  toPolicyRow,
} from '@/lib/iam/policyRows';
import { auditItemsToCsv, csvCell, CSV_COLUMNS, type AuditFeedItem } from '@/lib/iam/auditFeed';
import { clipToBytes, deniedActionOf, policyAuditMetadata } from '@/lib/iam/audit';
import { explainReasons } from '@/lib/iam/simulate';
import { policiesAffecting } from '@/lib/iam/principals';
import { decodeCursor, encodeCursor, MAX_AUDIT_OFFSET, MAX_DIRECTORY_OFFSET } from '@/server/api/plugins/iam-directory';
import type { IIamPolicy } from '@/lib/iam/store';

const policy = (over: Partial<IIamPolicy> = {}): IIamPolicy => ({
  _id: 'p1', policyId: 'p1', name: 'P', cedar: 'forbid(principal, action, resource);', spec: null, enabled: true,
  createdBy: 'u', updatedBy: 'u', createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-02T00:00:00Z'), ...over,
});

describe('tenant IAM settings', () => {
  it('defaults to no rule', () => {
    expect(DEFAULT_IAM_SETTINGS).toEqual({ tokens: { maxLifetimeDays: null, requireExpiry: false } });
  });

  it('parses and validates a patch', () => {
    expect(parseIamSettingsPatch({ tokens: { maxLifetimeDays: 90, requireExpiry: true } })).toEqual({ tokens: { maxLifetimeDays: 90, requireExpiry: true } });
    expect(parseIamSettingsPatch({ tokens: { maxLifetimeDays: null } })).toEqual({ tokens: { maxLifetimeDays: null } });
    expect(parseIamSettingsPatch({})).toEqual({});
    expect(parseIamSettingsPatch({ tokens: {} })).toEqual({ tokens: {} });
    for (const bad of [null, [], 'x', { tokens: 1 }, { tokens: [] }, { x: 1 }, { tokens: { maxLifetimeDays: 0 } }, { tokens: { maxLifetimeDays: -1 } },
      { tokens: { maxLifetimeDays: MAX_TOKEN_LIFETIME_DAYS + 1 } }, { tokens: { maxLifetimeDays: 2.5 } }, { tokens: { maxLifetimeDays: '9' } },
      { tokens: { maxLifetimeDays: NaN } }, { tokens: { requireExpiry: 1 } }, { tokens: { extra: true } }]) {
      expect(() => parseIamSettingsPatch(bad), JSON.stringify(bad)).toThrow(IamSettingsError);
    }
    try {
      parseIamSettingsPatch({ tokens: { maxLifetimeDays: 0, requireExpiry: 'x' } });
    } catch (error) {
      expect((error as IamSettingsError).details.map((d) => d.field)).toEqual(['tokens.maxLifetimeDays', 'tokens.requireExpiry']);
    }
  });

  describe('checkTokenExpiry', () => {
    const created = new Date('2026-06-01T00:00:00Z');
    const day = 86_400_000;
    const settings = (maxLifetimeDays: number | null, requireExpiry: boolean) => ({ tokens: { maxLifetimeDays, requireExpiry } });

    it('accepts anything when there is no rule', () => {
      expect(checkTokenExpiry(settings(null, false), { expiresAt: null, createdAt: created })).toEqual({ ok: true });
      expect(checkTokenExpiry(settings(null, false), { expiresAt: new Date(created.getTime() + 9999 * day), createdAt: created })).toEqual({ ok: true });
    });

    it('requireExpiry refuses a token that never expires', () => {
      for (const missing of [null, undefined, '']) {
        expect(checkTokenExpiry(settings(null, true), { expiresAt: missing, createdAt: created })).toEqual({ ok: false, code: 'expiry_required', maxExpiresAt: null });
      }
      expect(checkTokenExpiry(settings(null, true), { expiresAt: new Date(created.getTime() + day), createdAt: created })).toEqual({ ok: true });
    });

    it('a maximum lifetime implies an expiry and caps it from the creation time', () => {
      const s = settings(30, false);
      const limit = new Date(created.getTime() + 30 * day);
      expect(checkTokenExpiry(s, { expiresAt: null, createdAt: created })).toEqual({ ok: false, code: 'expiry_required', maxExpiresAt: limit });
      expect(checkTokenExpiry(s, { expiresAt: limit, createdAt: created })).toEqual({ ok: true });
      expect(checkTokenExpiry(s, { expiresAt: new Date(limit.getTime() + 1), createdAt: created })).toEqual({ ok: false, code: 'exceeds_max_lifetime', maxExpiresAt: limit });
      expect(checkTokenExpiry(s, { expiresAt: limit.toISOString(), createdAt: created.toISOString() })).toEqual({ ok: true });
      // a shorter expiry is always fine
      expect(checkTokenExpiry(s, { expiresAt: new Date(created.getTime() + day), createdAt: created })).toEqual({ ok: true });
    });
  });
});

describe('request context', () => {
  it('keeps only usable values and always carries a time', () => {
    const now = new Date('2026-10-09T12:00:00.123Z');
    expect(buildCedarContext(undefined, now)).toEqual({ now: { __extn: { fn: 'datetime', arg: '2026-10-09T12:00:00.123Z' } } });
    expect(buildCedarContext({ projectId: 'p1', channel: 'api', method: 'post', path: '/api/x', ip: '::ffff:10.0.0.1', now: '2026-01-01T00:00:00Z' }, now)).toEqual({
      projectId: 'p1', channel: 'api', method: 'POST', path: '/api/x',
      ip: { __extn: { fn: 'ip', arg: '10.0.0.1' } },
      now: { __extn: { fn: 'datetime', arg: '2026-01-01T00:00:00.000Z' } },
    });
    // an unusable time falls back to the real one, an unusable address is dropped, empty strings are dropped
    expect(buildCedarContext({ now: 'garbage', ip: 'nope', projectId: '', channel: null }, now)).toEqual({ now: { __extn: { fn: 'datetime', arg: '2026-10-09T12:00:00.123Z' } } });
    expect(buildCedarContext({ path: 'x'.repeat(5000) }, now).path).toHaveLength(512);
  });

  it('formats Cedar datetimes and channels', () => {
    expect(toCedarDatetime(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01-01T00:00:00.000Z');
    expect(toCedarDatetime('nope')).toBeNull();
    expect(toCedarDatetime('1969-12-31T00:00:00Z')).toBeNull();
    expect(isIamChannel('portal')).toBe(true);
    expect(isIamChannel('sms')).toBe(false);
  });
});

describe('policy rows', () => {
  it('summarises effects and statements', () => {
    expect(summarizeEffect('forbid(principal, action, resource);')).toEqual({ effect: 'forbid', statementCount: 1 });
    expect(summarizeEffect('permit(principal, action, resource);\npermit(principal, action, resource);')).toEqual({ effect: 'permit', statementCount: 2 });
    expect(summarizeEffect('permit(principal, action, resource);\nforbid(principal, action, resource);')).toEqual({ effect: 'mixed', statementCount: 2 });
    expect(summarizeEffect('this is not cedar')).toEqual({ effect: 'permit', statementCount: 0 });
  });

  it('builds a row: enabled or disabled, nothing else', () => {
    const row = toPolicyRow(policy({ enabled: false, description: undefined }), new Map([['u', 'Una']]));
    expect(row).toMatchObject({
      policyId: 'p1', description: '', effect: 'forbid', enabled: false, spec: null, statementCount: 1,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', updatedBy: 'u', updatedByLabel: 'Una',
    });
    // the dry-run mode and its counters are gone from the row
    expect(Object.keys(row).sort()).toEqual([
      'cedar', 'createdAt', 'description', 'effect', 'enabled', 'name', 'policyId', 'spec', 'statementCount', 'updatedAt', 'updatedBy', 'updatedByLabel',
    ]);
    expect(toPolicyRow(policy()).enabled).toBe(true);
    expect(toPolicyRow(policy()).updatedByLabel).toBe('u'); // unresolved: the id
  });

  it('describes every managed policy in plain language', () => {
    const views = listManagedPolicyViews();
    expect(views.map((v) => v.id)).toHaveLength(12);
    for (const v of views) {
      expect(v.name.length).toBeGreaterThan(5);
      expect(v.description.length).toBeGreaterThan(20);
      expect(v.cedar).toContain('@managed(');
    }
    expect(describeManagedPolicy('managed:rbac:user-read')).toMatchObject({ group: 'rbac', effect: 'permit' });
    expect(describeManagedPolicy('managed:boundary:token-cap-write')).toMatchObject({ group: 'boundary', effect: 'forbid' });
    expect(describeManagedPolicy('managed:unknown:x')).toMatchObject({ name: 'managed:unknown:x', description: '', effect: 'permit' });
  });
});

describe('who a policy mentions', () => {
  it('reads a spec exactly', () => {
    const refs = policyReferences(policy({
      cedar: 'x', spec: { effect: 'forbid', principals: { users: ['u1'], groups: ['g1'], tokens: ['t1'], anyToken: true }, actions: ['Read'], resources: { any: true } },
    }));
    expect(refs).toMatchObject({ any: false, anyUser: false, anyToken: true });
    expect([...refs.users]).toEqual(['u1']);
    expect([...refs.groups]).toEqual(['g1']);
    expect([...refs.tokens]).toEqual(['t1']);
    expect(policyReferences(policy({ cedar: 'x', spec: { effect: 'permit', principals: { any: true }, actions: ['Read'], resources: { any: true } } })).any).toBe(true);
  });

  it('reads raw Cedar from the principal scope and every entity literal', () => {
    const refs = policyReferences(policy({
      cedar: 'forbid(principal in Group::"g-ops", action, resource) when { principal has role && principal == User::"u-boss" || principal == ApiToken::"tok\\"x" };',
    }));
    expect([...refs.groups]).toEqual(['g-ops']);
    expect([...refs.users]).toEqual(['u-boss']);
    expect([...refs.tokens]).toEqual(['tok"x']);
    expect(policyReferences(policy({ cedar: 'permit(principal, action, resource);' })).any).toBe(true);
    expect(policyReferences(policy({ cedar: 'permit(principal is User, action, resource);' }))).toMatchObject({ any: false, anyUser: true, anyToken: false });
    expect(policyReferences(policy({ cedar: 'permit(principal is ApiToken, action, resource);' }))).toMatchObject({ anyUser: false, anyToken: true });
  });

  it('counts direct references per principal', () => {
    const counts = countDirectReferences([
      policy({ policyId: 'a', cedar: 'x', spec: { effect: 'forbid', principals: { users: ['u1', 'u2'] }, actions: ['Read'], resources: { any: true } } }),
      policy({ policyId: 'b', cedar: 'forbid(principal == User::"u1", action, resource);' }),
      policy({ policyId: 'c', cedar: 'forbid(principal in Group::"g1", action, resource);' }),
    ]);
    expect(counts.get('user:u1')).toBe(2);
    expect(counts.get('user:u2')).toBe(1);
    expect(counts.get('group:g1')).toBe(1);
    expect(counts.get('user:nobody')).toBeUndefined();
  });

  it('finds the policies that apply to a principal: naming it, its groups, its owner, or everyone of its kind', () => {
    const ps = [
      policy({ policyId: 'everyone', cedar: 'permit(principal, action, resource);' }),
      policy({ policyId: 'users', cedar: 'permit(principal is User, action, resource);' }),
      policy({ policyId: 'tokens', cedar: 'permit(principal is ApiToken, action, resource);' }),
      policy({ policyId: 'u1', cedar: 'forbid(principal == User::"u1", action, resource);' }),
      policy({ policyId: 'g1', cedar: 'forbid(principal in Group::"g1", action, resource);' }),
      policy({ policyId: 't1', cedar: 'forbid(principal == ApiToken::"t1", action, resource);' }),
      policy({ policyId: 'other', cedar: 'forbid(principal == User::"u9", action, resource);' }),
    ];
    expect(policiesAffecting(ps, { type: 'user', id: 'u1', groupIds: ['g1'] }).sort()).toEqual(['everyone', 'g1', 'u1', 'users']);
    expect(policiesAffecting(ps, { type: 'user', id: 'u2', groupIds: [] }).sort()).toEqual(['everyone', 'users']);
    expect(policiesAffecting(ps, { type: 'token', id: 't1', groupIds: ['g1'], ownerId: 'u1' }).sort()).toEqual(['everyone', 'g1', 't1', 'tokens', 'u1']);
    expect(policiesAffecting(ps, { type: 'token', id: 't2', groupIds: [], ownerId: 'u2' }).sort()).toEqual(['everyone', 'tokens']);
    expect(policiesAffecting(ps, { type: 'group', id: 'g1', groupIds: [] }).sort()).toEqual(['everyone', 'g1']);
  });
});

describe('decision reasons', () => {
  it('explains managed and custom reasons, including the statement of a multi-statement policy', () => {
    const multi = policy({ policyId: 'multi', name: 'Two rules', cedar: 'permit(principal, action, resource);\nforbid(principal, action, resource);' });
    const reasons = explainReasons(['managed:rbac:user-write', 'managed:boundary:project-read', 'custom:multi#0', 'custom:multi#1', 'custom:gone'], [multi]);
    expect(reasons).toEqual([
      expect.objectContaining({ cedarId: 'managed:rbac:user-write', policyId: null, managed: true, effect: 'permit' }),
      expect.objectContaining({ cedarId: 'managed:boundary:project-read', policyId: null, managed: true, effect: 'forbid' }),
      { cedarId: 'custom:multi#0', policyId: 'multi', managed: false, name: 'Two rules', effect: 'permit' },
      { cedarId: 'custom:multi#1', policyId: 'multi', managed: false, name: 'Two rules', effect: 'forbid' },
      { cedarId: 'custom:gone', policyId: 'gone', managed: false, name: 'gone', effect: 'permit' }, // deleted since: the id
    ]);
  });
});

describe('audit', () => {
  it('clips text to a byte budget without breaking a character', () => {
    expect(clipToBytes('abc', 10)).toEqual({ text: 'abc', truncated: false });
    const clipped = clipToBytes('é'.repeat(100), 51); // 2 bytes each
    expect(clipped.truncated).toBe(true);
    expect(Buffer.byteLength(clipped.text)).toBeLessThanOrEqual(51);
    expect(clipped.text).toBe('é'.repeat(25));
  });

  it('describes a policy for the audit row with its Cedar (at most 4 KB)', () => {
    const small = policyAuditMetadata(policy({ name: 'N', enabled: false }));
    expect(small).toMatchObject({ iamChange: true, policyId: 'p1', name: 'N', enabled: false, effect: 'forbid', statementCount: 1, source: 'cedar' });
    expect(small).not.toHaveProperty('mode');
    expect(small.cedarTruncated).toBeUndefined();
    const big = policyAuditMetadata(policy({ cedar: `// ${'x'.repeat(10_000)}\nforbid(principal, action, resource);` }));
    expect(Buffer.byteLength(String(big.cedar))).toBeLessThanOrEqual(4096);
    expect(big.cedarTruncated).toBe(true);
  });

  it('reconstructs the gate action of a denial', () => {
    const admin = new Set(['members', 'iam']);
    const row = (method: string, service: string, required: string, extra: Record<string, unknown> = {}) =>
      ({ method, service, metadata: { deniedService: service, required, ...extra } });
    expect(deniedActionOf(row('GET', 'agents', 'read'), admin)).toBe('agents.read');
    expect(deniedActionOf(row('POST', 'agents', 'write'), admin)).toBe('agents.write');
    expect(deniedActionOf(row('DELETE', 'members', 'admin'), admin)).toBe('members.write'); // admin-service escalation
    expect(deniedActionOf(row('GET', 'agents', 'admin'), admin)).toBe('agents.admin'); // a route that declared its own level
    expect(deniedActionOf(row('POST', 'agents', 'admin'), admin)).toBe('agents.admin');
    expect(deniedActionOf(row('GET', 'iam', 'read', { code: 'route_not_declared' }), admin)).toBeNull();
    expect(deniedActionOf({ method: 'GET', service: 'agents', metadata: {} }, admin)).toBeNull();
  });
});

describe('csv', () => {
  it('quotes cells and neutralises formulas', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(null)).toBe('');
    expect(csvCell(42)).toBe('42');
    for (const formula of ['=1+1', '+1', '-1', '@SUM(A1)', '\tx', '\rx']) expect(csvCell(formula).replace(/^"/, '')).toMatch(/^'/);
  });

  it('writes one header and one line per item', () => {
    const item: AuditFeedItem = {
      id: '1', at: '2026-01-01T00:00:00.000Z', kind: 'denials', principal: { type: 'user', id: 'u1', label: 'Una, "U"' }, service: 'agents',
      action: 'agents.write', method: 'POST', route: '/api/agents', code: 'forbidden', decisionId: 'd1', policyId: 'p1', summary: 'Denied',
    };
    const csv = auditItemsToCsv([item]);
    const lines = csv.trimEnd().split('\n');
    expect(lines[0]).toBe(CSV_COLUMNS.join(','));
    expect(lines[1]).toBe('2026-01-01T00:00:00.000Z,denials,user,u1,"Una, ""U""",,agents,agents.write,POST,/api/agents,forbidden,d1,p1,Denied');
    expect(auditItemsToCsv([item], false).trimEnd().split('\n')).toHaveLength(1);
    expect(auditItemsToCsv([], true)).toBe(`${CSV_COLUMNS.join(',')}\n`);
    expect(auditItemsToCsv([], false)).toBe('');
  });
});

describe('cursors', () => {
  it('round-trip offsets and refuse anything else', () => {
    for (const offset of [0, 1, 50, 10_000, 100_000]) expect(decodeCursor(encodeCursor(offset))).toBe(offset);
    // a cursor becomes a database skip: it is bounded (the audit feed far tighter than the directory)
    expect(decodeCursor(encodeCursor(MAX_DIRECTORY_OFFSET + 1))).toBe('invalid');
    expect(decodeCursor(encodeCursor(10_000_000))).toBe('invalid');
    expect(decodeCursor(encodeCursor(MAX_AUDIT_OFFSET), MAX_AUDIT_OFFSET)).toBe(MAX_AUDIT_OFFSET);
    expect(decodeCursor(encodeCursor(MAX_AUDIT_OFFSET + 1), MAX_AUDIT_OFFSET)).toBe('invalid');
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor('')).toBeNull();
    for (const bad of ['garbage', 'e30', Buffer.from('{"o":-1}').toString('base64url'), Buffer.from('{"o":1.5}').toString('base64url'),
      Buffer.from('{"o":"5"}').toString('base64url'), Buffer.from('{"o":99999999999}').toString('base64url'), 'x'.repeat(100), 5 as never]) {
      expect(decodeCursor(bad)).toBe('invalid');
    }
  });
});
