/**
 * What a chat surface shows around an agent: the welcome text and the starters.
 */

import { describe, expect, it } from 'vitest';
import {
    AGENT_STARTERS_MAX,
    AGENT_STARTER_LABEL_MAX,
    AGENT_STARTER_TEXT_MAX,
    AGENT_WELCOME_MAX,
    escapeForMarkdown,
    renderWelcomeTemplate,
    resolveAgentExperience,
    toClientExperience,
    validateExperienceConfig,
} from '@/lib/services/agents/agentExperience';
import { validateAgentConfigShape } from '@/lib/services/agents/agentConfigValidation';

const fields = (config: Parameters<typeof validateExperienceConfig>[0]) => validateExperienceConfig(config).errors.map((e) => e.field);

describe('validateExperienceConfig', () => {
    it('absent, empty and complete configs are fine', () => {
        expect(fields({})).toEqual([]);
        expect(fields({ experience: {} })).toEqual([]);
        expect(fields({ experience: { welcome: 'Hi', starters: [{ text: 'What can you do?', label: 'Abilities', autoSend: true }] } })).toEqual([]);
        expect(fields({ experience: { starters: Array.from({ length: AGENT_STARTERS_MAX }, (_, i) => ({ text: `q${i}` })) } })).toEqual([]);
    });

    it('refuses what a surface could not show', () => {
        expect(fields({ experience: 'hello' as never })).toEqual(['experience']);
        expect(fields({ experience: { welcome: 'x'.repeat(AGENT_WELCOME_MAX + 1) } })).toEqual(['experience.welcome']);
        expect(fields({ experience: { welcome: 5 as never } })).toEqual(['experience.welcome']);
        expect(fields({ experience: { starters: 'a' as never } })).toEqual(['experience.starters']);
        expect(fields({ experience: { starters: Array.from({ length: AGENT_STARTERS_MAX + 1 }, (_, i) => ({ text: `q${i}` })) } })).toEqual(['experience.starters']);
        expect(fields({ experience: { starters: [{ text: '  ' }] } })).toEqual(['experience.starters.0.text']);
        expect(fields({ experience: { starters: [{ text: 'x'.repeat(AGENT_STARTER_TEXT_MAX + 1) }] } })).toEqual(['experience.starters.0.text']);
        expect(fields({ experience: { starters: [{ text: 'ok', label: 'x'.repeat(AGENT_STARTER_LABEL_MAX + 1) }] } })).toEqual(['experience.starters.0.label']);
        expect(fields({ experience: { starters: [{ text: 'ok', autoSend: 'yes' as never }] } })).toEqual(['experience.starters.0.autoSend']);
        expect(fields({ experience: { starters: [null as never] } })).toEqual(['experience.starters.0']);
    });

    it('names every problem, by position', () => {
        expect(fields({ experience: { starters: [{ text: '' }, { text: 'fine' }, { text: '' }] } })).toEqual(['experience.starters.0.text', 'experience.starters.2.text']);
    });

    it('a save is checked with the rest of the config, connected agents included', () => {
        const config = { modelKey: 'm', experience: { starters: [{ text: '' }] } };
        expect(validateAgentConfigShape(config).errors.map((e) => e.field)).toContain('experience.starters.0.text');
        const external = { kind: 'external' as const, experience: { welcome: 'x'.repeat(AGENT_WELCOME_MAX + 1) } };
        expect(validateAgentConfigShape(external).errors.map((e) => e.field)).toEqual(['experience.welcome']);
    });
});

describe('resolveAgentExperience', () => {
    it('an agent that set nothing has nothing', () => {
        expect(resolveAgentExperience(undefined)).toEqual({ starters: [] });
        expect(resolveAgentExperience({})).toEqual({ starters: [] });
        expect(resolveAgentExperience({ experience: {} })).toEqual({ starters: [] });
    });

    it('trims, drops blank starters, caps the list and always says whether a starter sends at once', () => {
        const resolved = resolveAgentExperience({
            experience: {
                welcome: '  Hello there  ',
                starters: [
                    { text: '  one  ', label: '  First ' },
                    { text: '   ' },
                    { text: 'two', autoSend: true },
                    ...Array.from({ length: 10 }, (_, i) => ({ text: `more ${i}` })),
                ],
            },
        });
        expect(resolved.welcome).toBe('Hello there');
        expect(resolved.starters).toHaveLength(AGENT_STARTERS_MAX);
        expect(resolved.starters.slice(0, 2)).toEqual([
            { text: 'one', label: 'First', autoSend: false },
            { text: 'two', autoSend: true },
        ]);
    });

    it('survives a malformed stored value', () => {
        expect(resolveAgentExperience({ experience: { starters: [null, 4, { text: 3 }, { text: 'ok' }] as never } }).starters).toEqual([{ text: 'ok', autoSend: false }]);
        expect(resolveAgentExperience({ experience: 'broken' as never })).toEqual({ starters: [] });
    });
});

describe('toClientExperience', () => {
    it('is absent when the agent set nothing', () => {
        expect(toClientExperience({})).toBeUndefined();
        expect(toClientExperience({ experience: { welcome: '  ' } })).toBeUndefined();
    });

    it('speaks snake_case', () => {
        expect(toClientExperience({ experience: { welcome: 'Hi', starters: [{ text: 'q', label: 'Q', autoSend: true }, { text: 'r' }] } })).toEqual({
            welcome: 'Hi',
            starters: [{ text: 'q', label: 'Q', auto_send: true }, { text: 'r', auto_send: false }],
        });
    });
});

describe('renderWelcomeTemplate', () => {
    const variables = { user: { name: 'Ada Lovelace', email: 'ada@example.com' }, portal: { name: 'Acme Help' }, agent: { name: 'Support' } };

    it('fills the four variables', () => {
        expect(renderWelcomeTemplate('Hi {{user.firstName}} ({{user.name}}), welcome to {{portal.name}} — I am {{agent.name}}.', variables))
            .toBe('Hi Ada (Ada Lovelace), welcome to Acme Help — I am Support.');
        expect(renderWelcomeTemplate('{{ user.firstName }}', variables)).toBe('Ada');
    });

    it('falls back to the e-mail name, and to nothing', () => {
        expect(renderWelcomeTemplate('Hi {{user.name}} / {{user.firstName}}', { user: { email: 'grace.hopper@example.com' } })).toBe('Hi grace\\.hopper / grace\\.hopper');
        expect(renderWelcomeTemplate('Hi {{user.firstName}}!', {})).toBe('Hi !');
    });

    it('leaves any other {{…}} alone', () => {
        expect(renderWelcomeTemplate('{{user.password}} {{other}} {{ agent.name }}', variables)).toBe('{{user.password}} {{other}} Support');
    });

    it('a name cannot add Markdown: links, images, tags and emphasis are escaped', () => {
        const hostile = '[click](https://evil.example) ![x](https://evil.example/p.png) <script>alert(1)</script> **bold** `code`';
        const out = renderWelcomeTemplate('Hi {{user.name}}', { user: { name: hostile } });
        expect(out).not.toMatch(/(^|[^\\])\[/);
        expect(out).not.toMatch(/(^|[^\\])</);
        expect(out).not.toMatch(/(^|[^\\])\*/);
        expect(out).not.toMatch(/(^|[^\\])`/);
        expect(out).not.toMatch(/(^|[^\\])!/);
    });

    it('a name is one line and short', () => {
        expect(escapeForMarkdown('Ada\n\n# Heading\tand\u0000more')).toBe('Ada \\# Heading and more');
        expect(escapeForMarkdown('x'.repeat(500)).length).toBe(80);
        expect(escapeForMarkdown('www.evil.com')).toBe('www\\.evil\\.com');
    });

    it('does not touch the Markdown the admin wrote', () => {
        expect(renderWelcomeTemplate('**Welcome**, {{user.firstName}}!\n\n- one\n- two', variables)).toBe('**Welcome**, Ada!\n\n- one\n- two');
    });
});
