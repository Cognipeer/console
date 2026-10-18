/**
 * Prompt text is not HTML. Mustache escapes every `{{x}}` value as HTML by
 * default (`&` becomes `&amp;`, `<` becomes `&lt;`, quotes become entities), which
 * handed the model `Tom &amp; Jerry`. Everything that renders a template into
 * model-facing text goes through `renderPromptText`; these tests pin the
 * rendering itself, the agent's system prompt on top of it, and that no render
 * site goes around the helper.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import Mustache from 'mustache';
import { describe, expect, it } from 'vitest';
import type { IAgentConfig } from '@/lib/database/provider/types.domain';
import { renderPromptText } from '@/lib/shared/promptText';
import { buildPromptVariables, renderPromptTemplate } from '@/lib/services/agents/promptVariables';

const NASTY = `Tom & Jerry <b>"quoted"</b> it's a/b \`code\` x=1`;

describe('renderPromptText', () => {
    it('inserts a value with & < > " \' / ` = exactly as it is', () => {
        expect(renderPromptText('Name: {{name}}', { name: NASTY })).toBe(`Name: ${NASTY}`);
        expect(renderPromptText('{{a}}|{{b}}|{{c}}|{{d}}|{{e}}', { a: '&', b: '<', c: '>', d: '"', e: "'" })).toBe('&|<|>|"|\'');
    });

    it('treats {{{x}}} and {{&x}} like {{x}}: the same text', () => {
        const view = { x: NASTY };
        expect(renderPromptText('{{{x}}}', view)).toBe(NASTY);
        expect(renderPromptText('{{&x}}', view)).toBe(NASTY);
        expect(renderPromptText('{{x}}', view)).toBe(NASTY);
    });

    it('reads nested values, sections, inverted sections and comments as before', () => {
        const view = { user: { name: 'A & B' }, items: [{ n: '<1>' }, { n: '<2>' }], none: [], on: true };
        expect(renderPromptText('{{user.name}}', view)).toBe('A & B');
        expect(renderPromptText('{{#items}}[{{n}}]{{/items}}', view)).toBe('[<1>][<2>]');
        expect(renderPromptText('{{^none}}empty{{/none}}{{#on}}!{{/on}}{{! a comment }}', view)).toBe('empty!');
    });

    it('prints numbers and booleans as text, and nothing for a missing or null value', () => {
        expect(renderPromptText('{{n}} {{zero}} {{yes}} {{no}}', { n: 3.5, zero: 0, yes: true, no: false })).toBe('3.5 0 true false');
        expect(renderPromptText('[{{gone}}][{{nothing}}]', { nothing: null })).toBe('[][]');
    });

    it('does not touch the library: the global escaper stays and a default render still escapes', () => {
        const escaper = Mustache.escape;
        const template = 'v={{x}}';
        expect(renderPromptText(template, { x: '<&>' })).toBe('v=<&>');
        expect(Mustache.escape).toBe(escaper);
        // Same template, default call: tokens are cached per template, escaping is per call.
        expect(Mustache.render(template, { x: '<&>' })).toBe('v=&lt;&amp;&gt;');
        expect(renderPromptText(template, { x: '<&>' })).toBe('v=<&>');
    });
});

describe('the agent system prompt (renderPromptTemplate)', () => {
    const config = (extra: Partial<IAgentConfig> = {}): IAgentConfig => ({ modelKey: 'm', ...extra } as IAgentConfig);

    it('keeps a static prompt variable with special characters verbatim', () => {
        const resolved = buildPromptVariables({ config: config({ promptVariables: { customer: NASTY } }), agentKey: 'a', agentName: 'A' });
        expect(renderPromptTemplate('Customer: {{customer}}.', resolved).text).toBe(`Customer: ${NASTY}.`);
    });

    it('keeps a caller metadata value and a declared variable verbatim', () => {
        const resolved = buildPromptVariables({
            config: config({ variables: [{ name: 'q', type: 'string' }] }),
            agentKey: 'a',
            agentName: 'A & Co',
            runtimeContext: { metadata: { team: 'R&D <core>' } } as never,
            variables: { q: 'a < b && c > d' },
        });
        expect(renderPromptTemplate('{{agent.name}} / {{team}} / {{variables.q}}', resolved).text).toBe('A & Co / R&D <core> / a < b && c > d');
    });

    it('still reports unresolved placeholders and the caller-filled names', () => {
        const resolved = buildPromptVariables({
            config: config(), agentKey: 'a', agentName: 'A', runtimeContext: { metadata: { team: 'R&D' } } as never,
        });
        const rendered = renderPromptTemplate('{{team}} {{oncall}}', resolved);
        expect(rendered.text).toBe('R&D ');
        expect(rendered.unresolved).toEqual(['oncall']);
        expect(rendered.fromCaller).toEqual(['team']);
    });
});

describe('no render site goes around the helper', () => {
    const root = path.resolve(__dirname, '../..');

    const sources = (dir: string): string[] => readdirSync(dir).flatMap((entry) => {
        const full = path.join(dir, entry);
        if (entry === '__tests__' || entry === 'node_modules') return [];
        if (statSync(full).isDirectory()) return sources(full);
        return /\.(ts|tsx)$/.test(entry) ? [full] : [];
    });

    // A render that does not produce model-facing text, or that carries its own escaper.
    const ALLOWED: Record<string, string> = {
        // The prompt helper itself (the one place that calls the library's render).
        'lib/shared/promptText.ts': 'the helper',
        // Webhook templates are rendered by a writer of their own that inserts every value as JSON.
        'lib/services/agents/agentTriggerWebhookView.ts': 'JSON-escaped writer',
    };

    // Comments may talk about `Mustache.render(...)`; only code counts.
    const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

    it('calls Mustache.render / Writer.render only in the helper and the JSON-escaping webhook writer', () => {
        const offenders = sources(root)
            .map((file) => path.relative(root, file).split(path.sep).join('/'))
            .filter((rel) => !(rel in ALLOWED))
            .filter((rel) => /\bMustache\.render\s*\(|\bnew\s+Mustache\.Writer\s*\(|\bmustache\.render\s*\(/.test(withoutComments(readFileSync(path.join(root, rel), 'utf8'))));
        expect(offenders).toEqual([]);
    });
});
