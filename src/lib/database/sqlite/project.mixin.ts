/**
 * SQLite Provider – Project operations mixin
 */

import type { IProject } from '../provider.interface';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase, TABLES, logger } from './base';

export function ProjectMixin<TBase extends Constructor<SQLiteProviderBase>>(Base: TBase) {
  return class ProjectOps extends Base {

    async createProject(
      project: Omit<IProject, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IProject> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();

      db.prepare(`
        INSERT INTO ${TABLES.projects} (id, tenantId, key, name, description, createdBy, updatedBy, createdAt, updatedAt)
        VALUES (@id, @tenantId, @key, @name, @description, @createdBy, @updatedBy, @createdAt, @updatedAt)
      `).run({
        id,
        tenantId: project.tenantId,
        key: project.key,
        name: project.name,
        description: project.description ?? null,
        createdBy: project.createdBy,
        updatedBy: project.updatedBy ?? null,
        createdAt: now,
        updatedAt: now,
      });

      return { ...project, _id: id, createdAt: new Date(now), updatedAt: new Date(now) };
    }

    async updateProject(
      id: string,
      data: Partial<Omit<IProject, 'tenantId' | 'key'>>,
    ): Promise<IProject | null> {
      const db = this.getTenantDb();
      const now = this.now();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: now };

      if (data.name !== undefined) { sets.push('name = @name'); params.name = data.name; }
      if (data.description !== undefined) { sets.push('description = @description'); params.description = data.description; }
      if (data.updatedBy !== undefined) { sets.push('updatedBy = @updatedBy'); params.updatedBy = data.updatedBy; }

      db.prepare(`UPDATE ${TABLES.projects} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      return this.findProjectById(id);
    }

    async deleteProject(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      const result = db.prepare(`DELETE FROM ${TABLES.projects} WHERE id = @id`).run({ id });
      return result.changes > 0;
    }

    async findProjectById(id: string): Promise<IProject | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.projects} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapProjectRow(row) : null;
    }

    async findProjectByKey(tenantId: string, key: string): Promise<IProject | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.projects} WHERE tenantId = @tenantId AND key = @key`)
        .get({ tenantId, key }) as SqliteRow | undefined;
      return row ? this.mapProjectRow(row) : null;
    }

    async listProjects(tenantId: string): Promise<IProject[]> {
      const db = this.getTenantDb();
      const rows = db.prepare(`SELECT * FROM ${TABLES.projects} WHERE tenantId = @tenantId ORDER BY createdAt DESC`)
        .all({ tenantId }) as SqliteRow[];
      return rows.map((r) => this.mapProjectRow(r));
    }

    async assignProjectIdToLegacyRecords(tenantId: string, projectId: string): Promise<void> {
      const db = this.getTenantDb();
      const tables = [
        TABLES.models, TABLES.prompts, TABLES.promptVersions,
        TABLES.providers, TABLES.vectorIndexes, TABLES.fileBuckets,
        TABLES.files, TABLES.guardrails, TABLES.ragModules,
      ];

      const tx = db.transaction(() => {
        for (const table of tables) {
          try {
            db.prepare(
              `UPDATE ${table} SET projectId = @projectId WHERE tenantId = @tenantId AND (projectId IS NULL OR projectId = '')`,
            ).run({ tenantId, projectId });
          } catch (err) {
            logger.warn(`assignProjectIdToLegacyRecords: skipping ${table}`, { err });
          }
        }
      });
      tx();
    }

    protected mapProjectRow(r: SqliteRow): IProject {
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        key: r.key as string,
        name: r.name as string,
        description: r.description as string | undefined,
        createdBy: r.createdBy as string,
        updatedBy: r.updatedBy as string | undefined,
        createdAt: this.toDate(r.createdAt),
        updatedAt: this.toDate(r.updatedAt),
      };
    }
  };
}
