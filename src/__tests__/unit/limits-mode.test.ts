/**
 * Unit tests — effective plan-limit mode (deployment ceiling x tenant enforcement).
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

describe('deploymentPlanLimitsMode', () => {
  it('is off on onprem whatever PLAN_LIMITS_MODE says', () => {
    for (const mode of ['off', 'shadow', 'on']) {
      withEnv({ DEPLOYMENT_MODE: 'onprem', PLAN_LIMITS_MODE: mode });
      expect(deploymentPlanLimitsMode()).toBe('off');
      expect(planLimitsActive()).toBe(false);
      expect(effectivePlanLimitsMode('on')).toBe('off');
      expect(effectivePlanLimitsMode()).toBe('off');
    }
  });

  it('is off on saas unless PLAN_LIMITS_MODE is set', () => {
    withEnv({ DEPLOYMENT_MODE: 'saas' });
    expect(deploymentPlanLimitsMode()).toBe('off');
    expect(planLimitsActive()).toBe(false);
  });

  it.each(['shadow', 'on'] as const)('follows PLAN_LIMITS_MODE=%s on saas', (mode) => {
    withEnv({ DEPLOYMENT_MODE: 'saas', PLAN_LIMITS_MODE: mode });
    expect(deploymentPlanLimitsMode()).toBe(mode);
    expect(planLimitsActive()).toBe(true);
  });

  it('falls back to off for an unknown PLAN_LIMITS_MODE', () => {
    withEnv({ DEPLOYMENT_MODE: 'saas', PLAN_LIMITS_MODE: 'strict' });
    expect(deploymentPlanLimitsMode()).toBe('off');
  });
});

describe('effectivePlanLimitsMode', () => {
  it('stays off on saas when the deployment is off, even if the tenant asks for on', () => {
    withEnv({ DEPLOYMENT_MODE: 'saas', PLAN_LIMITS_MODE: 'off' });
    expect(effectivePlanLimitsMode('on')).toBe('off');
    expect(effectivePlanLimitsMode('shadow')).toBe('off');
  });

  it('lets a tenant enforcement lower the ceiling but never raise it', () => {
    withEnv({ DEPLOYMENT_MODE: 'saas', PLAN_LIMITS_MODE: 'on' });
    expect(effectivePlanLimitsMode('on')).toBe('on');
    expect(effectivePlanLimitsMode('shadow')).toBe('shadow');

    withEnv({ DEPLOYMENT_MODE: 'saas', PLAN_LIMITS_MODE: 'shadow' });
    expect(effectivePlanLimitsMode('on')).toBe('shadow');
    expect(effectivePlanLimitsMode('shadow')).toBe('shadow');
  });

  it('uses PLAN_LIMITS_DEFAULT_ENFORCEMENT when the tenant sets none', () => {
    withEnv({ DEPLOYMENT_MODE: 'saas', PLAN_LIMITS_MODE: 'on' });
    expect(effectivePlanLimitsMode()).toBe('shadow');

    withEnv({ DEPLOYMENT_MODE: 'saas', PLAN_LIMITS_MODE: 'on', PLAN_LIMITS_DEFAULT_ENFORCEMENT: 'on' });
    expect(effectivePlanLimitsMode()).toBe('on');

    withEnv({ DEPLOYMENT_MODE: 'saas', PLAN_LIMITS_MODE: 'on', PLAN_LIMITS_DEFAULT_ENFORCEMENT: 'shadow' });
    expect(effectivePlanLimitsMode()).toBe('shadow');
  });

  it('prefers the tenant enforcement over the default', () => {
    withEnv({ DEPLOYMENT_MODE: 'saas', PLAN_LIMITS_MODE: 'on', PLAN_LIMITS_DEFAULT_ENFORCEMENT: 'shadow' });
    expect(effectivePlanLimitsMode('on')).toBe('on');

    withEnv({ DEPLOYMENT_MODE: 'saas', PLAN_LIMITS_MODE: 'on', PLAN_LIMITS_DEFAULT_ENFORCEMENT: 'on' });
    expect(effectivePlanLimitsMode('shadow')).toBe('shadow');
  });

  it('never exceeds a shadow deployment through the default enforcement', () => {
    withEnv({ DEPLOYMENT_MODE: 'saas', PLAN_LIMITS_MODE: 'shadow', PLAN_LIMITS_DEFAULT_ENFORCEMENT: 'on' });
    expect(effectivePlanLimitsMode()).toBe('shadow');
  });
});
