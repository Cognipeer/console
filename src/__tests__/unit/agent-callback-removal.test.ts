/**
 * Removing an agent's default callback (`config.callback`) clears the field.
 *
 * `config` replaces the stored one wholesale, and a callback "has no URL" in
 * several shapes: an empty object, a cleared URL, the mask next to no URL, or
 * a JSON `null`. All of them mean "no callback" (and the stored secret goes
 * with it), so the record is written without a `callback` key: not `{}`, not
 * `{ url: '' }`, not a secret left behind with nothing to sign.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));

import { getDatabase } from '@/lib/database';
import { createMockDb } from '../helpers/db.mock';
import { createAgentRecord, updateAgentRecord } from '@/lib/services/agents/agentService';
import { AGENT_CALLBACK_SECRET_MASK as MASK, openAgentCallbackSecret, sealAgentCallbackConfig } from '@/lib/services/agents/agentCallbackConfig';
import type { IAgentConfig } from '@/lib/database';

const URL_ = 'https://hooks.example.com/agent';
const STORED = sealAgentCallbackConfig({ url: URL_, secret: 'agent-callback-secret-1' }, undefined)!;

let db: ReturnType<typeof createMockDb>;

beforeEach(() => {
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.findAgentByKey.mockResolvedValue(null);
    db.findAgentById.mockResolvedValue({ _id: 'a1', key: 'k', config: { modelKey: 'm', callback: STORED } } as never);
    db.createAgent.mockImplementation((async (data: unknown) => data) as never);
    db.updateAgent.mockImplementation((async (_id: string, data: unknown) => data) as never);
});

/** What the store was handed as the agent's config. */
const writtenConfig = (): IAgentConfig => (db.updateAgent.mock.calls[0][1] as { config: IAgentConfig }).config;

describe('updating an agent that has a callback with a stored secret', () => {
    // The ways a client says "remove it": GET, clear the URL, PUT back (mask included), an empty object, null.
    const REMOVING: Array<[string, unknown]> = [
        ['an empty object', {}],
        ['a cleared URL', { url: '' }],
        ['a cleared URL next to the mask', { url: '', secret: MASK }],
        ['the mask without a URL', { secret: MASK }],
        ['a cleared URL and an empty secret', { url: '', secret: '' }],
        ['null', null],
    ];

    it.each(REMOVING)('%s clears the field and the stored secret with it', async (_label, callback) => {
        await updateAgentRecord('t_db', 'a1', { config: { modelKey: 'm', systemPrompt: 'kept', callback } as never }, 'u');
        const saved = writtenConfig();
        expect('callback' in saved).toBe(false);
        expect(JSON.stringify(saved)).not.toContain('secretSealed');
        expect(saved).toEqual({ modelKey: 'm', systemPrompt: 'kept' });
    });

    it('a config saved without a callback key has none afterwards either', async () => {
        await updateAgentRecord('t_db', 'a1', { config: { modelKey: 'm' } as never }, 'u');
        expect('callback' in writtenConfig()).toBe(false);
    });

    it('a callback with a URL keeps working as before: the mask keeps the secret, a new value replaces it, an empty one removes it', async () => {
        await updateAgentRecord('t_db', 'a1', { config: { modelKey: 'm', callback: { url: URL_, secret: MASK } } as never }, 'u');
        expect(writtenConfig().callback?.url).toBe(URL_);
        expect(openAgentCallbackSecret(writtenConfig().callback)).toBe('agent-callback-secret-1');

        db.updateAgent.mockClear();
        await updateAgentRecord('t_db', 'a1', { config: { modelKey: 'm', callback: { url: URL_, secret: 'rotated-secret-value-2' } } as never }, 'u');
        expect(openAgentCallbackSecret(writtenConfig().callback)).toBe('rotated-secret-value-2');

        db.updateAgent.mockClear();
        await updateAgentRecord('t_db', 'a1', { config: { modelKey: 'm', callback: { url: URL_, secret: '' } } as never }, 'u');
        expect(writtenConfig().callback).toEqual({ url: URL_ });
    });

    it('the sandbox is sealed on the same save that clears the callback', async () => {
        await updateAgentRecord('t_db', 'a1', {
            config: { modelKey: 'm', callback: {}, sandbox: { enabled: true, secrets: { TOKEN: 'sandbox-secret-value' } } } as never,
        }, 'u');
        const saved = writtenConfig();
        expect('callback' in saved).toBe(false);
        expect(saved.sandbox?.secretsSealed).toBeTruthy();
        expect(JSON.stringify(saved)).not.toContain('sandbox-secret-value');
    });
});

describe('creating an agent', () => {
    it.each([['an empty object', {}], ['a cleared URL', { url: '' }], ['null', null]])('%s stores no callback', async (_label, callback) => {
        await createAgentRecord('t_db', 't', 'p', 'u', { name: 'New', config: { modelKey: 'm', callback } as never });
        const saved = (db.createAgent.mock.calls[0][0] as unknown as { config: IAgentConfig }).config;
        expect('callback' in saved).toBe(false);
        expect(saved).toEqual({ modelKey: 'm' });
    });

    it('a callback with a URL is stored sealed', async () => {
        await createAgentRecord('t_db', 't', 'p', 'u', { name: 'New', config: { modelKey: 'm', callback: { url: URL_, secret: 'agent-callback-secret-1' } } as never });
        const saved = (db.createAgent.mock.calls[0][0] as unknown as { config: IAgentConfig }).config;
        expect(saved.callback?.url).toBe(URL_);
        expect(saved.callback?.secret).toBeUndefined();
        expect(openAgentCallbackSecret(saved.callback)).toBe('agent-callback-secret-1');
    });
});
