export function formatRelative(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const secs = Math.round((Date.now() - date.getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86_400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86_400)}d ago`;
}

export function formatMemoryMiB(memMiB: number): string {
  if (memMiB >= 1024) return `${(memMiB / 1024).toFixed(1)} GiB`;
  return `${memMiB} MiB`;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${bytes} B`;
}

export function statusColor(
  status: string,
): 'teal' | 'orange' | 'gray' | 'red' | 'blue' | 'yellow' {
  switch (status) {
    case 'online':
    case 'healthy':
      return 'teal';
    case 'pending_claim':
    case 'pending':
    case 'starting':
    case 'pulling':
      return 'blue';
    case 'draining':
    case 'removing':
      return 'orange';
    case 'unhealthy':
    case 'failed':
      return 'red';
    case 'stopped':
    case 'archived':
      return 'gray';
    default:
      return 'gray';
  }
}
