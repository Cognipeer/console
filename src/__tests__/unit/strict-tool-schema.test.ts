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
import { restoreToolCalls, toStrictCompatible, withStrictToolCalling } from '@/lib/services/agents/strictToolSchema';
import { createSmartAgent, createTool } from '@cognipeer/agent-sdk';
import { buildMemoryTools } from '@/lib/services/agents/agentMemoryTools';
import { toolInputSchemaToZod } from '@/lib/services/agents/agentRuntimeConfig';

type JsonSchema = { type?: unknown; properties?: Record<string, JsonSchema>; required?: string[]; additionalProperties?: unknown; items?: JsonSchema; anyOf?: JsonSchema[] };

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
    // The provider checks every union branch too; not recursing here is how
    // manage_plan's `todoList` union shipped broken with this suite green.
    schema.anyOf?.forEach((branch, index) => out.push(...violations(branch, `${path}|${index}`)));
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

    it('closes the branches of a union — manage_plan\'s todoList', () => {
        const writeItem = z.object({ id: z.number().int(), step: z.string().optional(), status: z.enum(['a', 'b']) });
        const updateItem = z.object({ id: z.number().int(), step: z.string().optional(), status: z.enum(['a', 'b']).optional() });
        const schema = z.object({
            operation: z.enum(['write', 'update']),
            todoList: z.array(z.union([writeItem, updateItem])).optional(),
        });
        expect(violations(strictParams(schema))).not.toEqual([]);
        const t = toStrictCompatible(schema);
        expect(violations(strictParams(t.schema))).toEqual([]);
        const restored = t.restore({ operation: 'update', todoList: [{ id: 1, step: null, status: null }] });
        expect(restored).toEqual({ operation: 'update', todoList: [{ id: 1 }] });
        expect(schema.safeParse(restored).success).toBe(true);
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

describe('restoreToolCalls', () => {
    it('restores LangChain-form and raw OpenAI-form tool calls', () => {
        const restorers = new Map([['read', toStrictCompatible(z.object({ id: z.string(), offset: z.number().optional() })).restore]]);
        expect(restoreToolCalls({ tool_calls: [{ name: 'read', args: { id: 'a', offset: null } }] }, restorers))
            .toEqual({ tool_calls: [{ name: 'read', args: { id: 'a' } }] });
        expect(restoreToolCalls({ tool_calls: [{ function: { name: 'read', arguments: '{"id":"a","offset":null}' } }] }, restorers))
            .toEqual({ tool_calls: [{ function: { name: 'read', arguments: '{"id":"a"}' } }] });
    });
});

/**
 * The whole point: EVERY tool that reaches the provider — the console's own
 * and the ones agent-sdk injects for planning, skills and sub-agents — passes
 * strict mode, and a strict-shaped tool call still runs the tool with its
 * original arguments.
 */
describe('withStrictToolCalling — every tool the provider sees', () => {
    function fakeStrictModel(script: Array<Record<string, unknown>>) {
        const bound: Array<{ tools: Array<{ name: string; description?: string; schema: z.ZodTypeAny }>; options?: Record<string, unknown> }> = [];
        let turn = 0;
        const model = {
            capabilities: { structuredOutput: 'native', strictToolCalling: true, provider: 'openai' },
            bindTools(tools: Array<{ name: string; description?: string; schema: z.ZodTypeAny }>, options?: Record<string, unknown>) {
                bound.push({ tools, options });
                return model;
            },
            async invoke() {
                const next = script[Math.min(turn, script.length - 1)];
                turn += 1;
                return next;
            },
        };
        return { model, bound };
    }

    it('binds every tool — console and agent-sdk alike — in strict-valid form', async () => {
        const { model, bound } = fakeStrictModel([{ role: 'assistant', content: 'done' }]);
        const guard = { protect: (_spec: unknown, fn: (a: Record<string, unknown>) => Promise<unknown>) => fn };
        const memory = buildMemoryTools({
            store: { get: async () => [], upsert: async () => undefined, markObsolete: async () => undefined },
            scope: 'workspace', createToolFn: createTool, zod: z, guard, allowWrites: true,
        } as never);
        const knowledgeLike = createTool({
            name: 'knowledge_read_document_lines',
            description: 'read lines',
            schema: z.object({ documentId: z.string(), offset: z.number().int().optional(), limit: z.number().int().optional() }),
            func: async () => 'ok',
        });
        const openApiLike = createTool({
            name: 'post_incident_comment',
            description: 'post',
            schema: toolInputSchemaToZod({
                type: 'object',
                properties: { incidentId: { type: 'string' }, body: { type: 'object' } },
                required: ['incidentId'],
            }),
            func: async () => 'ok',
        });
        const agent = createSmartAgent({
            name: 'strict-probe',
            model: withStrictToolCalling(model) as never,
            tools: [knowledgeLike, openApiLike, ...memory],
            planning: { mode: 'todo' },
            skills: [{ key: 'triage', title: 'Triage', header: 'How to triage', prompt: 'Look at logs.' }] as never,
            subagents: [{ name: 'reader', description: 'reads logs', systemPrompt: 'read' }] as never,
        } as never);
        await agent.invoke({ messages: [{ role: 'user', content: 'go' }] } as never);

        expect(bound.length).toBeGreaterThan(0);
        const names = new Set<string>();
        for (const call of bound) {
            expect(call.options?.strict).toBe(true);
            for (const tool of call.tools) {
                names.add(tool.name);
                expect({ tool: tool.name, violations: violations(strictParams(tool.schema)) })
                    .toEqual({ tool: tool.name, violations: [] });
            }
        }
        // The SDK-injected tools that were NOT strict-compatible on their own.
        expect([...names]).toEqual(expect.arrayContaining([
            'knowledge_read_document_lines', 'post_incident_comment', 'memory_search', 'memory_write',
            'manage_plan', 'delegate_to', 'spawn_subagent', 'spawn_subagents_parallel', 'open_skill', 'bind_skill_tools',
        ]));
    });

    it('runs a tool with its original arguments after a strict-shaped call', async () => {
        const seen: unknown[] = [];
        const tool = createTool({
            name: 'knowledge_read_document_lines',
            description: 'read lines',
            schema: z.object({ documentId: z.string(), offset: z.number().int().optional() }),
            func: async (args: unknown) => { seen.push(args); return 'line 1'; },
        });
        const { model } = fakeStrictModel([
            // What a strict provider returns: every argument present, nulls for "not given".
            { role: 'assistant', content: '', tool_calls: [{ id: 'c1', name: 'knowledge_read_document_lines', args: { documentId: 'd1', offset: null } }] },
            { role: 'assistant', content: 'done' },
        ]);
        const agent = createSmartAgent({ name: 'p', model: withStrictToolCalling(model) as never, tools: [tool] } as never);
        await agent.invoke({ messages: [{ role: 'user', content: 'go' }] } as never);
        // Without the restore the SDK's own validation rejected `offset: null`.
        expect(seen).toEqual([{ documentId: 'd1' }]);
    });

    it('binds a tool with NO parameters (and one with an unknown schema) strict-valid', async () => {
        // Found by the agent-findings e2e: a parameterless OpenAPI operation
        // became a top-level string, LangChain wrapped it as `{ input }` with
        // no `required`, and the provider rejected EVERY call of the agent.
        const { model, bound } = fakeStrictModel([
            { role: 'assistant', content: '', tool_calls: [
                { id: 'c1', name: 'list_errors', args: {} },
                { id: 'c2', name: 'legacy_mcp', args: { input: '{"q":"502"}' } },
            ] },
            { role: 'assistant', content: 'done' },
        ]);
        const seen: Record<string, unknown> = {};
        const noParams = createTool({
            name: 'list_errors',
            description: 'no parameters',
            schema: toolInputSchemaToZod({ type: 'object', properties: {} }),
            func: async (args: unknown) => { seen.list_errors = args; return 'ok'; },
        });
        const unknownSchema = createTool({
            name: 'legacy_mcp',
            description: 'no declared schema',
            schema: toolInputSchemaToZod(undefined),
            func: async (args: unknown) => { seen.legacy_mcp = args; return 'ok'; },
        });
        const agent = createSmartAgent({
            name: 'p', model: withStrictToolCalling(model) as never, tools: [noParams, unknownSchema],
        } as never);
        await agent.invoke({ messages: [{ role: 'user', content: 'go' }] } as never);

        for (const tool of bound[0].tools.filter((t) => t.name === 'list_errors' || t.name === 'legacy_mcp')) {
            expect({ tool: tool.name, violations: violations(strictParams(tool.schema)) })
                .toEqual({ tool: tool.name, violations: [] });
        }
        expect(seen.list_errors).toEqual({});
        // The unknown-schema tool gets its arguments decoded back into an object.
        expect(seen.legacy_mcp).toEqual({ q: '502' });
    });

    it('leaves a provider without strict tool calling untouched', () => {
        const model = { capabilities: { strictToolCalling: false }, bindTools: () => model };
        expect(withStrictToolCalling(model)).toBe(model);
    });
});
