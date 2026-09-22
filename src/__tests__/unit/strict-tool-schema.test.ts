/**
 * Tool schemas in a provider's STRICT mode.
 *
 * With structured output on, OpenAI-family models get tools bound with
 * `strict: true`, which requires every property in `required` and every
 * object closed. The knowledge tools' optional `offset` broke that and the
 * provider rejected every such request — found by the incident-triage e2e.
 * These tests check the transformed schemas against the rule itself, through
 * LangChain's own strict conversion, and that the executor still receives
 * the arguments it always did.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import { makeToolsStrictCompatible, toStrictCompatible } from '@/lib/services/agents/strictToolSchema';
import { toolInputSchemaToZod } from '@/lib/services/agents/agentRuntimeConfig';

type JsonSchema = { type?: unknown; properties?: Record<string, JsonSchema>; required?: string[]; additionalProperties?: unknown; items?: JsonSchema };

/** OpenAI strict mode's own rules, checked recursively. */
function violations(schema: JsonSchema, path = 'root'): string[] {
    const out: string[] = [];
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (types.includes('object')) {
        const props = Object.keys(schema.properties ?? {});
        const required = schema.required ?? [];
        for (const key of props) if (!required.includes(key)) out.push(`${path}.${key} not required`);
        if (schema.additionalProperties !== false) out.push(`${path} not closed`);
        for (const key of props) out.push(...violations(schema.properties![key], `${path}.${key}`));
    }
    if (schema.items) out.push(...violations(schema.items, `${path}[]`));
    return out;
}

const strictParams = (schema: z.ZodTypeAny) =>
    (convertToOpenAITool({ name: 't', description: 'd', schema }, { strict: true }) as { function: { parameters: JsonSchema } }).function.parameters;

describe('strict-compatible tool schemas', () => {
    const readLines = z.object({
        documentId: z.string(),
        offset: z.number().int().optional(),
        limit: z.number().int().optional(),
    });

    it('the original knowledge tool schema breaks strict mode — the bug', () => {
        expect(violations(strictParams(readLines))).toEqual(['root.offset not required', 'root.limit not required']);
    });

    it('the transformed one satisfies it', () => {
        expect(violations(strictParams(toStrictCompatible(readLines).schema))).toEqual([]);
    });

    it('drops the nulls the model sends for "not given"', () => {
        const { restore } = toStrictCompatible(readLines);
        expect(restore({ documentId: 'd1', offset: null, limit: 50 })).toEqual({ documentId: 'd1', limit: 50 });
    });

    it('closes nested objects and keeps nested optionals optional', () => {
        const schema = z.object({ filter: z.object({ tag: z.string().optional() }).optional() });
        const t = toStrictCompatible(schema);
        expect(violations(strictParams(t.schema))).toEqual([]);
        expect(t.restore({ filter: { tag: null } })).toEqual({ filter: {} });
        expect(t.restore({ filter: null })).toEqual({});
    });

    it('carries a free-form object as JSON text and decodes it for the executor', () => {
        // An OpenAPI body with no declared properties has no strict form.
        const schema = toolInputSchemaToZod({ type: 'object', properties: { body: { type: 'object' } }, required: ['body'] });
        const t = toStrictCompatible(schema);
        expect(violations(strictParams(t.schema))).toEqual([]);
        expect(t.restore({ body: '{"query":"{app=\\"postgres\\"}"}' })).toEqual({ body: { query: '{app="postgres"}' } });
    });

    it('turns a whole OpenAPI action schema strict-compatible', () => {
        const schema = toolInputSchemaToZod({
            type: 'object',
            properties: {
                service: { type: 'string', description: 'Service name' },
                level: { type: 'string', enum: ['INFO', 'ERROR'] },
                size: { type: 'integer' },
            },
            required: ['service'],
        });
        const params = strictParams(toStrictCompatible(schema).schema);
        expect(violations(params)).toEqual([]);
        expect(params.properties?.service).toMatchObject({ description: 'Service name' });
    });
});

describe('makeToolsStrictCompatible', () => {
    it('reshapes the schema and restores arguments before the tool runs', async () => {
        const seen: unknown[] = [];
        const tool = {
            name: 'knowledge_read_document_lines',
            schema: z.object({ documentId: z.string(), offset: z.number().optional() }),
            invoke: async (input: unknown) => { seen.push(input); return 'ok'; },
            __lcTool: { stale: true },
        };
        const [strict] = makeToolsStrictCompatible([tool]) as Array<typeof tool>;
        expect(violations(strictParams(strict.schema))).toEqual([]);
        await strict.invoke({ documentId: 'd1', offset: null });
        expect(seen).toEqual([{ documentId: 'd1' }]);
        // The SDK's cached LangChain conversion was built from the old schema.
        expect((strict as { __lcTool?: unknown }).__lcTool).toBeUndefined();
    });

    it('leaves a tool without a zod schema alone', () => {
        const tool = { name: 'raw', invoke: async () => 'x' };
        expect(makeToolsStrictCompatible([tool])[0]).toBe(tool);
    });
});
