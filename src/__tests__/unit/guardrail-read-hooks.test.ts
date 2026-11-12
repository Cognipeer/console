/**
 * `readHooks` is the single read-path resolver for a guardrail's configuration:
 * `hooks` is the only stored shape, so a record without usable hooks has an
 * empty configuration and enforces nothing. It must never invent policies.
 */
import { describe, expect, it } from 'vitest';
import {
  GUARDRAIL_CONTRACT_VERSION,
  emptyHooksConfig,
  readHooks,
} from '@/lib/services/guardrail/hooks/contract';
import type { GuardrailHooksConfig } from '@/lib/services/guardrail/hooks/contract';

const SYNC_BLOCK = { timing: 'sync', onFail: 'block' } as const;

describe('readHooks', () => {
  it('returns the stored config as it is', () => {
    const hooks: GuardrailHooksConfig = {
      contractVersion: GUARDRAIL_CONTRACT_VERSION,
      policies: [
        { id: 'sec', family: 'secrets', enabled: true, hooks: ['output.pre'], schedule: SYNC_BLOCK },
      ],
      bindings: { 'output.pre': { enabled: true, schedule: SYNC_BLOCK } },
    };
    const read = readHooks({ hooks });
    expect(read.policies).toHaveLength(1);
    expect(read.policies[0].family).toBe('secrets');
    expect(read.bindings['output.pre']?.enabled).toBe(true);
  });

  it('reads nothing for a record with no hooks, and invents no policy', () => {
    for (const record of [{}, { hooks: undefined }, { hooks: null }]) {
      const read = readHooks(record);
      expect(read.policies).toEqual([]);
      expect(read.bindings).toEqual({});
    }
  });

  it('reads nothing for a config without a policies array', () => {
    const broken = { contractVersion: 2, bindings: {} } as unknown as GuardrailHooksConfig;
    expect(readHooks({ hooks: broken }).policies).toEqual([]);
  });

  it('still understands the `checks` spelling written before the rename', () => {
    const old = {
      contractVersion: 2,
      checks: [
        { id: 'sec', family: 'secrets', enabled: true, hooks: ['input.pre'], schedule: SYNC_BLOCK },
      ],
      bindings: {},
    } as unknown as GuardrailHooksConfig;
    expect(readHooks({ hooks: old }).policies.map((policy) => policy.id)).toEqual(['sec']);
  });

  it('does not mutate the record it was given', () => {
    const record = { hooks: undefined as GuardrailHooksConfig | undefined };
    readHooks(record);
    expect(record.hooks).toBeUndefined();
  });
});

describe('emptyHooksConfig', () => {
  it('has no policies, no bindings, streaming on and short-circuit on', () => {
    const empty = emptyHooksConfig();
    expect(empty.contractVersion).toBe(GUARDRAIL_CONTRACT_VERSION);
    expect(empty.policies).toEqual([]);
    expect(empty.bindings).toEqual({});
    expect(empty.stream?.enabled).toBe(true);
    expect(empty.shortCircuit).toBe(true);
  });

  it('returns a fresh object each call', () => {
    expect(emptyHooksConfig()).not.toBe(emptyHooksConfig());
  });
});
