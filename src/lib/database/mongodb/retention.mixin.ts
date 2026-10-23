/**
 * MongoDB Provider – retention primitives mixin
 *
 * The few generic operations the retention engine (src/lib/retention) needs to
 * age out any registered log collection. Deletes and redactions go by `_id`
 * batches: find the ids first (index range on the time field), then act on
 * exactly those, so one call never holds a long multi-document write.
 *
 * Time fields are Dates in most collections and ISO strings in a few, and a
 * BSON comparison never matches across the two types, so every age condition
 * is written for both.
 */

import type { Filter, Document } from 'mongodb';
import type { Constructor } from './types';
import { MongoDBProviderBase } from './base';
import type { RetentionFilter, RetentionRedactField } from '../provider/types';

function ageCondition(field: string, before: Date, after?: Date): Filter<Document> {
  const asDate: Record<string, unknown> = { $lt: before };
  const asString: Record<string, unknown> = { $lt: before.toISOString() };
  if (after) {
    asDate.$gte = after;
    asString.$gte = after.toISOString();
  }
  return { $or: [{ [field]: asDate }, { [field]: asString }] };
}

export function buildRetentionQuery(filter: RetentionFilter, extra: Filter<Document>[] = []): Filter<Document> {
  const clauses: Filter<Document>[] = [ageCondition(filter.timeField, filter.before, filter.after)];
  if (filter.projectField) {
    if (filter.projectIn) clauses.push({ [filter.projectField]: { $in: filter.projectIn } });
    if (filter.projectNotIn && filter.projectNotIn.length > 0) {
      clauses.push({ [filter.projectField]: { $nin: filter.projectNotIn } });
    }
  }
  for (const condition of filter.where ?? []) {
    if (condition.in) clauses.push({ [condition.field]: { $in: condition.in } });
    if (condition.notIn) clauses.push({ [condition.field]: { $nin: condition.notIn } });
  }
  clauses.push(...extra);
  return clauses.length === 1 ? clauses[0] : { $and: clauses };
}

/** Rows that still hold content in at least one of the fields. */
function holdsContent(fields: RetentionRedactField[]): Filter<Document> {
  return { $or: fields.map(({ field }) => ({ [field]: { $nin: [null, ''] } })) };
}

export function RetentionMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class RetentionOps extends Base {
    async retentionCount(collection: string, filter: RetentionFilter): Promise<number> {
      return this.getTenantDb().collection(collection).countDocuments(buildRetentionQuery(filter));
    }

    async retentionCountRedactable(collection: string, filter: RetentionFilter, fields: RetentionRedactField[]): Promise<number> {
      if (fields.length === 0) return 0;
      return this.getTenantDb().collection(collection).countDocuments(buildRetentionQuery(filter, [holdsContent(fields)]));
    }

    async retentionDeleteBatch(collection: string, filter: RetentionFilter, limit: number): Promise<number> {
      const coll = this.getTenantDb().collection(collection);
      const ids = await coll
        .find(buildRetentionQuery(filter), { projection: { _id: 1 } })
        .limit(Math.max(1, limit))
        .toArray();
      if (ids.length === 0) return 0;
      const res = await coll.deleteMany({ _id: { $in: ids.map((d) => d._id) } });
      return res.deletedCount ?? 0;
    }

    async retentionRedactBatch(
      collection: string,
      filter: RetentionFilter,
      fields: RetentionRedactField[],
      limit: number,
    ): Promise<number> {
      if (fields.length === 0) return 0;
      const coll = this.getTenantDb().collection(collection);
      const ids = await coll
        .find(buildRetentionQuery(filter, [holdsContent(fields)]), { projection: { _id: 1 } })
        .limit(Math.max(1, limit))
        .toArray();
      if (ids.length === 0) return 0;
      const unset: Record<string, ''> = {};
      const set: Record<string, string> = {};
      for (const { field, clearTo } of fields) {
        if (clearTo === 'empty') set[field] = '';
        else unset[field] = '';
      }
      const update: Document = {};
      if (Object.keys(unset).length > 0) update.$unset = unset;
      if (Object.keys(set).length > 0) update.$set = set;
      const res = await coll.updateMany({ _id: { $in: ids.map((d) => d._id) } }, update);
      return res.modifiedCount ?? 0;
    }

    async retentionSelectValues(collection: string, filter: RetentionFilter, field: string, limit: number): Promise<string[]> {
      const rows = await this.getTenantDb()
        .collection(collection)
        .find(buildRetentionQuery(filter), { projection: { [field]: 1 } })
        .limit(Math.max(1, limit))
        .toArray();
      const values = new Set<string>();
      for (const row of rows) {
        const value = row[field];
        if (typeof value === 'string' && value.length > 0) values.add(value);
      }
      return [...values];
    }

    async retentionDeleteWhereIn(collection: string, field: string, values: string[]): Promise<number> {
      if (values.length === 0) return 0;
      const res = await this.getTenantDb().collection(collection).deleteMany({ [field]: { $in: values } });
      return res.deletedCount ?? 0;
    }
  };
}
