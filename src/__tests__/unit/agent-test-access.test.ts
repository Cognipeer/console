// @vitest-environment jsdom
/**
 * Who may run an agent test (or create / change one): Write on Agents, whatever the revision. The pure
 * mapping, and the hook that reads it from the session's effective permissions: on until the engine says
 * otherwise (the server decides and answers 403 for what the hint missed).
 * (createElement, not JSX: the suite only collects `.test.ts`.)
 */

import { createElement as h } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AGENT_TEST_ACCESS_HINT,
  agentTestAccessFromPermissions,
  useAgentTestAccess,
  type AgentTestAccess,
} from '@/components/agents/useAgentTestAccess';
import { installApiMock, installDomStubs, mount, wait, type Mounted } from '../helpers/iamCenterUi';

describe('agentTestAccessFromPermissions', () => {
  it('lets write and admin run agent tests', () => {
    expect(agentTestAccessFromPermissions({ agents: 'write' })).toEqual({ canRunAgentTests: true });
    expect(agentTestAccessFromPermissions({ agents: 'admin' })).toEqual({ canRunAgentTests: true });
  });

  it('refuses read and none once the level is known', () => {
    expect(agentTestAccessFromPermissions({ agents: 'read' })).toEqual({ canRunAgentTests: false });
    expect(agentTestAccessFromPermissions({ agents: 'none' })).toEqual({ canRunAgentTests: false });
  });

  it('reads Agents only: another service at admin does not stand in for it', () => {
    expect(agentTestAccessFromPermissions({ agents: 'read', evaluations: 'admin', redteam: 'admin' })).toEqual({ canRunAgentTests: false });
    expect(agentTestAccessFromPermissions({ agents: 'write', evaluations: 'read', redteam: 'none' })).toEqual({ canRunAgentTests: true });
  });

  it('leaves it to the server while the level is not known', () => {
    expect(agentTestAccessFromPermissions(null)).toEqual({ canRunAgentTests: true });
    expect(agentTestAccessFromPermissions(undefined)).toEqual({ canRunAgentTests: true });
    expect(agentTestAccessFromPermissions({})).toEqual({ canRunAgentTests: true });
    expect(agentTestAccessFromPermissions({ evaluations: 'write' })).toEqual({ canRunAgentTests: true });
  });

  it('says what the user must ask for', () => {
    expect(AGENT_TEST_ACCESS_HINT).toBe('Running an agent test needs Write access to Agents');
  });
});

describe('useAgentTestAccess', () => {
  beforeAll(() => {
    installDomStubs();
  });

  const mounted: Mounted[] = [];
  afterEach(async () => {
    for (const item of mounted.splice(0)) await item.unmount();
    vi.unstubAllGlobals();
  });

  /** Mounts the hook and keeps every value it returned, in order. */
  async function renderAccess() {
    const history: AgentTestAccess[] = [];
    function Probe() {
      history.push(useAgentTestAccess());
      return null;
    }
    mounted.push(await mount(h(Probe)));
    return history;
  }

  it('allows until the session answers, then follows the level for Agents', async () => {
    installApiMock([['GET', '/api/auth/session', () => ({ effectivePermissions: { agents: 'read', evaluations: 'admin' } })]]);
    const history = await renderAccess();
    expect(history[0]).toEqual({ canRunAgentTests: true });
    await wait(20);
    expect(history.at(-1)).toEqual({ canRunAgentTests: false });
  });

  it('stays on for a level that can write', async () => {
    installApiMock([['GET', '/api/auth/session', () => ({ effectivePermissions: { agents: 'write' } })]]);
    const history = await renderAccess();
    await wait(20);
    expect(history.every((access) => access.canRunAgentTests)).toBe(true);
  });

  it('stays on when the session gives no answer', async () => {
    installApiMock([['GET', '/api/auth/session', () => ({ authenticated: true, effectivePermissions: null })]]);
    const history = await renderAccess();
    await wait(20);
    expect(history.every((access) => access.canRunAgentTests)).toBe(true);
  });
});
