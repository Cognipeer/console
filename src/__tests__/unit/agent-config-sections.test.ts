import { describe, expect, it } from 'vitest';
import {
    BUILD_SECTION_ORDER,
    CONFIG_SECTION_KEYS,
    changedConfigSections,
    unsetConfigSections,
} from '@/components/agents/studio/configSections';

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

describe('knowledge bases count as a change to General', () => {
    it('flags General when a knowledge base was attached or removed since the published version', () => {
        const published = { modelKey: 'gpt' };
        expect(changedConfigSections({ modelKey: 'gpt', knowledgeBindings: [{ key: 'docs' }] }, published).has('basic')).toBe(true);
        expect(changedConfigSections({ modelKey: 'gpt' }, { modelKey: 'gpt', knowledgeBindings: [{ key: 'docs' }] }).has('basic')).toBe(true);
    });
});

describe('Build order and the sections that fold while unset', () => {
    it('lists every section exactly once', () => {
        expect([...BUILD_SECTION_ORDER].sort()).toEqual(Object.keys(CONFIG_SECTION_KEYS).sort());
    });

    it('folds a capability the agent does not use, never General, Prompt, Approvals or Runtime', () => {
        const unset = unsetConfigSections({ modelKey: 'gpt', systemPrompt: 'Hi', skills: [], memory: undefined });
        expect([...unset].sort()).toEqual(['callback', 'clienttools', 'files', 'memory', 'output', 'sandbox', 'skills', 'subagents', 'variables']);
        expect(unset.has('basic') || unset.has('prompt') || unset.has('hitl') || unset.has('advanced')).toBe(false);
    });

    it('keeps a section open once anything in it is set, even when switched off', () => {
        const unset = unsetConfigSections({
            memory: { enabled: true, memoryStoreKey: 'facts' },
            sandbox: { enabled: false, template: 'python' },
            variables: [{ name: 'customer' }],
        });
        expect(unset.has('memory')).toBe(false);
        expect(unset.has('sandbox')).toBe(false);
        expect(unset.has('variables')).toBe(false);
        expect(unset.has('skills')).toBe(true);
    });

    it('counts where client tools are offered as part of Client tools', () => {
        expect(unsetConfigSections({ clientToolSurfaces: { portal: false } }).has('clienttools')).toBe(false);
        expect([...changedConfigSections({ clientToolSurfaces: { portal: false } }, {})]).toEqual(['clienttools']);
    });
});
