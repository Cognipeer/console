/**
 * Retention engine: turns a policy into work items and runs them in batches.
 *
 * It knows nothing about queues or tenants: the caller (scheduler.ts) has
 * already bound the tenant database, holds the tenant lock and decides when to
 * stop. One work item = one (target, phase, project scope); deletes run before
 * redactions, so fewer rows are left to rewrite.
 *
 * Project overrides: for a class some projects keep differently, the tenant
 * duration applies to every row *not* in those projects (rows without a
 * project included), and each overriding project gets its own item.
 *
 * Redaction watermark: once a redact item finishes, everything older than its
 * cut-off holds no content any more, so the next sweep only looks at rows from
 * that cut-off on. Rows that arrive late with an old timestamp are left to the
 * delete phase.
 */

import { createHash } from 'node:crypto';
import type { DatabaseProvider } from '@/lib/database';
import type { RetentionFilter, RetentionRedactField } from '@/lib/database/provider/types';
import type { RetentionClassId } from './classes';
import { classMinDays, resolveClasses, type RetentionPolicyInput } from './policy';
import { getRetentionTargets, type RetentionCascade } from './targets';

const DAY_MS = 86_400_000;

/** Classes a manual "older than" purge may not take below their minimum (audit trail, billing totals). */
const PURGE_FLOOR_CLASSES: ReadonlySet<RetentionClassId> = new Set(['audit', 'usage']);

export type RetentionMode = { kind: 'policy' } | { kind: 'olderThan'; days: number };

export interface PlanOptions {
  mode: RetentionMode;
  /** Only these classes (all when omitted). */
  classes?: RetentionClassId[];
  /** Only this project's rows; targets without a project field are skipped. */
  projectId?: string;
  now?: Date;
}

export interface RetentionWorkItem {
  key: string;
  targetId: string;
  collection: string;
  label: string;
  class: RetentionClassId;
  action: 'delete' | 'redact';
  days: number;
  filter: RetentionFilter;
  fields?: RetentionRedactField[];
  cascade?: RetentionCascade;
  /** Redact items of a policy run: where the watermark is kept. */
  watermarkKey?: string;
}

export interface RetentionItemResult {
  key: string;
  targetId: string;
  collection: string;
  class: RetentionClassId;
  action: 'delete' | 'redact';
  days: number;
  /** Rows deleted or redacted (dry run: rows that would be). */
  affected: number;
  /** Child rows deleted with them (trace events). */
  cascaded: number;
  error?: string;
}

export interface RetentionRunResult {
  /** Every item ran to the end (no budget cut, no cancel). */
  done: boolean;
  cancelled: boolean;
  dryRun: boolean;
  deleted: number;
  redacted: number;
  items: RetentionItemResult[];
  errors: number;
}

export interface WatermarkStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
}

export interface RunOptions {
  dryRun: boolean;
  batchSize: number;
  /** Epoch ms after which no new batch starts. */
  deadline: number;
  isCancelled?: () => Promise<boolean>;
  onProgress?: (result: RetentionRunResult) => Promise<void> | void;
  watermarks?: WatermarkStore;
}

function scopeHash(values: string[]): string {
  return createHash('sha256').update([...values].sort().join(',')).digest('hex').slice(0, 12);
}

function minusDays(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

/** The work a run would do, in the order it does it. */
export function planWork(policy: RetentionPolicyInput, options: PlanOptions): RetentionWorkItem[] {
  const now = options.now ?? new Date();
  const only = options.classes ? new Set(options.classes) : null;
  const tenantDays = resolveClasses(policy);
  const items: RetentionWorkItem[] = [];

  for (const target of getRetentionTargets()) {
    if (options.projectId && !target.projectField) continue;
    target.phases.forEach((phase, index) => {
      if (only && !only.has(phase.class)) return;
      // Fixed durations (destruction records) are never purged by hand.
      if (phase.fixedDays && options.mode.kind === 'olderThan') return;

      const base = {
        targetId: target.id,
        collection: target.collection,
        label: target.label,
        class: phase.class,
        action: phase.action,
        fields: phase.fields,
        cascade: phase.action === 'delete' ? target.cascade : undefined,
      };
      const push = (scopeKey: string, days: number, scope: Pick<RetentionFilter, 'projectIn' | 'projectNotIn'>) => {
        const key = `${target.id}:${index}:${scopeKey}`;
        items.push({
          ...base,
          key,
          days,
          filter: {
            timeField: target.timeField,
            before: minusDays(now, days),
            ...(target.projectField && (scope.projectIn || scope.projectNotIn) ? { projectField: target.projectField, ...scope } : {}),
            ...(target.guard ? { where: target.guard } : {}),
          },
          ...(phase.action === 'redact' && options.mode.kind === 'policy' && !options.projectId ? { watermarkKey: key } : {}),
        });
      };

      if (options.mode.kind === 'olderThan') {
        const floor = PURGE_FLOOR_CLASSES.has(phase.class) ? classMinDays(phase.class) : 0;
        const days = Math.max(options.mode.days, floor);
        if (options.projectId) push(`p-${options.projectId}`, days, { projectIn: [options.projectId] });
        else push('all', days, {});
        return;
      }

      if (phase.fixedDays) {
        push('all', phase.fixedDays(), {});
        return;
      }
      if (options.projectId) {
        push(`p-${options.projectId}`, resolveClasses(policy, options.projectId)[phase.class].days, { projectIn: [options.projectId] });
        return;
      }
      const overriding = target.projectField
        ? Object.keys(policy.projects).filter((id) => policy.projects[id][phase.class] !== undefined)
        : [];
      if (overriding.length === 0) {
        push('all', tenantDays[phase.class].days, {});
        return;
      }
      push(`rest-${scopeHash(overriding)}`, tenantDays[phase.class].days, { projectNotIn: overriding });
      for (const projectId of overriding) {
        push(`p-${projectId}`, resolveClasses(policy, projectId)[phase.class].days, { projectIn: [projectId] });
      }
    });
  }

  // Rows past the delete cut-off of the same target and scope are deleted first: redaction (and its count) stops there.
  const deletes = new Map(items.filter((i) => i.action === 'delete').map((i) => [i.key.replace(/^([^:]+):\d+:/, '$1:'), i]));
  for (const item of items) {
    if (item.action !== 'redact') continue;
    const del = deletes.get(item.key.replace(/^([^:]+):\d+:/, '$1:'));
    if (del && del.filter.before < item.filter.before) item.filter = { ...item.filter, after: del.filter.before };
  }

  return [...items.filter((i) => i.action === 'delete'), ...items.filter((i) => i.action === 'redact')];
}

/** Rows each item would touch now. */
export async function countWork(db: DatabaseProvider, items: RetentionWorkItem[]): Promise<RetentionItemResult[]> {
  const results: RetentionItemResult[] = [];
  for (const item of items) {
    const result = emptyItemResult(item);
    try {
      result.affected = item.action === 'redact'
        ? await db.retentionCountRedactable(item.collection, item.filter, item.fields ?? [])
        : await db.retentionCount(item.collection, item.filter);
    } catch (err) {
      result.error = errorMessage(err);
    }
    results.push(result);
  }
  return results;
}

function emptyItemResult(item: RetentionWorkItem): RetentionItemResult {
  return {
    key: item.key,
    targetId: item.targetId,
    collection: item.collection,
    class: item.class,
    action: item.action,
    days: item.days,
    affected: 0,
    cascaded: 0,
  };
}

function errorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

async function deleteBatch(
  db: DatabaseProvider,
  item: RetentionWorkItem,
  limit: number,
): Promise<{ affected: number; cascaded: number; more: boolean }> {
  if (item.cascade) {
    const values = await db.retentionSelectValues(item.collection, item.filter, item.cascade.parentField, limit);
    if (values.length > 0) {
      // Children first: a crash in between leaves a parent that the next batch finds again.
      let cascaded = 0;
      for (const child of item.cascade.children) {
        cascaded += await db.retentionDeleteWhereIn(child.collection, child.field, values);
      }
      const affected = await db.retentionDeleteWhereIn(item.collection, item.cascade.parentField, values);
      return { affected, cascaded, more: true };
    }
  }
  // Rows without a parent id (or no cascade at all).
  const affected = await db.retentionDeleteBatch(item.collection, item.filter, limit);
  return { affected, cascaded: 0, more: affected >= limit };
}

/**
 * Runs the items until done, out of time or cancelled. A failing item is
 * recorded and skipped; the others still run.
 */
export async function runWork(db: DatabaseProvider, items: RetentionWorkItem[], options: RunOptions): Promise<RetentionRunResult> {
  const result: RetentionRunResult = {
    done: false, cancelled: false, dryRun: options.dryRun, deleted: 0, redacted: 0, items: [], errors: 0,
  };

  if (options.dryRun) {
    result.items = await countWork(db, items);
    for (const item of result.items) {
      if (item.error) result.errors += 1;
      else if (item.action === 'delete') result.deleted += item.affected;
      else result.redacted += item.affected;
    }
    result.done = true;
    return result;
  }

  for (const item of items) {
    const itemResult = emptyItemResult(item);
    result.items.push(itemResult);
    let filter = item.filter;
    if (item.watermarkKey && options.watermarks) {
      const mark = await options.watermarks.get(item.watermarkKey);
      if (mark) {
        const after = new Date(mark);
        if (!Number.isNaN(after.getTime()) && (!filter.after || after > filter.after)) {
          if (after >= filter.before) continue;
          filter = { ...filter, after };
        }
      }
    }

    try {
      let more = true;
      while (more) {
        if (Date.now() >= options.deadline) return result;
        if (options.isCancelled && await options.isCancelled()) {
          result.cancelled = true;
          return result;
        }
        if (item.action === 'redact') {
          const n = await db.retentionRedactBatch(item.collection, filter, item.fields ?? [], options.batchSize);
          itemResult.affected += n;
          result.redacted += n;
          more = n >= options.batchSize;
        } else {
          const batch = await deleteBatch(db, { ...item, filter }, options.batchSize);
          itemResult.affected += batch.affected;
          itemResult.cascaded += batch.cascaded;
          result.deleted += batch.affected + batch.cascaded;
          more = batch.more;
        }
        await options.onProgress?.(result);
      }
      if (item.watermarkKey && options.watermarks) {
        await options.watermarks.set(item.watermarkKey, item.filter.before.toISOString());
      }
    } catch (err) {
      itemResult.error = errorMessage(err);
      result.errors += 1;
    }
  }

  result.done = true;
  return result;
}

/** Per-class totals for the retention page and the destruction record. */
export function totalsByClass(items: RetentionItemResult[]): Partial<Record<RetentionClassId, { deleted: number; redacted: number }>> {
  const out: Partial<Record<RetentionClassId, { deleted: number; redacted: number }>> = {};
  for (const item of items) {
    const entry = out[item.class] ?? { deleted: 0, redacted: 0 };
    if (item.action === 'delete') entry.deleted += item.affected + item.cascaded;
    else entry.redacted += item.affected;
    out[item.class] = entry;
  }
  return out;
}
