/**
 * Publishing an imported agent turns it on.
 *
 * An import lands as a `draft` until someone checks it and publishes. Runs,
 * reminders and triggers refuse an agent that is not `active`, so a published
 * draft that stayed `draft` could never run. Publishing makes it `active`, in
 * the record and in the version snapshot. An agent someone switched off stays
 * `inactive` when a new version is published.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));

import { getDatabase } from '@/lib/database';
import { createMockDb } from '../helpers/db.mock';
import { publishAgent } from '@/lib/services/agents/agentService';

let db: ReturnType<typeof createMockDb>;

const agentWith = (status: 'active' | 'inactive' | 'draft') => ({
    _id: 'a1',
    tenantId: 't1',
    projectId: 'p1',
    key: 'imported-agent',
    name: 'Imported agent',
    config: { modelKey: 'm' },
    status,
    publishedVersion: 3,
    latestVersion: 3,
});

beforeEach(() => {
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.createAgentVersion.mockImplementation((async (data: unknown) => data) as never);
    db.updateAgent.mockImplementation((async (_id: string, data: unknown) => data) as never);
});

/** What the agent record was updated with. */
const written = () => db.updateAgent.mock.calls[0][1] as Record<string, unknown>;
/** The status stored in the new version's snapshot. */
const snapshotStatus = () => (db.createAgentVersion.mock.calls[0][0] as { snapshot: { status: string } }).snapshot.status;

describe('publishing an agent', () => {
    it('turns an imported draft into an active agent, in the record and in the version', async () => {
        db.findAgentById.mockResolvedValue(agentWith('draft') as never);

        await publishAgent('tenant_t1', 'a1', 'u1');

        expect(written()).toMatchObject({ status: 'active', publishedVersion: 4, latestVersion: 4 });
        expect(snapshotStatus()).toBe('active');
    });

    it.each(['active', 'inactive'] as const)('leaves an %s agent as it is', async (status) => {
        db.findAgentById.mockResolvedValue(agentWith(status) as never);

        await publishAgent('tenant_t1', 'a1', 'u1');

        expect('status' in written()).toBe(false);
        expect(written()).toMatchObject({ publishedVersion: 4, latestVersion: 4 });
        expect(snapshotStatus()).toBe(status);
    });
});
