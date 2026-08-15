/**
 * MongoDB Provider – Prescription report operations mixin
 *
 * Automated analysis reports (prescriptions service). Tenant-scoped;
 * `findings` / `totals` / `narrative` are opaque JSON owned by the service.
 */

import { ObjectId } from 'mongodb';
import type {
  IPrescriptionReport,
  PrescriptionSubjectKind,
} from '../provider.interface';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS } from './base';

function toObjectId(id: string): ObjectId | null {
  return ObjectId.isValid(id) ? new ObjectId(id) : null;
}

export function PrescriptionMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class PrescriptionOps extends Base {
    async createPrescriptionReport(
      report: Omit<IPrescriptionReport, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IPrescriptionReport> {
      const db = this.getTenantDb();
      const now = new Date();
      const doc = { ...report, createdAt: now, updatedAt: now };
      const result = await db
        .collection(COLLECTIONS.prescriptionReports)
        .insertOne(doc);
      return { ...doc, _id: result.insertedId.toString() };
    }

    async updatePrescriptionReport(
      id: string,
      data: Partial<Omit<IPrescriptionReport, '_id' | 'tenantId' | 'projectId' | 'createdAt'>>,
    ): Promise<IPrescriptionReport | null> {
      const objectId = toObjectId(id);
      if (!objectId) return null;
      const db = this.getTenantDb();
      const updateData: Record<string, unknown> = { ...data, updatedAt: new Date() };
      delete updateData._id;
      const result = await db
        .collection<IPrescriptionReport>(COLLECTIONS.prescriptionReports)
        .findOneAndUpdate(
          { _id: objectId as never },
          { $set: updateData },
          { returnDocument: 'after' },
        );
      if (!result) return null;
      return { ...result, _id: result._id?.toString() } as IPrescriptionReport;
    }

    async findPrescriptionReportById(id: string): Promise<IPrescriptionReport | null> {
      const objectId = toObjectId(id);
      if (!objectId) return null;
      const db = this.getTenantDb();
      const doc = await db
        .collection(COLLECTIONS.prescriptionReports)
        .findOne({ _id: objectId });
      if (!doc) return null;
      return { ...doc, _id: doc._id?.toString() } as unknown as IPrescriptionReport;
    }

    async listPrescriptionReports(filters: {
      projectId: string;
      subjectKind?: PrescriptionSubjectKind;
      subjectName?: string;
      limit?: number;
      skip?: number;
    }): Promise<{ reports: IPrescriptionReport[]; total: number }> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = { projectId: filters.projectId };
      if (filters.subjectKind) query.subjectKind = filters.subjectKind;
      if (filters.subjectName !== undefined) query.subjectName = filters.subjectName;
      const collection = db.collection(COLLECTIONS.prescriptionReports);
      const total = await collection.countDocuments(query);
      const docs = await collection
        .find(query)
        .sort({ createdAt: -1 })
        .skip(filters.skip ?? 0)
        .limit(Math.min(filters.limit ?? 50, 200))
        .toArray();
      return {
        reports: docs.map((doc) => ({
          ...doc,
          _id: doc._id?.toString(),
        })) as unknown as IPrescriptionReport[],
        total,
      };
    }

    async deletePrescriptionReport(id: string): Promise<boolean> {
      const objectId = toObjectId(id);
      if (!objectId) return false;
      const db = this.getTenantDb();
      const result = await db
        .collection(COLLECTIONS.prescriptionReports)
        .deleteOne({ _id: objectId });
      return result.deletedCount === 1;
    }
  };
}
