import { describe, expect, it } from 'vitest';
import {
  SURFACE_HOOKS,
  declaredHooks,
  evaluateCurl,
  hookCurl,
  hookRequestBody,
  isLegacyConfig,
  parseSdkCapabilities,
  resolveVisibility,
  streamingEnforced,
} from '@/components/guardrails/GuardrailUsagePanel';
import {
  DEFAULT_VERDICT_VISIBILITY,
  HOOK_IDS,
  HOOK_SUBJECT_KIND,
} from '@/lib/services/guardrail/hooks/contract';
import type {
  GuardrailPolicy,
  GuardrailHooksConfig,
  HookId,
} from '@/lib/services/guardrail/hooks/contract';

const KEY = 'corporate-policy';

/** A `secrets` policy needs nothing beyond the base fields, so it is the
 *  cheapest way to say "an enabled policy bound to these hooks". */
function secretsPolicy(id: string, hooks: HookId[], enabled = true): GuardrailPolicy {
  return { id, family: 'secrets', enabled, hooks, schedule: { timing: 'sync', onFail: 'block' } };
}

function config(input: {
  policies: GuardrailPolicy[];
  bindings?: Partial<Record<HookId, boolean>>;
  stream?: boolean;
}): GuardrailHooksConfig {
  const bindings: GuardrailHooksConfig['bindings'] = {};
  for (const [hook, enabled] of Object.entries(input.bindings ?? {})) {
    bindings[hook as HookId] = { enabled: enabled === true, schedule: { timing: 'sync', onFail: 'block' } };
  }
  return {
    contractVersion: 2,
    policies: input.policies,
    bindings,
    ...(input.stream === undefined ? {} : { stream: { enabled: input.stream } }),
  };
}

describe('declaredHooks', () => {
  it('lifts a legacy record onto the two direction hooks rather than showing nothing', () => {
    expect(declaredHooks(undefined)).toEqual(['input.pre', 'output.pre']);
    expect(isLegacyConfig(undefined)).toBe(true);
  });

  it('treats a config with no usable policies array as legacy, exactly as ensureHooks does', () => {
    // The fail-safe: a version marker with no policies is not trusted.
    const broken = { contractVersion: 2, bindings: {} } as unknown as GuardrailHooksConfig;
    expect(isLegacyConfig(broken)).toBe(true);
    expect(declaredHooks(broken)).toEqual(['input.pre', 'output.pre']);
  });

  it('an authored config with nothing enabled declares nothing', () => {
    const hooks = config({ policies: [] });
    expect(isLegacyConfig(hooks)).toBe(false);
    expect(declaredHooks(hooks)).toEqual([]);
  });

  it('needs BOTH an enabled binding and an enabled policy naming the hook', () => {
    const both = config({
      policies: [secretsPolicy('secrets:args', ['tool.pre'])],
      bindings: { 'tool.pre': true },
    });
    expect(declaredHooks(both)).toEqual(['tool.pre']);

    const bindingOff = config({
      policies: [secretsPolicy('secrets:args', ['tool.pre'])],
      bindings: { 'tool.pre': false },
    });
    expect(declaredHooks(bindingOff)).toEqual([]);

    const policyOff = config({
      policies: [secretsPolicy('secrets:args', ['tool.pre'], false)],
      bindings: { 'tool.pre': true },
    });
    expect(declaredHooks(policyOff)).toEqual([]);
  });

  it('reports several policies bound to different hooks, in hook order', () => {
    const hooks = config({
      policies: [
        secretsPolicy('secrets:out', ['output.pre']),
        secretsPolicy('secrets:in', ['input.pre']),
      ],
      bindings: { 'input.pre': true, 'output.pre': true },
    });
    expect(declaredHooks(hooks)).toEqual(['input.pre', 'output.pre']);
  });

  it('streaming enforcement is the guardrail-level switch, not a per-policy one', () => {
    expect(streamingEnforced(undefined)).toBe(false);
    expect(streamingEnforced(config({ policies: [] }))).toBe(false);
    expect(streamingEnforced(config({ policies: [], stream: true }))).toBe(true);
  });
});

describe('surface hooks', () => {
  it('names only real hook ids', () => {
    for (const hooks of Object.values(SURFACE_HOOKS)) {
      for (const hook of hooks) expect(HOOK_IDS).toContain(hook);
    }
  });

  it('a model never emits a tool hook and an agent never emits the stream hook', () => {
    expect(SURFACE_HOOKS.model).not.toContain('tool.pre');
    expect(SURFACE_HOOKS.model).not.toContain('tool.post');
    expect(SURFACE_HOOKS.model).toContain('output.stream.delta');
    expect(SURFACE_HOOKS.agent).not.toContain('output.stream.delta');
    expect(SURFACE_HOOKS.agent).toContain('tool.pre');
    expect(SURFACE_HOOKS.mcp).toEqual(['tool.pre', 'tool.post']);
  });
});

describe('example hook bodies', () => {
  it('covers every hook and always names the hook and the key', () => {
    for (const hook of HOOK_IDS) {
      const body = hookRequestBody(hook, KEY);
      expect(body.hook).toBe(hook);
      expect(body.guardrail_key).toBe(KEY);
    }
  });

  it('carries exactly the field the server parser requires for each subject kind', () => {
    // Mirrors `buildHookSubject`: text / tool_call / tool_result / stream_delta.
    for (const hook of HOOK_IDS) {
      const body = hookRequestBody(hook, KEY);
      switch (HOOK_SUBJECT_KIND[hook]) {
        case 'text':
          expect(typeof body.text).toBe('string');
          break;
        case 'tool_call':
          expect(typeof body.tool_name).toBe('string');
          expect(body.tool_args).toBeTypeOf('object');
          break;
        case 'tool_result':
          expect(typeof body.tool_name).toBe('string');
          expect(body.tool_result).toBeDefined();
          break;
        case 'stream_delta':
          // The FULL buffer, not just the delta: verdict spans are absolute
          // into it.
          expect(typeof body.buffer).toBe('string');
          break;
      }
    }
  });
});

describe('copy-ready snippets', () => {
  const snippets = [
    evaluateCurl({ baseUrl: 'https://console.example', guardrailKey: KEY }),
    ...HOOK_IDS.map((hook) => hookCurl({ baseUrl: 'https://console.example', hook, guardrailKey: KEY })),
  ];

  it('substitutes the real guardrail key and the given origin', () => {
    for (const snippet of snippets) {
      expect(snippet).toContain(KEY);
      expect(snippet).toContain('https://console.example/api/client/v1/guardrails');
    }
  });

  it('never contains an apostrophe, which would break the single-quoted -d payload', () => {
    for (const snippet of snippets) {
      const payload = snippet.slice(snippet.indexOf("-d '") + 4);
      expect(payload.endsWith("'")).toBe(true);
      expect(payload.slice(0, -1)).not.toContain("'");
    }
  });

  it('emits a payload that actually parses as JSON', () => {
    for (const snippet of snippets) {
      const payload = snippet.slice(snippet.indexOf("-d '") + 4, -1);
      expect(() => JSON.parse(payload) as unknown).not.toThrow();
    }
  });
});

describe('verdict visibility', () => {
  it('falls back to the contract defaults field by field', () => {
    expect(resolveVisibility(undefined)).toEqual(DEFAULT_VERDICT_VISIBILITY);
  });

  it('a stored false is honoured, and untouched fields keep their default', () => {
    const hooks: GuardrailHooksConfig = {
      ...config({ policies: [] }),
      visibility: { aegisCompatHeaders: false, useVerdictStatusCodes: true },
    };
    const resolved = resolveVisibility(hooks);
    // The whole point of resolving field by field rather than spreading: a
    // `{ ...defaults, ...stored }` would overwrite these with undefined.
    expect(resolved.aegisCompatHeaders).toBe(false);
    expect(resolved.useVerdictStatusCodes).toBe(true);
    expect(resolved.headers).toBe(DEFAULT_VERDICT_VISIBILITY.headers);
    expect(resolved.detailedHeaders).toBe(DEFAULT_VERDICT_VISIBILITY.detailedHeaders);
  });
});

describe('the agent-SDK capability table', () => {
  const table = {
    contractVersion: 2,
    hooks: {
      'input.pre': { supported: true, phase: 'request', reason: 'Served by GuardrailPhase.Request.' },
      'output.stream.delta': { supported: false, reason: 'onStream is synchronous and void-returning.' },
    },
    mutations: false,
    streamHoldBack: false,
  };

  it('reads it out of the compiled-policy envelope', () => {
    const parsed = parseSdkCapabilities({ target: 'agent-sdk', capabilities: table });
    expect(parsed?.hooks['input.pre']).toEqual({
      supported: true,
      phase: 'request',
      reason: 'Served by GuardrailPhase.Request.',
    });
    expect(parsed?.hooks['output.stream.delta']?.supported).toBe(false);
    expect(parsed?.streamHoldBack).toBe(false);
  });

  it('reads a bare capability object too', () => {
    expect(parseSdkCapabilities(table)?.contractVersion).toBe(2);
  });

  it('returns null for anything unrecognised, so the caller renders the static note', () => {
    expect(parseSdkCapabilities(null)).toBeNull();
    expect(parseSdkCapabilities('nope')).toBeNull();
    expect(parseSdkCapabilities({ capabilities: {} })).toBeNull();
    // Entries with no reason are dropped; a table of only such entries is not
    // usable and must not render as an empty "nothing is supported" table.
    expect(parseSdkCapabilities({ hooks: { 'input.pre': { supported: true } } })).toBeNull();
  });

  it('surfaces phases the installed SDK declares that the console does not map', () => {
    const parsed = parseSdkCapabilities({ ...table, unmappedPhases: ['tool_pre', 7] });
    expect(parsed?.unmappedPhases).toEqual(['tool_pre']);
  });
});
