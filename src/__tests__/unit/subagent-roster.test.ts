/**
 * Which sub-agents a run can actually delegate to: the roster as declared, minus
 * a policy that switches delegation off, minus entries switched off, minus `ref`
 * entries whose agent cannot be loaded.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ getDatabase: vi.fn() }));
vi.mock('@/lib/database', () => ({ getDatabase: hoisted.getDatabase }));

import {
  activeSubagentEntries,
  resolveSubagentTarget,
  subagentModelKeys,
} from '@/lib/services/agents/subagentRoster';

type Entry = Parameters<typeof resolveSubagentTarget>[2] & Record<string, unknown>;
const inline = (name: string, extra: Record<string, unknown> = {}) => ({ kind: 'inline', name, header: name, ...extra }) as never;
const ref = (name: string, agentKey: string, extra: Record<string, unknown> = {}) => ({ kind: 'ref', name, header: name, agentKey, ...extra }) as never;

/** Agents of the project by key: a draft config, an optional published snapshot, an optional pinned one. */
function stubAgents(agents: Record<string, { config: Record<string, unknown>; published?: Record<string, unknown>; pinned?: Record<string, unknown> }>) {
  const findAgentByKey = vi.fn(async (key: string) => {
    const agent = agents[key];
    return agent ? { _id: `id-${key}`, key, config: agent.config, publishedVersion: agent.published ? 2 : undefined } : null;
  });
  const findAgentVersion = vi.fn(async (id: string, version: number) => {
    const agent = agents[id.replace('id-', '')];
    const snapshot = version === 2 ? agent?.published : version === 1 ? agent?.pinned : undefined;
    return snapshot ? { version, snapshot: { config: snapshot } } : null;
  });
  hoisted.getDatabase.mockResolvedValue({ switchToTenant: vi.fn(), findAgentByKey, findAgentVersion });
  return { findAgentByKey, findAgentVersion };
}

beforeEach(() => {
  vi.clearAllMocks();
  stubAgents({});
});

describe('activeSubagentEntries', () => {
  it('is every entry that is not switched off', () => {
    const entries = [inline('a'), inline('b', { enabled: false }), inline('c', { enabled: true })];
    expect(activeSubagentEntries({ subagents: entries }).map((e) => e.name)).toEqual(['a', 'c']);
  });

  it('is empty when the policy switches delegation off, whatever the roster says', () => {
    expect(activeSubagentEntries({ subagents: [inline('a')], subagentPolicy: { mode: 'off' } })).toEqual([]);
  });

  it('keeps the roster under every other policy, and for an agent with none', () => {
    expect(activeSubagentEntries({ subagents: [inline('a')], subagentPolicy: { mode: 'registry_only' } })).toHaveLength(1);
    expect(activeSubagentEntries({ subagents: [inline('a')], subagentPolicy: { maxDepth: 3 } })).toHaveLength(1);
    expect(activeSubagentEntries({})).toEqual([]);
  });
});

describe('resolveSubagentTarget', () => {
  const target = (entry: Entry) => resolveSubagentTarget('t_db', 'p1', entry);

  it('loads the PUBLISHED version of the agent, not its draft', async () => {
    stubAgents({ writer: { config: { modelKey: 'draft-model' }, published: { modelKey: 'live-model' } } });
    const result = await target(ref('w', 'writer') as Entry);
    expect(result).toMatchObject({ ok: true, config: { modelKey: 'live-model' }, resolvedVersion: 2 });
  });

  it('loads the pinned version when the entry pins one', async () => {
    stubAgents({ writer: { config: { modelKey: 'draft' }, published: { modelKey: 'live' }, pinned: { modelKey: 'pinned-model' } } });
    const result = await target(ref('w', 'writer', { agentVersion: 1 }) as Entry);
    expect(result).toMatchObject({ ok: true, config: { modelKey: 'pinned-model' }, resolvedVersion: 1 });
  });

  it('falls back to the draft of an agent that was never published', async () => {
    stubAgents({ writer: { config: { modelKey: 'draft-model' } } });
    expect(await target(ref('w', 'writer') as Entry)).toMatchObject({ ok: true, config: { modelKey: 'draft-model' }, resolvedVersion: null });
  });

  it('says why an entry cannot run, in words for the owner of the parent', async () => {
    stubAgents({ remote: { config: { kind: 'external', connection: { url: 'https://x' } } } });

    expect(await target(ref('w', '') as Entry)).toMatchObject({ ok: false, reason: 'no_agent_key', message: 'Sub-agent "w" was skipped: it points at no agent.' });
    expect(await target(ref('w', 'gone') as Entry)).toMatchObject({ ok: false, reason: 'unresolved', message: 'Sub-agent "w" was skipped: Agent "gone" not found.' });
    expect(await target(ref('w', 'remote') as Entry)).toMatchObject({ ok: false, reason: 'external' });
    expect(await target(ref('w', 'remote') as Entry)).toMatchObject({ message: expect.stringContaining('connected agent') });
  });

  it('reports a pinned version that does not exist, not a silent fallback', async () => {
    stubAgents({ writer: { config: { modelKey: 'draft' }, published: { modelKey: 'live' } } });
    expect(await target(ref('w', 'writer', { agentVersion: 7 }) as Entry))
      .toMatchObject({ ok: false, reason: 'unresolved', message: 'Sub-agent "w" was skipped: Version 7 not found for agent "writer".' });
  });
});

describe('subagentModelKeys', () => {
  const keys = (config: Parameters<typeof subagentModelKeys>[2]) => subagentModelKeys('t_db', 'p1', config);

  it('is the model of each inline entry that has one, once', async () => {
    expect(await keys({ subagents: [inline('a', { modelKey: 'cheap' }), inline('b', { modelKey: 'cheap' }), inline('c')] })).toEqual(['cheap']);
  });

  it('takes a referenced agent\'s model from the agent the run will load', async () => {
    stubAgents({ writer: { config: { modelKey: 'draft-model' }, published: { modelKey: 'live-model' } } });
    expect(await keys({ subagents: [ref('w', 'writer')] })).toEqual(['live-model']);
  });

  it('lets an entry\'s own model win over its target\'s', async () => {
    stubAgents({ writer: { config: { modelKey: 'target-model' } } });
    expect(await keys({ subagents: [ref('w', 'writer', { modelKey: 'override' })] })).toEqual(['override']);
  });

  it('skips a reference the run would skip, whatever model it names', async () => {
    stubAgents({ remote: { config: { kind: 'external', modelKey: 'x' } } });
    expect(await keys({ subagents: [ref('a', 'gone', { modelKey: 'override' }), ref('b', 'remote'), ref('c', '')] })).toEqual([]);
  });

  it('is empty for a roster that cannot run, without loading anything', async () => {
    const { findAgentByKey } = stubAgents({ writer: { config: { modelKey: 'target-model' } } });
    expect(await keys({ subagents: [ref('w', 'writer'), inline('a', { modelKey: 'cheap' })], subagentPolicy: { mode: 'off' } })).toEqual([]);
    expect(await keys({ subagents: [ref('w', 'writer', { enabled: false }), inline('a', { modelKey: 'cheap', enabled: false })] })).toEqual([]);
    expect(findAgentByKey).not.toHaveBeenCalled();
  });
});
