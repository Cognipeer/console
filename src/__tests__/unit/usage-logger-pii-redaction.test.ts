/**
 * Integration-level regression test for F-12: logModelUsage must not persist
 * raw customer PII from messages[].content into the usage log row.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));
vi.mock('@/lib/services/usage/usageEvents', () => ({
  recordUsageEvent: vi.fn().mockReturnValue({
    userId: 'user-1',
    apiTokenId: undefined,
    actorType: 'user',
    requestId: 'req-1',
    projectId: 'proj-1',
  }),
}));

import { getDatabase } from '@/lib/database';
import { logModelUsage } from '@/lib/services/models/usageLogger';
import type { IModel } from '@/lib/database';

const MODEL = {
  _id: 'model-1',
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  key: 'gpt-test',
  pricing: {},
} as unknown as IModel;

describe('logModelUsage — PII redaction on the persisted payload', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  });

  it('does not persist a customer email that appears in messages[].content', async () => {
    await logModelUsage('tenant_acme', MODEL, {
      requestId: 'req-1',
      route: '/client/v1/chat/completions',
      status: 'success',
      providerRequest: {
        apiKey: 'sk-secret-value-should-be-masked',
        messages: [
          { role: 'user', content: 'My name is Jane Doe, reach me at jane.doe@example.com' },
        ],
      },
      providerResponse: { choices: [{ message: { content: 'Sure, I\'ll email john.smith@example.com now.' } }] },
      usage: { inputTokens: 10, outputTokens: 5 },
    });

    expect(db.createModelUsageLog).toHaveBeenCalledTimes(1);
    const persisted = db.createModelUsageLog.mock.calls[0][0];
    const requestJson = JSON.stringify(persisted.providerRequest);
    const responseJson = JSON.stringify(persisted.providerResponse);

    expect(requestJson).not.toContain('jane.doe@example.com');
    expect(responseJson).not.toContain('john.smith@example.com');
    // Secret-value scrub (a different module, logRedaction.ts) still applies too.
    expect(requestJson).not.toContain('sk-secret-value-should-be-masked');
  });

  it('redacts PII from a free-text error message', async () => {
    await logModelUsage('tenant_acme', MODEL, {
      requestId: 'req-2',
      route: '/client/v1/chat/completions',
      status: 'error',
      providerRequest: {},
      providerResponse: {},
      errorMessage: 'Delivery failed for jane.doe@example.com',
      usage: {},
    });

    const persisted = db.createModelUsageLog.mock.calls[0][0];
    expect(persisted.errorMessage).not.toContain('jane.doe@example.com');
  });
});
