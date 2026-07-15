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

// ── MCP Aegis guardrail seam ──────────────────────────────────────────────
// Pre/post hooks around every MCP tool call. The enterprise overlay wires
// these to the Aegis enforcement plane (shield evaluation); community is a
// no-op. A pre-hook may block the call by returning `{ allowed: false }`.
export interface McpGuardrailContext {
  tenantId: string;
  projectId?: string;
  serverKey: string;
  toolName: string;
  shieldId?: string;
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

export const mcpGuardrailHook: { current: McpGuardrailHook | null } = { current: null };

// ── Edition flag ──────────────────────────────────────────────────────────
// True only when the overlay has replaced this file. Lets the UI/runtime tell
// "feature absent (community build)" apart from "feature present but FREE tier".
export const IS_ENTERPRISE_BUILD = false;
