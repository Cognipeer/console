/**
 * API tests — PII service Fastify plugin.
 * Mocks the service layer; verifies routing, validation, request shape.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/database', async () => {
  const actual = await vi.importActual<typeof import('@/lib/database')>('@/lib/database');
  return {
    ...actual,
    getDatabase: vi.fn().mockResolvedValue({
      switchToTenant: vi.fn().mockResolvedValue(undefined),
      findUserById: vi.fn().mockResolvedValue({
        _id: 'user-1',
        email: 'a@b.com',
        role: 'owner',
        tenantId: 'tenant-1',
        servicePermissions: {},
      }),
    }),
  };
});

vi.mock('@/lib/services/pii', () => ({
  buildDefaultPolicyCategories: vi.fn().mockReturnValue({ email: true, phone: true }),
  createPiiPolicy: vi.fn(),
  deletePiiPolicy: vi.fn(),
  detectPii: vi.fn(),
  getCategoryCatalog: vi.fn().mockReturnValue([
    { id: 'email', label: 'Email address', description: '', languages: ['global'], severity: 'high', defaultEnabled: true },
  ]),
  getPiiPolicy: vi.fn(),
  listPiiPolicies: vi.fn(),
  maskPii: vi.fn(),
  redactPii: vi.fn(),
  tokenizePii: vi.fn(),
  detokenizePii: vi.fn(),
  scanWithPolicy: vi.fn(),
  updatePiiPolicy: vi.fn(),
}));

vi.mock('@/lib/services/projects/projectContext', () => {
  class ProjectContextError extends Error {
    status: number;
    constructor(msg: string, status: number) {
      super(msg);
      this.status = status;
    }
  }
  return {
    ProjectContextError,
    resolveProjectContext: vi.fn().mockResolvedValue({
      projectId: 'proj-1',
      project: { _id: 'proj-1', key: 'default', name: 'Default' },
      userProject: null,
    }),
  };
});

import { piiApiPlugin } from '@/server/api/plugins/pii';
import {
  createPiiPolicy,
  detectPii,
  listPiiPolicies,
  maskPii,
  redactPii,
  tokenizePii,
  detokenizePii,
  scanWithPolicy,
} from '@/lib/services/pii';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const HEADERS = {
  'x-tenant-db-name': 'tenant_acme',
  'x-tenant-id': 'tenant-1',
  'x-tenant-slug': 'acme',
  'x-user-id': 'user-1',
  'x-user-email': 'a@b.com',
  'x-user-role': 'admin',
  'x-license-type': 'PROFESSIONAL',
};

const MOCK_POLICY = {
  id: 'p-1',
  key: 'default-pii-scan',
  name: 'Default PII Scan',
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  defaultAction: 'detect',
  categories: { email: true, phone: true },
  customPatterns: [],
  languages: [],
  enabled: true,
  createdBy: 'user-1',
};

beforeEach(() => {
  vi.clearAllMocks();
  (listPiiPolicies as ReturnType<typeof vi.fn>).mockResolvedValue([MOCK_POLICY]);
  (createPiiPolicy as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_POLICY);
  (detectPii as ReturnType<typeof vi.fn>).mockReturnValue({
    inputLength: 17,
    findings: [{ category: 'email', value: 'a@b.com', start: 0, end: 7 }],
    outputText: 'a@b.com',
    hasBlocking: false,
    action: 'detect',
    languages: ['global'],
  });
  (redactPii as ReturnType<typeof vi.fn>).mockReturnValue({
    inputLength: 17,
    findings: [],
    outputText: '[REDACTED_EMAIL]',
    hasBlocking: false,
    action: 'redact',
    languages: ['global'],
  });
  (maskPii as ReturnType<typeof vi.fn>).mockReturnValue({
    inputLength: 17,
    findings: [],
    outputText: 'a*****@b.com',
    hasBlocking: false,
    action: 'mask',
    languages: ['global'],
  });
  (tokenizePii as ReturnType<typeof vi.fn>).mockReturnValue({
    inputLength: 17,
    findings: [],
    outputText: '[EMAIL_1]',
    hasBlocking: false,
    action: 'tokenize',
    languages: ['global'],
    vault: { '[EMAIL_1]': { value: 'a@b.com', category: 'email' } },
  });
  (detokenizePii as ReturnType<typeof vi.fn>).mockReturnValue({ outputText: 'a@b.com' });
  (scanWithPolicy as ReturnType<typeof vi.fn>).mockResolvedValue({
    inputLength: 17,
    findings: [],
    outputText: 'a@b.com',
    hasBlocking: false,
    action: 'detect',
    languages: ['global'],
    policyKey: 'default-pii-scan',
    policyName: 'Default PII Scan',
  });
});

describe('GET /api/pii/categories', () => {
  it('returns the catalog with defaults and supported languages', async () => {
    const app = await createFastifyApiTestApp(piiApiPlugin);
    const res = await app.inject({ method: 'GET', url: '/api/pii/categories', headers: HEADERS });
    expect(res.statusCode).toBe(200);
    const body = parseJsonBody<{ categories: unknown[]; defaults: unknown; supportedLanguages: string[] }>(res.body);
    expect(Array.isArray(body.categories)).toBe(true);
    expect(body.supportedLanguages).toContain('tr');
    expect(body.supportedLanguages).toContain('en');
  });
});

describe('GET /api/pii/policies', () => {
  it('returns 200 with policies array', async () => {
    const app = await createFastifyApiTestApp(piiApiPlugin);
    const res = await app.inject({ method: 'GET', url: '/api/pii/policies', headers: HEADERS });
    expect(res.statusCode).toBe(200);
    const body = parseJsonBody<{ policies: unknown[] }>(res.body);
    expect(body.policies).toHaveLength(1);
  });
});

describe('POST /api/pii/policies', () => {
  it('rejects when name is missing', async () => {
    const app = await createFastifyApiTestApp(piiApiPlugin);
    const res = await app.inject({
      method: 'POST',
      url: '/api/pii/policies',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      payload: { defaultAction: 'detect' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects invalid defaultAction', async () => {
    const app = await createFastifyApiTestApp(piiApiPlugin);
    const res = await app.inject({
      method: 'POST',
      url: '/api/pii/policies',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      payload: { name: 'X', defaultAction: 'nope' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('creates a policy on valid payload', async () => {
    const app = await createFastifyApiTestApp(piiApiPlugin);
    const res = await app.inject({
      method: 'POST',
      url: '/api/pii/policies',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      payload: { name: 'Default PII Scan', defaultAction: 'detect' },
    });
    expect(res.statusCode).toBe(201);
    expect(createPiiPolicy).toHaveBeenCalled();
  });
});

describe('POST /api/pii/detect', () => {
  it('rejects when text is missing', async () => {
    const app = await createFastifyApiTestApp(piiApiPlugin);
    const res = await app.inject({
      method: 'POST',
      url: '/api/pii/detect',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns detection result', async () => {
    const app = await createFastifyApiTestApp(piiApiPlugin);
    const res = await app.inject({
      method: 'POST',
      url: '/api/pii/detect',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      payload: { text: 'a@b.com', locale: 'tr' },
    });
    expect(res.statusCode).toBe(200);
    expect(detectPii).toHaveBeenCalled();
  });
});

describe('POST /api/pii/redact', () => {
  it('returns redacted output', async () => {
    const app = await createFastifyApiTestApp(piiApiPlugin);
    const res = await app.inject({
      method: 'POST',
      url: '/api/pii/redact',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      payload: { text: 'a@b.com' },
    });
    expect(res.statusCode).toBe(200);
    expect(redactPii).toHaveBeenCalled();
  });
});

describe('POST /api/pii/mask', () => {
  it('returns masked output', async () => {
    const app = await createFastifyApiTestApp(piiApiPlugin);
    const res = await app.inject({
      method: 'POST',
      url: '/api/pii/mask',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      payload: { text: 'a@b.com' },
    });
    expect(res.statusCode).toBe(200);
    expect(maskPii).toHaveBeenCalled();
  });
});

describe('POST /api/pii/tokenize', () => {
  it('returns tokenized output with a vault', async () => {
    const app = await createFastifyApiTestApp(piiApiPlugin);
    const res = await app.inject({
      method: 'POST',
      url: '/api/pii/tokenize',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      payload: { text: 'a@b.com' },
    });
    expect(res.statusCode).toBe(200);
    expect(tokenizePii).toHaveBeenCalled();
    const body = parseJsonBody<{ outputText: string; vault: Record<string, unknown> }>(res.body);
    expect(body.vault['[EMAIL_1]']).toBeDefined();
  });
});

describe('POST /api/pii/detokenize', () => {
  it('rejects when text is missing', async () => {
    const app = await createFastifyApiTestApp(piiApiPlugin);
    const res = await app.inject({
      method: 'POST',
      url: '/api/pii/detokenize',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      payload: { vault: {} },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects when vault is missing or not an object', async () => {
    const app = await createFastifyApiTestApp(piiApiPlugin);
    const res = await app.inject({
      method: 'POST',
      url: '/api/pii/detokenize',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      payload: { text: '[EMAIL_1]', vault: [] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('restores the original text from the vault', async () => {
    const app = await createFastifyApiTestApp(piiApiPlugin);
    const res = await app.inject({
      method: 'POST',
      url: '/api/pii/detokenize',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      payload: { text: '[EMAIL_1]', vault: { '[EMAIL_1]': { value: 'a@b.com', category: 'email' } } },
    });
    expect(res.statusCode).toBe(200);
    expect(detokenizePii).toHaveBeenCalled();
    const body = parseJsonBody<{ outputText: string }>(res.body);
    expect(body.outputText).toBe('a@b.com');
  });
});

describe('POST /api/pii/scan', () => {
  it('rejects when policy_key is missing', async () => {
    const app = await createFastifyApiTestApp(piiApiPlugin);
    const res = await app.inject({
      method: 'POST',
      url: '/api/pii/scan',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      payload: { text: 'a@b.com' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects when text is missing', async () => {
    const app = await createFastifyApiTestApp(piiApiPlugin);
    const res = await app.inject({
      method: 'POST',
      url: '/api/pii/scan',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      payload: { policy_key: 'default-pii-scan' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('runs a scan with a stored policy', async () => {
    const app = await createFastifyApiTestApp(piiApiPlugin);
    const res = await app.inject({
      method: 'POST',
      url: '/api/pii/scan',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      payload: { policy_key: 'default-pii-scan', text: 'a@b.com' },
    });
    expect(res.statusCode).toBe(200);
    expect(scanWithPolicy).toHaveBeenCalledWith(expect.objectContaining({
      policyKey: 'default-pii-scan',
      text: 'a@b.com',
    }));
  });
});
