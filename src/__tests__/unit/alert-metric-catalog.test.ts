/**
 * The metric catalog is the single source of truth for alertable metrics:
 * every id of the AlertMetric union has a definition, every metric the alert
 * service offers per module resolves, and legacy metrics keep their collectors.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ALERT_METRIC_CATALOG,
  ALERT_MODULE_METRICS,
  MODULE_ENTITY_TYPE,
  getMetricDef,
} from '@/lib/services/alerts/metricCatalog';
import { getCollectorForMetric } from '@/lib/services/alerts/metrics';
import { computeEntityMetric } from '@/lib/services/entityMetrics/entityMetricsQuery';
import { emptyCounters } from '@/lib/services/entityMetrics/latencyHistogram';

const SRC = path.resolve(__dirname, '../..');
const DOMAIN_TYPES = readFileSync(path.join(SRC, 'lib/database/provider/types.domain.ts'), 'utf8');

function unionMembers(typeName: string): string[] {
  const start = DOMAIN_TYPES.indexOf(`export type ${typeName} =`);
  expect(start).toBeGreaterThan(-1);
  const end = DOMAIN_TYPES.indexOf(';\n', start);
  const body = DOMAIN_TYPES.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

const ALL_METRICS = unionMembers('AlertMetric');
const ALL_MODULES = unionMembers('AlertModule');

describe('alert metric catalog', () => {
  it('reads the AlertMetric union (sanity)', () => {
    expect(ALL_METRICS.length).toBeGreaterThanOrEqual(61);
    expect(ALL_METRICS).toContain('error_rate');
    expect(ALL_METRICS).toContain('tool_p95_latency_ms');
  });

  it('defines every metric of the AlertMetric union exactly once', () => {
    expect(ALL_METRICS.filter((id) => !getMetricDef(id))).toEqual([]);
    const ids = ALERT_METRIC_CATALOG.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => !ALL_METRICS.includes(id))).toEqual([]);
  });

  it('covers the 35 metrics that existed before entity health', () => {
    const legacy = ALERT_METRIC_CATALOG.filter((d) => d.source === 'legacy');
    expect(legacy).toHaveLength(35);
  });

  it('gives every metric a label, a module of the union and a valid mode list', () => {
    for (const def of ALERT_METRIC_CATALOG) {
      expect(def.label.trim(), def.id).not.toBe('');
      expect(ALL_MODULES, def.id).toContain(def.module);
      expect(def.modes, def.id).toContain('threshold');
      expect(['up', 'down']).toContain(def.goodDirection);
    }
  });

  it('keeps the legacy units the email and UI maps used', () => {
    expect(getMetricDef('error_rate')).toMatchObject({ unit: '%', module: 'models' });
    expect(getMetricDef('total_cost')?.unit).toBe('$');
    expect(getMetricDef('p95_latency_ms')?.unit).toBe('ms');
    expect(getMetricDef('guardrail_avg_risk_score')?.unit).toBe('');
    expect(getMetricDef('evaluation_avg_score')?.unit).toBe('%');
    expect(getMetricDef('aegis_block_rate')).toMatchObject({ module: 'guardrails', hiddenForNewRules: true });
  });

  it('marks exactly the legacy duplicates as hidden for new rules', () => {
    const hidden = ALERT_METRIC_CATALOG.filter((d) => d.hiddenForNewRules).map((d) => d.id).sort();
    expect(hidden).toEqual([
      'aegis_approval_rate', 'aegis_avg_risk_score', 'aegis_block_rate', 'aegis_total_decisions',
      'avg_latency_ms', 'error_rate', 'mcp_avg_latency_ms', 'mcp_error_rate', 'mcp_total_requests',
      'p95_latency_ms', 'rag_avg_latency_ms', 'rag_total_queries', 'total_cost', 'total_requests',
    ].sort());
  });

  it('gives entity metrics an entity type consistent with their module, and baseline + absence modes', () => {
    const entityDefs = ALERT_METRIC_CATALOG.filter((d) => d.source === 'entity');
    expect(entityDefs.length).toBe(26);
    for (const def of entityDefs) {
      expect(def.entityType, def.id).toBeDefined();
      expect(MODULE_ENTITY_TYPE[def.module], def.id).toBe(def.entityType);
      expect(def.modes, def.id).toEqual(expect.arrayContaining(['threshold', 'baseline', 'absence']));
    }
    for (const def of ALERT_METRIC_CATALOG.filter((d) => d.source === 'legacy')) {
      expect(def.modes, def.id).toEqual(['threshold']);
    }
  });

  it('offers slo_burn only for error-rate and p95 metrics whose counters it can burn', () => {
    const slo = ALERT_METRIC_CATALOG.filter((d) => d.modes.includes('slo_burn')).map((d) => d.id).sort();
    expect(slo).toEqual([
      'agent_error_rate', 'agent_p95_duration_ms',
      'kb_error_rate', 'kb_p95_latency_ms',
      'mcp_server_error_rate', 'mcp_server_p95_latency_ms',
      'model_error_rate', 'model_p95_latency_ms',
      'tool_error_rate', 'tool_p95_latency_ms',
    ]);
  });

  it('marks count metrics as zero-when-empty', () => {
    for (const id of ['agent_sessions', 'agent_error_events', 'agent_cost', 'model_requests', 'model_cost', 'kb_queries', 'mcp_server_requests', 'tool_calls']) {
      expect(getMetricDef(id)?.zeroWhenEmpty, id).toBe(true);
    }
    expect(getMetricDef('agent_error_rate')?.zeroWhenEmpty).toBeUndefined();
  });

  it('has a computeEntityMetric formula for every entity metric', () => {
    for (const def of ALERT_METRIC_CATALOG.filter((d) => d.source === 'entity')) {
      const counters = emptyCounters();
      counters.requests = 10;
      counters.toolCalls = 10;
      counters.aiCalls = 10;
      counters.latencyCount = 1;
      counters.lat2 = 1;
      counters.latencyMsSum = 300;
      expect(computeEntityMetric(def.id, counters).value, def.id).not.toBeNull();
    }
  });
});

describe('module to metrics table', () => {
  it('lists every catalog metric under its module and resolves aegis like guardrails', () => {
    for (const def of ALERT_METRIC_CATALOG) {
      expect(ALERT_MODULE_METRICS[def.module], def.id).toContain(def.id);
    }
    expect(ALERT_MODULE_METRICS.aegis).toEqual(ALERT_MODULE_METRICS.guardrails);
    expect(Object.keys(ALERT_MODULE_METRICS).sort()).toEqual([...ALL_MODULES].sort());
  });

  it('keeps every metric the alert service offers per module in the catalog under the same module', () => {
    const service = readFileSync(path.join(SRC, 'lib/services/alerts/alertService.ts'), 'utf8');
    // Once the service derives its table from the catalog there is no second list to compare.
    if (service.includes('metricCatalog')) return;
    const start = service.indexOf('const MODULE_METRICS');
    const block = service.slice(start, service.indexOf('\n};', start));
    const guardrailBlock = service.slice(service.indexOf('const GUARDRAIL_METRICS'), service.indexOf('];', service.indexOf('const GUARDRAIL_METRICS')));
    const guardrailIds = [...guardrailBlock.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]!);

    const moduleBlocks = [...block.matchAll(/^\s+'?([a-z-]+)'?:\s*\[([^\]]*)\]/gm)];
    expect(moduleBlocks.length).toBeGreaterThanOrEqual(8);
    for (const [, moduleName, list] of moduleBlocks) {
      for (const id of [...list!.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]!)) {
        const def = getMetricDef(id);
        expect(def, `${moduleName}: ${id}`).toBeDefined();
        expect(def!.module, id).toBe(moduleName);
      }
    }
    for (const id of guardrailIds) expect(getMetricDef(id)?.module, id).toBe('guardrails');
  });

  it('resolves a collector for every legacy metric that ships in the community build', () => {
    const unresolved = ALERT_METRIC_CATALOG
      .filter((d) => d.source === 'legacy')
      .filter((d) => !getCollectorForMetric(d.id))
      .map((d) => d.id)
      .sort();
    // the AI App Gateway collector is registered by the enterprise build through the alert-extensions seam
    expect(unresolved).toEqual(['appgw_block_rate', 'appgw_error_rate', 'appgw_requests', 'appgw_requests_per_user']);
  });
});
