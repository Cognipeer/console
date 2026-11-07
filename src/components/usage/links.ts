/**
 * Deep links of the usage page. Pure module (no React / Next imports).
 *
 *   /dashboard/usage?tab=overview|credits|events
 */

export const USAGE_PATH = '/dashboard/usage';

export const USAGE_TAB_IDS = ['overview', 'credits', 'events'] as const;

export type UsageTabId = (typeof USAGE_TAB_IDS)[number];

export const DEFAULT_USAGE_TAB: UsageTabId = 'overview';

export function isUsageTabId(value: unknown): value is UsageTabId {
  return typeof value === 'string' && (USAGE_TAB_IDS as readonly string[]).includes(value);
}

export function parseUsageTab(raw: string | null | undefined): UsageTabId {
  return isUsageTabId(raw) ? raw : DEFAULT_USAGE_TAB;
}

export function usageHref(tab: UsageTabId = DEFAULT_USAGE_TAB): string {
  return tab === DEFAULT_USAGE_TAB ? USAGE_PATH : `${USAGE_PATH}?tab=${tab}`;
}
