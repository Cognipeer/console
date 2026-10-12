/**
 * Which model an agent run uses (agentModelSelection.ts): the requested one when it is the main model or on the list, the
 * session's last choice otherwise, else the main model. The engine is only asked about additional models.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  AgentModelError,
  advertisedAgentModels,
  applyAgentModelChoice,
  resolveAgentRunModel,
  type AgentModelAuthorizer,
} from '@/lib/services/agents/agentModelSelection';

const config = {
  modelKey: 'main',
  additionalModels: [
    { modelKey: 'fast', label: 'Fast', description: 'cheap and quick' },
    { modelKey: 'smart' },
  ],
};
const allow = (): AgentModelAuthorizer => vi.fn(async () => ({ allowed: true }));
const deny = (decisionId = 'dec-1'): AgentModelAuthorizer => vi.fn(async () => ({ allowed: false, decisionId }));

describe('resolveAgentRunModel', () => {
  it('requested main model: allowed, and the engine is never asked', async () => {
    const authorize = deny();
    await expect(resolveAgentRunModel({ config, requested: 'main', authorize })).resolves.toEqual({ modelKey: 'main', reason: 'requested' });
    expect(authorize).not.toHaveBeenCalled();
  });

  it('a model that is not on the list is 400 model_not_allowed BEFORE the engine is asked', async () => {
    const authorize = allow();
    const error = await resolveAgentRunModel({ config, requested: 'other', authorize }).catch((e) => e);
    expect(error).toBeInstanceOf(AgentModelError);
    expect(error).toMatchObject({ code: 'model_not_allowed', status: 400 });
    expect(authorize).not.toHaveBeenCalled();
  });

  it('a listed model needs the engine: allowed -> requested', async () => {
    const authorize = allow();
    await expect(resolveAgentRunModel({ config, requested: 'fast', authorize })).resolves.toEqual({ modelKey: 'fast', reason: 'requested' });
    expect(authorize).toHaveBeenCalledWith('fast', { quiet: false });
  });

  it('a listed model the engine refuses is 403 model_forbidden with the decision id', async () => {
    const error = await resolveAgentRunModel({ config, requested: 'fast', authorize: deny('dec-9') }).catch((e) => e);
    expect(error).toMatchObject({ code: 'model_forbidden', status: 403, decisionId: 'dec-9' });
  });

  it('an engine that cannot decide is a 503, never a "no"', async () => {
    const authorize: AgentModelAuthorizer = async () => ({ allowed: false, unavailable: true, decisionId: 'dec-3' });
    const error = await resolveAgentRunModel({ config, requested: 'fast', authorize }).catch((e) => e);
    expect(error).toMatchObject({ code: 'authorization_unavailable', status: 503, decisionId: 'dec-3' });
  });

  it('nothing requested: the main model by default', async () => {
    const authorize = allow();
    await expect(resolveAgentRunModel({ config, authorize })).resolves.toEqual({ modelKey: 'main', reason: 'default' });
    expect(authorize).not.toHaveBeenCalled();
  });

  it('nothing requested: the session\'s last model sticks, re-checked quietly', async () => {
    const authorize = allow();
    const sessionMetadata = { activeModel: { modelKey: 'smart', reason: 'requested' } };
    await expect(resolveAgentRunModel({ config, sessionMetadata, authorize })).resolves.toEqual({ modelKey: 'smart', reason: 'session' });
    expect(authorize).toHaveBeenCalledWith('smart', { quiet: true });
  });

  it('a sticky model that is no longer allowed, or no longer listed, falls back to the main model silently', async () => {
    const sessionMetadata = { activeModel: { modelKey: 'smart', reason: 'requested' } };
    await expect(resolveAgentRunModel({ config, sessionMetadata, authorize: deny() })).resolves.toEqual({ modelKey: 'main', reason: 'default' });
    await expect(resolveAgentRunModel({ config: { modelKey: 'main' }, sessionMetadata, authorize: allow() })).resolves.toEqual({ modelKey: 'main', reason: 'default' });
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
    const models = await advertisedAgentModels({ config, authorize: allow(), nameOf });
    expect(models).toEqual([
      { key: 'main', label: 'Main model', default: true },
      { key: 'fast', label: 'Fast', description: 'cheap and quick', default: false },
      { key: 'smart', label: 'Smart model', default: false },
    ]);
  });

  it('leaves out what the caller is denied, and omits the field below two entries', async () => {
    const onlyFast: AgentModelAuthorizer = async (key) => ({ allowed: key === 'fast' });
    expect((await advertisedAgentModels({ config, authorize: onlyFast, nameOf }))?.map((m) => m.key)).toEqual(['main', 'fast']);
    expect(await advertisedAgentModels({ config, authorize: deny(), nameOf })).toBeUndefined();
  });

  it('is absent for an agent with no additional models', async () => {
    expect(await advertisedAgentModels({ config: { modelKey: 'main' }, authorize: allow(), nameOf })).toBeUndefined();
  });
});

describe('additionalModels in the config check', () => {
  it('accepts a clean list and rejects the main model, a duplicate, an empty key and more than ten', async () => {
    const { validateAgentConfigShape } = await import('@/lib/services/agents/agentConfigValidation');
    const base = { modelKey: 'main', systemPrompt: 'x' } as never;
    expect(validateAgentConfigShape({ ...(base as object), additionalModels: [{ modelKey: 'a' }, { modelKey: 'b', label: 'B' }] } as never).errors).toEqual([]);
    const fields = (list: unknown[]) => validateAgentConfigShape({ ...(base as object), additionalModels: list } as never).errors.map((e) => e.field);
    expect(fields([{ modelKey: 'main' }])).toEqual(['additionalModels[0].modelKey']);
    expect(fields([{ modelKey: 'a' }, { modelKey: 'a' }])).toEqual(['additionalModels[1].modelKey']);
    expect(fields([{ modelKey: ' ' }])).toEqual(['additionalModels[0].modelKey']);
    expect(fields(Array.from({ length: 11 }, (_, i) => ({ modelKey: `m${i}` })))).toEqual(['additionalModels']);
  });
});
