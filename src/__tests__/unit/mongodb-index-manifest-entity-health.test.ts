import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TENANT_DB_INDEXES } from '@/lib/database/mongodb/indexManifest';

const nameOf = (collection: string, name: string) =>
  (TENANT_DB_INDEXES[collection] ?? []).find((index) => index.options.name === name);

const mixinSource = (file: string) =>
  readFileSync(path.join(process.cwd(), 'src/lib/database/mongodb', file), 'utf8');

describe('index manifest: entity health collections', () => {
  it('entity_metrics has the unique dimension index, the bucket indexes and the TTL', () => {
    expect(nameOf('entity_metrics', 'uniq_entity_metrics_dims')?.options.unique).toBe(true);
    expect(nameOf('entity_metrics', 'uniq_entity_metrics_dims')?.key).toEqual(
      { tenantId: 1, projectId: 1, entityType: 1, entityKey: 1, source: 1, bucketMs: 1 },
    );
    expect(nameOf('entity_metrics', 'idx_entity_metrics_type_bucket')?.key).toEqual(
      { tenantId: 1, projectId: 1, entityType: 1, bucketMs: 1 },
    );
    expect(nameOf('entity_metrics', 'ttl_entity_metrics_expiresAt')?.options.expireAfterSeconds).toBe(0);
  });

  it('alert_states is unique per (tenant, rule, entity)', () => {
    expect(nameOf('alert_states', 'uniq_alert_states_rule_entity')?.options.unique).toBe(true);
    expect(nameOf('alert_states', 'uniq_alert_states_rule_entity')?.key).toEqual({ tenantId: 1, ruleId: 1, entityKey: 1 });
    expect(nameOf('alert_states', 'idx_alert_states_project_phase')?.key).toEqual({ tenantId: 1, projectId: 1, phase: 1 });
    // listAlertStates() runs inside the per-tenant DB without a tenantId predicate.
    expect(nameOf('alert_states', 'idx_alert_states_rule')?.key).toEqual({ ruleId: 1 });
    expect(nameOf('alert_states', 'idx_alert_states_project_phase_notenant')?.key).toEqual({ projectId: 1, phase: 1 });
  });

  it('incidents are indexed for the project/status list, the (rule, entity) lookup, the entity list and the alert event lookup', () => {
    expect(nameOf('incidents', 'idx_incidents_project_status_firedAt')?.key).toEqual({ projectId: 1, status: 1, firedAt: -1 });
    expect(nameOf('incidents', 'idx_incidents_rule_entity')?.key).toEqual({ ruleId: 1, entityKey: 1 });
    // listIncidents filtered by entity (newest first) and findIncidentByAlertEventId.
    expect(nameOf('incidents', 'idx_incidents_project_entity_firedAt')?.key).toEqual({ projectId: 1, entityKey: 1, firedAt: -1 });
    expect(nameOf('incidents', 'idx_incidents_alertEventId')?.key).toEqual({ alertEventId: 1 });
  });

  it('the mixins that ensure these indexes on first write use the same names as the manifest', () => {
    // The manifest is existence-guarded, so each mixin creates its own indexes on
    // the write path; a name/key mismatch would throw when both run.
    const sources: Record<string, string> = {
      entity_metrics: mixinSource('entity-metrics.mixin.ts'),
      alert_states: mixinSource('alert-state.mixin.ts'),
      incidents: mixinSource('incident.mixin.ts'),
    };
    for (const [collection, source] of Object.entries(sources)) {
      for (const index of TENANT_DB_INDEXES[collection]) {
        expect(source, `${collection}.${index.options.name}`).toContain(`name: '${index.options.name}'`);
      }
    }
  });
});
