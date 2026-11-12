/**
 * Knowledge tools of an agent: the search / read / read-lines tool definitions, who
 * a run's knowledge tools read for, and the builders that bind an agent's
 * knowledge bindings to the Knowledge Engine.
 */

import type { ToolInterface as AgentSdkToolInterface } from '@cognipeer/agent-sdk';
import type { IAgentKnowledgeBinding } from '@/lib/database/provider/types.domain';
import { knowledgeKeySlug, formatKnowledgeHit, mergeKnowledgeHits, normalizeKnowledgeBindings, type KnowledgeBindingSource, type KnowledgeHit } from './agentKnowledgeBindings';
import type { DatabaseProvider, IAgentConversation } from '@/lib/database';
import { getRagDocument, getRagDocumentFullText, getRagDocumentTextLines, queryRag } from '@/lib/services/rag/ragService';
import { anonymousKbCaller, currentKnowledgeExposure, kbCallerFromIdentity, kbCallerFromRuntime, noteRestrictedDocuments, resolveRagAccess, type KbCaller, type RagAccessModule, type RagAccessScope } from '@/lib/services/rag/access';
import type { ConsoleIdentityPerson } from '@/lib/iam/consoleIdentity';
import { currentTurnSignal } from '@/lib/core/turnSignal';
import { resolveAgentKnowledgeModule } from './bindingResolution';
import type { TraceToolDefinition } from '@/lib/services/tracingToolDefinitions';
import type { AgentRuntimeContext } from '@/lib/services/runtimeContext';
import { agentToolPolicyName, type AgentToolGuard } from './agentToolGuard';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('agents');

const CONSOLE_AGENT_KNOWLEDGE_SEARCH_DESCRIPTION =
    'PRIMARY retrieval tool. For factual, product, policy, API, docs, or troubleshooting questions, call this tool BEFORE drafting the final answer. Use the user question (or a focused rewrite) as query. If results are empty/insufficient, then answer briefly with uncertainty. Each match carries a documentId — pass it to knowledge_read_document or knowledge_read_document_lines when the question needs more of that file than the matched passage.';

const CONSOLE_AGENT_KNOWLEDGE_READ_DESCRIPTION =
    'Returns the whole extracted text of one knowledge-base document, given the documentId from a knowledge_search result. Use this when the question is about the document as a whole (e.g. "summarize this file") and the file is not huge. The response is truncated past a size limit — when it is, switch to knowledge_read_document_lines to read the rest.';

const CONSOLE_AGENT_KNOWLEDGE_READ_LINES_DESCRIPTION =
    'Returns one line range of a knowledge-base document, given the documentId from a knowledge_search result. Use this for long documents, to page through a file, or to jump to a specific part of it. Call again with a later offset to continue reading.';

/** Prepended to the system prompt of an agent with a knowledge engine bound. */
export const KNOWLEDGE_FIRST_INSTRUCTION = [
    'Knowledge-base-first policy:',
    '- For user questions that are factual, documentation, API, setup, troubleshooting, or product-behavior related, call `knowledge_search` first.',
    '- Do not provide a final answer before at least one `knowledge_search` attempt unless the request is purely conversational.',
    '- After retrieval, answer using the retrieved content; if retrieval is empty, say you are not fully certain and provide the best concise answer.',
].join('\n');

/**
 * Description of the optional `filter` argument, listing the metadata keys the
 * Knowledge Engine module exposes. Omitted entirely when the module declares
 * none, so the model is never invited to guess at metadata names.
 */
function knowledgeSearchFilterDescription(filterableFields: string[]): string {
    return (
        'Optional metadata filter narrowing the search. Filterable fields: '
        + `${filterableFields.join(', ')}. `
        + 'Use { "field": value } for equality, or operators $eq, $ne, $gt, $gte, $lt, $lte, '
        + '$in, $nin, $exists combined with $and / $or / $not.'
    );
}

/** Trace menu entry mirroring the zod schema `knowledge_search` is bound with. */
function knowledgeSearchToolDefinition(filterableFields: string[]): TraceToolDefinition {
    const properties: Record<string, unknown> = {
        query: { type: 'string', description: 'The search query' },
    };
    if (filterableFields.length > 0) {
        properties.filter = {
            type: 'object',
            description: knowledgeSearchFilterDescription(filterableFields),
        };
    }
    return {
        name: 'knowledge_search',
        description: CONSOLE_AGENT_KNOWLEDGE_SEARCH_DESCRIPTION,
        parameters: {
            type: 'object',
            properties,
            required: ['query'],
        },
    };
}

/** Trace menu entry mirroring the zod schema `knowledge_read_document` is bound with. */
function knowledgeReadToolDefinition(): TraceToolDefinition {
    return {
        name: 'knowledge_read_document',
        description: CONSOLE_AGENT_KNOWLEDGE_READ_DESCRIPTION,
        parameters: {
            type: 'object',
            properties: {
                documentId: { type: 'string', description: 'documentId from a knowledge_search result' },
            },
            required: ['documentId'],
        },
    };
}

/** Trace menu entry mirroring the zod schema `knowledge_read_document_lines` is bound with. */
function knowledgeReadLinesToolDefinition(): TraceToolDefinition {
    return {
        name: 'knowledge_read_document_lines',
        description: CONSOLE_AGENT_KNOWLEDGE_READ_LINES_DESCRIPTION,
        parameters: {
            type: 'object',
            properties: {
                documentId: { type: 'string', description: 'documentId from a knowledge_search result' },
                offset: { type: 'number', description: '1-indexed line to start from (default 1)' },
                limit: { type: 'number', description: 'Number of lines to return (default 200, max 1000)' },
            },
            required: ['documentId'],
        },
    };
}

/**
 * Who a run's knowledge tools read for: the person a continued pause is for
 * (not whoever answered it), else the caller its server-stamped runtime context
 * names. A run without either is an unknown caller, who reads only what a
 * knowledge base with access control opens to everyone.
 */
export function knowledgeCallerOf(input: {
    identity?: ConsoleIdentityPerson;
    runtimeContext?: AgentRuntimeContext;
}): KbCaller {
    return input.identity ? kbCallerFromIdentity(input.identity) : kbCallerFromRuntime(input.runtimeContext);
}

/**
 * Ties the turn's knowledge exposure (opened by the turn's entry) to its session: what the session already holds
 * marks every stored copy of the turn from its first model call, and a new mark is written to the session before
 * the passage that caused it goes back to the model (see rag/access/exposure.ts).
 */
export async function bindKnowledgeExposure(
    db: DatabaseProvider,
    conversation: Pick<IAgentConversation, '_id' | 'kbRestricted'>,
): Promise<void> {
    const exposure = currentKnowledgeExposure();
    if (!exposure || !conversation._id) return;
    const conversationId = String(conversation._id);
    await exposure.bind({
        seed: conversation.kbRestricted,
        onRestricted: (added) => db.addAgentConversationRestriction(conversationId, added),
    });
}

/**
 * What one build of knowledge tools knows about who it reads for: the caller,
 * and that caller's scope in each knowledge base with access control. A scope
 * is resolved the first time a tool needs it and kept for the tools of the
 * build; a knowledge base without access control resolves nothing.
 */
interface KnowledgeAccess {
    readonly caller: KbCaller;
    /** The caller's scope in `ragModule`; undefined when the knowledge base has no access control. */
    scopeOf(ragModule: RagAccessModule): Promise<RagAccessScope | undefined>;
}

function createKnowledgeAccess(tenantDbName: string, tenantId: string, caller?: KbCaller): KnowledgeAccess {
    const reader = caller ?? anonymousKbCaller('unknown');
    const scopes = new Map<string, Promise<RagAccessScope>>();
    return {
        caller: reader,
        async scopeOf(ragModule) {
            if (ragModule.access?.enabled !== true) return undefined;
            const key = ragModule.key;
            let pending = scopes.get(key);
            if (!pending) {
                const resolving = resolveRagAccess({ tenantDbName, tenantId, module: ragModule, caller: reader });
                pending = resolving;
                scopes.set(key, resolving);
                // A failed lookup is not kept: the next call asks again.
                resolving.catch(() => {
                    if (scopes.get(key) === resolving) scopes.delete(key);
                });
            }
            return pending;
        },
    };
}

/**
 * The three Knowledge Engine tools an agent gets when it has a knowledgeEngineKey
 * configured: search, then two ways to read a match's source document further
 * than the matched passage. Shared by the live chat and playground chat paths,
 * which otherwise built the same tools twice and would drift on the next change.
 */
async function buildKnowledgeTools(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
    ragModuleKey: string,
    guard: AgentToolGuard,
    opts: KnowledgeToolOptions = {},
): Promise<{ tools: AgentSdkToolInterface[]; toolDefinitions: TraceToolDefinition[] }> {
    const { createTool } = await import('@cognipeer/agent-sdk');
    const sfx = opts.suffix ? `_${opts.suffix}` : '';
    const searchName = `knowledge_search${sfx}`;
    const readName = `knowledge_read_document${sfx}`;
    const readLinesName = `knowledge_read_document_lines${sfx}`;
    const renamed = (text: string) => (sfx
        ? text
            .replace(/knowledge_search/g, searchName)
            .replace(/knowledge_read_document_lines/g, readLinesName)
            .replace(/knowledge_read_document(?!_)/g, readName)
        : text);
    const searchDescription = withDirective(renamed(CONSOLE_AGENT_KNOWLEDGE_SEARCH_DESCRIPTION), opts.description);
    const { z } = await import('zod');

    const knowledgeModule = await resolveAgentKnowledgeModule(tenantDbName, ragModuleKey, projectId);
    if (!knowledgeModule) {
        logger.warn('Skipping knowledge engine not visible to the agent\'s project', { key: ragModuleKey, projectId });
        return { tools: [], toolDefinitions: [] };
    }
    if (knowledgeModule.status !== 'active') {
        logger.warn('Skipping knowledge engine that is switched off', { key: ragModuleKey, projectId });
        return { tools: [], toolDefinitions: [] };
    }
    // Every later read re-resolves the module by key; pinning the scope it was
    // found in keeps those reads on this same row ('' = tenant-wide only).
    const moduleScope = knowledgeModule.projectId ? String(knowledgeModule.projectId) : '';
    const filterableFields = knowledgeModule.filterableFields ?? [];
    const kbAccess = opts.access ?? createKnowledgeAccess(tenantDbName, tenantId);
    const boundModule: RagAccessModule = knowledgeModule;
    const accessScope = () => kbAccess.scopeOf(boundModule);

    const searchTool = createTool({
        name: searchName,
        description: searchDescription,
        schema: filterableFields.length > 0
            ? z.object({
                query: z.string().describe('The search query'),
                filter: z.record(z.unknown()).optional()
                    .describe(knowledgeSearchFilterDescription(filterableFields)),
            })
            : z.object({ query: z.string().describe('The search query') }),
        func: guard.protect(
            { name: agentToolPolicyName('knowledge', 'search'), requestedName: searchName },
            async (args: { query: string; filter?: Record<string, unknown> }) => {
                const access = await accessScope();
                const result = await queryRag(tenantDbName, tenantId, moduleScope, {
                    ragModuleKey,
                    query: args.query,
                    topK: opts.topK ?? (opts.suffix ? undefined : 5),
                    ...(opts.minScore !== undefined ? { minScore: opts.minScore } : {}),
                    filter: mergeKnowledgeFilters(opts.filter, args.filter),
                    // The model fills `args.filter`; it may not send provider-native filters.
                    // The binding's own filter alone stays trusted.
                    ...(args.filter && Object.keys(args.filter).length > 0 ? { filterSource: 'untrusted' as const } : {}),
                }, { signal: currentTurnSignal(), caller: kbAccess.caller, ...(access ? { access } : {}) });
                return result.matches
                    .filter((m) => m.content)
                    .map((m) => {
                        const tag = m.documentId
                            ? `[documentId: ${m.documentId}${m.fileName ? `, file: ${m.fileName}` : ''}]\n`
                            : '';
                        return `${tag}${m.content}`;
                    })
                    .join('\n\n---\n\n');
            },
        ),
    });

    // documentId is trusted to be one this tenant's search just returned, but a
    // model can pass any string — checking ragModuleKey keeps a read call scoped
    // to the same knowledge base the agent was actually bound to.
    async function resolveOwnedDocument(documentId: string) {
        const document = await getRagDocument(tenantDbName, documentId);
        if (!document || document.ragModuleKey !== ragModuleKey) return undefined;
        if (moduleScope && document.projectId && String(document.projectId) !== moduleScope) return undefined;
        // A document the caller may not read is reported like one that does not exist.
        const access = await accessScope();
        if (access?.enforced && !access.canReadDocument(document)) return undefined;
        // Its text is about to go to the model: the run's stored copies must know what they hold first.
        await noteRestrictedDocuments({ tenantDbName, tenantId, module: boundModule, documents: [document] });
        return document;
    }

    const readTool = createTool({
        name: readName,
        description: sfx ? withDirective(renamed(CONSOLE_AGENT_KNOWLEDGE_READ_DESCRIPTION), opts.description) : CONSOLE_AGENT_KNOWLEDGE_READ_DESCRIPTION,
        schema: z.object({
            documentId: z.string().describe('The documentId from a knowledge_search result'),
        }),
        func: guard.protect(
            {
                name: agentToolPolicyName('knowledge', 'read_document'),
                requestedName: readName,
            },
            async (args: { documentId: string }) => {
                const document = await resolveOwnedDocument(args.documentId);
                if (!document) return 'Document not found in this knowledge base.';
                const result = await getRagDocumentFullText(tenantDbName, tenantId, moduleScope, document);
                if (!result) return 'Source text is not available for this document; it may need to be re-ingested.';
                const notice = result.truncated
                    ? `\n\n[Truncated at ${result.text.length} of ${result.totalChars} characters `
                        + `(${result.totalLines} lines total). Use knowledge_read_document_lines to read the rest.]`
                    : '';
                return `# ${result.fileName}\n\n${result.text}${notice}`;
            },
        ),
    });

    const readLinesTool = createTool({
        name: readLinesName,
        description: renamed(CONSOLE_AGENT_KNOWLEDGE_READ_LINES_DESCRIPTION),
        schema: z.object({
            documentId: z.string().describe('The documentId from a knowledge_search result'),
            offset: z.number().int().min(1).optional().describe('1-indexed line to start from (default 1)'),
            limit: z.number().int().min(1).max(1000).optional()
                .describe('Number of lines to return (default 200, max 1000)'),
        }),
        func: guard.protect(
            {
                name: agentToolPolicyName('knowledge', 'read_document_lines'),
                requestedName: readLinesName,
            },
            async (args: { documentId: string; offset?: number; limit?: number }) => {
                const document = await resolveOwnedDocument(args.documentId);
                if (!document) return 'Document not found in this knowledge base.';
                const result = await getRagDocumentTextLines(tenantDbName, tenantId, moduleScope, document, {
                    offset: args.offset,
                    limit: args.limit,
                });
                if (!result) return 'Source text is not available for this document; it may need to be re-ingested.';
                const more = result.hasMore
                    ? `\n\n[Lines ${result.startLine}-${result.endLine} of ${result.totalLines}. `
                        + `Call again with offset: ${result.endLine + 1} to continue.]`
                    : '';
                return `# ${result.fileName} (lines ${result.startLine}-${result.endLine} of ${result.totalLines})\n\n`
                    + `${result.lines}${more}`;
            },
        ),
    });

    return {
        tools: [searchTool, readTool, readLinesTool],
        toolDefinitions: [
            { ...knowledgeSearchToolDefinition(filterableFields), name: searchName, description: searchDescription },
            { ...knowledgeReadToolDefinition(), name: readName },
            { ...knowledgeReadLinesToolDefinition(), name: readLinesName },
        ],
    };
}

interface KnowledgeToolOptions {
    /** Tool-name suffix (separate mode). Unset = the legacy un-suffixed tools. */
    suffix?: string;
    description?: string;
    topK?: number;
    minScore?: number;
    filter?: Record<string, unknown>;
    /** Who the tools read for. Unset = an unknown caller. */
    access?: KnowledgeAccess;
}

function withDirective(base: string, description?: string): string {
    const text = description?.trim();
    return text ? `${base}\n\nUse for: ${text}` : base;
}

/** Binding filter AND-ed with whatever filter the model supplied. */
function mergeKnowledgeFilters(
    fixed?: Record<string, unknown>,
    asked?: Record<string, unknown>,
): Record<string, unknown> | undefined {
    const hasFixed = fixed && Object.keys(fixed).length > 0;
    if (!hasFixed) return asked;
    if (!asked || Object.keys(asked).length === 0) return fixed;
    return { $and: [fixed, asked] };
}

/**
 * Knowledge tools for an agent config. One legacy key keeps the historical
 * tools; several bindings become either one combined tool set or one set per KB.
 */
export async function buildAgentKnowledgeTools(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
    source: KnowledgeBindingSource,
    guard: AgentToolGuard,
    /** `caller`: who the tools read for. Unset = an unknown caller. */
    options: { caller?: KbCaller } = {},
): Promise<{ tools: AgentSdkToolInterface[]; toolDefinitions: TraceToolDefinition[] }> {
    const bindings = normalizeKnowledgeBindings(source);
    if (bindings.length === 0) return { tools: [], toolDefinitions: [] };
    const access = createKnowledgeAccess(tenantDbName, tenantId, options.caller);
    const plain = bindings[0];
    if (bindings.length === 1 && !plain.description && plain.topK === undefined
        && plain.minScore === undefined && !plain.filter) {
        return buildKnowledgeTools(tenantDbName, tenantId, projectId, plain.key, guard, { access });
    }
    if (source.knowledgeToolMode === 'separate') {
        const tools: AgentSdkToolInterface[] = [];
        const toolDefinitions: TraceToolDefinition[] = [];
        for (const binding of bindings) {
            const built = await buildKnowledgeTools(tenantDbName, tenantId, projectId, binding.key, guard, {
                suffix: knowledgeKeySlug(binding.key),
                description: binding.description,
                topK: binding.topK,
                minScore: binding.minScore,
                filter: binding.filter,
                access,
            });
            tools.push(...built.tools);
            toolDefinitions.push(...built.toolDefinitions);
        }
        return { tools, toolDefinitions };
    }
    return buildCombinedKnowledgeTools(tenantDbName, tenantId, projectId, bindings, guard, { access });
}

async function buildCombinedKnowledgeTools(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
    bindings: IAgentKnowledgeBinding[],
    guard: AgentToolGuard,
    opts: Pick<KnowledgeToolOptions, 'access'> = {},
): Promise<{ tools: AgentSdkToolInterface[]; toolDefinitions: TraceToolDefinition[] }> {
    const { createTool } = await import('@cognipeer/agent-sdk');
    const { z } = await import('zod');
    const kbAccess = opts.access ?? createKnowledgeAccess(tenantDbName, tenantId);

    const visible: Array<{ binding: IAgentKnowledgeBinding; scope: string; ragModule: RagAccessModule }> = [];
    for (const binding of bindings) {
        const mod = await resolveAgentKnowledgeModule(tenantDbName, binding.key, projectId);
        if (!mod) {
            logger.warn('Skipping knowledge engine not visible to the agent\'s project', { key: binding.key, projectId });
            continue;
        }
        if (mod.status !== 'active') {
            logger.warn('Skipping knowledge engine that is switched off', { key: binding.key, projectId });
            continue;
        }
        visible.push({ binding, scope: mod.projectId ? String(mod.projectId) : '', ragModule: mod });
    }
    if (visible.length === 0) return { tools: [], toolDefinitions: [] };
    const byKey = new Map(visible.map((v) => [v.binding.key, v]));
    const keys = visible.map((v) => v.binding.key);

    const catalog = visible
        .map((v) => `- ${v.binding.key}${v.binding.description?.trim() ? `: ${v.binding.description.trim()}` : ''}`)
        .join('\n');
    const searchDescription = `${CONSOLE_AGENT_KNOWLEDGE_SEARCH_DESCRIPTION}\n\nThis searches ALL of these knowledge bases at once; each match is tagged with its kb:\n${catalog}`;
    const readHint = ' Pass `kb` (the kb tag of the match) when more than one knowledge base is bound.';
    const searchSchema = z.object({ query: z.string().describe('The search query') });
    const kbArg = z.string().optional().describe(`Knowledge base key from the search result. One of: ${keys.join(', ')}`);

    // The bound KB a read targets: explicit `kb`, or the only one, else ambiguous.
    async function resolveOwned(documentId: string, kb?: string) {
        const candidates = kb ? (byKey.has(kb) ? [byKey.get(kb)!] : []) : visible;
        if (kb && candidates.length === 0) return { error: `Unknown knowledge base "${kb}". Use one of: ${keys.join(', ')}.` };
        const document = await getRagDocument(tenantDbName, documentId);
        if (!document) return { error: 'Document not found in the bound knowledge bases.' };
        const owner = candidates.find((c) => c.binding.key === document.ragModuleKey
            && !(c.scope && document.projectId && String(document.projectId) !== c.scope));
        if (!owner) return { error: 'Document not found in the bound knowledge bases.' };
        // A document the caller may not read is reported like one that does not exist.
        const access = await kbAccess.scopeOf(owner.ragModule);
        if (access?.enforced && !access.canReadDocument(document)) return { error: 'Document not found in the bound knowledge bases.' };
        // Its text is about to go to the model: the run's stored copies must know what they hold first.
        await noteRestrictedDocuments({ tenantDbName, tenantId, module: owner.ragModule, documents: [document] });
        return { document, scope: owner.scope };
    }

    const searchTool = createTool({
        name: 'knowledge_search',
        description: searchDescription,
        schema: searchSchema,
        func: guard.protect(
            { name: agentToolPolicyName('knowledge', 'search'), requestedName: 'knowledge_search' },
            async (args: { query: string }) => {
                const lists = await Promise.all(visible.map(async ({ binding, scope, ragModule }) => {
                    const access = await kbAccess.scopeOf(ragModule);
                    const result = await queryRag(tenantDbName, tenantId, scope, {
                        ragModuleKey: binding.key,
                        query: args.query,
                        topK: binding.topK,
                        ...(binding.minScore !== undefined ? { minScore: binding.minScore } : {}),
                        filter: binding.filter,
                    }, { signal: currentTurnSignal(), caller: kbAccess.caller, ...(access ? { access } : {}) });
                    return result.matches.filter((m) => m.content).map((m): KnowledgeHit => ({
                        kb: binding.key,
                        documentId: m.documentId,
                        fileName: m.fileName,
                        score: m.score ?? 0,
                        content: m.content ?? '',
                    }));
                }));
                return mergeKnowledgeHits(lists.flat()).map(formatKnowledgeHit).join('\n\n---\n\n');
            },
        ),
    });

    const readTool = createTool({
        name: 'knowledge_read_document',
        description: CONSOLE_AGENT_KNOWLEDGE_READ_DESCRIPTION + readHint,
        schema: z.object({
            documentId: z.string().describe('The documentId from a knowledge_search result'),
            kb: kbArg,
        }),
        func: guard.protect(
            { name: agentToolPolicyName('knowledge', 'read_document'), requestedName: 'knowledge_read_document' },
            async (args: { documentId: string; kb?: string }) => {
                const owned = await resolveOwned(args.documentId, args.kb);
                if ('error' in owned) return owned.error;
                const result = await getRagDocumentFullText(tenantDbName, tenantId, owned.scope, owned.document);
                if (!result) return 'Source text is not available for this document; it may need to be re-ingested.';
                const notice = result.truncated
                    ? `\n\n[Truncated at ${result.text.length} of ${result.totalChars} characters `
                        + `(${result.totalLines} lines total). Use knowledge_read_document_lines to read the rest.]`
                    : '';
                return `# ${result.fileName}\n\n${result.text}${notice}`;
            },
        ),
    });

    const readLinesTool = createTool({
        name: 'knowledge_read_document_lines',
        description: CONSOLE_AGENT_KNOWLEDGE_READ_LINES_DESCRIPTION + readHint,
        schema: z.object({
            documentId: z.string().describe('The documentId from a knowledge_search result'),
            kb: kbArg,
            offset: z.number().int().min(1).optional().describe('1-indexed line to start from (default 1)'),
            limit: z.number().int().min(1).max(1000).optional()
                .describe('Number of lines to return (default 200, max 1000)'),
        }),
        func: guard.protect(
            { name: agentToolPolicyName('knowledge', 'read_document_lines'), requestedName: 'knowledge_read_document_lines' },
            async (args: { documentId: string; kb?: string; offset?: number; limit?: number }) => {
                const owned = await resolveOwned(args.documentId, args.kb);
                if ('error' in owned) return owned.error;
                const result = await getRagDocumentTextLines(tenantDbName, tenantId, owned.scope, owned.document, {
                    offset: args.offset,
                    limit: args.limit,
                });
                if (!result) return 'Source text is not available for this document; it may need to be re-ingested.';
                const more = result.hasMore
                    ? `\n\n[Lines ${result.startLine}-${result.endLine} of ${result.totalLines}. `
                        + `Call again with offset: ${result.endLine + 1} to continue.]`
                    : '';
                return `# ${result.fileName} (lines ${result.startLine}-${result.endLine} of ${result.totalLines})\n\n`
                    + `${result.lines}${more}`;
            },
        ),
    });

    return {
        tools: [searchTool, readTool, readLinesTool],
        toolDefinitions: [
            {
                name: 'knowledge_search',
                description: searchDescription,
                parameters: { type: 'object', properties: { query: { type: 'string', description: 'The search query' } }, required: ['query'] },
            },
            { ...knowledgeReadToolDefinition(), description: CONSOLE_AGENT_KNOWLEDGE_READ_DESCRIPTION + readHint },
            { ...knowledgeReadLinesToolDefinition(), description: CONSOLE_AGENT_KNOWLEDGE_READ_LINES_DESCRIPTION + readHint },
        ],
    };
}
