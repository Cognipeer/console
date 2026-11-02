/**
 * A tool result the request log keeps only a summary of.
 *
 * The request log is read by people with MCP access, who may not be allowed to
 * read what a tool returned (a knowledge base with access control answers each
 * caller with the documents that caller may read). A provider marks such a
 * result with `setResponseLogSummary`; `logMcpRequest` then stores the summary
 * in its place.
 *
 * The mark follows the result object, so it is found where the log row is
 * written: the routes pass `logMcpRequest` the very object `executeMcpTool`
 * returned and never see the provider. A result that crossed nodes as JSON is a
 * new object, so `executeMcpTool` marks it again from the `logSummary` carried
 * on the outcome.
 */

const summaries = new WeakMap<object, Record<string, unknown>>();

/** Log `summary` instead of `result`. Returns `result`; a value that is not an object cannot carry a mark. */
export function setResponseLogSummary<T>(result: T, summary: Record<string, unknown>): T {
  if (result !== null && typeof result === 'object') summaries.set(result, summary);
  return result;
}

/** What the log keeps of `result` instead of the result itself, when it was marked. */
export function responseLogSummaryOf(result: unknown): Record<string, unknown> | undefined {
  return result !== null && typeof result === 'object' ? summaries.get(result) : undefined;
}
