/**
 * Enterprise extension registry — COMMUNITY (open-source) edition.
 *
 * This is the single seam through which the closed-source enterprise overlay
 * plugs into the community core. In the community edition every collection
 * below is EMPTY, so all `apply*` / loops are no-ops and the FREE product runs
 * unchanged.
 *
 * The enterprise overlay repository (cognipeer-console-ee) ships a file that
 * REPLACES this one (same path) and populates the collections by importing the
 * real implementations from `@/enterprise/impl/*`. See the cognipeer-console-ee repo (docs/licensing/SEAM-DESIGN.md).
 *
 * IMPORTANT: keep this file dependency-free of any enterprise module. It must
 * compile and run with zero enterprise code present.
 */

import type { FastifyInstance } from 'fastify';

/**
 * THE SEAM CONTRACT VERSION, declared in code so CI can check it.
 *
 * It used to live only in `console-ee/COMPAT.json`, which meant nothing could
 * verify that the community tree an overlay is applied to actually speaks the
 * shape that overlay expects. The build workflows resolve the community source
 * from `compatibleCommunity` alone and take the HIGHEST matching tag
 * (`console-saas-build.yml:33-58`), so a range whose floor still admits an
 * older line silently selects it, and the mismatch surfaces as an overlay
 * typecheck error naming none of this. That is a discipline-enforced
 * invariant; this constant makes it machine-enforced.
 *
 * Bump it whenever the SHAPE of this file changes — a collection added or
 * removed, a signature changed — and bump `COMPAT.json.seamContractVersion`
 * with it. The overlay file that REPLACES this one must declare the same
 * number.
 *
 * 3 — the guardrail hook plane replaced the Aegis enforcement plane:
 *     `EnterpriseDbMethods` lost the nine `*Aegis*` methods,
 *     `McpGuardrailContext` gained `guardrailKey`, and `mcpGuardrailHook`
 *     is now claimed by the community bridge rather than assigned by the
 *     overlay.
 */
export const SEAM_CONTRACT_VERSION = 3;



// ── Deterministic agent insights ──────────────────────────────────────────
/**
 * Derives the deterministic per-agent / per-model analysis (tool-menu size,
 * system-prompt lint, repeated-call waste, recurring errors) from a bounded
 * sample of tracing sessions.
 *
 * EMPTY in the community edition: the tracing service records the sessions and
 * events, but deriving the analysis from them is part of the enterprise Cost &
 * Optimization module. With no provider registered the overview endpoints
 * simply report `insights: null`, which every consumer already handles.
 *
 * Kept deliberately loose (`Record<string, unknown>`) so the community contract
 * carries no enterprise shape; the overlay narrows it to its own type.
 */
export type AgentInsightsProvider = (
  db: unknown,
  projectId: string,
  sortedSessions: Array<Record<string, unknown>>,
  options?: { modelName?: string },
) => Promise<Record<string, unknown> | null>;

export const enterpriseAgentInsightsProviders: AgentInsightsProvider[] = [];

/** Run the registered provider, or report no insights in the community build. */
export async function deriveEnterpriseAgentInsights(
  db: unknown,
  projectId: string,
  sortedSessions: Array<Record<string, unknown>>,
  options?: { modelName?: string },
): Promise<Record<string, unknown> | null> {
  const provider = enterpriseAgentInsightsProviders[0];
  if (!provider) return null;
  return provider(db, projectId, sortedSessions, options);
}

// ── Background queue consumers ────────────────────────────────────────────
/**
 * Queue consumers an enterprise module needs started at boot. EMPTY in the
 * community edition. `bootstrap.ts` awaits each one after the community
 * consumers are registered.
 */
export type EnterpriseQueueConsumerStarter = () => void | Promise<void>;

export const enterpriseQueueConsumers: EnterpriseQueueConsumerStarter[] = [];

// ── DB provider mixins ────────────────────────────────────────────────────
// A mixin takes a base constructor and returns an extended one. For the
// community type contract we treat them as identity over the base type:
// enterprise DB methods are accessed dynamically (they are not part of the
// `DatabaseProvider` interface), exactly as they are today.
export type GenericConstructor = new (...args: any[]) => object;
export type DbMixin = <T extends GenericConstructor>(Base: T) => T;

/**
 * Marker interface for the DB methods the enterprise mixins add. EMPTY in the
 * community edition. The overlay augments it (declaration merging) with the
 * gpu-fleet / sandbox method signatures. `DatabaseProvider` extends this, so the
 * community contract gains nothing and the enterprise contract gains the methods
 * — both from this single seam.
 */
export interface EnterpriseDbMethods {}
type EnterpriseDbCtor = new (...args: any[]) => EnterpriseDbMethods;

// SQLite and MongoDB have SEPARATE mixin implementations, so the overlay must
// contribute them to the matching provider. Order = application order.
export const enterpriseSqliteDbMixins: DbMixin[] = [];
export const enterpriseMongoDbMixins: DbMixin[] = [];

export function applyEnterpriseSqliteDbMixins<T extends GenericConstructor>(Base: T): T & EnterpriseDbCtor {
  return enterpriseSqliteDbMixins.reduce<GenericConstructor>((Acc, mixin) => mixin(Acc), Base) as T & EnterpriseDbCtor;
}

export function applyEnterpriseMongoDbMixins<T extends GenericConstructor>(Base: T): T & EnterpriseDbCtor {
  return enterpriseMongoDbMixins.reduce<GenericConstructor>((Acc, mixin) => mixin(Acc), Base) as T & EnterpriseDbCtor;
}

// ── Fastify API plugins ───────────────────────────────────────────────────
// Each registrar receives the Fastify app and registers its own plugin(s).
// This keeps the core plugin bootstrap decoupled from enterprise plugin types.
export type EnterprisePluginRegistrar = (app: FastifyInstance) => Promise<void> | void;

export const enterpriseApiPlugins: EnterprisePluginRegistrar[] = [];

export async function registerEnterpriseApiPlugins(app: FastifyInstance): Promise<void> {
  for (const register of enterpriseApiPlugins) {
    await register(app);
  }
}

// ── Bootstrap reconcilers ─────────────────────────────────────────────────
// Run once during server bootstrap (e.g. sandbox/gpu-fleet runtime reconcile).
// Each hook is isolated: a throw is logged by the caller and does not abort
// startup.
export type BootstrapHook = () => Promise<void> | void;

export const enterpriseReconcilers: BootstrapHook[] = [];

// ── Public-path contributions ─────────────────────────────────────────────
// Extra unauthenticated path prefixes the enterprise edition needs (e.g. the
// gpu-fleet installer.sh / agent bundle download). Merged into PUBLIC_API_*.
export const enterprisePublicApiPaths: string[] = [];
export const enterprisePublicApiPrefixes: string[] = [];

// ── MCP sandbox runner seam ───────────────────────────────────────────────
// Runs stdio MCP servers on persistent sandboxes (enterprise sandbox module).
// The overlay assigns `mcpSandboxRunner.current`; community leaves it null and
// the create flow rejects executionMode 'sandbox' with a clear message.
export interface McpSandboxRunnerServerRef {
  tenantDbName: string;
  tenantId: string;
  projectId?: string;
  serverId: string;
  serverKey: string;
}

export interface McpSandboxRunnerConfig {
  runtime: 'npx' | 'uvx';
  packageName: string;
  args?: string[];
  env?: Record<string, string>;
  templateKey?: string;
  resources?: { cpuCores?: number; memoryMb?: number };
  instanceId?: string;
}

export interface McpSandboxToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpSandboxRunner {
  /**
   * Ensure a persistent sandbox is running the given stdio MCP server.
   * Returns the (possibly newly provisioned) instance id so the caller can
   * persist it on the server record.
   */
  ensureRunning(
    ref: McpSandboxRunnerServerRef,
    config: McpSandboxRunnerConfig,
  ): Promise<{ instanceId: string }>;
  /** Discover the tool list from the sandbox-hosted MCP server. */
  listTools(
    ref: McpSandboxRunnerServerRef,
    config: McpSandboxRunnerConfig,
  ): Promise<McpSandboxToolInfo[]>;
  /** Call a tool on the sandbox-hosted MCP server. */
  callTool(
    ref: McpSandboxRunnerServerRef,
    config: McpSandboxRunnerConfig,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown>;
  /** Stop/release the sandbox backing the server (delete/disable flows). */
  release(ref: McpSandboxRunnerServerRef, instanceId?: string): Promise<void>;
  /** Lightweight status probe for the monitor screen. */
  status(ref: McpSandboxRunnerServerRef, instanceId?: string): Promise<{
    state: 'running' | 'stopped' | 'failed' | 'unknown';
    detail?: string;
  }>;
}

export const mcpSandboxRunner: { current: McpSandboxRunner | null } = { current: null };

// ── MCP guardrail seam ────────────────────────────────────────────────────
// Pre/post hooks around every MCP tool call. This USED to be an enterprise-only
// seam wired to the Aegis enforcement plane; it is now filled by the community
// guardrail hook plane (`tool.pre` / `tool.post`) and needs no overlay and no
// license. A pre-hook may block the call by returning `{ allowed: false }`.
//
// The seam SHAPE is deliberately unchanged so the overlay's own copy of this
// file keeps satisfying it for the release in which both exist.
export interface McpGuardrailContext {
  tenantId: string;
  projectId?: string;
  serverKey: string;
  toolName: string;
  /**
   * @deprecated Dead reference. Every stored value is an id from the removed
   * `aegis_shields` table, so resolving one finds nothing. Retained ONLY so an
   * overlay implementation still compiles; `mcpService` no longer sets it and
   * no implementation may read it. Use `guardrailKey`.
   */
  shieldId?: string;
  /**
   * Which guardrail evaluates this call. Absent means "the tenant's default
   * tool guardrail", which is what keeps a server armed with no per-server
   * setup.
   */
  guardrailKey?: string;
  /** Server-level binding. Kept in the MCP vocabulary ('off', not 'disabled'). */
  mode: 'off' | 'monitor' | 'enforce';
}

export interface McpGuardrailHook {
  beforeToolCall(
    ctx: McpGuardrailContext,
    args: Record<string, unknown>,
  ): Promise<{ allowed: boolean; reason?: string; args?: Record<string, unknown> }>;
  afterToolCall(
    ctx: McpGuardrailContext,
    result: unknown,
  ): Promise<{ allowed: boolean; reason?: string; result?: unknown }>;
}

/**
 * Filled by `consoleMcpGuardrailHook` — the COMMUNITY hook-plane bridge — not
 * by an overlay, so a plain community build has a live guardrail on every MCP
 * tool call. `ensureMcpGuardrailHook()` (guardrail/hooks/mcpHook.ts) is the ONE
 * way to reach this ref: it fills it on first read and hands back whatever
 * already claimed it.
 *
 * ── WHY THE ASSIGNMENT IS NOT ON THE NEXT LINE ─────────────────────────────
 * It cannot be. This file is imported by `sqlite.provider.ts` and
 * `mongodb.provider.ts`, both of which call `applyEnterprise*DbMixins` at
 * MODULE SCOPE (`const FinalBase = ...`, sqlite.provider.ts:97 /
 * mongodb.provider.ts:96). The bridge reaches `@/lib/database` through the hook
 * engine, so importing it here closes the cycle
 *   registry -> mcpHook -> engine -> @/lib/database -> *.provider -> registry
 * and, whenever registry is the module that ENTERS that cycle (bootstrap.ts,
 * api/plugin.ts), the provider re-enters this file mid-evaluation and reads
 * `enterpriseMongoDbMixins` while it is still in its TDZ:
 *   ReferenceError: Cannot access 'enterpriseMongoDbMixins' before initialization
 * Verified, not theorised. That is also why the file header demands this module
 * stay dependency-free — the rule has teeth, and this ref is where you find out.
 *
 * ── AND WHY NOBODY MAY *READ* IT AT MODULE SCOPE EITHER ────────────────────
 * The mirror image of the above, and it bit us once already. In the enterprise
 * overlay this file additionally imports ~20 Fastify plugins, and one of those
 * graphs comes back through `agentService -> mcp/index -> mcpService`. Imports
 * are hoisted, so that runs before the `= { current: null }` initialiser below:
 * a module-scope read there sees the binding before it exists and kills boot
 * with `TypeError: Cannot read properties of undefined (reading 'current')`.
 * Resolve the seam at CALL time — `ensureMcpGuardrailHook()` does exactly that.
 */
export const mcpGuardrailHook: { current: McpGuardrailHook | null } = { current: null };

// ── Edition flag ──────────────────────────────────────────────────────────
// True only when the overlay has replaced this file. Lets the UI/runtime tell
// "feature absent (community build)" apart from "feature present but FREE tier".
export const IS_ENTERPRISE_BUILD = false;
