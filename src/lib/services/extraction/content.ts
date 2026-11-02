/**
 * The text of what the converter library returned. The library answers with the Markdown itself; an object that
 * carries it under `markdown`, `content` or `result` is accepted as well (test doubles and older builds do that).
 */
export function extractMarkdownContent(conversion: unknown): string | undefined {
  if (!conversion) return undefined;
  if (typeof conversion === 'string') return conversion;
  if (typeof conversion === 'object') {
    const candidate = conversion as Record<string, unknown>;
    if (typeof candidate.markdown === 'string') return candidate.markdown;
    if (typeof candidate.content === 'string') return candidate.content;
    if (typeof candidate.result === 'string') return candidate.result;
  }
  return undefined;
}
