import { describe, expect, it } from 'vitest';
import { stripLegacyExecutionConfig } from '@/lib/services/agents/agentCallbackConfig';
import { sealAgentConfigSecrets } from '@/lib/services/agents/agentSandboxSecrets';
import { buildAgentManifest } from '@/lib/services/agents/agentManifest';
import type { IAgentConfig } from '@/lib/database';

const stray = {
  modelKey: 'm',
  systemPrompt: 'hi',
  inputs: [{ name: 'a' }],
  routine: { cron: '* * * * *' },
  routines: [],
  execution: { mode: 'x' },
  bogusKey: 1,
} as unknown as IAgentConfig;

describe('unknown top-level agent config keys', () => {
  it('are dropped, known keys survive', () => {
    expect(stripLegacyExecutionConfig(stray)).toEqual({ modelKey: 'm', systemPrompt: 'hi' });
  });

  it('are dropped on every save through sealAgentConfigSecrets', () => {
    expect(Object.keys(sealAgentConfigSecrets(stray, undefined)).sort()).toEqual(['modelKey', 'systemPrompt']);
  });

  it('are never exported', () => {
    const manifest = buildAgentManifest({ key: 'a', name: 'A', description: '', status: 'active' }, stray);
    expect(Object.keys(manifest.spec).sort()).toEqual(['modelKey', 'systemPrompt']);
  });
});
