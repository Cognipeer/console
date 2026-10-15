/**
 * The alert extension seam is a leaf module the enterprise overlay fills at
 * load. Registered collectors must be found by the core collector registry at
 * CALL time, and nothing registered means the community behaviour.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  __resetAlertExtensionsForTests,
  getEntityBaselineProvider,
  getIncidentEnricher,
  getRegisteredAlertMetricCollectors,
  getSloBurnEvaluator,
  registerAlertMetricCollector,
  registerEntityBaselineProvider,
  registerIncidentEnricher,
  registerSloBurnEvaluator,
  type EntityBaselineProvider,
  type IMetricCollectorLike,
} from '@/enterprise/alert-extensions';
import { collectMetric, getCollectorForMetric } from '@/lib/services/alerts/metrics';
import type { MetricQuery } from '@/lib/services/alerts/metrics';

afterEach(() => {
  __resetAlertExtensionsForTests();
});

describe('alert-extensions registration', () => {
  it('is empty by default (community build)', () => {
    expect(getEntityBaselineProvider()).toBeNull();
    expect(getSloBurnEvaluator()).toBeNull();
    expect(getIncidentEnricher()).toBeNull();
    expect(getRegisteredAlertMetricCollectors()).toEqual([]);
  });

  it('registers, replaces and clears the single-slot extensions', () => {
    const first: EntityBaselineProvider = { evaluate: async () => new Map(), band: async () => [] };
    const second: EntityBaselineProvider = { evaluate: async () => new Map(), band: async () => [] };
    registerEntityBaselineProvider(first);
    expect(getEntityBaselineProvider()).toBe(first);
    registerEntityBaselineProvider(second);
    expect(getEntityBaselineProvider()).toBe(second);
    registerEntityBaselineProvider(null);
    expect(getEntityBaselineProvider()).toBeNull();

    const slo = async () => new Map();
    registerSloBurnEvaluator(slo);
    expect(getSloBurnEvaluator()).toBe(slo);
    registerSloBurnEvaluator(null);
    expect(getSloBurnEvaluator()).toBeNull();

    const enrich = async () => ({});
    registerIncidentEnricher(enrich);
    expect(getIncidentEnricher()).toBe(enrich);
    registerIncidentEnricher(null);
    expect(getIncidentEnricher()).toBeNull();
  });

  it('keeps collectors in registration order, ignores the same instance twice and returns a copy', () => {
    const a: IMetricCollectorLike = { supportedMetrics: ['x'], collect: async () => ({ value: 1, sampleCount: 1 }) };
    const b: IMetricCollectorLike = { supportedMetrics: ['y'], collect: async () => ({ value: 2, sampleCount: 1 }) };
    registerAlertMetricCollector(a);
    registerAlertMetricCollector(b);
    registerAlertMetricCollector(a);
    const list = getRegisteredAlertMetricCollectors();
    expect(list).toEqual([a, b]);
    list.pop();
    expect(getRegisteredAlertMetricCollectors()).toHaveLength(2);
  });
});

describe('collector registry and the seam', () => {
  const appgwLike: IMetricCollectorLike = {
    supportedMetrics: ['appgw_requests', 'appgw_block_rate'],
    collect: async () => ({ value: 42, sampleCount: 7 }),
  };
  const query = { tenantDbName: 'db', tenantId: 't', metric: 'appgw_requests', windowMinutes: 5 } as MetricQuery;

  it('does not resolve an enterprise-only metric until a collector is registered', async () => {
    expect(getCollectorForMetric('appgw_requests')).toBeUndefined();
    expect(await collectMetric(query)).toEqual({ value: 0, sampleCount: 0 });
  });

  it('finds a collector registered AFTER the registry module was loaded (call-time lookup)', async () => {
    registerAlertMetricCollector(appgwLike);
    expect(getCollectorForMetric('appgw_requests')).toBe(appgwLike);
    expect(getCollectorForMetric('appgw_block_rate')).toBe(appgwLike);
    expect(await collectMetric(query)).toEqual({ value: 42, sampleCount: 7 });
  });

  it('prefers a built-in collector over a registered one for the same metric', () => {
    const shadow: IMetricCollectorLike = { supportedMetrics: ['error_rate'], collect: async () => ({ value: -1, sampleCount: 1 }) };
    registerAlertMetricCollector(shadow);
    expect(getCollectorForMetric('error_rate')).not.toBe(shadow);
    expect(getCollectorForMetric('error_rate')).toBeDefined();
  });

  it('stops resolving once the seam is reset', () => {
    registerAlertMetricCollector(appgwLike);
    __resetAlertExtensionsForTests();
    expect(getCollectorForMetric('appgw_requests')).toBeUndefined();
  });
});

describe('alert-extensions module shape', () => {
  it('imports types only: the overlay registers at load time, before the .env files load, so the seam must not log or read config', () => {
    const source = readFileSync(path.join(process.cwd(), 'src/enterprise/alert-extensions.ts'), 'utf8');
    const imports = source.split('\n').filter((line) => /^import\s/.test(line));
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.filter((line) => !line.startsWith('import type '))).toEqual([]);
  });
});
