/**
 * Internal MCP provider: Knowledge Base (RAG module).
 *
 * Exposes a single retrieval tool ("search") backed by `queryRag`, so a
 * Knowledge Base can be published as an MCP tool without hand-writing an
 * OpenAPI spec. One provider instance = one RAG module = one MCP tool.
 * Returns raw query matches — no extra chat model is used to turn them into
 * a generated answer, and topK falls back to the module's own default.
 */

import { listRagModules, getRagModule, queryRag } from '@/lib/services/rag/ragService';
import type {
  InternalMcpInstanceOption,
  InternalMcpProvider,
  InternalMcpProviderContext,
} from './types';

const TOOL_NAME = 'search';

/** Retrieval only, no side effects, no calls outside the console. */
const SEARCH_ANNOTATIONS = {
  title: 'Search knowledge base',
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

function searchInputSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query to run against this knowledge base.',
      },
    },
    required: ['query'],
    additionalProperties: false,
  };
}

export const knowledgeBaseProvider: InternalMcpProvider = {
  id: 'knowledge-base',
  label: 'Knowledge Base',
  description: 'Publish a Knowledge Base as a search/retrieval MCP tool.',
  configFields: [],

  async listInstances(ctx: InternalMcpProviderContext): Promise<InternalMcpInstanceOption[]> {
    const modules = await listRagModules(ctx.tenantDbName, {
      projectId: ctx.projectId,
      status: 'active',
    });
    return modules.map((m) => ({
      key: m.key,
      label: m.name,
      description: m.description,
    }));
  },

  async validateInstance(ctx, instanceKey) {
    const ragModule = await getRagModule(ctx.tenantDbName, instanceKey, ctx.projectId);
    if (!ragModule) {
      throw new Error(`Knowledge Base "${instanceKey}" not found`);
    }
  },

  async buildTools(ctx, instanceKey, _config) {
    const ragModule = await getRagModule(ctx.tenantDbName, instanceKey, ctx.projectId);
    const label = ragModule?.name ?? instanceKey;
    const description = ragModule?.description
      ? `Search the "${label}" knowledge base and return matching passages. ${ragModule.description}`
      : `Search the "${label}" knowledge base and return matching passages.`;
    return {
      tools: [
        {
          name: TOOL_NAME,
          description,
          inputSchema: searchInputSchema(),
          annotations: { ...SEARCH_ANNOTATIONS, title: `Search ${label}` },
        },
      ],
      suggestedName: label,
      suggestedDescription: ragModule?.description,
    };
  },

  async execute(ctx, instanceKey, _config, toolName, args) {
    if (toolName !== TOOL_NAME) {
      throw new Error(`Unknown tool "${toolName}" on Knowledge Base provider`);
    }
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) {
      throw new Error('"query" is required');
    }
    // topK is intentionally omitted — queryRag falls back to the module's default.
    const result = await queryRag(ctx.tenantDbName, ctx.tenantId, ctx.projectId, {
      ragModuleKey: instanceKey,
      query,
    });
    return {
      query: result.query,
      matches: result.matches,
    };
  },
};
