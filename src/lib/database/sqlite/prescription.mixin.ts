/**
 * SQLite Provider – Prescription report operations mixin
 *
 * Automated analysis reports (prescriptions service). Tenant-scoped;
 * `findings` / `totals` / `narrative` are opaque JSON owned by the service.
 */

import type {
  IPrescriptionReport,
  PrescriptionSubjectKind,
} from '../provider.interface';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase, TABLES } from './base';

export function PrescriptionMixin<TBase extends Constructor<SQLiteProviderBase>>(Base: TBase) {
  return class PrescriptionOps extends Base {
    async createPrescriptionReport(
      report: Omit<IPrescriptionReport, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IPrescriptionReport> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();

      db.prepare(`
        INSERT INTO ${TABLES.prescriptionReports}
        (id, tenantId, projectId, subjectKind, subjectName, windowDays,
         fromAt, toAt, status, error, totals, findings, narrative,
         createdBy, createdAt, updatedAt, finishedAt)
        VALUES (@id, @tenantId, @projectId, @subjectKind, @subjectName, @windowDays,
         @fromAt, @toAt, @status, @error, @totals, @findings, @narrative,
         @createdBy, @createdAt, @updatedAt, @finishedAt)
      `).run({
        id,
        tenantId: report.tenantId,
        projectId: report.projectId,
        subjectKind: report.subjectKind,
        subjectName: report.subjectName ?? null,
        windowDays: report.windowDays,
        fromAt: report.from ? report.from.toISOString() : null,
        toAt: report.to ? report.to.toISOString() : null,
        status: report.status,
        error: report.error ?? null,
        totals: report.totals ? this.toJson(report.totals) : null,
        findings: this.toJson(report.findings ?? []),
        narrative: report.narrative ? this.toJson(report.narrative) : null,
        createdBy: report.createdBy ?? null,
        createdAt: now,
        updatedAt: now,
        finishedAt: report.finishedAt ? report.finishedAt.toISOString() : null,
      });

      return { ...report, _id: id, createdAt: new Date(now), updatedAt: new Date(now) };
    }

    async updatePrescriptionReport(
      id: string,
      data: Partial<Omit<IPrescriptionReport, '_id' | 'tenantId' | 'projectId' | 'createdAt'>>,
    ): Promise<IPrescriptionReport | null> {
      const db = this.getTenantDb();
      const now = this.now();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: now };

      if (data.subjectKind !== undefined) { sets.push('subjectKind = @subjectKind'); params.subjectKind = data.subjectKind; }
      if (data.subjectName !== undefined) { sets.push('subjectName = @subjectName'); params.subjectName = data.subjectName ?? null; }
      if (data.windowDays !== undefined) { sets.push('windowDays = @windowDays'); params.windowDays = data.windowDays; }
      if (data.from !== undefined) { sets.push('fromAt = @fromAt'); params.fromAt = data.from ? data.from.toISOString() : null; }
      if (data.to !== undefined) { sets.push('toAt = @toAt'); params.toAt = data.to ? data.to.toISOString() : null; }
      if (data.status !== undefined) { sets.push('status = @status'); params.status = data.status; }
      if (data.error !== undefined) { sets.push('error = @error'); params.error = data.error ?? null; }
      if (data.totals !== undefined) { sets.push('totals = @totals'); params.totals = data.totals ? this.toJson(data.totals) : null; }
      if (data.findings !== undefined) { sets.push('findings = @findings'); params.findings = this.toJson(data.findings ?? []); }
      if (data.narrative !== undefined) { sets.push('narrative = @narrative'); params.narrative = data.narrative ? this.toJson(data.narrative) : null; }
      if (data.createdBy !== undefined) { sets.push('createdBy = @createdBy'); params.createdBy = data.createdBy ?? null; }
      if (data.finishedAt !== undefined) { sets.push('finishedAt = @finishedAt'); params.finishedAt = data.finishedAt ? data.finishedAt.toISOString() : null; }

      const result = db
        .prepare(`UPDATE ${TABLES.prescriptionReports} SET ${sets.join(', ')} WHERE id = @id`)
        .run(params);
      if (result.changes === 0) return null;
      return this.findPrescriptionReportById(id);
    }

    async findPrescriptionReportById(id: string): Promise<IPrescriptionReport | null> {
      const db = this.getTenantDb();
      const row = db
        .prepare(`SELECT * FROM ${TABLES.prescriptionReports} WHERE id = @id`)
        .get({ id }) as SqliteRow | undefined;
      return row ? this.mapPrescriptionReportRow(row) : null;
    }

    async listPrescriptionReports(filters: {
      projectId: string;
      subjectKind?: PrescriptionSubjectKind;
      subjectName?: string;
      limit?: number;
      skip?: number;
    }): Promise<{ reports: IPrescriptionReport[]; total: number }> {
      const db = this.getTenantDb();
      const where: string[] = ['projectId = @projectId'];
      const params: Record<string, unknown> = { projectId: filters.projectId };
      if (filters.subjectKind) { where.push('subjectKind = @subjectKind'); params.subjectKind = filters.subjectKind; }
      if (filters.subjectName !== undefined) { where.push('subjectName = @subjectName'); params.subjectName = filters.subjectName; }

      const totalRow = db
        .prepare(`SELECT COUNT(*) AS n FROM ${TABLES.prescriptionReports} WHERE ${where.join(' AND ')}`)
        .get(params) as SqliteRow;
      const rows = db
        .prepare(`
          SELECT * FROM ${TABLES.prescriptionReports}
          WHERE ${where.join(' AND ')}
          ORDER BY createdAt DESC
          LIMIT @limit OFFSET @skip
        `)
        .all({
          ...params,
          limit: Math.min(filters.limit ?? 50, 200),
          skip: filters.skip ?? 0,
        }) as SqliteRow[];

      return {
        reports: rows.map((row) => this.mapPrescriptionReportRow(row)),
        total: (totalRow?.n as number) ?? 0,
      };
    }

    async deletePrescriptionReport(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      const result = db
        .prepare(`DELETE FROM ${TABLES.prescriptionReports} WHERE id = @id`)
        .run({ id });
      return result.changes > 0;
    }

    // ── Row mappers ─────────────────────────────────────────────────

    protected mapPrescriptionReportRow(r: SqliteRow): IPrescriptionReport {
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        projectId: r.projectId as string,
        subjectKind: r.subjectKind as IPrescriptionReport['subjectKind'],
        subjectName: (r.subjectName as string | null) ?? null,
        windowDays: r.windowDays as number,
        from: r.fromAt ? this.toDate(r.fromAt) : null,
        to: r.toAt ? this.toDate(r.toAt) : null,
        status: r.status as IPrescriptionReport['status'],
        error: (r.error as string | null) ?? null,
        totals: r.totals ? this.parseJson(r.totals, {}) : null,
        findings: this.parseJson(r.findings, []),
        narrative: r.narrative
          ? (() => {
              const parsed = this.parseJson<{ text: string; modelKey: string; generatedAt: string }>(
                r.narrative,
                { text: '', modelKey: '', generatedAt: '' },
              );
              return {
                text: parsed.text,
                modelKey: parsed.modelKey,
                generatedAt: parsed.generatedAt ? new Date(parsed.generatedAt) : new Date(0),
              };
            })()
          : null,
        createdBy: (r.createdBy as string | null) ?? null,
        createdAt: this.toDate(r.createdAt),
        updatedAt: this.toDate(r.updatedAt),
        finishedAt: r.finishedAt ? this.toDate(r.finishedAt) : null,
      };
    }
  };
}
