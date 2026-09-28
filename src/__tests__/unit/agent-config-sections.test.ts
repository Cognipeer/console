import { describe, expect, it } from 'vitest';
import { changedConfigSections } from '@/components/agents/studio/configSections';

describe('changedConfigSections', () => {
    const published = {
        modelKey: 'gpt',
        systemPrompt: 'You help.',
        toolBindings: [{ source: 'mcp', sourceKey: 'jira', toolNames: ['search'] }],
        sandbox: { enabled: true, mode: 'ephemeral' },
    };

    it('flags nothing when there is no published version', () => {
        expect(changedConfigSections(published, null).size).toBe(0);
    });

    it('flags nothing for an identical draft, key order and empty values aside', () => {
        const draft = {
            sandbox: { mode: 'ephemeral', enabled: true },
            systemPrompt: 'You help.',
            modelKey: 'gpt',
            toolBindings: [{ toolNames: ['search'], sourceKey: 'jira', source: 'mcp' }],
            skills: [],
            memory: null,
        };
        expect([...changedConfigSections(draft, published)]).toEqual([]);
    });

    it('flags exactly the sections whose keys changed', () => {
        const draft = {
            ...published,
            systemPrompt: 'You help. Share preview links.',
            sandbox: { enabled: true, mode: 'ephemeral', preview: { enabled: true } },
        };
        expect([...changedConfigSections(draft, published)].sort()).toEqual(['prompt', 'sandbox']);
    });
});
