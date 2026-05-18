export function matchesProjectScope(
  recordProjectId: string | undefined,
  activeProjectId: string | undefined,
): boolean {
  const normalizedRecordProjectId = recordProjectId?.trim() || undefined;
  const normalizedActiveProjectId = activeProjectId?.trim() || undefined;

  if (!normalizedRecordProjectId && !normalizedActiveProjectId) {
    return true;
  }

  if (!normalizedRecordProjectId || !normalizedActiveProjectId) {
    return false;
  }

  return normalizedRecordProjectId === normalizedActiveProjectId;
}

export function sanitizePersistedUrl(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return undefined;

  try {
    const url = new URL(rawUrl);
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

export function redactTypedText(text: string): string {
  return `[redacted:${text.length} chars]`;
}
