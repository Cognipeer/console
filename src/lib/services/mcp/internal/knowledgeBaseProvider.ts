/**
 * Internal MCP provider: Knowledge Base (RAG module).
 *
 * Exposes three retrieval tools backed by `queryRag` / `getRagDocumentFullText` /
 * `getRagDocumentTextLines`, so a Knowledge Base can be published as an MCP
 * server without hand-writing an OpenAPI spec. One provider instance = one RAG
 * module.
 *
 * `search` returns raw query matches — no extra chat model is used to turn
 * them into a generated answer, and topK falls back to the module's own
 * default. Each match carries a `documentId`, which `read_document` and
 * `read_document_lines` accept to go past the matched passage: the whole
 * document in one call, or a paged line range for documents too large for
 * that. Both are scoped to documents that belong to this instance's RAG
 * module, the same way `search` is scoped to it.
 */

import {
  listRagModules,
  getRagDocument,
  getRagDocumentFullText,
  getRagDocumentTextLines,
  getRagModule,
  queryRag,
} from '@/lib/services/rag/ragService';
import type {
  InternalMcpInstanceOption,
  InternalMcpProvider,
  InternalMcpProviderContext,
} from './types';

const SEARCH_TOOL_NAME = 'search';
const READ_TOOL_NAME = 'read_document';
const READ_LINES_TOOL_NAME = 'read_document_lines';

/** Retrieval only, no side effects, no calls outside the console. */
const SEARCH_ANNOTATIONS = {
  title: 'Search knowledge base',
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const READ_ANNOTATIONS = {
  title: 'Read knowledge base document',
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

function searchInputSchema(filterableFields?: string[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    query: {
      type: 'string',
      description: 'The search query to run against this knowledge base.',
    },
  };

  // Only advertise filtering when the module says which keys are filterable —
  // without that list the model would be guessing at metadata names.
  if (filterableFields && filterableFields.length > 0) {
    properties.filter = {
      type: 'object',
      additionalProperties: true,
      description:
        'Optional metadata filter. Supported fields: '
        + `${filterableFields.join(', ')}. `
        + 'Use { "field": value } for equality or operators '
        + '$eq, $ne, $gt, $gte, $lt, $lte, $in, $nin, $exists, combined with $and / $or / $not.',
    };
  }

  return {
    type: 'object',
    properties,
    required: ['query'],
    additionalProperties: false,
  };
}

const READ_DOCUMENT_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    documentId: {
      type: 'string',
      description: 'The documentId returned on a match by the "search" tool.',
    },
  },
  required: ['documentId'],
  additionalProperties: false,
};

const READ_LINES_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    documentId: {
      type: 'string',
      description: 'The documentId returned on a match by the "search" tool.',
    },
    offset: {
      type: 'number',
      description: '1-indexed line to start from. Defaults to 1.',
    },
    limit: {
      type: 'number',
      description: 'Number of lines to return. Defaults to 200, capped at 1000.',
    },
  },
  required: ['documentId'],
  additionalProperties: false,
};

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
    const searchDescription = ragModule?.description
      ? `Search the "${label}" knowledge base and return matching passages. ${ragModule.description}`
      : `Search the "${label}" knowledge base and return matching passages.`;
    return {
      tools: [
        {
          name: SEARCH_TOOL_NAME,
          description: searchDescription,
          inputSchema: searchInputSchema(ragModule?.filterableFields),
          annotations: { ...SEARCH_ANNOTATIONS, title: `Search ${label}` },
        },
        {
          name: READ_TOOL_NAME,
          description:
            `Return the whole extracted text of one document in the "${label}" knowledge base, `
            + 'given the documentId from a "search" match. Use this for questions about a document '
            + 'as a whole; the response is truncated past a size limit, so switch to '
            + `"${READ_LINES_TOOL_NAME}" when it is.`,
          inputSchema: READ_DOCUMENT_INPUT_SCHEMA,
          annotations: { ...READ_ANNOTATIONS, title: `Read document from ${label}` },
        },
        {
          name: READ_LINES_TOOL_NAME,
          description:
            `Return one line range of a document in the "${label}" knowledge base, given the `
            + 'documentId from a "search" match. Use this to page through a large document or jump '
            + 'to a specific part of it; call again with a later offset to continue reading.',
          inputSchema: READ_LINES_INPUT_SCHEMA,
          annotations: { ...READ_ANNOTATIONS, title: `Read document lines from ${label}` },
        },
      ],
      suggestedName: label,
      suggestedDescription: ragModule?.description,
    };
  },

  async execute(ctx, instanceKey, _config, toolName, args) {
    if (toolName === SEARCH_TOOL_NAME) {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) {
        throw new Error('"query" is required');
      }
      const filter =
        args.filter && typeof args.filter === 'object' && !Array.isArray(args.filter)
          ? (args.filter as Record<string, unknown>)
          : undefined;
      // topK is intentionally omitted — queryRag falls back to the module's default.
      const result = await queryRag(ctx.tenantDbName, ctx.tenantId, ctx.projectId, {
        ragModuleKey: instanceKey,
        query,
        filter,
      });
      return {
        query: result.query,
        matches: result.matches,
      };
    }

    if (toolName === READ_TOOL_NAME || toolName === READ_LINES_TOOL_NAME) {
      const documentId = typeof args.documentId === 'string' ? args.documentId.trim() : '';
      if (!documentId) {
        throw new Error('"documentId" is required');
      }
      // A documentId is trusted to be one this instance's own "search" just
      // returned, but a caller can pass any string — checking ragModuleKey
      // keeps a read scoped to the module this MCP tool was published from.
      const document = await getRagDocument(ctx.tenantDbName, documentId);
      if (!document || document.ragModuleKey !== instanceKey) {
        throw new Error(`Document "${documentId}" not found in this knowledge base`);
      }

      if (toolName === READ_TOOL_NAME) {
        const result = await getRagDocumentFullText(ctx.tenantDbName, ctx.tenantId, ctx.projectId, document);
        if (!result) {
          throw new Error('Source text is not available for this document; it may need to be re-ingested');
        }
        return result;
      }

      const offset = typeof args.offset === 'number' ? args.offset : undefined;
      const limit = typeof args.limit === 'number' ? args.limit : undefined;
      const result = await getRagDocumentTextLines(
        ctx.tenantDbName, ctx.tenantId, ctx.projectId, document, { offset, limit },
      );
      if (!result) {
        throw new Error('Source text is not available for this document; it may need to be re-ingested');
      }
      return result;
    }

    throw new Error(`Unknown tool "${toolName}" on Knowledge Base provider`);
  },
};
