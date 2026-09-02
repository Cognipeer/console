/**
 * API tests — GET /api/client/v1/guardrails (the token-authenticated list) and
 * the regex-rule diagnostic on the write path.
 *
 * Run against the LIVE Fastify plugin, not `src/server/api/routes/**`, which is
 * dead code: a test of the dead tree would pass while the surface an SDK talks
 * to kept answering 404.
 *
 * What is locked here, and why each one is a real failure mode:
 *   · the tenant and project come from the TOKEN — a query parameter must not
 *     move either, and another project's guardrail must not appear;
 *   · a workspace-level guardrail (no projectId) IS listed, because
 *     `/guardrails/hooks/evaluate` will evaluate it by key;
 *   · the envelope is `{ guardrails: [...] }`, matching the `{ guardrail }` the
 *     create/update routes on this same surface return;
 *   · a webhook policy's bearer token, url and secret refs never leave the
 *     server;
 *   · `hooksSummary.servable` answers "can I evaluate tool.pre against this
 *     one?" without a second request, for authored AND legacy rows.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services/apiTokenAuth', () => {
  class ApiTokenAuthError extends Error {
    status: number;

    constructor(message: string, status = 401) {
      super(message);
      this.name = 'ApiTokenAuthError';
      this.status = status;
    }
  }

  return { ApiTokenAuthError, requireApiTokenFromHeader: vi.fn() };
});

// Sync factories only: an async `vi.mock` factory does not intercept in this
// repo, and the module under test would silently bind the real service.
vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
  getTenantDatabase: vi.fn(),
  runWithTenantScope: vi.fn(),
}));

// The whole barrel, because the client plugin imports the dashboard plugin for
// the shared half of this surface and that one reaches for far more of it.
// `hooks/legacy` (the lift) and `families/regex` (the diagnostic) are NOT
// mocked — they are the logic under test.
vi.mock('@/lib/services/guardrail', () => ({
  buildDefaultPresetPolicy: vi.fn(),
  createGuardrail: vi.fn(),
  createWordList: vi.fn(),
  deleteGuardrail: vi.fn(),
  deleteWordList: vi.fn(),
  evaluateGuardrail: vi.fn(),
  getGuardrail: vi.fn(),
  getGuardrailByKey: vi.fn(),
  getWordList: vi.fn(),
  listGuardrails: vi.fn(),
  listWordLists: vi.fn(),
  MODERATION_CATEGORIES: [],
  normalizeWordArray: vi.fn(),
  parseWordListContent: vi.fn(),
  PII_CATEGORIES: [],
  PROMPT_SHIELD_ISSUES: [],
  runHook: vi.fn(),
  updateGuardrail: vi.fn(),
  updateWordList: vi.fn(),
  WORD_FILTER_BUILTIN_LISTS: [],
  WordListValidationError: class WordListValidationError extends Error {},
}));

import { requireApiTokenFromHeader, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { getDatabase } from '@/lib/database';
import { createGuardrail, evaluateGuardrail, listGuardrails } from '@/lib/services/guardrail';
import { clientGuardrailsApiPlugin } from '@/server/api/plugins/client-guardrails';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

function mockFn(fn: unknown): ReturnType<typeof vi.fn> {
  return fn as ReturnType<typeof vi.fn>;
}

const AUTH_CTX = {
  token: 'tok_abc',
  tokenRecord: { _id: 'tok-1', userId: 'user-1' },
  tenant: { licenseType: 'PROFESSIONAL' },
  tenantId: 'tenant-1',
  tenantSlug: 'acme',
  tenantDbName: 'tenant_acme',
  projectId: 'proj-1',
  user: { _id: 'user-1', role: 'owner', tenantId: 'tenant-1' },
};

/** Must never appear in a response body. */
const WEBHOOK_BEARER = 'sk-partner-do-not-leak';
const SYNC_BLOCK = { timing: 'sync', onFail: 'block' } as const;

/** An AUTHORED config: hooksVersion >= 1, so `ensureHooks` uses it verbatim. */
const AUTHORED_GUARDRAIL = {
  id: 'gr-1',
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  key: 'pii-guard',
  name: 'PII Guard',
  description: 'Customer PII on the way in and on tool calls',
  type: 'preset',
  target: 'input',
  action: 'block',
  enabled: true,
  failMode: 'closed',
  mode: 'monitor',
  hooksVersion: 2,
  createdBy: 'user-1',
  createdAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-08-20T10:00:00.000Z',
  hooks: {
    contractVersion: 2,
    policies: [
      {
        id: 'pii-1',
        family: 'pii',
        enabled: true,
        label: 'Customer PII',
        hooks: ['input.pre', 'tool.pre'],
        schedule: SYNC_BLOCK,
        action: 'redact',
        piiPolicyKey: 'default-pii',
      },
      {
        id: 'partner-webhook',
        family: 'webhook',
        enabled: true,
        hooks: ['tool.pre'],
        schedule: SYNC_BLOCK,
        url: 'https://partner.internal.example.com/guard',
        headers: { Authorization: `Bearer ${WEBHOOK_BEARER}` },
        credentialProviderKey: 'partner-bearer',
        signingSecretRef: 'config:partner-hmac',
        send: 'text',
      },
      {
        // Bound to a hook whose BINDING is off: named by a policy, still not
        // servable.
        id: 'shield',
        family: 'prompt_shield',
        enabled: true,
        hooks: ['output.pre'],
        schedule: SYNC_BLOCK,
        modelKey: 'gpt-4o-mini',
        sensitivity: 'balanced',
      },
    ],
    bindings: {
      'input.pre': { enabled: true, schedule: SYNC_BLOCK, timeoutMs: 1500 },
      'tool.pre': { enabled: true, schedule: SYNC_BLOCK, failMode: 'open' },
      'output.pre': { enabled: false, schedule: SYNC_BLOCK },
    },
    stream: { enabled: false },
  },
};

/** A LEGACY row: no `hooks`, no `hooksVersion`, and no project — the shape the
 *  key-scoped routes reach through their workspace-level fallback. */
const WORKSPACE_LEGACY_GUARDRAIL = {
  id: 'gr-2',
  tenantId: 'tenant-1',
  key: 'workspace-pii',
  name: 'Workspace PII',
  type: 'preset',
  target: 'input',
  action: 'block',
  enabled: true,
  createdBy: 'user-1',
  createdAt: '2026-07-01T10:00:00.000Z',
  policy: {
    pii: { enabled: true, action: 'block', categories: { email: true } },
  },
};

const OTHER_PROJECT_GUARDRAIL = {
  id: 'gr-3',
  tenantId: 'tenant-1',
  projectId: 'proj-other',
  key: 'other-project-guard',
  name: 'Another team’s policy',
  type: 'preset',
  target: 'input',
  action: 'block',
  enabled: true,
  createdBy: 'user-9',
  createdAt: '2026-08-02T10:00:00.000Z',
};

interface ListedGuardrail {
  key: string;
  name: string;
  type: string;
  action: string;
  enabled: boolean;
  failMode?: string;
  mode?: string;
  hooksVersion?: number;
  hooks?: unknown;
  effectiveMode: string;
  hooksSummary: {
    contractVersion: number;
    authored: boolean;
    servable: string[];
    bindings: Record<string, { enabled: boolean; timing: string; onFail: string }>;
    policies: Array<Record<string, unknown>>;
    stream: { enabled: boolean } | null;
  };
}

describe('GET /api/client/v1/guardrails', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockFn(requireApiTokenFromHeader).mockResolvedValue(AUTH_CTX);
    mockFn(getDatabase).mockResolvedValue({
      runWithTenant: <T,>(_tenantDbName: string, operation: () => T) => operation(),
    });
    mockFn(listGuardrails).mockResolvedValue([
      AUTHORED_GUARDRAIL,
      WORKSPACE_LEGACY_GUARDRAIL,
      OTHER_PROJECT_GUARDRAIL,
    ]);
    app = await createFastifyApiTestApp(clientGuardrailsApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  function list(query = '') {
    return app.inject({
      method: 'GET',
      url: `/api/client/v1/guardrails${query}`,
      headers: { authorization: 'Bearer tok_abc' },
    });
  }

  it('answers with a { guardrails: [...] } envelope, like the sibling { guardrail } routes', async () => {
    const response = await list();
    const body = parseJsonBody<{ guardrails: ListedGuardrail[] }>(response.body);

    expect(response.statusCode).toBe(200);
    expect(Array.isArray(body.guardrails)).toBe(true);
    // Not a bare array, and not the dashboard's `templates` companion.
    expect(Array.isArray(body)).toBe(false);
    expect((body as Record<string, unknown>).templates).toBeUndefined();
  });

  it('reads the tenant from the token and ignores tenant/project query parameters', async () => {
    const response = await list('?tenant_id=tenant-evil&tenantDbName=tenant_evil&project_id=proj-other');
    const body = parseJsonBody<{ guardrails: ListedGuardrail[] }>(response.body);

    expect(response.statusCode).toBe(200);
    expect(listGuardrails).toHaveBeenCalledTimes(1);
    expect(listGuardrails).toHaveBeenCalledWith('tenant_acme', {
      enabled: undefined,
      search: undefined,
      type: undefined,
    });
    // The forged project id changes nothing: scoping is applied to the token's.
    expect(body.guardrails.map((guardrail) => guardrail.key)).toEqual([
      'pii-guard',
      'workspace-pii',
    ]);
  });

  it('lists the token project and workspace-level rows, never another project', async () => {
    const body = parseJsonBody<{ guardrails: ListedGuardrail[] }>((await list()).body);
    const keys = body.guardrails.map((guardrail) => guardrail.key);

    expect(keys).toContain('pii-guard');
    // Reachable by key from /guardrails/hooks/evaluate, so it must be listed.
    expect(keys).toContain('workspace-pii');
    expect(keys).not.toContain('other-project-guard');
    expect(body.guardrails).toHaveLength(2);
  });

  it('passes the enabled / type / search filters to the store', async () => {
    await list('?enabled=true&type=preset&search=pii');

    expect(listGuardrails).toHaveBeenCalledWith('tenant_acme', {
      enabled: true,
      search: 'pii',
      type: 'preset',
    });
  });

  it('rejects an unknown type instead of silently listing nothing', async () => {
    const response = await list('?type=bogus');

    expect(response.statusCode).toBe(400);
    expect(parseJsonBody<{ error: string }>(response.body).error).toContain('type must be');
    expect(listGuardrails).not.toHaveBeenCalled();
  });

  it('returns the create/update serialisation, plus mode, hooksVersion and the hook summary', async () => {
    const body = parseJsonBody<{ guardrails: ListedGuardrail[] }>((await list()).body);
    const guardrail = body.guardrails[0];

    expect(guardrail).toMatchObject({
      key: 'pii-guard',
      name: 'PII Guard',
      description: 'Customer PII on the way in and on tool calls',
      type: 'preset',
      action: 'block',
      enabled: true,
      failMode: 'closed',
      mode: 'monitor',
      hooksVersion: 2,
    });
    expect(guardrail.effectiveMode).toBe('monitor');
    expect(guardrail.hooksSummary.contractVersion).toBe(2);
    expect(guardrail.hooksSummary.authored).toBe(true);
  });

  it('answers "can I evaluate tool.pre against this one?" without a second request', async () => {
    const body = parseJsonBody<{ guardrails: ListedGuardrail[] }>((await list()).body);
    const authored = body.guardrails[0];

    expect(authored.hooksSummary.servable).toEqual(['input.pre', 'tool.pre']);
    // A policy names output.pre, but its binding is off — the engine answers a
    // vacuous allow there, so the list must not advertise it.
    expect(authored.hooksSummary.servable).not.toContain('output.pre');
    expect(authored.hooksSummary.bindings['output.pre'].enabled).toBe(false);
    expect(authored.hooksSummary.bindings['input.pre']).toMatchObject({
      enabled: true,
      timing: 'sync',
      onFail: 'block',
    });
  });

  it('summarises a legacy row from the lift, exactly as the engine would resolve it', async () => {
    const body = parseJsonBody<{ guardrails: ListedGuardrail[] }>((await list()).body);
    const legacy = body.guardrails.find((guardrail) => guardrail.key === 'workspace-pii');

    expect(legacy).toBeDefined();
    // Derived on read, not authored — a caller must be able to tell.
    expect(legacy?.hooksSummary.authored).toBe(false);
    expect(legacy?.hooksSummary.servable).toEqual(['input.pre', 'output.pre']);
    expect(legacy?.hooksSummary.policies.some((policy) => policy.family === 'pii')).toBe(true);
    // No mode column on a legacy row: `enabled` is what makes it enforcing.
    expect(legacy?.effectiveMode).toBe('enforce');
  });

  it('folds `enabled` into effectiveMode', async () => {
    mockFn(listGuardrails).mockResolvedValue([{ ...AUTHORED_GUARDRAIL, enabled: false }]);

    const body = parseJsonBody<{ guardrails: ListedGuardrail[] }>((await list()).body);

    expect(body.guardrails[0].mode).toBe('monitor');
    expect(body.guardrails[0].effectiveMode).toBe('disabled');
  });

  it('never returns a webhook policy\'s credentials, url or secret refs', async () => {
    const response = await list();
    const body = parseJsonBody<{ guardrails: ListedGuardrail[] }>(response.body);
    const webhookPolicy = body.guardrails[0].hooksSummary.policies.find(
      (policy) => policy.family === 'webhook',
    );

    // The whole response, not just the parsed policy: a secret that leaks
    // through some other key is still a leaked secret.
    expect(response.body).not.toContain(WEBHOOK_BEARER);
    expect(response.body).not.toContain('partner.internal.example.com');
    expect(response.body).not.toContain('config:partner-hmac');
    expect(response.body).not.toContain('partner-bearer');

    // The policy is still REPORTED — a caller has to know a webhook runs on
    // tool.pre — with its identity and nothing else.
    expect(webhookPolicy).toMatchObject({
      id: 'partner-webhook',
      family: 'webhook',
      enabled: true,
      hooks: ['tool.pre'],
    });
    expect(Object.keys(webhookPolicy ?? {}).sort()).toEqual(
      ['enabled', 'family', 'hooks', 'id'].sort(),
    );
    // The authored blob itself is not on a list response at all.
    expect(body.guardrails[0].hooks).toBeUndefined();
  });

  it('refuses a token whose owner has no read on the guardrail service', async () => {
    mockFn(requireApiTokenFromHeader).mockResolvedValue({
      ...AUTH_CTX,
      user: {
        _id: 'user-2',
        role: 'user',
        tenantId: 'tenant-1',
        servicePermissions: { guardrails: 'none' },
      },
    });

    const response = await list();

    expect(response.statusCode).toBe(403);
    expect(parseJsonBody<{ error: string }>(response.body).error).toContain('guardrails');
    expect(listGuardrails).not.toHaveBeenCalled();
  });

  it('propagates an auth failure as its own status', async () => {
    mockFn(requireApiTokenFromHeader).mockRejectedValue(
      new ApiTokenAuthError('Invalid token', 401),
    );

    const response = await list();

    expect(response.statusCode).toBe(401);
    expect(listGuardrails).not.toHaveBeenCalled();
  });

  it('answers 500 when the store fails', async () => {
    mockFn(listGuardrails).mockRejectedValue(new Error('cosmos unavailable'));

    const response = await list();

    expect(response.statusCode).toBe(500);
    expect(parseJsonBody<{ error: string }>(response.body).error).toBe('cosmos unavailable');
  });
});

describe('POST /api/client/v1/guardrails — regex rule diagnostics', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockFn(requireApiTokenFromHeader).mockResolvedValue(AUTH_CTX);
    mockFn(getDatabase).mockResolvedValue({
      runWithTenant: <T,>(_tenantDbName: string, operation: () => T) => operation(),
    });
    app = await createFastifyApiTestApp(clientGuardrailsApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  function create(pattern: string, flags?: string, enabled = true) {
    return app.inject({
      method: 'POST',
      url: '/api/client/v1/guardrails',
      headers: { authorization: 'Bearer tok_abc', 'content-type': 'application/json' },
      payload: {
        name: 'Card scanner',
        type: 'preset',
        hooks: {
          policies: [
            {
              id: 'card-rule',
              family: 'regex',
              enabled,
              hooks: ['input.pre'],
              schedule: SYNC_BLOCK,
              rules: [
                {
                  id: 'card-number',
                  label: 'Card number',
                  pattern,
                  ...(flags === undefined ? {} : { flags }),
                  category: 'custom',
                  severity: 'high',
                  maxMatchChars: 64,
                },
              ],
            },
          ],
          bindings: { 'input.pre': { enabled: true, schedule: SYNC_BLOCK } },
        },
      },
    });
  }

  it('names the inline flag and says where the flag belongs', async () => {
    const response = await create('(?i)secret');
    const { error } = parseJsonBody<{ error: string }>(response.body);

    expect(response.statusCode).toBe(400);
    expect(error).toContain('Regex rule "card-number"');
    expect(error).toContain('inline flags');
    expect(error).toContain('"flags" field');
    // The engine's own words, which are the specific half.
    expect(error).toContain('Invalid regular expression');
    expect(error).not.toBe('Regex rule "card-number" is not a valid pattern');
    expect(createGuardrail).not.toHaveBeenCalled();
  });

  it('keeps the generic report — with the engine\'s message — for anything else', async () => {
    const response = await create('(unclosed');
    const { error } = parseJsonBody<{ error: string }>(response.body);

    expect(response.statusCode).toBe(400);
    expect(error).toContain('pattern does not compile');
    expect(error).toContain('Unterminated group');
    // No invented advice about a construct this pattern does not contain.
    expect(error).not.toContain('inline flags');
    expect(createGuardrail).not.toHaveBeenCalled();
  });

  it('blames the flags field, not the pattern, when only the flags are refused', async () => {
    const response = await create('secret', 'x');
    const { error } = parseJsonBody<{ error: string }>(response.body);

    expect(response.statusCode).toBe(400);
    expect(error).toContain('flags "x" are not supported');
    expect(error).not.toContain('pattern does not compile');
    expect(createGuardrail).not.toHaveBeenCalled();
  });

  it('lets a compilable rule through to the rest of the write path', async () => {
    mockFn(createGuardrail).mockResolvedValue({ id: 'gr-9', key: 'card-scanner' });

    const response = await create('\\b\\d{16}\\b', 'i');

    expect(response.statusCode).toBe(201);
    expect(createGuardrail).toHaveBeenCalled();
  });

  it('leaves a DISABLED policy alone, as the shared validator does', async () => {
    mockFn(createGuardrail).mockResolvedValue({ id: 'gr-9', key: 'card-scanner' });

    // A parked work-in-progress rule runs nowhere; refusing to save it would be
    // a stricter gate than the dashboard's, for no enforcement gain.
    const response = await create('(?i)secret', undefined, false);

    expect(response.statusCode).toBe(201);
  });
});

/**
 * The retired Aegis client surface. `@cognipeer/console-sdk` ≤ 1.7.x still
 * calls these three paths; a bare Fastify 404 there is indistinguishable from
 * a typo, and a consumer whose catch block treats transport errors as an
 * outage fails OPEN on the call that was meant to gate a tool. The routes
 * answer 410 with the replacement path instead — behind the same auth and
 * RBAC as every other route on this surface.
 */
describe('retired /api/client/v1/aegis/* surface answers 410 Gone', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockFn(requireApiTokenFromHeader).mockResolvedValue(AUTH_CTX);
    mockFn(getDatabase).mockResolvedValue({
      runWithTenant: <T,>(_tenantDbName: string, operation: () => T) => operation(),
    });
    app = await createFastifyApiTestApp(clientGuardrailsApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  const CASES = [
    {
      method: 'POST' as const,
      url: '/api/client/v1/aegis/evaluate',
      replacement: '/api/client/v1/guardrails/hooks/evaluate',
    },
    {
      method: 'GET' as const,
      url: '/api/client/v1/aegis/shields',
      replacement: '/api/client/v1/guardrails',
    },
    {
      method: 'GET' as const,
      url: '/api/client/v1/aegis/shields/shield_123/audit',
      replacement: null,
    },
  ];

  type GoneBody = {
    error: { type: string; code: string; message: string; replacement: string | null };
  };

  function call(
    method: 'GET' | 'POST',
    url: string,
    headers: Record<string, string> = { authorization: 'Bearer tok_abc' },
  ) {
    return app.inject({
      method,
      url,
      headers: method === 'POST' ? { ...headers, 'content-type': 'application/json' } : headers,
      // What a 1.7.x `client.aegis.evaluate()` sends. It must not be evaluated.
      ...(method === 'POST' ? { payload: { shieldId: 'shield_123', input: 'rm -rf /' } } : {}),
    });
  }

  it.each(CASES)('$method $url → 410 naming the replacement', async ({ method, url, replacement }) => {
    const response = await call(method, url);
    const body = parseJsonBody<GoneBody>(response.body);

    expect(response.statusCode).toBe(410);
    expect(body.error).toMatchObject({ type: 'gone', code: 'aegis_removed', replacement });
    expect(body.error.message.length).toBeGreaterThan(0);
    expect(response.headers.deprecation).toBe('true');
    if (replacement) {
      expect(response.headers.link).toBe(`<${replacement}>; rel="successor-version"`);
      expect(body.error.message).toContain(replacement);
    } else {
      expect(response.headers.link).toBeUndefined();
    }
    // A retired path evaluates and lists nothing.
    expect(evaluateGuardrail).not.toHaveBeenCalled();
    expect(listGuardrails).not.toHaveBeenCalled();
  });

  it('points the audit caller at the evaluation-log surface and the trace id, with no token-facing replacement', async () => {
    const body = parseJsonBody<GoneBody>(
      (await call('GET', '/api/client/v1/aegis/shields/shield_123/audit')).body,
    );

    expect(body.error.replacement).toBeNull();
    expect(body.error.message).toContain('/api/guardrails/:id/evaluations');
    expect(body.error.message).toContain('traceId');
  });

  it.each(CASES)('$method $url still answers 401, not 410, without a valid token', async ({ method, url }) => {
    mockFn(requireApiTokenFromHeader).mockRejectedValue(new ApiTokenAuthError('Invalid token', 401));

    const response = await call(method, url, { authorization: 'Bearer nope' });

    expect(response.statusCode).toBe(401);
  });

  it('applies guardrail RBAC first — the /aegis prefix maps to the guardrails service', async () => {
    mockFn(requireApiTokenFromHeader).mockResolvedValue({
      ...AUTH_CTX,
      user: {
        _id: 'user-2',
        role: 'user',
        tenantId: 'tenant-1',
        servicePermissions: { guardrails: 'none' },
      },
    });

    const response = await call('GET', '/api/client/v1/aegis/shields');

    expect(response.statusCode).toBe(403);
    expect(parseJsonBody<{ error: string }>(response.body).error).toContain('guardrails');
  });
});
