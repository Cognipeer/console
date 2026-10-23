/**
 * Retention policy: resolution order, clamping, the audit floor, validation and
 * the delayed shortening.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { reloadConfig } from '@/lib/core/config';
import type { DatabaseProvider } from '@/lib/database';
import { RETENTION_CLASSES, RETENTION_CLASS_IDS, RETENTION_PRESETS } from '@/lib/retention/classes';
import {
  RetentionPolicyError,
  cancelPending,
  emptyPolicy,
  loadPolicy,
  parsePolicyInput,
  resolveClasses,
  savePolicy,
} from '@/lib/retention/policy';
import { getLegacyRetentionTargets, getRetentionTargets } from '@/lib/retention/targets';

const HOUR = 3_600_000;

function docStore() {
  const docs = new Map<string, Record<string, unknown>>();
  const db = {
    iamDocGet: vi.fn(async (_c: string, id: string) => (docs.has(id) ? { id, data: docs.get(id)!, updatedAt: new Date() } : null)),
    iamDocPut: vi.fn(async (_c: string, id: string, data: Record<string, unknown>) => {
      docs.set(id, JSON.parse(JSON.stringify(data)));
      return { id, data, updatedAt: new Date() };
    }),
  };
  return db as unknown as DatabaseProvider & typeof db;
}

afterEach(() => {
  vi.unstubAllEnvs();
  reloadConfig();
});

describe('defaults', () => {
  it('every class, preset entry and registered collection has a concrete default', () => {
    for (const id of RETENTION_CLASS_IDS) {
      const def = RETENTION_CLASSES[id];
      expect(def.defaultDays).toBeGreaterThanOrEqual(def.minDays);
      expect(def.defaultDays).toBeLessThanOrEqual(def.maxDays);
    }
    const resolved = resolveClasses(emptyPolicy());
    for (const target of getRetentionTargets()) {
      for (const phase of target.phases) {
        const days = phase.fixedDays ? phase.fixedDays() : resolved[phase.class].days;
        expect(days, `${target.id}/${phase.class}`).toBeGreaterThan(0);
      }
    }
    for (const legacy of getLegacyRetentionTargets()) {
      expect(legacy.days(), legacy.id).toBeGreaterThan(0);
    }
  });

  it('the built-in defaults are the Standard preset', () => {
    const resolved = resolveClasses(emptyPolicy());
    for (const [id, days] of Object.entries(RETENTION_PRESETS.standard)) {
      expect(resolved[id as keyof typeof resolved].days, id).toBe(days);
    }
    expect(emptyPolicy().preset).toBe('standard');
  });
});

describe('resolveClasses', () => {
  it('goes default → deployment env → tenant → project', () => {
    vi.stubEnv('RETENTION_TELEMETRY_DAYS', '120');
    reloadConfig();
    const policy = { ...emptyPolicy(), classes: { trace: 60 }, projects: { p1: { trace: 90 } } };

    const tenant = resolveClasses(policy);
    expect(tenant.content).toMatchObject({ days: 30, source: 'default' });
    expect(tenant.telemetry).toMatchObject({ days: 120, source: 'deployment' });
    expect(tenant.trace).toMatchObject({ days: 60, source: 'tenant' });
    expect(resolveClasses(policy, 'p1').trace).toMatchObject({ days: 90, source: 'project' });
    expect(resolveClasses(policy, 'p2').trace).toMatchObject({ days: 60, source: 'tenant' });
  });

  it('clamps to the class range and keeps audit at or above the deployment floor', () => {
    vi.stubEnv('RETENTION_AUDIT_MIN_DAYS', '730');
    vi.stubEnv('RETENTION_CONTENT_DAYS', '500');
    reloadConfig();
    const resolved = resolveClasses({ ...emptyPolicy(), classes: { audit: 400 } });
    expect(resolved.audit.days).toBe(730);
    expect(resolved.audit.minDays).toBe(730);
    expect(resolved.content.days).toBe(RETENTION_CLASSES.content.maxDays);
  });
});

describe('parsePolicyInput', () => {
  it('fills a preset without classes with the preset numbers', () => {
    expect(parsePolicyInput({ preset: 'minimal' }).classes).toEqual(RETENTION_PRESETS.minimal);
  });

  it('rejects unknown and non-editable classes, out-of-range days and bad project ids', () => {
    expect.assertions(5);
    try {
      parsePolicyInput({ classes: { nope: 10, delivery: 30, content: 0, trace: 1.5 }, projects: { 'a.b': { trace: 30 } } });
    } catch (err) {
      expect(err).toBeInstanceOf(RetentionPolicyError);
      const fields = (err as RetentionPolicyError).details.map((d) => d.field);
      expect(fields).toContain('classes.nope');
      expect(fields).toContain('classes.delivery');
      expect(fields).toContain('classes.content');
      expect(fields).toContain('projects.a.b');
    }
  });
});

describe('savePolicy', () => {
  const now = new Date('2026-10-23T10:00:00.000Z');

  it('lengthening applies at once', async () => {
    const db = docStore();
    const saved = await savePolicy(db, { preset: 'custom', classes: { telemetry: 180 }, projects: {} }, 'a@x', now);
    expect(saved.pending).toBeNull();
    expect(saved.classes.telemetry).toBe(180);
    expect(saved.version).toBe(1);
  });

  it('shortening keeps the old number until the delay passes, then applies', async () => {
    const db = docStore();
    const saved = await savePolicy(db, { preset: 'custom', classes: { telemetry: 30, trace: 60 }, projects: {} }, 'a@x', now);
    expect(saved.classes).toEqual({ telemetry: 90, trace: 60 });
    expect(saved.pending).toMatchObject({ classes: { telemetry: 30, trace: 60 }, requestedBy: 'a@x' });
    expect(saved.pending!.effectiveAt).toBe(new Date(now.getTime() + 24 * HOUR).toISOString());

    expect((await loadPolicy(db, new Date(now.getTime() + 23 * HOUR))).classes.telemetry).toBe(90);
    const applied = await loadPolicy(db, new Date(now.getTime() + 25 * HOUR));
    expect(applied.classes).toEqual({ telemetry: 30, trace: 60 });
    expect(applied.pending).toBeNull();
    expect(applied.updatedBy).toBe('a@x');
  });

  it('removing a project override that kept rows longer is a shortening too', async () => {
    const db = docStore();
    await savePolicy(db, { preset: 'custom', classes: {}, projects: { p1: { telemetry: 365 } } }, null, now);
    const saved = await savePolicy(db, { preset: 'custom', classes: {}, projects: {} }, null, now);
    expect(saved.projects).toEqual({ p1: { telemetry: 365 } });
    expect(saved.pending?.projects).toEqual({});
  });

  it('a pending shortening can be cancelled', async () => {
    const db = docStore();
    await savePolicy(db, { preset: 'custom', classes: { telemetry: 30 }, projects: {} }, null, now);
    const cancelled = await cancelPending(db, null, now);
    expect(cancelled.pending).toBeNull();
    expect(cancelled.classes.telemetry).toBe(90);
  });

  it('applies a shortening at once when the delay is 0', async () => {
    vi.stubEnv('RETENTION_SHORTEN_DELAY_HOURS', '0');
    reloadConfig();
    const db = docStore();
    const saved = await savePolicy(db, { preset: 'custom', classes: { telemetry: 30 }, projects: {} }, null, now);
    expect(saved.pending).toBeNull();
    expect(saved.classes.telemetry).toBe(30);
  });
});
