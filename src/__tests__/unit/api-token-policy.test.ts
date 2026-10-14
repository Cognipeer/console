/**
 * Tenant token policy: what a new token or an extended expiry must satisfy,
 * how an existing token is flagged, and how the create / update requests are
 * prepared. Pure logic with an injected policy reader (no database).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/database', () => ({ runWithTenantScope: vi.fn() }));

import { checkTokenExpiry } from '@/lib/iam/settings';
import {
  NO_TOKEN_POLICY,
  MAX_EXPIRES_IN_DAYS,
  MS_PER_DAY,
  TokenPolicyUnavailableError,
  checkExpiryAgainstPolicy,
  expiryRequired,
  loadTokenPolicy,
  loadTokenPolicyForDisplay,
  parseExpiryInput,
  prepareTokenCreate,
  prepareTokenUpdate,
  presentApiToken,
  tokenExceedsPolicy,
  type TokenPolicy,
} from '@/lib/services/apiTokens/tokenPolicy';

const NOW = new Date('2026-10-09T12:00:00.000Z');
const days = (n: number) => new Date(NOW.getTime() + n * MS_PER_DAY);

const policy = (maxLifetimeDays: number | null, requireExpiry = false): TokenPolicy => ({
  tokens: { maxLifetimeDays, requireExpiry },
});
const reader = (value: TokenPolicy) => vi.fn(async () => value);

describe('expiryRequired', () => {
  it('is on for requireExpiry or any maximum lifetime', () => {
    expect(expiryRequired(NO_TOKEN_POLICY)).toBe(false);
    expect(expiryRequired(policy(null, true))).toBe(true);
    expect(expiryRequired(policy(90))).toBe(true);
    expect(expiryRequired(policy(90, true))).toBe(true);
  });
});

describe('checkExpiryAgainstPolicy', () => {
  it('accepts anything under the empty policy, including no expiry', () => {
    expect(checkExpiryAgainstPolicy({ policy: NO_TOKEN_POLICY, expiresAt: null, createdAt: NOW })).toBeNull();
    expect(checkExpiryAgainstPolicy({ policy: NO_TOKEN_POLICY, expiresAt: days(5000), createdAt: NOW })).toBeNull();
  });

  it('requires an expiry when asked to, with a stable code', () => {
    const refusal = checkExpiryAgainstPolicy({ policy: policy(null, true), expiresAt: null, createdAt: NOW });
    expect(refusal?.status).toBe(400);
    expect(refusal?.body.code).toBe('token_expiry_required');
    expect(checkExpiryAgainstPolicy({ policy: policy(null, true), expiresAt: days(9999), createdAt: NOW })).toBeNull();
  });

  it('a maximum lifetime implies an expiry and caps the date, counted from creation', () => {
    const noExpiry = checkExpiryAgainstPolicy({ policy: policy(90), expiresAt: null, createdAt: NOW });
    expect(noExpiry?.body.code).toBe('token_expiry_required');
    expect(checkExpiryAgainstPolicy({ policy: policy(90), expiresAt: days(90), createdAt: NOW })).toBeNull();
    const tooLong = checkExpiryAgainstPolicy({ policy: policy(90), expiresAt: new Date(days(90).getTime() + 1), createdAt: NOW });
    expect(tooLong?.body.code).toBe('token_expiry_too_long');
    expect(tooLong?.body.details).toEqual({ maxLifetimeDays: 90, latestExpiresAt: days(90).toISOString() });
    // Measured from createdAt, not from now: an old token has less room.
    const old = new Date(NOW.getTime() - 80 * MS_PER_DAY);
    expect(checkExpiryAgainstPolicy({ policy: policy(90), expiresAt: days(10), createdAt: old })).toBeNull();
    expect(checkExpiryAgainstPolicy({ policy: policy(90), expiresAt: days(11), createdAt: old })?.body.code).toBe('token_expiry_too_long');
  });

  it('agrees with the shared rule in settings.ts for every combination', () => {
    const policies: TokenPolicy[] = [NO_TOKEN_POLICY, policy(null, true), policy(30), policy(30, true), policy(3650)];
    const expiries: Array<Date | null> = [null, days(1), days(29), days(30), new Date(days(30).getTime() + 1), days(31), days(4000)];
    for (const p of policies) {
      for (const expiresAt of expiries) {
        const mine = checkExpiryAgainstPolicy({ policy: p, expiresAt, createdAt: NOW });
        const shared = checkTokenExpiry(p, { expiresAt, createdAt: NOW });
        expect(mine === null, JSON.stringify({ p, expiresAt })).toBe(shared.ok);
      }
    }
  });
});

describe('tokenExceedsPolicy (the badge)', () => {
  const created = new Date(NOW.getTime() - 10 * MS_PER_DAY);

  it('is false when there is no rule', () => {
    expect(tokenExceedsPolicy({ createdAt: created }, NO_TOKEN_POLICY, NOW)).toBe(false);
    expect(tokenExceedsPolicy({ createdAt: created, expiresAt: days(9000) }, NO_TOKEN_POLICY, NOW)).toBe(false);
  });

  it('flags a never-expiring token once expiry is required or a maximum is set', () => {
    expect(tokenExceedsPolicy({ createdAt: created }, policy(null, true), NOW)).toBe(true);
    expect(tokenExceedsPolicy({ createdAt: created }, policy(365), NOW)).toBe(true);
  });

  it('flags a token that lives longer than the maximum, measured from its creation', () => {
    // created 10 days ago with a 90-day maximum: the latest allowed expiry is 80 days from now
    expect(tokenExceedsPolicy({ createdAt: created, expiresAt: days(79) }, policy(90), NOW)).toBe(false);
    expect(tokenExceedsPolicy({ createdAt: created, expiresAt: days(80) }, policy(90), NOW)).toBe(false);
    expect(tokenExceedsPolicy({ createdAt: created, expiresAt: days(81) }, policy(90), NOW)).toBe(true);
    expect(tokenExceedsPolicy({ createdAt: created, expiresAt: days(300) }, policy(90), NOW)).toBe(true);
  });

  it('is false for a token that has already expired (it can no longer be used)', () => {
    expect(tokenExceedsPolicy({ createdAt: created, expiresAt: days(-1) }, policy(1), NOW)).toBe(false);
    expect(tokenExceedsPolicy({ createdAt: created, expiresAt: days(-1) }, policy(null, true), NOW)).toBe(false);
  });

  it('treats a stored string date and a missing createdAt without crashing', () => {
    expect(tokenExceedsPolicy({ createdAt: created, expiresAt: days(300).toISOString() as unknown as Date }, policy(90), NOW)).toBe(true);
    expect(tokenExceedsPolicy({ expiresAt: days(10) }, policy(90), NOW)).toBe(false);
  });
});

describe('parseExpiryInput', () => {
  const ok = (input: Parameters<typeof parseExpiryInput>[0]) => {
    const result = parseExpiryInput(input, NOW);
    if (!result.ok) throw new Error(`unexpected refusal: ${result.error.body.error}`);
    return result.expiry;
  };
  const refusal = (input: Parameters<typeof parseExpiryInput>[0]) => {
    const result = parseExpiryInput(input, NOW);
    if (result.ok) throw new Error('expected a refusal');
    return result.error;
  };

  it('nothing given = not provided', () => {
    expect(ok({})).toEqual({ provided: false });
  });

  it('null means "never expires"', () => {
    expect(ok({ expiresAt: null })).toEqual({ provided: true, value: null });
    expect(ok({ expiresInDays: null })).toEqual({ provided: true, value: null });
  });

  it('reads an ISO date-time in the future', () => {
    const value = ok({ expiresAt: '2027-01-01T00:00:00.000Z' });
    expect(value).toEqual({ provided: true, value: new Date('2027-01-01T00:00:00.000Z') });
    expect(ok({ expiresAt: '2027-01-01' })).toMatchObject({ provided: true });
  });

  it('counts expiresInDays from the server clock', () => {
    expect(ok({ expiresInDays: 30 })).toEqual({ provided: true, value: days(30) });
    expect(ok({ expiresInDays: 1 })).toEqual({ provided: true, value: days(1) });
  });

  it('refuses malformed input with token_expiry_invalid', () => {
    for (const input of [
      { expiresAt: '' },
      { expiresAt: 'tomorrow' },
      { expiresAt: '1' },
      { expiresAt: '2027-13-45' },
      { expiresAt: 1_900_000_000_000 },
      { expiresAt: {} },
      { expiresAt: true },
      { expiresInDays: 0 },
      { expiresInDays: -3 },
      { expiresInDays: 1.5 },
      { expiresInDays: '30' },
      { expiresInDays: MAX_EXPIRES_IN_DAYS + 1 },
      { expiresInDays: Number.NaN },
      { expiresInDays: Number.POSITIVE_INFINITY },
    ]) {
      const error = refusal(input as never);
      expect(error.status, JSON.stringify(input)).toBe(400);
      expect(error.body.code, JSON.stringify(input)).toBe('token_expiry_invalid');
    }
  });

  it('refuses a date that is not in the future', () => {
    expect(refusal({ expiresAt: NOW.toISOString() }).body.code).toBe('token_expiry_invalid');
    expect(refusal({ expiresAt: '2020-01-01T00:00:00Z' }).body.code).toBe('token_expiry_invalid');
  });

  it('refuses both fields at once', () => {
    expect(refusal({ expiresAt: '2027-01-01T00:00:00Z', expiresInDays: 30 }).body.code).toBe('token_expiry_invalid');
  });
});

describe('loadTokenPolicy', () => {
  it('returns what the reader returns', async () => {
    await expect(loadTokenPolicy('t', reader(policy(30)))).resolves.toEqual(policy(30));
  });

  it('fails closed: an unreadable policy is an error, not "no rule"', async () => {
    const failing = vi.fn(async () => { throw new Error('db down'); });
    await expect(loadTokenPolicy('t', failing)).rejects.toBeInstanceOf(TokenPolicyUnavailableError);
    const malformed = vi.fn(async () => ({}) as TokenPolicy);
    await expect(loadTokenPolicy('t', malformed)).rejects.toBeInstanceOf(TokenPolicyUnavailableError);
  });

  it('the display variant degrades to "no rule" instead of failing a listing', async () => {
    const failing = vi.fn(async () => { throw new Error('db down'); });
    await expect(loadTokenPolicyForDisplay('t', failing)).resolves.toEqual(NO_TOKEN_POLICY);
  });
});

describe('prepareTokenCreate', () => {
  it('defaults: no expiry, no allowlist, nothing to enforce', async () => {
    const result = await prepareTokenCreate({ body: {}, tenantDbName: 't', now: NOW, reader: reader(NO_TOKEN_POLICY) });
    expect(result).toMatchObject({ ok: true, expiresAt: null, allowedIpRanges: null });
  });

  it('takes expiry and allowlist from the body', async () => {
    const result = await prepareTokenCreate({
      body: { expiresInDays: 30, allowedIpRanges: ['203.0.113.0/24', '203.0.113.7'] },
      tenantDbName: 't',
      now: NOW,
      reader: reader(NO_TOKEN_POLICY),
    });
    expect(result).toMatchObject({ ok: true, expiresAt: days(30), allowedIpRanges: ['203.0.113.0/24', '203.0.113.7/32'] });
  });

  it('refuses a missing expiry when the tenant requires one', async () => {
    const result = await prepareTokenCreate({ body: {}, tenantDbName: 't', now: NOW, reader: reader(policy(null, true)) });
    expect(result).toMatchObject({ ok: false, status: 400, body: { code: 'token_expiry_required' } });
  });

  it('refuses an expiry beyond the tenant maximum and reports the latest allowed date', async () => {
    const result = await prepareTokenCreate({ body: { expiresInDays: 91 }, tenantDbName: 't', now: NOW, reader: reader(policy(90)) });
    expect(result).toMatchObject({
      ok: false,
      status: 400,
      body: { code: 'token_expiry_too_long', details: { maxLifetimeDays: 90, latestExpiresAt: days(90).toISOString() } },
    });
    const exact = await prepareTokenCreate({ body: { expiresInDays: 90 }, tenantDbName: 't', now: NOW, reader: reader(policy(90)) });
    expect(exact).toMatchObject({ ok: true, expiresAt: days(90) });
  });

  it('validates the request shape before it touches the policy', async () => {
    const read = reader(NO_TOKEN_POLICY);
    const badIp = await prepareTokenCreate({ body: { allowedIpRanges: ['10.0.0.0/33', 'nope'] }, tenantDbName: 't', now: NOW, reader: read });
    expect(badIp).toMatchObject({ ok: false, status: 400, body: { code: 'invalid_ip_ranges' } });
    const details = (badIp as { body: { details: Array<{ index: number; value: string }> } }).body.details;
    expect(details.map((d) => [d.index, d.value])).toEqual([[0, '10.0.0.0/33'], [1, 'nope']]);
    const badExpiry = await prepareTokenCreate({ body: { expiresAt: 'soon' }, tenantDbName: 't', now: NOW, reader: read });
    expect(badExpiry).toMatchObject({ ok: false, status: 400, body: { code: 'token_expiry_invalid' } });
    expect(read).not.toHaveBeenCalled();
  });

  it('fails closed with 503 when the policy cannot be read', async () => {
    const failing = vi.fn(async () => { throw new Error('db down'); });
    const result = await prepareTokenCreate({ body: {}, tenantDbName: 't', now: NOW, reader: failing });
    expect(result).toMatchObject({ ok: false, status: 503, body: { code: 'policy_unavailable' } });
  });
});

describe('prepareTokenUpdate', () => {
  const token = { createdAt: new Date(NOW.getTime() - 10 * MS_PER_DAY), expiresAt: days(20) };

  it('an empty body changes nothing and reads no policy', async () => {
    const read = reader(policy(30));
    const result = await prepareTokenUpdate({ body: {}, tenantDbName: 't', token, now: NOW, reader: read });
    expect(result).toEqual({ ok: true, patch: {}, policy: null });
    expect(read).not.toHaveBeenCalled();
  });

  it('renames and re-scopes the allowlist without consulting the policy', async () => {
    const read = reader(policy(30));
    const result = await prepareTokenUpdate({
      body: { label: '  CI token  ', allowedIpRanges: ['10.0.0.0/8'] },
      tenantDbName: 't', token, now: NOW, reader: read,
    });
    expect(result).toEqual({ ok: true, patch: { label: 'CI token', allowedIpRanges: ['10.0.0.0/8'] }, policy: null });
    expect(read).not.toHaveBeenCalled();
  });

  it('clears the allowlist with null or []', async () => {
    for (const allowedIpRanges of [null, []]) {
      const result = await prepareTokenUpdate({ body: { allowedIpRanges }, tenantDbName: 't', token, now: NOW });
      expect(result).toMatchObject({ ok: true, patch: { allowedIpRanges: null } });
    }
  });

  it('refuses a short label and a bad allowlist', async () => {
    expect(await prepareTokenUpdate({ body: { label: 'ab' }, tenantDbName: 't', token, now: NOW }))
      .toMatchObject({ ok: false, status: 400, body: { code: 'invalid_label' } });
    expect(await prepareTokenUpdate({ body: { label: 7 }, tenantDbName: 't', token, now: NOW }))
      .toMatchObject({ ok: false, status: 400, body: { code: 'invalid_label' } });
    expect(await prepareTokenUpdate({ body: { allowedIpRanges: ['x'] }, tenantDbName: 't', token, now: NOW }))
      .toMatchObject({ ok: false, status: 400, body: { code: 'invalid_ip_ranges' } });
  });

  it('shortening the expiry is always accepted, even when the policy is already violated', async () => {
    const read = reader(policy(5));
    const result = await prepareTokenUpdate({ body: { expiresAt: days(15).toISOString() }, tenantDbName: 't', token, now: NOW, reader: read });
    expect(result).toMatchObject({ ok: true, patch: { expiresAt: days(15) } });
    expect(read).not.toHaveBeenCalled();
  });

  it('re-saving the same expiry is a no-op that never trips a tightened policy', async () => {
    const read = reader(policy(5));
    const result = await prepareTokenUpdate({
      body: { label: 'renamed token', expiresAt: token.expiresAt.toISOString() },
      tenantDbName: 't', token, now: NOW, reader: read,
    });
    expect(result).toEqual({ ok: true, patch: { label: 'renamed token' }, policy: null });
    expect(read).not.toHaveBeenCalled();
  });

  it('extending the expiry is checked against the policy, from the token\'s creation', async () => {
    // created 10 days ago, maximum 30 days -> latest = now + 20 days
    const within = await prepareTokenUpdate({
      body: { expiresAt: days(19).toISOString() }, tenantDbName: 't',
      token: { createdAt: token.createdAt, expiresAt: days(5) }, now: NOW, reader: reader(policy(30)),
    });
    expect(within).toMatchObject({ ok: true, patch: { expiresAt: days(19) } });
    const beyond = await prepareTokenUpdate({
      body: { expiresAt: days(21).toISOString() }, tenantDbName: 't',
      token: { createdAt: token.createdAt, expiresAt: days(5) }, now: NOW, reader: reader(policy(30)),
    });
    expect(beyond).toMatchObject({ ok: false, status: 400, body: { code: 'token_expiry_too_long' } });
  });

  it('removing the expiry is an extension: refused when an expiry is required, allowed otherwise', async () => {
    const refused = await prepareTokenUpdate({ body: { expiresAt: null }, tenantDbName: 't', token, now: NOW, reader: reader(policy(null, true)) });
    expect(refused).toMatchObject({ ok: false, status: 400, body: { code: 'token_expiry_required' } });
    const allowed = await prepareTokenUpdate({ body: { expiresAt: null }, tenantDbName: 't', token, now: NOW, reader: reader(NO_TOKEN_POLICY) });
    expect(allowed).toMatchObject({ ok: true, patch: { expiresAt: null } });
  });

  it('giving a never-expiring token its first expiry counts as shortening', async () => {
    const read = reader(policy(5));
    const result = await prepareTokenUpdate({
      body: { expiresInDays: 400 }, tenantDbName: 't',
      token: { createdAt: token.createdAt, expiresAt: undefined }, now: NOW, reader: read,
    });
    expect(result).toMatchObject({ ok: true, patch: { expiresAt: days(400) } });
    expect(read).not.toHaveBeenCalled();
  });

  it('fails closed with 503 when an extension needs the policy and it cannot be read', async () => {
    const failing = vi.fn(async () => { throw new Error('db down'); });
    const result = await prepareTokenUpdate({
      body: { expiresAt: days(40).toISOString() }, tenantDbName: 't', token, now: NOW, reader: failing,
    });
    expect(result).toMatchObject({ ok: false, status: 503, body: { code: 'policy_unavailable' } });
  });
});

describe('presentApiToken', () => {
  const base = {
    _id: 'tok-1',
    userId: 'u1',
    tenantId: 't1',
    label: 'CI',
    tokenPrefix: 'cpeer_abc',
    tokenHash: 'SECRET-HASH',
    createdAt: new Date(NOW.getTime() - MS_PER_DAY),
    lastUsed: new Date(NOW.getTime() - 3_600_000),
  };

  it('adds expiry, allowlist, lastUsedAt and the policy flag, never the hash', () => {
    const view = presentApiToken(
      { ...base, expiresAt: days(10), allowedIpRanges: ['10.0.0.0/8'] } as never,
      { policy: policy(30), now: NOW, canDelete: true, canEdit: true },
    );
    expect(view).toMatchObject({
      _id: 'tok-1',
      label: 'CI',
      tokenPrefix: 'cpeer_abc',
      userId: 'u1',
      canDelete: true,
      canEdit: true,
      expiresAt: days(10).toISOString(),
      allowedIpRanges: ['10.0.0.0/8'],
      lastUsedAt: base.lastUsed.toISOString(),
      lastUsed: base.lastUsed,
      exceedsTenantPolicy: false,
      servicePermissions: null,
      createdBy: null,
    });
    expect(JSON.stringify(view)).not.toContain('SECRET-HASH');
  });

  it('a legacy token reads as unrestricted, non-expiring and never used', () => {
    const view = presentApiToken({ ...base, lastUsed: undefined } as never, { policy: NO_TOKEN_POLICY, now: NOW });
    expect(view).toMatchObject({
      expiresAt: null,
      allowedIpRanges: null,
      lastUsedAt: null,
      exceedsTenantPolicy: false,
      canDelete: false,
      canEdit: false,
    });
  });

  it('flags a token outside the policy and normalizes an empty / damaged list to null', () => {
    const flagged = presentApiToken({ ...base, allowedIpRanges: [] } as never, { policy: policy(null, true), now: NOW });
    expect(flagged.exceedsTenantPolicy).toBe(true);
    expect(flagged.allowedIpRanges).toBeNull();
  });
});
