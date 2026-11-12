/**
 * PII protection for an MCP server's tool calls: a round trip.
 *
 * With a PII policy selected on the server (`metadata.piiProtection`), the
 * string values of a call's arguments leave for the upstream with personal
 * data replaced by tokens (`[EMAIL_kqzvtmwb]`), and tokens in what comes back
 * are turned back into the values. The upstream — a third-party server — never
 * sees the values; the caller sees them as before.
 *
 * Tokens are keyed per server (`mcp:<serverId>`): one value is always the same
 * token on that server, so the upstream can still find a record by it, while
 * two servers cannot match each other's tokens. Restoring is per call (the
 * values a call sent); a token the upstream returns in a later call stays a token.
 *
 * Applies to sources with an upstream outside Console (remote, OpenAPI, stdio).
 * A tool listed in `metadata.piiPassthroughTools` receives real values.
 * Configuration lives in the PII module; the server only names a policy.
 */
import type { IMcpServer, McpSourceType } from '@/lib/database';
import { deriveRoundTripKey, PiiRoundTrip } from '@/lib/services/pii/roundTrip';
import { resolveTenantDbName } from '@/lib/services/guardrail/hooks/recordCache';

const PROTECTED_SOURCES: ReadonlySet<McpSourceType> = new Set(['remote', 'openapi', 'stdio']);
const MAX_DEPTH = 32;
const MAX_JSON_SNIFF_CHARS = 1_000_000;

type Metadata = Record<string, unknown> | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The policy protecting a server's calls, or undefined when none is selected. */
export function getMcpPiiProtection(metadata: Metadata): { policyKey: string } | undefined {
  const raw = metadata?.piiProtection;
  if (!isRecord(raw) || typeof raw.policyKey !== 'string' || !raw.policyKey) return undefined;
  return { policyKey: raw.policyKey };
}

/** Tools of the server that receive real values (their upstream needs them, e.g. a mail recipient). */
export function getPiiPassthroughTools(metadata: Metadata): string[] {
  const raw = metadata?.piiPassthroughTools;
  return Array.isArray(raw) ? raw.filter((name): name is string => typeof name === 'string') : [];
}

export interface McpPiiRoundTrip {
  /** The arguments with personal data in their string values replaced by tokens. */
  protect(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** The result with this call's tokens turned back into their values. */
  restore<T>(result: T): T;
}

async function protectValue(roundTrip: PiiRoundTrip, value: unknown, depth: number): Promise<unknown> {
  if (typeof value === 'string') return roundTrip.protectText(value);
  if (depth >= MAX_DEPTH) return value;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    // One at a time: a large array must not start a scan per item at once.
    for (const item of value) out.push(await protectValue(roundTrip, item, depth + 1));
    return out;
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = await protectValue(roundTrip, item, depth + 1);
    return out;
  }
  return value;
}

/** A text that is a JSON document: a restored value is escaped so the document stays valid. */
function isJsonText(text: string): boolean {
  if (text.length > MAX_JSON_SNIFF_CHARS || !/^\s*[[{]/.test(text)) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function restoreValue(roundTrip: PiiRoundTrip, value: unknown, depth: number): unknown {
  if (typeof value === 'string') return roundTrip.restoreText(value, isJsonText(value));
  if (depth >= MAX_DEPTH) return value;
  if (Array.isArray(value)) return value.map((item) => restoreValue(roundTrip, item, depth + 1));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = restoreValue(roundTrip, item, depth + 1);
    return out;
  }
  return value;
}

/**
 * The round trip of one call, or null when nothing protects it: no policy on
 * the server, a source without an outside upstream, a tool that receives real
 * values, or a disabled policy (the call then goes as it is, as a model call
 * does). A policy that no longer exists fails the call: protection was asked for.
 */
export async function openMcpPiiRoundTrip(
  server: IMcpServer,
  sourceType: McpSourceType,
  realToolName: string,
): Promise<McpPiiRoundTrip | null> {
  if (!PROTECTED_SOURCES.has(sourceType)) return null;
  const metadata = server.metadata as Metadata;
  const config = getMcpPiiProtection(metadata);
  if (!config) return null;
  if (getPiiPassthroughTools(metadata).includes(realToolName)) return null;

  const tenantDbName = await resolveTenantDbName(server.tenantId);
  if (!tenantDbName) throw new Error('PII protection: the workspace database could not be resolved');
  // Loaded on use: this module sits under the MCP service, which the guardrail registry imports early.
  const [{ loadPolicyScanner }, { roundTripSecret }] = await Promise.all([
    import('@/lib/services/pii/piiService'),
    import('@/lib/services/models/gatewayPii'),
  ]);
  const scanner = await loadPolicyScanner({ tenantDbName, policyKey: config.policyKey, projectId: server.projectId });
  if (!scanner) return null;

  const roundTrip = new PiiRoundTrip({
    key: deriveRoundTripKey(roundTripSecret(), server.tenantId, `mcp:${String(server._id ?? server.key)}`),
    version: scanner.version,
    scan: scanner.scan,
  });
  return {
    protect: async (args) => (await protectValue(roundTrip, args, 0)) as Record<string, unknown>,
    restore: (result) => restoreValue(roundTrip, result, 0) as typeof result,
  };
}

// ── What the request log keeps ───────────────────────────────────────────────
// A protected call is logged as it crossed to the upstream: the tokenized
// arguments and the result before restoring, never the values. The view hangs
// on the arguments object the caller passes in and logs (as responseLog.ts
// marks a result). Until the arguments are tokenized they are withheld, so a
// call that fails early is not logged with the values either.

/** What a protected call sent and got back, as the upstream saw them. Plain data: it also comes back from another node. */
export interface McpPiiLog {
  arguments: Record<string, unknown>;
  result: unknown;
}

interface LogView {
  arguments: Record<string, unknown>;
  result?: { restored: unknown; tokenized: unknown };
}

const WITHHELD_MESSAGE = 'Not logged: PII protection is on for this tool';
const logViews = new WeakMap<object, LogView>();

/** Whether this tool's calls go through the round trip (from the server record alone). */
export function isMcpPiiProtected(
  server: Pick<IMcpServer, 'metadata'>,
  sourceType: McpSourceType,
  realToolName: string,
): boolean {
  const metadata = server.metadata as Metadata;
  return PROTECTED_SOURCES.has(sourceType)
    && Boolean(getMcpPiiProtection(metadata))
    && !getPiiPassthroughTools(metadata).includes(realToolName);
}

/** Before a call runs: a protected call's arguments are withheld from the log; any earlier view is dropped. */
export function preparePiiLogView(args: unknown, protectedCall: boolean): void {
  if (!isRecord(args)) return;
  if (protectedCall) logViews.set(args, { arguments: { withheld: WITHHELD_MESSAGE } });
  else logViews.delete(args);
}

/** The arguments as they left for the upstream. */
export function markPiiArgumentsView(args: unknown, tokenized: Record<string, unknown>): void {
  if (isRecord(args)) logViews.set(args, { arguments: tokenized });
}

/** A finished call: what crossed to the upstream, and the result the caller got (which the log will be handed). */
export function markPiiLogView(args: unknown, log: McpPiiLog, restored: unknown): void {
  if (isRecord(args)) logViews.set(args, { arguments: log.arguments, result: { restored, tokenized: log.result } });
}

/** The finished-call view on `args` (a call that `args` were handed on to, e.g. a composite's member). */
export function piiLogOf(args: unknown): McpPiiLog | undefined {
  const view = isRecord(args) ? logViews.get(args) : undefined;
  return view?.result ? { arguments: view.arguments, result: view.result.tokenized } : undefined;
}

/** A view on `from` also on `to` (arguments a guardrail replaced before a call failed). */
export function carryPiiArgumentsView(from: unknown, to: unknown): void {
  if (from === to || !isRecord(from) || !isRecord(to)) return;
  const view = logViews.get(from);
  if (view) logViews.set(to, { arguments: view.arguments });
}

/**
 * The payloads a log row keeps. Unchanged for a call that was not protected;
 * for a protected one, the tokenized arguments and result. A response that is
 * not the result the call returned (a caller wraps a text result as `{ value }`)
 * is matched on that; anything else is withheld rather than logged with values.
 */
export function piiLoggedPayloads<Req, Res>(
  requestPayload: Req,
  responsePayload: Res,
): { requestPayload: Req; responsePayload: Res } {
  const view = isRecord(requestPayload) ? logViewOf(requestPayload.arguments) : undefined;
  if (!view) return { requestPayload, responsePayload };
  const request = { ...(requestPayload as Record<string, unknown>), arguments: view.arguments } as Req;
  if (responsePayload === undefined || responsePayload === null) return { requestPayload: request, responsePayload };
  let response: unknown = { withheld: WITHHELD_MESSAGE };
  if (view.result) {
    const { restored, tokenized } = view.result;
    if (responsePayload === restored) {
      response = isRecord(tokenized) || Array.isArray(tokenized) ? tokenized : { value: tokenized };
    } else if (isRecord(responsePayload) && 'value' in responsePayload && responsePayload.value === restored) {
      response = { ...responsePayload, value: tokenized };
    }
  }
  return { requestPayload: request, responsePayload: response as Res };
}

function logViewOf(args: unknown): LogView | undefined {
  return isRecord(args) ? logViews.get(args) : undefined;
}
