/**
 * API tests — client PII route handlers (/api/client/v1/pii/*).
 *
 * Auth and the DB-backed scanWithPolicy are mocked. The detect/redact/mask/
 * tokenize/scan endpoints are policy-based (require policy_key) and delegate to
 * scanWithPolicy with the right action. detokenize runs for real (pure vault
 * reversal), so the tokenize → detokenize vault contract is exercised.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/apiTokenAuth', () => {
  class ApiTokenAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  return { requireApiToken: vi.fn(), ApiTokenAuthError };
});

vi.mock('@/lib/services/pii', async () => {
  const actual = await vi.importActual<typeof import('@/lib/services/pii')>('@/lib/services/pii');
  return { ...actual, scanWithPolicy: vi.fn() };
});

import { POST as detectPOST } from '@/server/api/routes/client/v1/pii/detect/route';
import { POST as redactPOST } from '@/server/api/routes/client/v1/pii/redact/route';
import { POST as maskPOST } from '@/server/api/routes/client/v1/pii/mask/route';
import { POST as tokenizePOST } from '@/server/api/routes/client/v1/pii/tokenize/route';
import { POST as detokenizePOST } from '@/server/api/routes/client/v1/pii/detokenize/route';
import { POST as scanPOST } from '@/server/api/routes/client/v1/pii/scan/route';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { scanWithPolicy } from '@/lib/services/pii';

const DEFAULT_CTX = {
  tenantId: 'tenant-1',
  tenantDbName: 'tenant_acme',
  projectId: 'proj-1',
  tokenRecord: { userId: 'user-1' },
};

function makeReq(path: string, body: object): NextRequest {
  return new NextRequest(`http://localhost/api/client/v1/pii/${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

function scanResult(overrides: Record<string, unknown> = {}) {
  return {
    inputLength: 7,
    findings: [],
    outputText: 'a@b.com',
    hasBlocking: false,
    action: 'detect',
    languages: ['global'],
    policyKey: 'support-intake',
    policyName: 'Support Intake',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (requireApiToken as ReturnType<typeof vi.fn>).mockResolvedValue(DEFAULT_CTX);
  (scanWithPolicy as ReturnType<typeof vi.fn>).mockResolvedValue(scanResult());
});

describe('auth & validation', () => {
  it('returns 401 on ApiTokenAuthError', async () => {
    (requireApiToken as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ApiTokenAuthError('Invalid token', 401),
    );
    const res = await detectPOST(makeReq('detect', { policy_key: 'p', text: 'a@b.com' }));
    expect(res.status).toBe(401);
  });

  it('requires policy_key on every detection endpoint', async () => {
    for (const POST of [detectPOST, redactPOST, maskPOST, tokenizePOST, scanPOST]) {
      const res = await POST(makeReq('x', { text: 'a@b.com' }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain('policy_key');
    }
  });

  it('requires text', async () => {
    const res = await detectPOST(makeReq('detect', { policy_key: 'p' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('text');
  });
});

describe('named endpoints pin the action and pass policy_key', () => {
  const cases: Array<[string, typeof detectPOST, string]> = [
    ['detect', detectPOST, 'detect'],
    ['redact', redactPOST, 'redact'],
    ['mask', maskPOST, 'mask'],
    ['tokenize', tokenizePOST, 'tokenize'],
  ];

  for (const [name, POST, action] of cases) {
    it(`${name} → scanWithPolicy(actionOverride: '${action}')`, async () => {
      (scanWithPolicy as ReturnType<typeof vi.fn>).mockResolvedValue(
        scanResult({ action, outputText: 'x' }),
      );
      const res = await POST(makeReq(name, { policy_key: 'support-intake', text: 'a@b.com' }));
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json.policy_key).toBe('support-intake');
      expect(json.policy_name).toBe('Support Intake');
      expect(json.action).toBe(action);
      expect(scanWithPolicy).toHaveBeenCalledWith(expect.objectContaining({
        policyKey: 'support-intake',
        projectId: 'proj-1',
        text: 'a@b.com',
        actionOverride: action,
      }));
    });
  }

  it('tokenize returns the policy-derived vault', async () => {
    (scanWithPolicy as ReturnType<typeof vi.fn>).mockResolvedValue(scanResult({
      action: 'tokenize',
      outputText: '[EMAIL_1]',
      vault: { '[EMAIL_1]': { value: 'a@b.com', category: 'email' } },
    }));
    const res = await tokenizePOST(makeReq('tokenize', { policy_key: 'support-intake', text: 'a@b.com' }));
    const json = await res.json();
    expect(json.vault['[EMAIL_1]'].value).toBe('a@b.com');
  });
});

describe('POST /api/client/v1/pii/scan', () => {
  it('passes a valid action override through', async () => {
    await scanPOST(makeReq('scan', { policy_key: 'p', text: 'a@b.com', action: 'tokenize' }));
    expect(scanWithPolicy).toHaveBeenCalledWith(expect.objectContaining({ actionOverride: 'tokenize' }));
  });

  it('uses the policy default when no action is given (actionOverride undefined)', async () => {
    await scanPOST(makeReq('scan', { policy_key: 'p', text: 'a@b.com' }));
    expect(scanWithPolicy).toHaveBeenCalledWith(expect.objectContaining({ actionOverride: undefined }));
  });

  it('rejects an invalid action override', async () => {
    const res = await scanPOST(makeReq('scan', { policy_key: 'p', text: 'a@b.com', action: 'nope' }));
    expect(res.status).toBe(400);
  });

  it('returns 404 when the policy is not found', async () => {
    (scanWithPolicy as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('PII policy with key "nope" not found'),
    );
    const res = await scanPOST(makeReq('scan', { policy_key: 'nope', text: 'a@b.com' }));
    expect(res.status).toBe(404);
  });
});

describe('POST /api/client/v1/pii/detokenize (policy-free vault reversal)', () => {
  it('returns 400 when text is missing', async () => {
    const res = await detokenizePOST(makeReq('detokenize', { vault: {} }));
    expect(res.status).toBe(400);
  });

  it('returns 400 when vault is not an object', async () => {
    const res = await detokenizePOST(makeReq('detokenize', { text: '[EMAIL_1]', vault: [] }));
    expect(res.status).toBe(400);
  });

  it('restores originals from the vault', async () => {
    const res = await detokenizePOST(makeReq('detokenize', {
      text: 'emailed [EMAIL_1] and dialed [TR_PHONE_1]',
      vault: {
        '[EMAIL_1]': { value: 'a@b.com', category: 'email' },
        '[TR_PHONE_1]': { value: '+90 532 555 22 33', category: 'tr_phone' },
      },
    }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.output_text).toBe('emailed a@b.com and dialed +90 532 555 22 33');
  });
});
