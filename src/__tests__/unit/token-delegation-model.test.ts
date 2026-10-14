/**
 * The form of "acting for users" as data (components/iam/tokens/delegationModel.ts): what it sends, what it shows next to a
 * field, when it counts as changed, and that nothing is lost on the way from the server's view to the form and back.
 */
import { describe, expect, it } from 'vitest';
import {
  delegationDirty,
  delegationProblems,
  emptyDelegationForm,
  formFromView,
  formToPayload,
  formatGroupMap,
  parseAudience,
  parseGroupMapText,
  type DelegationForm,
  type DelegationView,
} from '@/components/iam/tokens/delegationModel';

const SECRET = 'a-shared-secret-of-at-least-32-characters-ok';

const hsForm = (patch: Partial<DelegationForm> = {}): DelegationForm => ({
  ...emptyDelegationForm(),
  issuer: 'https://idp.example.com/',
  audience: 'cognipeer-console',
  algorithms: ['HS256'],
  secrets: [{ kid: 'k1', secret: SECRET, stored: false }],
  ...patch,
});

const view = (patch: Partial<DelegationView> = {}): DelegationView => ({
  tokenId: 'tok-1',
  enabled: true,
  trust: {
    issuer: 'https://idp.example.com/',
    audience: ['a', 'b'],
    algorithms: ['RS256', 'ES256'],
    keys: { jwksUrl: 'https://idp.example.com/jwks.json', pem: '-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----' },
    maxTokenAgeSeconds: 900,
    clockSkewSeconds: 30,
  },
  mapping: { matchBy: ['externalId'], jit: 'person', groupMap: [{ idpGroup: 'sales', consoleGroupName: 'Sales (verified)' }] },
  allowPrivileged: true,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
  updatedBy: 'u-1',
  ...patch,
});

describe('what the form sends', () => {
  it('sends only the key material that belongs to a pinned algorithm', () => {
    const payload = formToPayload(hsForm({ jwksUrl: 'https://leftover.example.com/jwks', pem: 'leftover' })) as any;
    expect(payload.trust.keys).toEqual({ hsSecrets: [{ kid: 'k1', secret: SECRET }] });
    const rs = formToPayload(hsForm({ algorithms: ['RS256'], jwksUrl: 'https://idp.example.com/jwks.json' })) as any;
    expect(rs.trust.keys).toEqual({ jwksUrl: 'https://idp.example.com/jwks.json' });
    expect(rs.trust.keys.hsSecrets).toBeUndefined();
    const both = formToPayload(hsForm({ algorithms: ['HS256', 'ES256'], pem: '-----BEGIN PUBLIC KEY-----\nx\n-----END PUBLIC KEY-----' })) as any;
    expect(Object.keys(both.trust.keys).sort()).toEqual(['hsSecrets', 'pem']);
  });

  it('leaves a stored secret out of the body: a key id alone keeps it', () => {
    const payload = formToPayload(hsForm({ secrets: [{ kid: 'k1', secret: '', stored: true }, { kid: ' k2 ', secret: SECRET, stored: false }] })) as any;
    expect(payload.trust.keys.hsSecrets).toEqual([{ kid: 'k1' }, { kid: 'k2', secret: SECRET }]);
  });

  it('sends one audience as a string, several as a list, and numbers as numbers', () => {
    expect((formToPayload(hsForm()) as any).trust.audience).toBe('cognipeer-console');
    const payload = formToPayload(hsForm({ audience: 'a, b\nc\n a ', maxTokenAgeSeconds: ' 900 ', clockSkewSeconds: '0' })) as any;
    expect(payload.trust.audience).toEqual(['a', 'b', 'c']);
    expect(payload.trust.maxTokenAgeSeconds).toBe(900);
    expect(payload.trust.clockSkewSeconds).toBe(0);
    expect((formToPayload(hsForm()) as any).trust.maxTokenAgeSeconds).toBeUndefined();
  });

  it('turns the matching switches into the strategies, in the fixed order, and the group map into entries', () => {
    const payload = formToPayload(hsForm({ matchIdentity: true, matchEmail: true, jit: 'external', groupMapText: 'sales => Sales (verified)\n\nsupport=>Support', allowPrivileged: true })) as any;
    expect(payload.mapping).toEqual({
      matchBy: ['externalId', 'verifiedEmail'],
      jit: 'external',
      groupMap: [{ idpGroup: 'sales', consoleGroupName: 'Sales (verified)' }, { idpGroup: 'support', consoleGroupName: 'Support' }],
    });
    expect(payload.allowPrivileged).toBe(true);
    expect((formToPayload(hsForm({ matchIdentity: false })) as any).mapping.matchBy).toEqual(['verifiedEmail']);
    expect((formToPayload(hsForm()) as any).mapping.groupMap).toBeUndefined();
  });
});

describe('the way back from the server', () => {
  it('shows what is stored without losing any of it', () => {
    const form = formFromView(view());
    expect(form).toMatchObject({
      issuer: 'https://idp.example.com/',
      audience: 'a\nb',
      algorithms: ['RS256', 'ES256'],
      maxTokenAgeSeconds: '900',
      clockSkewSeconds: '30',
      matchIdentity: true,
      matchEmail: false,
      jit: 'person',
      allowPrivileged: true,
      groupMapText: 'sales => Sales (verified)',
    });
    // saving it unchanged sends the same configuration
    const payload = formToPayload(form) as any;
    expect(payload.trust).toMatchObject({ audience: ['a', 'b'], algorithms: ['RS256', 'ES256'], maxTokenAgeSeconds: 900, clockSkewSeconds: 30 });
    expect(payload.trust.keys).toEqual({ jwksUrl: 'https://idp.example.com/jwks.json', pem: '-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----' });
    expect(payload.mapping).toEqual({ matchBy: ['externalId'], jit: 'person', groupMap: [{ idpGroup: 'sales', consoleGroupName: 'Sales (verified)' }] });
  });

  it('shows stored shared secrets by key id only, and keeps them when saved', () => {
    const stored = formFromView(view({ trust: { issuer: 'i', audience: 'a', algorithms: ['HS256'], keys: { hsSecrets: [{ kid: 'k1' }, { kid: 'k2' }] } } }));
    expect(stored.secrets).toEqual([{ kid: 'k1', secret: '', stored: true }, { kid: 'k2', secret: '', stored: true }]);
    expect((formToPayload(stored) as any).trust.keys.hsSecrets).toEqual([{ kid: 'k1' }, { kid: 'k2' }]);
  });

  it('knows when the form differs from what the server holds', () => {
    const v = view();
    expect(delegationDirty(formFromView(v), v)).toBe(false);
    expect(delegationDirty({ ...formFromView(v), jit: 'none' }, v)).toBe(true);
    expect(delegationDirty({ ...formFromView(v), enabled: false }, v)).toBe(true);
    expect(delegationDirty(emptyDelegationForm(), null)).toBe(true);
    const hs = view({ trust: { issuer: 'i', audience: 'a', algorithms: ['HS256'], keys: { hsSecrets: [{ kid: 'k1' }] } } });
    const form = formFromView(hs);
    expect(delegationDirty(form, hs)).toBe(false);
    // typing a new secret for a stored key id is a change
    expect(delegationDirty({ ...form, secrets: [{ kid: 'k1', secret: SECRET, stored: true }] }, hs)).toBe(true);
    expect(delegationDirty({ ...form, secrets: [...form.secrets, { kid: 'k2', secret: '', stored: false }] }, hs)).toBe(true);
  });
});

describe('what is wrong next to a field', () => {
  const codes = (form: DelegationForm) => delegationProblems(form).map((problem) => problem.code);

  it('accepts a complete form', () => {
    expect(delegationProblems(hsForm())).toEqual([]);
    expect(delegationProblems(formFromView(view()))).toEqual([]);
  });

  it('asks for the issuer, the audience and an algorithm', () => {
    expect(codes(hsForm({ issuer: ' ' }))).toContain('issuer_required');
    expect(codes(hsForm({ audience: ' \n ,' }))).toContain('audience_required');
    expect(codes(hsForm({ algorithms: [] }))).toContain('algorithm_required');
  });

  it('holds shared secrets to the server\'s rules, row by row', () => {
    expect(delegationProblems(hsForm({ secrets: [] }))).toContainEqual({ code: 'secret_required' });
    expect(delegationProblems(hsForm({ secrets: [{ kid: 'k1', secret: 'short', stored: false }] }))).toContainEqual({ code: 'secret_too_short', at: 1 });
    expect(delegationProblems(hsForm({ secrets: [{ kid: 'k 1', secret: SECRET, stored: false }] }))).toContainEqual({ code: 'secret_kid_invalid', at: 1 });
    expect(delegationProblems(hsForm({ secrets: [{ kid: '', secret: SECRET, stored: false }] }))).toContainEqual({ code: 'secret_kid_invalid', at: 1 });
    expect(delegationProblems(hsForm({ secrets: [{ kid: 'k1', secret: SECRET, stored: false }, { kid: 'k1', secret: SECRET, stored: false }] }))).toContainEqual({ code: 'secret_kid_duplicate', at: 2 });
    expect(delegationProblems(hsForm({ secrets: [{ kid: 'k1', secret: '', stored: false }] }))).toContainEqual({ code: 'secret_required', at: 1 });
    // a stored secret needs nothing typed
    expect(delegationProblems(hsForm({ secrets: [{ kid: 'k1', secret: '', stored: true }] }))).toEqual([]);
  });

  it('asks a public-key algorithm for a key set or a key, and checks both', () => {
    const rs = hsForm({ algorithms: ['RS256'], secrets: [] });
    expect(codes(rs)).toContain('public_key_required');
    expect(codes({ ...rs, jwksUrl: 'not a url' })).toContain('jwks_url_invalid');
    expect(codes({ ...rs, jwksUrl: 'ftp://x.example.com/' })).toContain('jwks_url_invalid');
    expect(codes({ ...rs, jwksUrl: 'https://idp.example.com/jwks.json' })).toEqual([]);
    expect(codes({ ...rs, pem: 'garbage' })).toContain('pem_invalid');
    expect(codes({ ...rs, pem: '-----BEGIN PUBLIC KEY-----\nx\n-----END PUBLIC KEY-----' })).toEqual([]);
    // an HS256-only form does not ask for any of it
    expect(codes(hsForm())).not.toContain('public_key_required');
  });

  it('checks the numbers, the strategies and the group map', () => {
    expect(codes(hsForm({ maxTokenAgeSeconds: '0' }))).toContain('max_age_invalid');
    expect(codes(hsForm({ maxTokenAgeSeconds: '90000' }))).toContain('max_age_invalid');
    expect(codes(hsForm({ maxTokenAgeSeconds: 'x' }))).toContain('max_age_invalid');
    expect(codes(hsForm({ clockSkewSeconds: '-1' }))).toContain('skew_invalid');
    expect(codes(hsForm({ clockSkewSeconds: '301' }))).toContain('skew_invalid');
    expect(codes(hsForm({ maxTokenAgeSeconds: '900', clockSkewSeconds: '0' }))).toEqual([]);
    expect(codes(hsForm({ matchIdentity: false, matchEmail: false }))).toContain('match_required');
    expect(delegationProblems(hsForm({ groupMapText: 'sales => A\nbroken line' }))).toContainEqual({ code: 'group_map_invalid', at: 2 });
    expect(codes(hsForm({ groupMapText: 'a => A\na => B' }))).toContain('group_map_invalid');
  });
});

describe('text helpers', () => {
  it('parses and formats the group map', () => {
    const parsed = parseGroupMapText('sales => Sales (verified)\n  support=>Support  \n\n=> nothing\nlonely');
    expect(parsed.entries).toEqual([{ idpGroup: 'sales', consoleGroupName: 'Sales (verified)' }, { idpGroup: 'support', consoleGroupName: 'Support' }]);
    expect(parsed.badLines).toEqual([4, 5]);
    expect(formatGroupMap(parsed.entries)).toBe('sales => Sales (verified)\nsupport => Support');
    expect(formatGroupMap(undefined)).toBe('');
    expect(parseGroupMapText('a => A\na => B').duplicates).toEqual(['a']);
  });

  it('splits an audience on lines and commas, once each', () => {
    expect(parseAudience('a, b\n\nb ,c')).toEqual(['a', 'b', 'c']);
    expect(parseAudience('')).toEqual([]);
  });
});
