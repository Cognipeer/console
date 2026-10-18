import { describe, expect, it } from 'vitest';

import type { IAgentConfig } from '@/lib/database/provider/types.domain';
import { collectManifestDependencies } from '@/lib/services/agents/agentManifest';

describe('collectManifestDependencies: sub-agents', () => {
  it('needs the model a referenced sub-agent is overridden to run on, next to the agent itself', () => {
    const spec = {
      modelKey: 'main',
      subagents: [{ name: 'writer', kind: 'ref', agentKey: 'writer-agent', modelKey: 'cheap-model' }],
    } as unknown as IAgentConfig;
    const ids = collectManifestDependencies(spec).map((d) => `${d.type}:${d.key}`);
    expect(ids).toContain('agent:writer-agent');
    expect(ids).toContain('model:cheap-model');
  });

  it('still needs nothing more of a reference that sets no model', () => {
    const spec = {
      modelKey: 'main',
      subagents: [{ name: 'writer', kind: 'ref', agentKey: 'writer-agent' }],
    } as unknown as IAgentConfig;
    const ids = collectManifestDependencies(spec).map((d) => `${d.type}:${d.key}`);
    expect(ids).toEqual(['model:main', 'agent:writer-agent']);
  });
});
