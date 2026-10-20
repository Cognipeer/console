/**
 * Console identity tokens (lib/iam/consoleIdentity.ts): minted only for a real, active person of
 * the workspace, for one audience, verifiable with the key set the workspace publishes, and
 * signed with one key per workspace however many callers race to create it. Runs on a real
 * SQLite provider (helpers/iamTestDb).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalJWKSet, decodeProtectedHeader, exportJWK, generateKeyPair, calculateJwkThumbprint, jwtVerify } from 'jose';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const hoisted = vi.hoisted(() => ({ getDatabase: vi.fn() }));
vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return {
    ...actual,
    getDatabase: hoisted.getDatabase,
    runWithTenantScope: async (tenantDbName: string, fn: (db: unknown) => unknown) => {
      const db = await hoisted.getDatabase();
      return db.runWithTenant(tenantDbName, () => fn(db));
    },
  };
});

import { getConfigSource, setConfigSource, type ConfigSource } from '@/lib/core/config';
import {
  CONSOLE_IDENTITY_TTL_SECONDS,
  ConsoleIdentityError,
  consoleIdentityAudience,
  consoleIdentityCallerOf,
  consoleIdentityChunkMasker,
  consoleIdentityDiscovery,
  consoleIdentityIssuer,
  consoleIdentityOfPausedTurn,
  consoleIdentityPersonOf,
  ensureConsoleIdentityKey,
  getConsoleIdentityJwks,
  isConsoleIdentityRefusal,
  mintConsoleIdentity,
  resetConsoleIdentityCachesForTests,
  scrubConsoleIdentityError,
  scrubConsoleIdentityToken,
  scrubConsoleIdentityValue,
  type ConsoleIdentityCaller,
} from '@/lib/iam/consoleIdentity';
import { encryptObject } from '@/lib/utils/crypto';
import { createIamTestDb, type IamTestDb } from '../helpers/iamTestDb';

const originalSource = getConfigSource();
const APP_URL = 'https://console.example.com/';
const ISSUER_BASE = 'https://console.example.com/api/public/identity';
const AUD = 'https://crm.example.com/mcp';

function sourceWith(values: Record<string, string>): ConfigSource {
  return { name: 'test', get: (key) => values[key] };
}

let env: IamTestDb;
const users: Record<string, string> = {};

async function addUser(key: string, extra: Record<string, unknown> = {}, tenantId = env.tenantId): Promise<string> {
  const created = await env.db.runWithTenant(env.tenantDbName, () => env.db.createUser({
    tenantId, email: `${key}@ci.example`, name: `Person ${key}`, password: '$2b$10$x', role: 'user', licenseId: 'FREE', features: [],
  } as never));
  const id = String(created._id);
  if (Object.keys(extra).length) {
    await env.db.runWithTenant(env.tenantDbName, () => env.db.updateUser(id, extra as never));
  }
  return id;
}

/** A second, untouched workspace (its own tenant database). */
async function freshTenant(dbName: string): Promise<{ tenantId: string; tenantDbName: string }> {
  const tenant = await env.db.createTenant({
    companyName: dbName, slug: dbName.replace(/_/g, '-'), dbName, licenseType: 'FREE', ownerId: 'owner-pending',
  });
  return { tenantId: String(tenant._id), tenantDbName: dbName };
}

beforeAll(async () => {
  env = await createIamTestDb('tenant_console_identity');
  hoisted.getDatabase.mockResolvedValue(env.db);
  setConfigSource(sourceWith({ JWT_SECRET: 'console-identity-test-secret-at-least-32-chars', APP_URL }));
  users.alice = await addUser('alice');
  users.sso = await addUser('sso', { authProvider: 'oidc', externalId: 'google-sub-123' });
  users.ldap = await addUser('ldap', { authProvider: 'ldap', externalId: 'cn=ldap,dc=example,dc=com' });
  users.disabled = await addUser('disabled', { status: 'disabled' });
  users.foreign = await addUser('foreign', {}, 'another-tenant-id');
});

afterAll(async () => {
  setConfigSource(originalSource);
  await env.cleanup();
});

beforeEach(() => resetConsoleIdentityCachesForTests());
afterEach(() => vi.restoreAllMocks());

const mint = (caller: ConsoleIdentityCaller | undefined, audience = AUD) =>
  mintConsoleIdentity({ tenantId: env.tenantId, audience, caller });

async function verify(token: string, audience = consoleIdentityAudience(AUD)) {
  const jwks = createLocalJWKSet(await getConsoleIdentityJwks(env.tenantDbName));
  return jwtVerify(token, jwks, {
    issuer: consoleIdentityIssuer(env.tenantId),
    audience,
    algorithms: ['RS256'],
    typ: 'at+jwt',
  });
}

describe('minting', () => {
  it('signs a five-minute token for the person, verifiable with the published key set', async () => {
    const minted = await mint({ userId: users.alice, source: 'portal', agentKey: 'crm-helper', projectId: 'proj-1' });
    const { payload, protectedHeader } = await verify(minted.token);

    expect(protectedHeader).toMatchObject({ alg: 'RS256', typ: 'at+jwt' });
    expect(payload).toMatchObject({
      iss: `${ISSUER_BASE}/${env.tenantId}`,
      aud: AUD,
      sub: users.alice,
      email: 'alice@ci.example',
      name: 'Person alice',
      client_id: 'cognipeer-console',
      tenant_id: env.tenantId,
      project_id: 'proj-1',
      src: 'portal',
      via: 'session',
      act: { sub: 'agent:crm-helper' },
    });
    expect(payload.exp! - payload.iat!).toBe(CONSOLE_IDENTITY_TTL_SECONDS);
    expect(payload.nbf).toBe(payload.iat);
    expect(typeof payload.jti).toBe('string');
    expect(minted.summary).toMatchObject({ type: 'console_identity', sub: users.alice, via: 'session', src: 'portal', act: 'agent:crm-helper' });
    expect(minted.summary.jti).toBe(payload.jti);
    expect(JSON.stringify(minted.summary)).not.toContain(minted.token);
  });

  it('binds the token to one audience: another server rejects it', async () => {
    const { token } = await mint({ userId: users.alice });
    await expect(verify(token, 'https://other.example.com/mcp')).rejects.toThrow();
  });

  it('names how Console knew the person: delegated > trigger > api_token > session', async () => {
    const via = async (caller: ConsoleIdentityCaller) => (await verify((await mint(caller)).token)).payload.via;
    expect(await via({ userId: users.alice })).toBe('session');
    expect(await via({ userId: users.alice, tokenId: 't1', source: 'api' })).toBe('api_token');
    expect(await via({ userId: users.alice, source: 'trigger' })).toBe('trigger');
    expect(await via({ userId: users.alice, tokenId: 't1', delegated: true, source: 'api' })).toBe('delegated');
  });

  it('carries the SSO subject for an OIDC / SAML account only', async () => {
    const sso = (await verify((await mint({ userId: users.sso })).token)).payload;
    expect(sso).toMatchObject({ idp: 'oidc', idp_sub: 'google-sub-123' });
    const ldap = (await verify((await mint({ userId: users.ldap })).token)).payload;
    expect(ldap.idp).toBeUndefined();
    expect(ldap.idp_sub).toBeUndefined();
  });

  it('resolves the workspace database from the tenant id or takes it as given', async () => {
    const given = await mintConsoleIdentity({ tenantId: env.tenantId, tenantDbName: env.tenantDbName, audience: AUD, caller: { userId: users.alice } });
    const resolved = await mint({ userId: users.alice });
    expect(decodeProtectedHeader(given.token).kid).toBe(decodeProtectedHeader(resolved.token).kid);
  });
});

describe('refusals', () => {
  const codeOf = async (promise: Promise<unknown>) => {
    try {
      await promise;
      return 'minted';
    } catch (error) {
      expect(error).toBeInstanceOf(ConsoleIdentityError);
      expect(isConsoleIdentityRefusal(error)).toBe(true);
      return (error as ConsoleIdentityError).code;
    }
  };

  it('mints nothing for a call with nobody behind it', async () => {
    expect(await codeOf(mint(undefined))).toBe('no_person');
    expect(await codeOf(mint({}))).toBe('no_person');
    expect(await codeOf(mint({ userId: '' }))).toBe('no_person');
    expect(await codeOf(mint({ userId: 'system:trigger:abc' }))).toBe('no_person');
    expect(await codeOf(mint({ userId: 'a2a-public' }))).toBe('no_person');
    expect(await codeOf(mint({ userId: 'agent:helper' }))).toBe('no_person');
  });

  it('mints nothing for an unknown, foreign or disabled account', async () => {
    expect(await codeOf(mint({ userId: '0123456789abcdef01234567' }))).toBe('unknown_person');
    expect(await codeOf(mint({ userId: users.foreign }))).toBe('unknown_person');
    expect(await codeOf(mint({ userId: users.disabled }))).toBe('person_disabled');
  });

  it('mints nothing for a destination that is not an absolute http(s) URL', async () => {
    expect(await codeOf(mint({ userId: users.alice }, 'ftp://crm.example.com'))).toBe('bad_audience');
    expect(await codeOf(mint({ userId: users.alice }, 'not a url'))).toBe('bad_audience');
  });

  it('reads a failed account lookup as an outage, not a missing account, and does not remember it', async () => {
    const lookup = vi.spyOn(env.db, 'findUserById').mockRejectedValueOnce(new Error('connection reset'));
    expect(await codeOf(mint({ userId: users.alice }))).toBe('unavailable');
    expect(await codeOf(mint({ userId: users.alice }))).toBe('minted');
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('mints nothing in an unknown workspace', async () => {
    const promise = mintConsoleIdentity({ tenantId: '0123456789abcdef01234567', audience: AUD, caller: { userId: users.alice } });
    expect(await codeOf(promise)).toBe('unknown_workspace');
  });

  it('recognises a refusal that arrives as text from another node', () => {
    expect(isConsoleIdentityRefusal(new Error(new ConsoleIdentityError('no_person').message))).toBe(true);
    expect(isConsoleIdentityRefusal(new Error('MCP server responded with 401'))).toBe(false);
  });
});

describe('who the call is for', () => {
  it('takes the stamped person, and a trigger run acts for its accountable person', () => {
    expect(consoleIdentityCallerOf({ userId: 'u1', tokenId: 't1', source: 'api', via: { kind: 'delegated', issuer: 'https://idp' } }, { agentKey: 'a', projectId: 'p' }))
      .toEqual({ userId: 'u1', tokenId: 't1', delegated: true, source: 'api', agentKey: 'a', projectId: 'p' });
    expect(consoleIdentityCallerOf({ source: 'trigger', trigger: { id: 'tr', type: 'schedule' } }, { accountableUserId: 'owner-1' }))
      .toEqual({ userId: 'owner-1', source: 'trigger' });
    // Only a trigger run borrows the accountable person.
    expect(consoleIdentityCallerOf({ source: 'api' }, { accountableUserId: 'owner-1' })).toEqual({ source: 'api' });
    expect(consoleIdentityCallerOf(undefined)).toEqual({});
  });

  it('continues a pause for the person whose turn it is, never for whoever answers it', () => {
    const stored = consoleIdentityPersonOf(consoleIdentityCallerOf(
      { userId: 'owner-1', tokenId: 'tok-1', source: 'api', via: { kind: 'delegated', issuer: 'https://idp' } },
      { agentKey: 'a', projectId: 'p' },
    ));
    expect(stored).toEqual({ userId: 'owner-1', tokenId: 'tok-1', delegated: true, source: 'api' });
    // The stored person wins over everything the answering request knows.
    expect(consoleIdentityOfPausedTurn({ stored, startedBy: 'approver-9', source: 'portal' })).toEqual(stored);
    // A pause stored before it recorded the person: whoever started the turn (a trigger: its accountable person).
    expect(consoleIdentityOfPausedTurn({ stored: undefined, startedBy: 'owner-1', source: 'portal' })).toEqual({ userId: 'owner-1', source: 'portal' });
    expect(consoleIdentityOfPausedTurn({ stored: undefined, source: 'trigger', accountableUserId: 'acc-1' })).toEqual({ userId: 'acc-1', source: 'trigger' });
    // Nobody known: no person, so a Console identity call is refused instead of being made for the approver.
    expect(consoleIdentityOfPausedTurn({ stored: undefined, source: 'portal' })).toEqual({ source: 'portal' });
    // A stored value is read field by field.
    expect(consoleIdentityPersonOf({ userId: 7, delegated: 'yes', source: 'elsewhere', tokenId: 'tok' })).toEqual({ tokenId: 'tok' });
    expect(consoleIdentityPersonOf({ agentKey: 'a' })).toBeUndefined();
  });
});

describe('audience', () => {
  it('is the destination URL without query, fragment, credentials or trailing slash', () => {
    expect(consoleIdentityAudience('https://crm.example.com/mcp/')).toBe('https://crm.example.com/mcp');
    expect(consoleIdentityAudience('https://user:pw@CRM.example.com/mcp?key=secret#x')).toBe('https://crm.example.com/mcp');
    expect(consoleIdentityAudience('https://crm.example.com')).toBe('https://crm.example.com');
    expect(consoleIdentityAudience('http://crm.internal:8080/a2a')).toBe('http://crm.internal:8080/a2a');
  });
});

describe('keys', () => {
  it('publishes the public half only and keeps the private half sealed', async () => {
    await ensureConsoleIdentityKey(env.tenantDbName);
    const { keys } = await getConsoleIdentityJwks(env.tenantDbName);
    expect(keys).toHaveLength(1);
    expect(Object.keys(keys[0]).sort()).toEqual(['alg', 'e', 'kid', 'kty', 'n', 'use']);
    expect(keys[0]).toMatchObject({ kty: 'RSA', alg: 'RS256', use: 'sig' });

    const stored = await env.db.runWithTenant(env.tenantDbName, () => env.db.iamDocGet('iam_meta', 'console_identity_keys'));
    const raw = JSON.stringify(stored?.data);
    expect(raw).toContain('privateJwkSealed');
    expect(raw).not.toMatch(/"d":/);
  });

  it('an unused workspace publishes an empty key set and gets no key from reading it', async () => {
    const t = await freshTenant('tenant_ci_unused');
    expect(await getConsoleIdentityJwks(t.tenantDbName)).toEqual({ keys: [] });
    const stored = await env.db.runWithTenant(t.tenantDbName, () => env.db.iamDocGet('iam_meta', 'console_identity_keys'));
    expect(stored).toBeNull();
  });

  it('creates one key for concurrent first calls and keeps using it', async () => {
    const t = await freshTenant('tenant_ci_race');
    const person = await env.db.runWithTenant(t.tenantDbName, () => env.db.createUser({
      tenantId: t.tenantId, email: 'racer@ci.example', name: 'Racer', password: '$2b$10$x', role: 'user', licenseId: 'FREE', features: [],
    } as never));
    const caller = { userId: String(person._id) };
    const minted = await Promise.all(Array.from({ length: 6 }, () => mintConsoleIdentity({ tenantId: t.tenantId, audience: AUD, caller })));
    const kids = new Set(minted.map((m) => decodeProtectedHeader(m.token).kid));
    expect(kids.size).toBe(1);

    resetConsoleIdentityCachesForTests(); // as another node would: nothing cached
    const again = await mintConsoleIdentity({ tenantId: t.tenantId, audience: AUD, caller });
    expect(decodeProtectedHeader(again.token).kid).toBe([...kids][0]);
    expect((await getConsoleIdentityJwks(t.tenantDbName)).keys.map((k) => k.kid)).toEqual([...kids]);
  });

  it('waits for the key another node is creating instead of creating a second one', async () => {
    const t = await freshTenant('tenant_ci_wait');
    // Another node drew ticket 1 and is generating the key.
    await env.db.runWithTenant(t.tenantDbName, () => env.db.iamDocIncrement('iam_meta', 'console_identity_keygen', 'n', 1));
    const { publicKey, privateKey } = await generateKeyPair('RS256', { modulusLength: 2048, extractable: true });
    const publicJwk = await exportJWK(publicKey);
    const kid = await calculateJwkThumbprint(publicJwk);
    const otherNodeKey = {
      kid,
      alg: 'RS256',
      publicJwk: { kty: publicJwk.kty, n: publicJwk.n, e: publicJwk.e, kid, alg: 'RS256', use: 'sig' },
      privateJwkSealed: encryptObject(await exportJWK(privateKey)),
      createdAt: new Date().toISOString(),
    };
    setTimeout(() => {
      void env.db.runWithTenant(t.tenantDbName, () => env.db.iamDocPut('iam_meta', 'console_identity_keys', { keys: [otherNodeKey] }));
    }, 400);

    await ensureConsoleIdentityKey(t.tenantDbName);
    const { keys } = await getConsoleIdentityJwks(t.tenantDbName);
    expect(keys.map((k) => k.kid)).toEqual([kid]);
  });

  it('creates the key itself when the node that claimed it never writes it', async () => {
    const t = await freshTenant('tenant_ci_orphan');
    await env.db.runWithTenant(t.tenantDbName, () => env.db.iamDocIncrement('iam_meta', 'console_identity_keygen', 'n', 1));
    await ensureConsoleIdentityKey(t.tenantDbName);
    expect((await getConsoleIdentityJwks(t.tenantDbName)).keys).toHaveLength(1);
  });
});

describe('issuer', () => {
  it('comes from the configured URL and publishes a discovery document', () => {
    expect(consoleIdentityIssuer('t-1')).toBe(`${ISSUER_BASE}/t-1`);
    expect(consoleIdentityDiscovery('t-1')).toMatchObject({
      issuer: `${ISSUER_BASE}/t-1`,
      jwks_uri: `${ISSUER_BASE}/t-1/.well-known/jwks.json`,
      id_token_signing_alg_values_supported: ['RS256'],
    });
  });
});

describe('scrubbing', () => {
  it('masks a token wherever an upstream echoes it', () => {
    expect(scrubConsoleIdentityToken('401: bad token abc.def.ghi (abc.def.ghi)', 'abc.def.ghi')).toBe('401: bad token [redacted] ([redacted])');
    expect(scrubConsoleIdentityToken('nothing here', undefined)).toBe('nothing here');
  });

  const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1In0.c2lnbmF0dXJl';

  it('masks the token in the stack of an error, not only in its message', () => {
    const scrubbed = scrubConsoleIdentityError(new Error(`upstream said: Bearer ${TOKEN}`), TOKEN) as Error;
    expect(scrubbed.message).toBe('upstream said: Bearer [redacted]');
    expect(scrubbed.stack).toContain('upstream said: Bearer [redacted]');
    expect(scrubbed.stack).not.toContain(TOKEN);
    // A frozen error cannot be edited: a copy carries the safe text.
    const frozen = Object.freeze(new Error(`echo ${TOKEN}`));
    const copy = scrubConsoleIdentityError(frozen, TOKEN) as Error;
    expect(copy).not.toBe(frozen);
    expect(copy.message).toBe('echo [redacted]');
    expect(copy.stack).not.toContain(TOKEN);
  });

  it('masks the token in every string of a JSON value', () => {
    expect(scrubConsoleIdentityValue({ a: [`x ${TOKEN}`], b: 1 }, TOKEN)).toEqual({ a: ['x [redacted]'], b: 1 });
    const clean = { a: 'clean' };
    expect(scrubConsoleIdentityValue(clean, TOKEN)).toBe(clean);
    expect(scrubConsoleIdentityValue(undefined, TOKEN)).toBeUndefined();
  });

  it('masks a token that streams in across chunks, and holds back nothing else', () => {
    const out: string[] = [];
    const masker = consoleIdentityChunkMasker(TOKEN, (text) => out.push(text));
    for (const piece of ['Your header was ', TOKEN.slice(0, 5), TOKEN.slice(5, 20), TOKEN.slice(20), ' (done)', ' and e']) masker.push(piece);
    masker.flush();
    expect(out.join('')).toBe('Your header was [redacted] (done) and e');
    expect(out[0]).toBe('Your header was ');
    expect(out.some((text) => text.includes(TOKEN.slice(0, 5)))).toBe(false);
  });
});
