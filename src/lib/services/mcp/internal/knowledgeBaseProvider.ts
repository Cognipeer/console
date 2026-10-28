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
 *
 * A module with access control answers with what the caller of the tool call
 * may read (`ctx.identity`; a public endpoint passes none, so it gets what is
 * open to everyone). A document the caller may not read is reported exactly like
 * an unknown id, and such a module's responses are logged as a summary (see
 * `../responseLog`).
 */

import { currentTurnSignal } from '@/lib/core/turnSignal';
import { McpToolInputError } from '../errors';
import { setResponseLogSummary } from '../responseLog';
import {
  listRagModules,
  getRagDocument,
  getRagDocumentFullText,
  getRagDocumentTextLines,
  getRagModule,
  queryRag,
} from '@/lib/services/rag/ragService';
import {
  kbCallerFromIdentity,
  noteRestrictedDocuments,
  resolveRagAccess,
  restrictedKnowledgeTag,
  type KbCaller,
  type RagAccessModule,
  type RagAccessScope,
} from '@/lib/services/rag/access';
import { RagModuleInactiveError } from '@/lib/services/rag/errors';
import { VectorFilterError } from '@/lib/providers';
import type {
  InternalMcpInstanceOption,
  InternalMcpProvider,
  InternalMcpProviderContext,
} from './types';

/** Longest piece of a caller-supplied id an error repeats back. */
const ECHOED_ID_MAX_CHARS = 100;

/** Longest search query an MCP caller may send. */
const QUERY_MAX_CHARS = 4000;

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

/**
 * `response` marked so the request log keeps `summary` (counts only) of it
 * instead. The mark goes on a copy: it belongs to this response alone, whatever
 * object the service handed back.
 */
function loggedAs<T extends object>(response: T, summary: Record<string, unknown>): T {
  return setResponseLogSummary({ ...response }, { omitted: true, reason: 'access_controlled', ...summary });
}

/**
 * The caller's scope in the instance's module, when the module has access
 * control; undefined for any other module (and for one that does not exist,
 * which the calls below report as they always did).
 */
async function accessScopeOf(
  ctx: InternalMcpProviderContext,
  instanceKey: string,
): Promise<{ caller: KbCaller; scope: RagAccessScope; module: RagAccessModule } | undefined> {
  const ragModule = await getRagModule(ctx.tenantDbName, instanceKey, ctx.projectId);
  if (ragModule?.access?.enabled !== true) return undefined;
  const caller = kbCallerFromIdentity(ctx.identity);
  const scope = await resolveRagAccess({ tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, module: ragModule, caller });
  return { caller, scope, module: ragModule };
}

/**
 * The summary's mark that the result holds passages of documents not open to everyone. It travels with the outcome
 * when the call ran on another node, so the agent run that called the tool can mark its stored copies too.
 */
function restrictedMark(tag: string | null | undefined): Record<string, unknown> {
  return tag ? { restrictedKnowledge: [tag] } : {};
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
      instructions:
        `These tools read the "${label}" knowledge base. Start with "${SEARCH_TOOL_NAME}": every match `
        + `carries a documentId. To read past a passage, pass that documentId to "${READ_TOOL_NAME}" for `
        + `the whole document, or to "${READ_LINES_TOOL_NAME}" to page through a long one with offset and limit.`,
    };
  },

  async execute(ctx, instanceKey, _config, toolName, args) {
    if (toolName === SEARCH_TOOL_NAME) {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) {
        throw new McpToolInputError('"query" is required');
      }
      if (query.length > QUERY_MAX_CHARS) {
        throw new McpToolInputError(`"query" must be at most ${QUERY_MAX_CHARS} characters`);
      }
      const filter =
        args.filter && typeof args.filter === 'object' && !Array.isArray(args.filter)
          ? (args.filter as Record<string, unknown>)
          : undefined;
      const access = await accessScopeOf(ctx, instanceKey);
      // topK is intentionally omitted — queryRag falls back to the module's default.
      try {
        const result = await queryRag(ctx.tenantDbName, ctx.tenantId, ctx.projectId, {
          ragModuleKey: instanceKey,
          query,
          filter,
          // MCP callers may be anonymous; they may not send provider-native filters.
          filterSource: 'untrusted',
        }, {
          signal: currentTurnSignal(),
          ...(access ? { caller: access.caller, access: access.scope } : {}),
        });
        // Internal keys (`_ragModule`, …) are never part of the public shape, and
        // metadata follows the module's responseDetail like the query endpoints.
        const includeMetadata = result.responseDetail !== 'text';
        const response = {
          query: result.query,
          matches: result.matches.map((m) => ({
            content: m.content,
            score: m.score,
            documentId: m.documentId,
            ...(m.fileName !== undefined ? { fileName: m.fileName } : {}),
            ...(includeMetadata && m.metadata
              ? {
                metadata: Object.fromEntries(
                  Object.entries(m.metadata).filter(([key]) => !key.startsWith('_')),
                ),
              }
              : {}),
          })),
        };
        return access
          ? loggedAs(response, {
            matches: result.matches.length,
            ...restrictedMark(result.restricted ? restrictedKnowledgeTag(access.module) : null),
          })
          : response;
      } catch (error) {
        // A switched-off knowledge base is a caller-visible state, not a server fault.
        if (error instanceof RagModuleInactiveError) throw new McpToolInputError(error.message);
        if (error instanceof VectorFilterError) throw new McpToolInputError(error.message);
        throw error;
      }
    }

    if (toolName === READ_TOOL_NAME || toolName === READ_LINES_TOOL_NAME) {
      const documentId = typeof args.documentId === 'string' ? args.documentId.trim() : '';
      if (!documentId) {
        throw new McpToolInputError('"documentId" is required');
      }
      // A documentId is trusted to be one this instance's own "search" just
      // returned, but a caller can pass any string. A read is scoped to the
      // module this MCP tool was published from and to that module's project; a
      // document stamped with another project is reported exactly like an
      // unknown id. (A document with no project stamp — rows from before
      // stamping, ingests through a tenant-wide token — stays readable, as it
      // does through the Knowledge Engine's own routes.) In a module with access
      // control, a document the caller may not read is reported the same way.
      const access = await accessScopeOf(ctx, instanceKey);
      const document = await getRagDocument(ctx.tenantDbName, documentId);
      const inThisProject = !ctx.projectId
        || !document?.projectId
        || String(document.projectId) === String(ctx.projectId);
      const hidden = access !== undefined && access.scope.enforced && !!document && !access.scope.canReadDocument(document);
      if (!document || document.ragModuleKey !== instanceKey || !inThisProject || hidden) {
        throw new McpToolInputError(
          `Document "${documentId.slice(0, ECHOED_ID_MAX_CHARS)}" not found in this knowledge base`,
        );
      }
      // Its text goes back to the caller next: the work it runs in learns first what it is about to hold.
      const restrictedTag = access
        ? await noteRestrictedDocuments({ tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, module: access.module, documents: [document] })
        : null;

      if (toolName === READ_TOOL_NAME) {
        const result = await getRagDocumentFullText(ctx.tenantDbName, ctx.tenantId, ctx.projectId, document);
        if (!result) {
          throw new Error('Source text is not available for this document; it may need to be re-ingested');
        }
        return access
          ? loggedAs(result, {
            totalChars: result.totalChars,
            totalLines: result.totalLines,
            truncated: result.truncated,
            ...restrictedMark(restrictedTag),
          })
          : result;
      }

      const offset = typeof args.offset === 'number' ? args.offset : undefined;
      const limit = typeof args.limit === 'number' ? args.limit : undefined;
      const result = await getRagDocumentTextLines(
        ctx.tenantDbName, ctx.tenantId, ctx.projectId, document, { offset, limit },
      );
      if (!result) {
        throw new Error('Source text is not available for this document; it may need to be re-ingested');
      }
      return access
        ? loggedAs(result, {
          totalLines: result.totalLines,
          startLine: result.startLine,
          endLine: result.endLine,
          hasMore: result.hasMore,
          ...restrictedMark(restrictedTag),
        })
        : result;
    }

    throw new Error(`Unknown tool "${toolName}" on Knowledge Base provider`);
  },
};
