/**
 * Unit tests — plan-limit mode: decided by the deployment alone (saas = on, onprem = off).
 * There is no measure-only mode, and the retired env switches change nothing.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { getConfigSource, setConfigSource, type ConfigSource } from '@/lib/core/config';
import {
  deploymentPlanLimitsMode,
  effectivePlanLimitsMode,
  planLimitsActive,
} from '@/lib/limits/mode';

const originalSource = getConfigSource();

function withEnv(env: Record<string, string>): void {
  setConfigSource({
    get: (key: string) => env[key],
  } as unknown as ConfigSource);
}

afterEach(() => {
  setConfigSource(originalSource);
});

const RETIRED_SWITCHES: Array<Record<string, string>> = [
  {},
  { PLAN_LIMITS_MODE: 'off' },
  { PLAN_LIMITS_MODE: 'shadow' },
  { PLAN_LIMITS_MODE: 'on' },
  { PLAN_LIMITS_MODE: 'on', PLAN_LIMITS_DEFAULT_ENFORCEMENT: 'shadow' },
  { PLAN_LIMITS_DEFAULT_ENFORCEMENT: 'on' },
];

describe('plan-limit mode', () => {
  it.each(RETIRED_SWITCHES)('is on for every saas deployment (%o)', (env) => {
    withEnv({ DEPLOYMENT_MODE: 'saas', ...env });
    expect(deploymentPlanLimitsMode()).toBe('on');
    expect(effectivePlanLimitsMode()).toBe('on');
    expect(planLimitsActive()).toBe(true);
  });

  it.each(RETIRED_SWITCHES)('is off for every onprem deployment (%o)', (env) => {
    withEnv({ DEPLOYMENT_MODE: 'onprem', ...env });
    expect(deploymentPlanLimitsMode()).toBe('off');
    expect(effectivePlanLimitsMode()).toBe('off');
    expect(planLimitsActive()).toBe(false);
  });

  it('never yields a measure-only mode', () => {
    for (const deployment of ['saas', 'onprem']) {
      withEnv({ DEPLOYMENT_MODE: deployment, PLAN_LIMITS_MODE: 'shadow', PLAN_LIMITS_DEFAULT_ENFORCEMENT: 'shadow' });
      expect(['on', 'off']).toContain(effectivePlanLimitsMode());
    }
  });
});
