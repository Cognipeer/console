/**
 * MongoDB Provider – Beta access code operations mixin
 *
 * Codes live in the MAIN database: they gate public signup, which happens
 * before any tenant exists.
 */

import type {
  BetaAccessCodeStatus,
  IBetaAccessCode,
} from '../provider.interface';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS } from './base';

interface BetaAccessCodeDoc {
  code: string;
  status: BetaAccessCodeStatus;
  note: string | null;
  usedByEmail: string | null;
  usedAt: Date | null;
  createdAt: Date;
}

function normalizeBetaAccessCode(code: string): string {
  return code.trim().toUpperCase();
}

export function BetaAccessCodeMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class BetaAccessCodeOps extends Base {
    async createBetaAccessCode(
      record: { code: string; note?: string | null },
    ): Promise<IBetaAccessCode> {
      const db = this.getMainDb();
      const code = normalizeBetaAccessCode(record.code);
      const collection = db.collection<BetaAccessCodeDoc>(COLLECTIONS.betaAccessCodes);

      await collection.updateOne(
        { code },
        {
          $setOnInsert: {
            code,
            status: 'active' satisfies BetaAccessCodeStatus,
            note: record.note ?? null,
            usedByEmail: null,
            usedAt: null,
            createdAt: new Date(),
          },
        },
        { upsert: true },
      );

      const doc = await collection.findOne({ code });
      return this.mapBetaAccessCode(doc!);
    }

    async findBetaAccessCode(code: string): Promise<IBetaAccessCode | null> {
      const db = this.getMainDb();
      const doc = await db
        .collection<BetaAccessCodeDoc>(COLLECTIONS.betaAccessCodes)
        .findOne({ code: normalizeBetaAccessCode(code) });
      return doc ? this.mapBetaAccessCode(doc) : null;
    }

    async listBetaAccessCodes(
      filters: { status?: BetaAccessCodeStatus } = {},
    ): Promise<IBetaAccessCode[]> {
      const db = this.getMainDb();
      const query: Record<string, unknown> = {};
      if (filters.status) query.status = filters.status;
      const docs = await db
        .collection<BetaAccessCodeDoc>(COLLECTIONS.betaAccessCodes)
        .find(query)
        .sort({ createdAt: 1 })
        .toArray();
      return docs.map((doc) => this.mapBetaAccessCode(doc));
    }

    async consumeBetaAccessCode(
      code: string,
      usedBy: { email: string },
    ): Promise<boolean> {
      const db = this.getMainDb();
      const result = await db
        .collection<BetaAccessCodeDoc>(COLLECTIONS.betaAccessCodes)
        .updateOne(
          { code: normalizeBetaAccessCode(code), status: 'active' },
          {
            $set: {
              status: 'used' satisfies BetaAccessCodeStatus,
              usedByEmail: usedBy.email,
              usedAt: new Date(),
            },
          },
        );
      return result.modifiedCount > 0;
    }

    async releaseBetaAccessCode(code: string): Promise<boolean> {
      const db = this.getMainDb();
      const result = await db
        .collection<BetaAccessCodeDoc>(COLLECTIONS.betaAccessCodes)
        .updateOne(
          { code: normalizeBetaAccessCode(code), status: 'used' },
          {
            $set: {
              status: 'active' satisfies BetaAccessCodeStatus,
              usedByEmail: null,
              usedAt: null,
            },
          },
        );
      return result.modifiedCount > 0;
    }

    // ── Mappers ─────────────────────────────────────────────────────

    private mapBetaAccessCode(doc: BetaAccessCodeDoc): IBetaAccessCode {
      return {
        code: doc.code,
        status: doc.status,
        note: doc.note ?? null,
        usedByEmail: doc.usedByEmail ?? null,
        usedAt: doc.usedAt ?? null,
        createdAt: doc.createdAt,
      };
    }
  };
}
