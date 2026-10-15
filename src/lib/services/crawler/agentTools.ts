/**
 * Agent SDK tool factory for the Web Fetch system tool.
 *
 * One call = one page, fetched live through the pinned crawler (its engine,
 * headers/auth and markdown options). No session to open and nothing to clean
 * up. Which hosts the model may reach is decided in `fetchPageWithCrawler`.
 */

import { z } from 'zod';
import { createTool } from '@cognipeer/agent-sdk';
import { currentTurnSignal } from '@/lib/core/turnSignal';
import { fetchPageWithCrawler } from './singlePage';

interface WebFetchToolBindCtx {
  tenantDbName: string;
  tenantId: string;
  projectId?: string;
  crawlerKey: string;
}

export function buildWebFetchAgentTools(ctx: WebFetchToolBindCtx) {
  return [createTool({
    name: 'web_fetch',
    description:
      'Fetch one web page live and return its content as markdown (title, status, content). Only URLs on the hosts this crawler is configured for can be fetched; it does not follow links.',
    schema: z.object({
      url: z.string().url().describe('Absolute http(s) URL of the page to fetch.'),
    }),
    func: async ({ url }) => {
      try {
        const page = await fetchPageWithCrawler(
          { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId },
          ctx.crawlerKey,
          url,
          currentTurnSignal(),
        );
        return { ok: true, ...page };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  })];
}
