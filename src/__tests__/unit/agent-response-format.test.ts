/**
 * Per-request structured output: the converter check that turns a request's
 * `response_format` / `text.format` into a contract (or refuses it), the
 * precedence over `config.structuredOutput` for that turn, and the turn
 * options that ride with a paused state so a continuation applies the same
 * schema and inputs.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
    MAX_RESPONSE_FORMAT_SCHEMA_BYTES,
    resolveResponseFormatSchema,
    resolveStructuredOutputSchema,
    resolveTurnOutputSchema,
} from '@/lib/services/agents/agentRuntimeConfig';
import { parsePausedState, serializePausedState } from '@/lib/services/agents/agentPendingActions';
import type { AgentResponseFormat } from '@/lib/database/provider/types.domain';

const TRIAGE: AgentResponseFormat = {
    type: 'json_schema',
    name: 'triage',
    schema: { type: 'object', properties: { label: { type: 'string' }, score: { type: 'number' } }, required: ['label'] },
};
const CONFIGURED = {
    enabled: true,
    schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
};

describe('resolveResponseFormatSchema', () => {
    it('json_object is any JSON object', () => {
        const result = resolveResponseFormatSchema({ type: 'json_object' });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.schema.safeParse({ anything: [1, 2], nested: { a: 1 } }).success).toBe(true);
        expect(result.schema.safeParse('text').success).toBe(false);
        expect(result.schema.safeParse([1]).success).toBe(false);
    });

    it('converts a draft-07 object schema with the converter config.structuredOutput uses', () => {
        const result = resolveResponseFormatSchema(TRIAGE);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.schema.safeParse({ label: 'bug' }).success).toBe(true);
        expect(result.schema.safeParse({ score: 1 }).success).toBe(false);
        expect(result.schema.safeParse({ label: 1 }).success).toBe(false);
    });

    it('strict promotes every property to required and closes the object', () => {
        const result = resolveResponseFormatSchema({ ...TRIAGE, strict: true });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.schema.safeParse({ label: 'bug' }).success).toBe(false);
        expect(result.schema.safeParse({ label: 'bug', score: 2, extra: 1 }).success).toBe(false);
        expect(result.schema.safeParse({ label: 'bug', score: 2 }).success).toBe(true);
    });

    it.each([
        ['an unknown top-level type (degrades to z.any)', { type: 'weird' }],
        ['no type at all', { properties: { a: { type: 'string' } } }],
        ['a scalar top level', { type: 'string' }],
        ['an array top level', { type: 'array', items: { type: 'string' } }],
        ['an object that declares nothing', { type: 'object' }],
        ['an anyOf at the top', { anyOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { type: 'string' }] }],
    ])('refuses %s', (_label, schema) => {
        const result = resolveResponseFormatSchema({ type: 'json_schema', schema });
        expect(result.ok).toBe(false);
    });

    it('refuses a schema over the size ceiling and a json_schema without a schema', () => {
        const huge = { type: 'object', properties: { a: { type: 'string', description: 'x'.repeat(MAX_RESPONSE_FORMAT_SCHEMA_BYTES) } } };
        expect(resolveResponseFormatSchema({ type: 'json_schema', schema: huge }).ok).toBe(false);
        expect(resolveResponseFormatSchema({ type: 'json_schema' }).ok).toBe(false);
    });

    it('an object with open additionalProperties and no properties is allowed', () => {
        expect(resolveResponseFormatSchema({ type: 'json_schema', schema: { type: 'object', additionalProperties: true } }).ok).toBe(true);
    });
});

describe('resolveTurnOutputSchema (precedence)', () => {
    it('the agent\'s configured structured output applies when the request brings none', () => {
        const schema = resolveTurnOutputSchema({ structuredOutput: CONFIGURED });
        expect(schema?.safeParse({ summary: 's' }).success).toBe(true);
        expect(resolveTurnOutputSchema({})).toBeUndefined();
    });

    it('the request\'s format REPLACES the configured one for that turn', () => {
        const schema = resolveTurnOutputSchema({ structuredOutput: CONFIGURED }, TRIAGE)!;
        expect(schema.safeParse({ label: 'bug' }).success).toBe(true);
        // The configured contract is not merged in: it is not enforced on this turn.
        expect(schema.safeParse({ summary: 's' }).success).toBe(false);
    });

    it('applies on an agent that configured no structured output at all', () => {
        expect(resolveTurnOutputSchema({}, TRIAGE)).toBeInstanceOf(z.ZodObject);
        expect(resolveTurnOutputSchema({ structuredOutput: { enabled: false, schema: CONFIGURED.schema } }, { type: 'json_object' })).toBeInstanceOf(z.ZodObject);
    });

    it('json_object over a configured schema is "any object", not the configured shape', () => {
        const schema = resolveTurnOutputSchema({ structuredOutput: CONFIGURED }, { type: 'json_object' })!;
        expect(schema.safeParse({ unrelated: true }).success).toBe(true);
    });

    it('a stored format that cannot be converted fails the run instead of falling back to free text', () => {
        expect(() => resolveTurnOutputSchema({ structuredOutput: CONFIGURED }, { type: 'json_schema', schema: { type: 'weird' } })).toThrow();
        // (The configured one alone is unchanged.)
        expect(resolveStructuredOutputSchema(CONFIGURED)).toBeDefined();
    });
});

describe('the paused state carries the turn options', () => {
    const state = {
        messages: [{ role: 'user', content: 'hi' }],
        pendingApprovals: [{ id: 'ap-1', status: 'pending', toolName: 't', args: {} }],
        ctx: { __awaitingApproval: true },
    } as never;

    it('round-trips responseFormat and inputs, so a resume rebuilds the same turn', () => {
        const text = serializePausedState(state, 'agent', undefined, {
            responseFormat: TRIAGE,
            inputs: { customer_id: 'c-1' },
        })!;
        const parsed = parsePausedState(text)!;
        expect(parsed.turn).toEqual({ responseFormat: TRIAGE, inputs: { customer_id: 'c-1' } });
        expect(parsed.state.pendingApprovals).toHaveLength(1);
    });

    it('keeps "inputs stay out of the prompt" with the pause', () => {
        const text = serializePausedState(state, 'agent', undefined, { inputs: { a: 1 }, inputsAsPromptVariables: false })!;
        expect(parsePausedState(text)!.turn).toEqual({ inputs: { a: 1 }, inputsAsPromptVariables: false });
    });

    it('a turn without options stores none, and an old state without them parses', () => {
        const plain = serializePausedState(state, 'agent')!;
        expect(JSON.parse(plain).turn).toBeUndefined();
        expect(parsePausedState(plain)!.turn).toBeUndefined();
        expect(parsePausedState(serializePausedState(state, 'agent', undefined, {})!)!.turn).toBeUndefined();
    });
});
