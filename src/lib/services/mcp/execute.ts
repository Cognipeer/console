import { enforceServiceQuota } from '@/lib/quota/serviceQuota';
import { assertServiceEnabled } from '@/lib/services/availability/serviceAvailability';
import { getDatabase } from '@/lib/database';
import type { IMcpServer } from '@/lib/database';
import { maskSecretValues } from '@/lib/services/logRedaction';
import { readResponseText, safeFetch } from '@/lib/security/outboundFetch';
import { routeInstanceCall } from '@/lib/core/cluster';
import type { QueuePayload } from '@/lib/core/queue';
import { mcpEntityId } from './mcpEntityId';
import { isMcpToolInputError, McpUnknownToolError, McpUpstreamError } from './errors';
import { responseLogSummaryOf, setResponseLogSummary } from './responseLog';
import { buildOpenApiRequest } from './openApiRequest';
import { specDeclaredParameters } from './openApiSpecParameters';
import { openAuthConfig } from './secretVault';
import { remoteCallTool, withUpstreamLimits } from './remoteMcpClient';
import { isConsoleIdentityRefusal, type ConsoleIdentityCaller } from '@/lib/iam/consoleIdentity';
import { stdioCallTool } from './stdioRunner';
import { ensureMcpGuardrailHook } from '@/lib/services/guardrail/hooks/mcpHook';
import { requireInternalMcpProvider } from './internal/registry';
import { assertMemberUsable } from './composite';
import { sanitizeExecutionError } from './executionError';
import { resolveMcpGuardrailBinding } from './guardrailBinding';
import { serverConsoleIdentityAuth, withConsoleIdentityHeader } from './identityAuth';
import { recordMcpServerMetric } from './monitor';
import { claimLastErrorWrite, lastErrorRecord, logMcpRequest, mcpRequestSecretValues, upstreamCredentialValues } from './requestLog';
import { ensureSandboxInstance, resolveSandboxRunner } from './sandboxHost';
import { resolveSourceType } from './serverView';
import { isMcpToolEnabled, resolveMcpToolName } from './toolOverrides';

// ── Guardrail seam registration ───────────────────────────────────────────
// The seam is filled by `ensureMcpGuardrailHook()`, called from
// `executeMcpToolLocal` below — NOT here at module scope. This file is pulled
// into `registry.ts`'s own import phase in the enterprise overlay
// (registry -> plugins/realtime -> ... -> agentService -> mcp/index -> here),
// where `mcpGuardrailHook` does not exist yet, so a module-scope read of the
// ref takes the process down at boot. See `ensureMcpGuardrailHook`'s doc for
// the full chain and for why optional-chaining it is the wrong fix.

// ── MCP Proxy ─────────────────────────────────────────────────────────────

/**
 * A disabled tool, a guardrail enforce-mode block and a Console identity
 * refusal (nobody to mint a token for) are policy outcomes, not server faults. They are told apart by message (the same text a routed call
 * carries back from another node) and kept out of the health rollup so they
 * cannot raise the server's error rate.
 */
function isMcpPolicyOutcome(error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';
  return isConsoleIdentityRefusal(error)
    || /^Tool ".*" is disabled on MCP server /.test(message)
    || message.startsWith('Blocked by guardrail')
    || message.startsWith('Response blocked by guardrail');
}

/** What a tool call returns; plain data, so it also comes back from another node. */
export interface McpToolOutcome {
  result: unknown;
  latencyMs: number;
  /** Set when the request log keeps this summary of `result` instead of the result (see responseLog.ts). */
  logSummary?: Record<string, unknown>;
}

/**
 * What a cross-node `invoke` job carries: which server to run (the worker
 * loads the record itself), and the call. The server record — with its sealed
 * credentials and stdio config — never travels through the queue.
 */
export interface McpInvokeJob {
  tenantId: string;
  serverId: string;
  serverKey: string;
  toolName: string;
  args: Record<string, unknown>;
  runtimeHeaders?: Record<string, string>;
  /** Who the call is for (plain data, no token): the executing node mints the upstream token itself. */
  identity?: ConsoleIdentityCaller;
}

/**
 * The single choke point for MCP tool execution (dashboard playground, client
 * API, public MCP and agents all come through here), so health is recorded
 * here and nowhere else: not in `logMcpRequest` (composite member rows would
 * double count) and not in `executeMcpToolLocal` (a routed call would be
 * counted on both nodes). A composite call is counted once under the
 * composite's key and its member hop once under the member's key, so
 * tenant-wide MCP totals include member hops. Policy outcomes (disabled tool,
 * guardrail block) are not recorded.
 */
export async function executeMcpTool(
  server: IMcpServer,
  toolName: string,
  args: Record<string, unknown>,
  runtimeHeaders?: Record<string, string>,
  /**
   * Who the call is for: a server set up for Console identity refuses a call without a person,
   * and a knowledge base with access control answers with what that person may read.
   */
  identity?: ConsoleIdentityCaller,
  /**
   * The caller's address, for a call made outside the request-context wrapper (the public route);
   * everywhere else the request context carries it.
   */
  caller?: { clientIp?: string },
): Promise<McpToolOutcome> {
  // Refuse before queuing a remote call and before a failure row is logged.
  await assertServiceEnabled({ tenantId: server.tenantId }, 'mcp');
  // One check per call, here: routes, agent tools and flows all arrive through this function.
  const quotaDb = await getDatabase();
  await enforceServiceQuota(
    {
      tenantDbName: quotaDb.getCurrentTenantDbName?.(),
      tenantId: server.tenantId,
      projectId: server.projectId ?? identity?.projectId,
      userId: identity?.userId,
      tokenId: identity?.tokenId,
      clientIp: caller?.clientIp,
    },
    { domain: 'mcp', resourceKey: server.key, cost: { requests: 1 } },
  );
  const startedAt = Date.now();
  try {
    let outcome: McpToolOutcome;
    if (server._id === undefined || server._id === null) {
      outcome = await executeMcpToolLocal(server, toolName, args, runtimeHeaders, identity);
    } else {
      const job: McpInvokeJob = {
        tenantId: server.tenantId,
        serverId: String(server._id),
        serverKey: server.key,
        toolName,
        args,
        runtimeHeaders,
        ...(identity ? { identity } : {}),
      };
      outcome = await routeInstanceCall(
        {
          entityType: 'mcp',
          entityId: mcpEntityId(server.tenantId, server.key),
          jobName: 'invoke',
        },
        job as unknown as QueuePayload,
        () => executeMcpToolLocal(server, toolName, args, runtimeHeaders, identity),
      );
    }
    // The object the caller logs: a result that came back from another node is a new one.
    if (outcome.logSummary) setResponseLogSummary(outcome.result, outcome.logSummary);
    recordMcpServerMetric(server, 'ok', Date.now() - startedAt);
    return outcome;
  } catch (error) {
    if (!isMcpPolicyOutcome(error)) {
      recordMcpServerMetric(server, 'error', Date.now() - startedAt);
    }
    throw error;
  }
}

export async function executeMcpToolLocal(
  server: IMcpServer,
  toolName: string,
  args: Record<string, unknown>,
  /**
   * Caller-supplied, policy-filtered headers merged into upstream HTTP calls.
   * Applies to remote and openapi sources only; stdio/sandbox runs have no
   * upstream HTTP request to attach them to.
   */
  runtimeHeaders?: Record<string, string>,
  /**
   * Who the call is for: a remote / OpenAPI server set up for Console identity gets a token for them,
   * and an internal provider (a knowledge base with access control) is told who is asking.
   */
  identity?: ConsoleIdentityCaller,
): Promise<McpToolOutcome> {
  await assertServiceEnabled({ tenantId: server.tenantId }, 'mcp');
  const sourceType = resolveSourceType(server);
  const start = Date.now();
  // A caller may address the tool by its renamed (exposed) name — resolve
  // back to the real, stored name once, up front, so every downstream check
  // and dispatch below operates on the tool's actual identity.
  const realToolName = resolveMcpToolName(server, toolName);

  // A call may only target a tool the server advertises: the stored tool list
  // is exactly what `tools/list` is built from (minus disabled tools, with
  // renames applied), for every source type. A name the upstream happens to
  // serve but the operator never listed is not callable through this server.
  // Checked before anything else runs — guardrail, sandbox, upstream.
  if (!(server.tools ?? []).some((tool) => tool.name === realToolName)) {
    throw new McpUnknownToolError();
  }

  if (!isMcpToolEnabled(server, realToolName)) {
    throw new Error(`Tool "${toolName}" is disabled on MCP server "${server.name}"`);
  }

  // Console identity: a token for the person behind this call, minted for this upstream. Refused
  // (nobody behind the call, an unknown or disabled account) before anything else runs.
  const identityAuth = await serverConsoleIdentityAuth(server, sourceType, identity);
  const upstreamHeaders = withConsoleIdentityHeader(runtimeHeaders, identityAuth?.headers);
  const identitySecrets = identityAuth ? [identityAuth.token] : [];

  // Guardrail `tool.pre` hook. `ensureMcpGuardrailHook()` fills the seam with
  // the community bridge on first call (an overlay that claimed it first
  // wins), so this is live in every build — and resolving it HERE rather than
  // at module load is what keeps this file importable from inside
  // `registry.ts`'s import phase.
  const guardrail = ensureMcpGuardrailHook();
  const { mode: guardrailMode, guardrailKey } = resolveMcpGuardrailBinding(server);
  // ONE context object for both hooks: the bridge keys its per-call trace id on
  // this object's identity, so splitting it would split the two evaluation-log
  // rows of a single tool call.
  const guardCtx = {
    tenantId: server.tenantId,
    projectId: server.projectId,
    serverKey: server.key,
    toolName: realToolName,
    guardrailKey,
    mode: guardrailMode,
  };
  let effectiveArgs = args;
  if (guardrailMode !== 'off') {
    const verdict = await guardrail.beforeToolCall(guardCtx, args);
    if (!verdict.allowed && guardrailMode === 'enforce') {
      throw new Error(`Blocked by guardrail${verdict.reason ? `: ${verdict.reason}` : ''}`);
    }
    if (verdict.args) effectiveArgs = verdict.args;
  }

  let result: unknown;
  let logSummary: Record<string, unknown> | undefined;
  try {
    if (sourceType === 'openapi') {
      result = await executeOpenApiTool(server, realToolName, effectiveArgs, upstreamHeaders);
    } else if (sourceType === 'remote') {
      result = await remoteCallTool(
        {
          url: server.remoteConfig!.url,
          transport: server.remoteConfig!.transport,
          auth: openAuthConfig(server.upstreamAuth),
          extraHeaders: upstreamHeaders,
        },
        realToolName,
        effectiveArgs,
      );
    } else if (sourceType === 'internal') {
      const internal = (server.metadata as Record<string, unknown> | undefined)?.internal as
        | { provider?: string; instanceKey?: string; config?: Record<string, unknown> }
        | undefined;
      if (!internal?.provider || !internal.instanceKey) {
        throw new Error(`MCP server "${server.name}" has no internal provider configured`);
      }
      const provider = requireInternalMcpProvider(internal.provider);
      const db = await getDatabase();
      const tenant = await db.findTenantById(server.tenantId);
      if (!tenant?.dbName) {
        throw new Error('Could not resolve tenant database for internal MCP execution');
      }
      result = await provider.execute(
        {
          tenantDbName: tenant.dbName,
          tenantId: server.tenantId,
          projectId: server.projectId,
          serverKey: server.key,
          ...(identity ? { identity } : {}),
        },
        internal.instanceKey,
        internal.config ?? {},
        realToolName,
        effectiveArgs,
      );
    } else if (sourceType === 'composite') {
      result = await executeCompositeTool(server, realToolName, effectiveArgs, runtimeHeaders, identity);
    } else if (server.stdioConfig?.executionMode === 'sandbox') {
      const { runner, ref, runnerConfig } = await resolveSandboxRunner(server);
      await ensureSandboxInstance(server, runner, ref, runnerConfig);
      result = await runner.callTool(ref, runnerConfig, realToolName, effectiveArgs);
    } else {
      result = await stdioCallTool(server.stdioConfig!, realToolName, effectiveArgs, { tenantId: server.tenantId });
    }
    // Read before the masking below, which may hand back a copy; a composite's
    // result carries its member's mark.
    logSummary = responseLogSummaryOf(result);
    // The server's own upstream credential (and the identity token minted for
    // it) is never legitimate output: mask it here, before the result reaches
    // the guardrail, the caller or the log.
    result = maskSecretValues(result, [...upstreamCredentialValues(server), ...identitySecrets]);
  } catch (error) {
    const secretValues = [...mcpRequestSecretValues(server, upstreamHeaders), ...identitySecrets];
    const safeError = sanitizeExecutionError(error, secretValues);
    // A call the caller got wrong says nothing about the server's health.
    // Anything else is persisted on the record so the monitor can surface it.
    if (!isMcpToolInputError(safeError)) void markServerError(server, safeError.message, secretValues);
    throw safeError;
  }

  // Guardrail `tool.post` hook.
  if (guardrailMode !== 'off') {
    const verdict = await guardrail.afterToolCall(guardCtx, result);
    if (!verdict.allowed && guardrailMode === 'enforce') {
      throw new Error(`Response blocked by guardrail${verdict.reason ? `: ${verdict.reason}` : ''}`);
    }
    if (verdict.result !== undefined) result = verdict.result;
  }

  return { result, latencyMs: Date.now() - start, ...(logSummary ? { logSummary } : {}) };
}

/**
 * Route one composite tool call to its member server and record a
 * member-scoped log entry alongside the caller's own external-facing log
 * (written by whichever route handler called `executeMcpTool` on the
 * composite) — so the member's own Logs tab and per-tool aggregate reflect
 * calls that arrived via this composite, without double-billing usage (see
 * `logMcpRequest`'s `skipUsageEvent`).
 *
 * Runtime-header passthrough: the composite's own opt-in policy already
 * gated which headers reached this function at all (default-deny, resolved
 * by the caller before `executeMcpTool` runs) — the member's own
 * `runtimeHeaders` policy is not independently re-checked for calls that
 * arrive via a composite. This mirrors every other multi-hop MCP source
 * today (there is one policy checkpoint per call, not one per hop).
 */
async function executeCompositeTool(
  server: IMcpServer,
  toolName: string,
  args: Record<string, unknown>,
  runtimeHeaders: Record<string, string> | undefined,
  identity: ConsoleIdentityCaller | undefined,
): Promise<unknown> {
  const tool = (server.tools ?? []).find((t) => t.name === toolName);
  if (!tool?.origin) {
    throw new Error(
      `Tool "${toolName}" has no member mapping on composite server "${server.name}" — try refreshing its tools`,
    );
  }

  const db = await getDatabase();
  const member = await db.findMcpServerById(tool.origin.serverId);
  assertMemberUsable(
    { id: String(server._id ?? ''), tenantId: server.tenantId, projectId: server.projectId },
    member,
    tool.origin.serverId,
  );
  const m = member!;
  if (m.status !== 'active') {
    throw new Error(`Member server "${m.name}" is disabled`);
  }

  const tenant = await db.findTenantById(server.tenantId);
  const tenantDbName = tenant?.dbName;
  const start = Date.now();

  // The member's log row is scrubbed with the MEMBER's secrets: its credential
  // and its runtime headers are what its upstream can echo.
  const memberSecrets = mcpRequestSecretValues(m, runtimeHeaders);

  try {
    // A member set up for Console identity mints its own token, for its own URL.
    const { result } = await executeMcpTool(m, tool.origin.realName, args, runtimeHeaders, identity);
    if (tenantDbName) {
      void logMcpRequest(tenantDbName, {
        tenantId: m.tenantId,
        projectId: m.projectId,
        serverId: String(m._id),
        serverKey: m.key,
        toolName: tool.origin.realName,
        status: 'success',
        latencyMs: Date.now() - start,
        requestPayload: { tool: tool.origin.realName, arguments: args },
        responsePayload: typeof result === 'object' && result !== null
          ? result as Record<string, unknown>
          : { value: result },
        viaServerKey: server.key,
        transport: 'internal',
        sourceType: resolveSourceType(m),
      }, memberSecrets, { skipUsageEvent: true });
    }
    return result;
  } catch (error) {
    if (tenantDbName) {
      const message = error instanceof Error ? error.message : 'Execution failed';
      void logMcpRequest(tenantDbName, {
        tenantId: m.tenantId,
        projectId: m.projectId,
        serverId: String(m._id),
        serverKey: m.key,
        toolName: tool.origin.realName,
        status: 'error',
        latencyMs: Date.now() - start,
        requestPayload: { tool: tool.origin.realName, arguments: args },
        errorMessage: message,
        viaServerKey: server.key,
        transport: 'internal',
        sourceType: resolveSourceType(m),
      }, memberSecrets, { skipUsageEvent: true });
    }
    throw error;
  }
}

async function markServerError(
  server: IMcpServer,
  message: string,
  secretValues?: string[],
): Promise<void> {
  try {
    if (!server._id) return;
    const record = lastErrorRecord(server, message, secretValues);
    // The same failure on every call is one write, not one per call.
    if (!claimLastErrorWrite(server, record.message)) return;
    const db = await getDatabase();
    // The caller already bound the tenant context for this request.
    await db.updateMcpServer(String(server._id), { lastError: record });
  } catch {
    // Best-effort only.
  }
}

/** Exported for the response-limit tests; callers go through `executeMcpTool`. */
export async function executeOpenApiTool(
  server: IMcpServer,
  toolName: string,
  args: Record<string, unknown>,
  runtimeHeaders?: Record<string, string>,
): Promise<unknown> {
  const tool = server.tools.find((t) => t.name === toolName);
  if (!tool) {
    throw new McpUnknownToolError();
  }
  if (!tool.httpPath || !tool.httpMethod) {
    throw new Error(`Tool "${toolName}" has no HTTP mapping`);
  }

  // Path parameters are filled in the tool's path template only, from the
  // arguments the tool declares; see `buildOpenApiRequest` for the rules.
  const request = buildOpenApiRequest({
    baseUrl: server.upstreamBaseUrl,
    httpPath: tool.httpPath,
    inputSchema: tool.inputSchema,
    declaredNames: specDeclaredParameters(server, tool),
    args,
  });

  // Build headers with upstream auth (decrypted from the vault)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };

  const auth = openAuthConfig(server.upstreamAuth);
  if (auth?.type === 'token' && auth.token) {
    headers['Authorization'] = `Bearer ${auth.token}`;
  } else if (auth?.type === 'header' && auth.headerName && auth.headerValue) {
    headers[auth.headerName] = auth.headerValue;
  } else if (auth?.type === 'basic' && auth.username && auth.password) {
    const encoded = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
    headers['Authorization'] = `Basic ${encoded}`;
  }

  // Caller-supplied runtime headers (already policy-filtered) win over static auth.
  Object.assign(headers, runtimeHeaders);

  const fetchOptions: RequestInit = {
    method: tool.httpMethod,
    headers,
  };

  if (request.body && ['POST', 'PUT', 'PATCH'].includes(tool.httpMethod)) {
    fetchOptions.body = JSON.stringify(request.body);
  }

  // The configured auth header and the runtime headers hold credentials meant
  // for this upstream; they do not follow a redirect to another origin.
  return withUpstreamLimits(async ({ signal, maxBytes }) => {
    const response = await safeFetch(request.url, { ...fetchOptions, signal }, {
      keepAbortLinked: true,
      sensitiveHeaders: [
        ...(auth?.type === 'header' && auth.headerName ? [auth.headerName] : []),
        ...Object.keys(runtimeHeaders ?? {}),
      ],
    });

    if (!response.ok) {
      const errorText = await readResponseText(response, { maxBytes: Math.min(maxBytes, 64 * 1024), signal })
        .catch(() => 'Unknown error');
      throw new McpUpstreamError(`Upstream API error (${response.status}): ${errorText}`, response.status);
    }

    const contentType = response.headers.get('content-type') || '';
    const text = await readResponseText(response, { maxBytes, signal });
    if (contentType.includes('application/json')) {
      return JSON.parse(text);
    }
    return text;
  });
}
