/**
 * Which lifetime an agent's sandbox config asks for.
 *
 * Kept free of server imports: the Studio panel, the validator and the run
 * path all read the same rule, and the panel is a client component.
 */

import type { AgentSandboxMode } from '@/lib/database';

export type ResolvedSandboxMode = 'session' | 'ephemeral' | 'instance';

/**
 * `session` is the default. `persist` is the name this mode had before the
 * sandbox stayed up between turns, and is still read as `session` so agents
 * saved with it keep working. `instance` is an existing persistent sandbox
 * (`config.sandbox.instanceId`), not a lifetime the agent manages.
 */
export function resolveSandboxMode(mode: AgentSandboxMode | undefined): ResolvedSandboxMode {
    if (mode === 'ephemeral' || mode === 'instance') return mode;
    return 'session';
}

export const SANDBOX_MODES: readonly AgentSandboxMode[] = ['session', 'ephemeral', 'instance', 'persist'];
