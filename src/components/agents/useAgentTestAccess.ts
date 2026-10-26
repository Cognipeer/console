'use client';

/**
 * Whether the signed-in person may run an agent test (or create / change one): Evaluations and Red team need
 * Write on Agents for it, whatever the revision (published, a pinned version, the draft). For the controls
 * only: a button that would end in a 403 is switched off and says why. A hint, never the enforcement - the
 * server decides every request and answers the refusal in the same words.
 */

import { useMemo } from 'react';
import { useEffectivePermissions, type EffectivePermissions } from '@/components/layout/useEffectivePermissions';

/** Said by every control that is off because of it. */
export const AGENT_TEST_ACCESS_HINT = 'Running an agent test needs Write access to Agents';

export interface AgentTestAccess {
  /**
   * false only when the engine's level for Agents is known and below write. While it is not known (still
   * loading, or no answer) the controls stay on: the server decides and answers 403 if it must.
   */
  canRunAgentTests: boolean;
}

/** The mapping of `useAgentTestAccess` as a pure function. */
export function agentTestAccessFromPermissions(permissions: EffectivePermissions | null | undefined): AgentTestAccess {
  const level = permissions?.agents ?? null;
  return { canRunAgentTests: level === null || level === 'write' || level === 'admin' };
}

export function useAgentTestAccess(): AgentTestAccess {
  const permissions = useEffectivePermissions();
  return useMemo(() => agentTestAccessFromPermissions(permissions), [permissions]);
}
