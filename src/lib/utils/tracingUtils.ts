/**
 * Utility functions for Agent Tracing components
 */

export const formatNumber = (num: number | null | undefined): string => {
  if (num === null || num === undefined) return '0';
  return new Intl.NumberFormat('en-US').format(num);
};

export const formatPercent = (value: number | null | undefined): string => {
  if (value === null || value === undefined) return '0%';
  return `${(value * 100).toFixed(1)}%`;
};

export const formatDuration = (ms: number | null | undefined): string => {
  if (!ms) return '—';

  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${(ms / 60000).toFixed(1)}m`;
  return `${(ms / 3600000).toFixed(1)}h`;
};

export const formatRelativeTime = (
  date: Date | string | null | undefined,
): string => {
  if (!date) return '—';

  const now = new Date();
  const then = new Date(date);
  const diffMs = now.getTime() - then.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;

  return then.toLocaleDateString();
};

export const resolveStatusColor = (status: string | undefined): string => {
  if (!status) return 'gray';
  const normalized = status.toLowerCase();
  if (normalized === 'success' || normalized === 'completed') return 'teal';
  if (normalized === 'error' || normalized === 'failed') return 'red';
  if (normalized === 'running' || normalized === 'in_progress' || normalized === 'pending') return 'blue';
  return 'gray';
};

export const formatToolName = (name: string | undefined): string => {
  if (!name) return '';
  // Convert SNAKE_CASE or snake_case to Title Case
  return name
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
};

export const humanize = (str: string | undefined): string => {
  if (!str) return '';
  return str
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
};

/** A session/thread status as a `StatusBadge` variant. */
export function statusVariant(status?: string) {
  if (!status) return 'info' as const;
  const v = status.toLowerCase();
  if (v === 'success' || v === 'completed') return 'ok' as const;
  if (v === 'error' || v === 'failed') return 'err' as const;
  return 'info' as const;
}

const titleCase = (value: string) => (value.includes('_') ? formatToolName(value) : value);

/** An event's actor (a name, or `{ scope, name, role, version }`) as one ` · `-joined label. */
export const formatActor = (actor: unknown): string => {
  if (!actor) return '';
  if (typeof actor === 'string') return titleCase(actor);
  if (typeof actor === 'object') {
    const record = actor as Record<string, unknown>;
    return [record.scope, record.name, record.role, record.version]
      .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
      .map(titleCase)
      .join(' · ');
  }
  return String(actor);
};

/** A section's content as text: strings as-is, anything else pretty-printed JSON. */
export const formatSectionContent = (content: unknown): string => {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
};

/** False for a null, blank, or empty array/object section field. */
export const shouldDisplaySectionField = (value: unknown): boolean => {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
};

/**
 * Share of total input tokens (uncached + cached) that were served from cache.
 * Cached tokens are billed/counted separately from `inputTokens`, so the total
 * prompt volume is `inputTokens + cachedInputTokens` — not `inputTokens` alone.
 */
export const calcCacheHitRate = (
  inputTokens: number | null | undefined,
  cachedInputTokens: number | null | undefined,
): number => {
  const input = inputTokens ?? 0;
  const cached = cachedInputTokens ?? 0;
  const total = input + cached;
  return total > 0 ? cached / total : 0;
};

export const formatBytes = (bytes: number | null | undefined): string => {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
};
