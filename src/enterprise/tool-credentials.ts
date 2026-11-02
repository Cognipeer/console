/**
 * Managed tool credentials seam — COMMUNITY (open-source) edition.
 *
 * A tool whose `upstreamAuth.type` is `'connector'` holds no secret of its own:
 * it names the connector that owns it, and the credential (the connector's
 * organization account, refreshed when needed) is resolved for each call by
 * the resolver the enterprise Connectors module registers here.
 *
 * Nothing is registered in the community edition, so a call on such a tool
 * fails closed (see `resolveUpstreamAuth` in services/tools/toolService.ts).
 * The community build never creates one: only the Connectors module does.
 *
 * Leaf module on purpose: only types are imported, so the overlay registry can
 * import it at load time without creating a cycle, and it is a separate
 * community file (NOT replaced by the overlay), so the `registry.ts` seam shape
 * and SEAM_CONTRACT_VERSION do not change because of it.
 * Never read a registered value at module scope: resolve it at call time.
 */
import type { ITool, IToolAuthConfig } from '@/lib/database';

export interface ManagedToolCredential {
  /** Applied to the upstream request like a static credential: `token`, `header` or `basic`. */
  auth: IToolAuthConfig;
  /** Headers the owner adds to every upstream request (for example an MCP server's toolset selection). */
  headers?: Record<string, string>;
}

/**
 * Returns the credential for one upstream call of `tool`. It throws when the
 * tool is not one its owner manages, or when the account cannot be used (not
 * connected, revoked, needs to be connected again); the message is shown to
 * the caller and the model, so it says what to do and holds no secret.
 */
export type ManagedToolCredentialResolver = (tool: ITool) => Promise<ManagedToolCredential>;

let resolver: ManagedToolCredentialResolver | null = null;

export function registerToolCredentialResolver(fn: ManagedToolCredentialResolver): void {
  resolver = fn;
}

export function getToolCredentialResolver(): ManagedToolCredentialResolver | null {
  return resolver;
}

/** Tests only: forget the registered resolver (the enterprise registry registers one when it loads). */
export function __resetToolCredentialResolverForTests(): void {
  resolver = null;
}
