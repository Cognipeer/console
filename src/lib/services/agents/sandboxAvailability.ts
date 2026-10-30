/**
 * Whether this deployment and tenant can use the sandbox module at all — the one rule an agent's sandbox tools
 * and the internal MCP sandbox providers share.
 *
 * Enterprise only: the module ships in the enterprise overlay (`agentSandboxRunner` seam) AND the tenant needs an
 * active Enterprise license, checked on every use. Kept apart from `agentSandboxTools.ts` so the MCP providers can
 * ask without importing the agent run path.
 */

import { agentSandboxRunner, type AgentSandboxRunner } from '@/enterprise/registry';
import { isTenantEnterpriseLicensed } from '@/lib/license/tenantLicense';

export type SandboxAvailability =
    | { available: true; runner: AgentSandboxRunner }
    | { available: false; reason: 'edition' | 'license' };

/** Whether this deployment and tenant can give agents (and MCP servers) a sandbox at all. */
export async function resolveSandboxAvailability(tenantId: string): Promise<SandboxAvailability> {
    // Optional chaining on the REF too: an overlay registry from before seam 4
    // replaces this file without exporting `agentSandboxRunner` at all, and
    // that mismatch must read as "no sandbox module", not crash every agent.
    const runner = agentSandboxRunner?.current;
    if (!runner) return { available: false, reason: 'edition' };
    if (!(await isTenantEnterpriseLicensed(tenantId))) return { available: false, reason: 'license' };
    return { available: true, runner };
}
