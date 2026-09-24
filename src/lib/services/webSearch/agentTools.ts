/**
 * Agent SDK tool factory for the Web Search system tool.
 *
 * Unlike the browser tools this needs no session: each call is a single
 * `runWebSearch`, bound to the project and (optionally) one pinned instance
 * key. Omitting `providerKey` defers to `runWebSearch`'s own resolution —
 * the project's single active instance, or a clear error when there is none
 * or more than one.
 */

import { z } from 'zod';
import { createTool } from '@cognipeer/agent-sdk';
import { runWebSearch } from './webSearchService';

interface WebSearchToolBindCtx {
  tenantDbName: string;
  tenantId: string;
  projectId?: string;
  /** Instance key. Omit to use the project's single active instance. */
  providerKey?: string;
  /** Called after each tool call (used by run loop to broadcast progress). */
  onToolCall?: (info: {
    name: string;
    input: unknown;
    output: unknown;
    error?: string;
  }) => void;
}

export function buildWebSearchAgentTools(ctx: WebSearchToolBindCtx) {
  const searchTool = createTool({
    name: 'web_search',
    description:
      'Search the web and return ranked results (title, url, snippet). Set includeAnswer to also get a synthesized answer — errors if the instance has no AI answer model configured.',
    schema: z.object({
      query: z.string().min(1),
      count: z.number().int().min(1).max(50).optional()
        .describe('Max results to return. Default 10.'),
      language: z.string().optional().describe('ISO language override.'),
      country: z.string().optional().describe('Country/market override.'),
      safeSearch: z.enum(['off', 'moderate', 'strict']).optional(),
      includeAnswer: z.boolean().optional()
        .describe('Also return a synthesized answer interpreted from the results.'),
    }),
    func: async (input) => {
      try {
        const result = await runWebSearch(ctx.tenantDbName, ctx.tenantId, ctx.projectId, {
          ...input,
          providerKey: ctx.providerKey,
          source: 'api',
        });
        ctx.onToolCall?.({ name: 'web_search', input, output: result });
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.onToolCall?.({ name: 'web_search', input, output: null, error: message });
        return { ok: false, error: message };
      }
    },
  });

  return [searchTool];
}
