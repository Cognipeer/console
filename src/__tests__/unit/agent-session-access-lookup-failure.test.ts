/**
 * A lookup that FAILS (the store is down) is not the same as an id that names no session. The helpers that stand
 * in front of a session's content must answer the first one `unavailable` (503) and never read it as "not a
 * session, so nothing to protect".
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/agents')>();
  return { ...actual, getConversationById: vi.fn().mockRejectedValue(new Error('cosmos 429 TooManyRequests')) };
});

import { loadSessionForPrincipal, refuseSessionLinked } from '@/server/api/plugins/agent-session-access';

const actor = { tenantDbName: 't', projectId: 'p', userId: 'u' };
const request = {} as never;

describe('a conversation lookup that fails', () => {
  it('is unavailable for the linked paths (tracing thread, session file, run)', async () => {
    expect(await refuseSessionLinked(request, 'some-conversation-id', 'view', { actor })).toMatchObject({ ok: false, status: 503, reason: 'unavailable', need: 'view' });
    expect(await refuseSessionLinked(request, 'some-conversation-id', 'manage', { actor })).toMatchObject({ ok: false, status: 503, reason: 'unavailable', need: 'manage' });
  });

  it('is unavailable for the session loader as well - not a 404 that says the session does not exist', async () => {
    expect(await loadSessionForPrincipal(request, 'some-conversation-id', { need: 'view', actor })).toMatchObject({ ok: false, status: 503, reason: 'unavailable' });
  });

  it('asks nothing when there is no id to ask about', async () => {
    expect(await refuseSessionLinked(request, null, 'view', { actor })).toBeNull();
    expect(await refuseSessionLinked(request, '', 'view', { actor })).toBeNull();
  });
});
