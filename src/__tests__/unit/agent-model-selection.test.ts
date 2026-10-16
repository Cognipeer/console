/**
 * Which model an agent run uses (agentModelSelection.ts): the requested one when it is the main model or on the list, the
 * session's last choice otherwise, else the main model.
 */
import { describe, expect, it } from 'vitest';
import {
  AgentModelError,
  advertisedAgentModels,
  applyAgentModelChoice,
  resolveAgentRunModel,
} from '@/lib/services/agents/agentModelSelection';
import { validateAgentConfigShape } from '@/lib/services/agents/agentConfigValidation';

const config = {
  modelKey: 'main',
  additionalModels: [
    { modelKey: 'fast', label: 'Fast', description: 'cheap and quick' },
    { modelKey: 'smart' },
  ],
};
describe('resolveAgentRunModel', () => {
  it('requested main model or a listed one: requested', async () => {
    await expect(resolveAgentRunModel({ config, requested: 'main' })).resolves.toEqual({ modelKey: 'main', reason: 'requested' });
    await expect(resolveAgentRunModel({ config, requested: 'fast' })).resolves.toEqual({ modelKey: 'fast', reason: 'requested' });
  });

  it('a model that is not on the list is 400 model_not_allowed', async () => {
    const error = await resolveAgentRunModel({ config, requested: 'other' }).catch((e) => e);
    expect(error).toBeInstanceOf(AgentModelError);
    expect(error).toMatchObject({ code: 'model_not_allowed', status: 400 });
  });

  it('nothing requested: the main model by default', async () => {
    await expect(resolveAgentRunModel({ config })).resolves.toEqual({ modelKey: 'main', reason: 'default' });
  });

  it('nothing requested: the session\'s last model sticks while it is still listed', async () => {
    const sessionMetadata = { activeModel: { modelKey: 'smart', reason: 'requested' } };
    await expect(resolveAgentRunModel({ config, sessionMetadata })).resolves.toEqual({ modelKey: 'smart', reason: 'session' });
    await expect(resolveAgentRunModel({ config: { modelKey: 'main' }, sessionMetadata })).resolves.toEqual({ modelKey: 'main', reason: 'default' });
  });
});

describe('applyAgentModelChoice (the service side)', () => {
  it('honours a chosen model on the list and ignores anything else', () => {
    expect(applyAgentModelChoice(config, { chosen: 'fast' })).toEqual({ modelKey: 'fast', reason: 'requested' });
    expect(applyAgentModelChoice(config, { chosen: 'rogue' })).toEqual({ modelKey: 'main', reason: 'default' });
  });
  it('reads the session only for a background run', () => {
    const sessionMetadata = { activeModel: { modelKey: 'smart', reason: 'requested' } };
    expect(applyAgentModelChoice(config, { sessionMetadata })).toEqual({ modelKey: 'main', reason: 'default' });
    expect(applyAgentModelChoice(config, { sessionMetadata, background: true })).toMatchObject({ modelKey: 'smart' });
  });
});

describe('advertisedAgentModels', () => {
  const nameOf = async (key: string) => ({ main: 'Main model', fast: 'Fast model', smart: 'Smart model' } as Record<string, string>)[key];

  it('main model first and default, labels from the agent or the model name', async () => {
    const models = await advertisedAgentModels({ config, nameOf });
    expect(models).toEqual([
      { key: 'main', label: 'Main model', default: true },
      { key: 'fast', label: 'Fast', description: 'cheap and quick', default: false },
      { key: 'smart', label: 'Smart model', default: false },
    ]);
  });

  it('a surface override (the portal) wins over the agent entry and the model name, the main model included', async () => {
    const models = await advertisedAgentModels({
      config,
      nameOf,
      overrides: {
        main: { label: '  Everyday  ', description: 'for most questions' },
        fast: { description: 'override text' },
        smart: { label: 'Deep thinker', description: '   ' },
        unknown: { label: 'ignored' },
      },
    });
    expect(models).toEqual([
      { key: 'main', label: 'Everyday', description: 'for most questions', default: true },
      // the override has no label: the agent's own stays; its description is replaced
      { key: 'fast', label: 'Fast', description: 'override text', default: false },
      // a blank override description does not erase anything
      { key: 'smart', label: 'Deep thinker', default: false },
    ]);
  });

  it('is absent for an agent with no additional models', async () => {
    expect(await advertisedAgentModels({ config: { modelKey: 'main' }, nameOf })).toBeUndefined();
  });
});

describe('additionalModels in the config check', () => {
  it('accepts a clean list and rejects the main model, a duplicate, an empty key and more than ten', () => {
    const base = { modelKey: 'main', systemPrompt: 'x' } as never;
    expect(validateAgentConfigShape({ ...(base as object), additionalModels: [{ modelKey: 'a' }, { modelKey: 'b', label: 'B' }] } as never).errors).toEqual([]);
    const fields = (list: unknown[]) => validateAgentConfigShape({ ...(base as object), additionalModels: list } as never).errors.map((e) => e.field);
    expect(fields([{ modelKey: 'main' }])).toEqual(['additionalModels[0].modelKey']);
    expect(fields([{ modelKey: 'a' }, { modelKey: 'a' }])).toEqual(['additionalModels[1].modelKey']);
    expect(fields([{ modelKey: ' ' }])).toEqual(['additionalModels[0].modelKey']);
    expect(fields(Array.from({ length: 11 }, (_, i) => ({ modelKey: `m${i}` })))).toEqual(['additionalModels']);
  });
});
