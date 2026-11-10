/**
 * MongoDB Provider – Plan limits usage mixin
 *
 * Monthly meters, limit events and capacity peaks live in the MAIN database:
 * they are measured per tenant but read by platform-level reports.
 */

import type { MonthlyMeter, PlanLimitEvent, PlanLimitKind } from '@/lib/limits/types';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS } from './base';

const MONTHLY_METERS: readonly MonthlyMeter[] = ['searches', 'flowRuns', 'crawlerPages', 'sandboxSeconds'];
const DIMENSION_RE = /^[a-zA-Z0-9_]+$/;

interface UsageMonthlyDoc {
  _id: string;
  tenantId: string;
  period: string;
  updatedAt: Date;
  searches?: number;
  flowRuns?: number;
  crawlerPages?: number;
  sandboxSeconds?: number;
}

interface UsagePeakDoc {
  _id: string;
  tenantId: string;
  day: string;
  updatedAt: Date;
  hours?: Record<string, Record<string, number>>;
}

function pickMeters(doc: Partial<Record<MonthlyMeter, number>>): Partial<Record<MonthlyMeter, number>> {
  const out: Partial<Record<MonthlyMeter, number>> = {};
  for (const meter of MONTHLY_METERS) {
    const value = doc[meter];
    if (typeof value === 'number') out[meter] = value;
  }
  return out;
}

export function PlanLimitsMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class PlanLimitsOps extends Base {
    async incrementPlanUsageMonthly(
      tenantId: string,
      period: string,
      deltas: Partial<Record<MonthlyMeter, number>>,
    ): Promise<void> {
      const inc: Record<string, number> = {};
      for (const meter of MONTHLY_METERS) {
        const value = deltas[meter];
        if (typeof value === 'number' && Number.isFinite(value) && value !== 0) inc[meter] = value;
      }
      if (Object.keys(inc).length === 0) return;
      const db = this.getMainDb();
      await db.collection<UsageMonthlyDoc>(COLLECTIONS.planUsageMonthly).updateOne(
        { _id: `${tenantId}:${period}` },
        { $inc: inc, $set: { tenantId, period, updatedAt: new Date() } },
        { upsert: true },
      );
    }

    async getPlanUsageMonthly(
      tenantId: string,
      period: string,
    ): Promise<Partial<Record<MonthlyMeter, number>>> {
      const db = this.getMainDb();
      const doc = await db
        .collection<UsageMonthlyDoc>(COLLECTIONS.planUsageMonthly)
        .findOne({ _id: `${tenantId}:${period}` });
      return doc ? pickMeters(doc) : {};
    }

    async listPlanUsageMonthly(
      period: string,
      opts: { tenantIds?: string[] } = {},
    ): Promise<Array<{ tenantId: string; period: string } & Partial<Record<MonthlyMeter, number>>>> {
      const db = this.getMainDb();
      const query: Record<string, unknown> = { period };
      if (opts.tenantIds) query.tenantId = { $in: opts.tenantIds };
      const docs = await db
        .collection<UsageMonthlyDoc>(COLLECTIONS.planUsageMonthly)
        .find(query)
        .sort({ tenantId: 1 })
        .toArray();
      return docs.map((doc) => ({ tenantId: doc.tenantId, period: doc.period, ...pickMeters(doc) }));
    }

    async insertPlanLimitEvents(events: PlanLimitEvent[]): Promise<void> {
      if (events.length === 0) return;
      const db = this.getMainDb();
      await db
        .collection<PlanLimitEvent>(COLLECTIONS.planLimitEvents)
        .insertMany(events.map((event) => ({ ...event })));
    }

    async listPlanLimitEvents(
      tenantId: string,
      opts: { since?: Date; kind?: PlanLimitKind; limit: number },
    ): Promise<PlanLimitEvent[]> {
      const db = this.getMainDb();
      const query: Record<string, unknown> = { tenantId };
      if (opts.since) query.at = { $gte: opts.since };
      if (opts.kind) query.kind = opts.kind;
      const docs = await db
        .collection<PlanLimitEvent>(COLLECTIONS.planLimitEvents)
        .find(query, { projection: { _id: 0 } })
        .sort({ at: -1 })
        .limit(opts.limit)
        .toArray();
      return docs as unknown as PlanLimitEvent[];
    }

    async deletePlanLimitEventsBefore(cutoff: Date): Promise<number> {
      const db = this.getMainDb();
      const result = await db
        .collection<PlanLimitEvent>(COLLECTIONS.planLimitEvents)
        .deleteMany({ at: { $lt: cutoff } });
      return result.deletedCount ?? 0;
    }

    async maxPlanUsagePeak(
      tenantId: string,
      day: string,
      dimension: string,
      hour: number,
      value: number,
    ): Promise<void> {
      if (!DIMENSION_RE.test(dimension)) {
        throw new Error(`Invalid plan usage dimension: ${dimension}`);
      }
      const hh = Math.trunc(hour);
      if (!Number.isFinite(hh) || hh < 0 || hh > 23) throw new Error(`Invalid hour: ${hour}`);
      const db = this.getMainDb();
      await db.collection<UsagePeakDoc>(COLLECTIONS.planUsagePeaks).updateOne(
        { _id: `${tenantId}:${day}` },
        {
          $max: { [`hours.${dimension}.${hh}`]: value },
          $set: { tenantId, day, updatedAt: new Date() },
        },
        { upsert: true },
      );
    }

    async getPlanUsagePeaks(
      tenantId: string,
      days: string[],
    ): Promise<Array<{ day: string; dimension: string; hour: number; value: number }>> {
      if (days.length === 0) return [];
      const db = this.getMainDb();
      const docs = await db
        .collection<UsagePeakDoc>(COLLECTIONS.planUsagePeaks)
        .find({ tenantId, day: { $in: days } })
        .sort({ day: 1 })
        .toArray();
      const out: Array<{ day: string; dimension: string; hour: number; value: number }> = [];
      for (const doc of docs) {
        for (const [dimension, hours] of Object.entries(doc.hours ?? {})) {
          for (const [hour, value] of Object.entries(hours)) {
            out.push({ day: doc.day, dimension, hour: Number(hour), value });
          }
        }
      }
      return out.sort(
        (a, b) => a.day.localeCompare(b.day) || a.dimension.localeCompare(b.dimension) || a.hour - b.hour,
      );
    }
  };
}
