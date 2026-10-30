/**
 * The tabs of a knowledge base's page and which one shows: the address bar's `?tab=` picks the first, and the Access
 * tab is for admins only.
 */

export const RAG_PAGE_TABS = ['overview', 'documents', 'playground', 'usage', 'history', 'access'] as const;
export type RagPageTab = (typeof RAG_PAGE_TABS)[number];

export function isRagPageTab(value: unknown): value is RagPageTab {
  return typeof value === 'string' && (RAG_PAGE_TABS as readonly string[]).includes(value);
}

/** The tab a `?tab=` value names; anything else opens the overview. */
export function parseRagPageTab(value: string | null | undefined): RagPageTab {
  return isRagPageTab(value) ? value : 'overview';
}

/**
 * The tab to draw. A person who is not an admin has no Access tab, so a link to it lands on the overview — but not
 * while their level is still loading, when the tab appears as soon as the answer says admin.
 */
export function visibleRagPageTab(requested: RagPageTab, viewer: { canAdmin: boolean; levelKnown: boolean }): RagPageTab {
  if (requested !== 'access' || viewer.canAdmin) return requested;
  return viewer.levelKnown ? 'overview' : requested;
}
