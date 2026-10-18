import { describe, expect, it } from 'vitest';

import type { IAgentConfig } from '@/lib/database/provider/types.domain';
import { collectManifestDependencies, validateAgentManifest } from '@/lib/services/agents/agentManifest';
import { validateAgentConfigShape } from '@/lib/services/agents/agentConfigValidation';
import { subagentConfigIssues } from '@/lib/services/agents/subagentConfigRules';

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

const base = { modelKey: 'main' } as IAgentConfig;
const fields = (config: Partial<IAgentConfig>) => validateAgentConfigShape({ ...base, ...config }).errors.map((e) => e.field);

describe('delegation settings are validated (CON-11)', () => {
  it('accepts a sane policy and sane child limits', () => {
    expect(fields({
      subagentPolicy: { mode: 'registry_and_adhoc', maxDepth: 5, maxChildCalls: 50, maxParallel: 16, childContextPolicy: 'full', allowAdhocTools: false },
      subagents: [{ kind: 'inline', name: 'a', header: 'h', systemPrompt: 'x', childContextPolicy: 'scoped', limits: { maxToolCalls: 10, maxCostUsd: 0.5 } }],
    })).toEqual([]);
  });

  it('refuses a mode, a context policy or a bound the SDK would silently ignore or clamp', () => {
    expect(fields({
      subagentPolicy: { mode: 'always' as never, maxDepth: 0, maxChildCalls: 51, maxParallel: 17, childContextPolicy: 'all' as never, allowAdhocTools: 'yes' as never },
    })).toEqual([
      'subagentPolicy.mode', 'subagentPolicy.childContextPolicy', 'subagentPolicy.maxDepth', 'subagentPolicy.maxChildCalls',
      'subagentPolicy.maxParallel', 'subagentPolicy.allowAdhocTools',
    ]);
    expect(fields({ subagentPolicy: { maxDepth: 1.5 } })).toEqual(['subagentPolicy.maxDepth']);
    expect(fields({ subagentPolicy: { maxDepth: Number.NaN } })).toEqual(['subagentPolicy.maxDepth']);
  });

  it('refuses a child limit that is out of range or not a number, and a child context policy that does not exist', () => {
    expect(fields({
      subagents: [{
        kind: 'inline', name: 'a', header: 'h', systemPrompt: 'x', childContextPolicy: 'everything' as never,
        limits: { maxToolCalls: 0, maxWallClockMs: 10, maxCostUsd: 0, maxTotalOutputTokens: 'lots' as never },
      }],
    })).toEqual([
      'subagents[0].childContextPolicy', 'subagents[0].limits.maxToolCalls', 'subagents[0].limits.maxTotalOutputTokens',
      'subagents[0].limits.maxCostUsd', 'subagents[0].limits.maxWallClockMs',
    ]);
  });

  it('leaves an agent with no delegation settings alone', () => {
    expect(subagentConfigIssues({})).toEqual([]);
  });

  it('is checked on a manifest too, where the owner reads the spec path', () => {
    const manifest = {
      apiVersion: 'console.cognipeer.com/v1', kind: 'Agent', metadata: { key: 'a', name: 'A' },
      spec: { ...base, subagentPolicy: { maxParallel: 99 } },
    };
    expect(validateAgentManifest(manifest).some((issue) => issue.includes('spec.subagentPolicy.maxParallel'))).toBe(true);
  });
});
