import { describe, expect, it } from 'vitest';
import { TENANT_DB_INDEXES } from '@/lib/database/mongodb/indexManifest';

const keysOf = (collection: string) => (TENANT_DB_INDEXES[collection] ?? []).map((index) => JSON.stringify(index.key));

describe('index manifest: agent runtime collections', () => {
  it.each([
    ['agent_session_events', [{ conversationId: 1, seq: 1 }, { expiresAt: 1 }]],
    ['agent_pending_actions', [{ conversationId: 1, status: 1 }, { status: 1, expiresAt: 1 }, { tenantId: 1, projectId: 1, status: 1 }]],
    // One rating per person per message; an agent's ratings newest first; a portal's.
    ['agent_message_feedback', [{ conversationId: 1, messageId: 1, userId: 1 }, { projectId: 1, agentKey: 1, createdAt: -1 }, { portalId: 1, createdAt: -1 }]],
    ['webhook_endpoints', [{ tenantId: 1, projectId: 1 }]],
    // (status, nextAttemptAt) serves the retry sweep and the claim; (status, createdAt) the retention.
    ['webhook_deliveries', [{ status: 1, nextAttemptAt: 1 }, { endpointId: 1, createdAt: -1 }, { tenantId: 1, eventId: 1 }, { status: 1, createdAt: 1 }]],
    ['files', [{ purpose: 1, expiresAt: 1 }, { conversationId: 1 }]],
    ['agent_runs', [{ callbackStatus: 1, updatedAt: 1 }]],
  ])('%s has the indexes its queries need', (collection, wanted) => {
    for (const key of wanted) expect(keysOf(collection)).toContain(JSON.stringify(key));
  });

  it('a message is rated once per person (unique index)', () => {
    const unique = TENANT_DB_INDEXES.agent_message_feedback.find((index) => JSON.stringify(index.key) === JSON.stringify({ conversationId: 1, messageId: 1, userId: 1 }));
    expect(unique?.options.unique).toBe(true);
  });

  it('session events expire on expiresAt (TTL)', () => {
    const ttl = TENANT_DB_INDEXES.agent_session_events.find((index) => JSON.stringify(index.key) === JSON.stringify({ expiresAt: 1 }));
    expect(ttl?.options.expireAfterSeconds).toBe(0);
  });
});
