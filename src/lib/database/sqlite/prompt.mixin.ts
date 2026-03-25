/**
 * SQLite Provider – Prompt operations mixin
 */

import type { IPrompt, IPromptVersion, IPromptComment } from '../provider.interface';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase, TABLES } from './base';

export function PromptMixin<TBase extends Constructor<SQLiteProviderBase>>(Base: TBase) {
  return class PromptOps extends Base {

    // ── Prompts ──────────────────────────────────────────────────────

    async createPrompt(prompt: Omit<IPrompt, '_id' | 'createdAt' | 'updatedAt'>): Promise<IPrompt> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();

      db.prepare(`
        INSERT INTO ${TABLES.prompts}
        (id, tenantId, projectId, key, name, description, template, metadata, currentVersion, deployments, deploymentHistory, createdBy, updatedBy, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @key, @name, @description, @template, @metadata, @currentVersion, @deployments, @deploymentHistory, @createdBy, @updatedBy, @createdAt, @updatedAt)
      `).run({
        id,
        tenantId: prompt.tenantId,
        projectId: prompt.projectId ?? null,
        key: prompt.key,
        name: prompt.name,
        description: prompt.description ?? null,
        template: prompt.template,
        metadata: this.toJson(prompt.metadata ?? {}),
        currentVersion: prompt.currentVersion ?? null,
        deployments: this.toJson(prompt.deployments ?? {}),
        deploymentHistory: this.toJson(prompt.deploymentHistory ?? []),
        createdBy: prompt.createdBy,
        updatedBy: prompt.updatedBy ?? null,
        createdAt: now,
        updatedAt: now,
      });

      return { ...prompt, _id: id, createdAt: new Date(now), updatedAt: new Date(now) };
    }

    async updatePrompt(id: string, data: Partial<IPrompt>): Promise<IPrompt | null> {
      const db = this.getTenantDb();
      const now = this.now();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: now };

      if (data.name !== undefined) { sets.push('name = @name'); params.name = data.name; }
      if (data.description !== undefined) { sets.push('description = @description'); params.description = data.description; }
      if (data.template !== undefined) { sets.push('template = @template'); params.template = data.template; }
      if (data.metadata !== undefined) { sets.push('metadata = @metadata'); params.metadata = this.toJson(data.metadata); }
      if (data.currentVersion !== undefined) { sets.push('currentVersion = @currentVersion'); params.currentVersion = data.currentVersion; }
      if (data.deployments !== undefined) { sets.push('deployments = @deployments'); params.deployments = this.toJson(data.deployments); }
      if (data.deploymentHistory !== undefined) { sets.push('deploymentHistory = @deploymentHistory'); params.deploymentHistory = this.toJson(data.deploymentHistory); }
      if (data.updatedBy !== undefined) { sets.push('updatedBy = @updatedBy'); params.updatedBy = data.updatedBy; }
      if (data.projectId !== undefined) { sets.push('projectId = @projectId'); params.projectId = data.projectId; }

      db.prepare(`UPDATE ${TABLES.prompts} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      return this.findPromptById(id);
    }

    async deletePrompt(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      return db.prepare(`DELETE FROM ${TABLES.prompts} WHERE id = @id`).run({ id }).changes > 0;
    }

    async findPromptById(id: string, projectId?: string): Promise<IPrompt | null> {
      const db = this.getTenantDb();
      let sql = `SELECT * FROM ${TABLES.prompts} WHERE id = @id`;
      const params: Record<string, unknown> = { id };
      if (projectId) { sql += ' AND projectId = @projectId'; params.projectId = projectId; }
      const row = db.prepare(sql).get(params) as SqliteRow | undefined;
      return row ? this.mapPromptRow(row) : null;
    }

    async findPromptByKey(key: string, projectId?: string): Promise<IPrompt | null> {
      const db = this.getTenantDb();
      let sql = `SELECT * FROM ${TABLES.prompts} WHERE key = @key`;
      const params: Record<string, unknown> = { key };
      if (projectId) { sql += ' AND projectId = @projectId'; params.projectId = projectId; }
      const row = db.prepare(sql).get(params) as SqliteRow | undefined;
      return row ? this.mapPromptRow(row) : null;
    }

    async listPrompts(filters?: { projectId?: string; search?: string }): Promise<IPrompt[]> {
      const db = this.getTenantDb();
      const clauses: string[] = [];
      const params: Record<string, unknown> = {};

      if (filters?.projectId) { clauses.push('projectId = @projectId'); params.projectId = filters.projectId; }
      if (filters?.search) {
        const pattern = this.likePattern(filters.search.trim());
        clauses.push('(name LIKE @search OR key LIKE @search OR description LIKE @search)');
        params.search = pattern;
      }

      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = db.prepare(`SELECT * FROM ${TABLES.prompts} ${where} ORDER BY updatedAt DESC, createdAt DESC`)
        .all(params) as SqliteRow[];
      return rows.map((r) => this.mapPromptRow(r));
    }

    // ── Prompt Versions ──────────────────────────────────────────────

    async createPromptVersion(version: Omit<IPromptVersion, '_id' | 'createdAt'>): Promise<IPromptVersion> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();

      db.prepare(`
        INSERT INTO ${TABLES.promptVersions}
        (id, tenantId, projectId, promptId, version, name, description, template, metadata, comment, createdBy, createdAt)
        VALUES (@id, @tenantId, @projectId, @promptId, @version, @name, @description, @template, @metadata, @comment, @createdBy, @createdAt)
      `).run({
        id,
        tenantId: version.tenantId,
        projectId: version.projectId ?? null,
        promptId: version.promptId,
        version: version.version,
        name: version.name,
        description: version.description ?? null,
        template: version.template,
        metadata: this.toJson(version.metadata ?? {}),
        comment: version.comment ?? null,
        createdBy: version.createdBy,
        createdAt: now,
      });

      return { ...version, _id: id, createdAt: new Date(now) };
    }

    async listPromptVersions(promptId: string, projectId?: string): Promise<IPromptVersion[]> {
      const db = this.getTenantDb();
      let sql = `SELECT * FROM ${TABLES.promptVersions} WHERE promptId = @promptId`;
      const params: Record<string, unknown> = { promptId };
      if (projectId) { sql += ' AND projectId = @projectId'; params.projectId = projectId; }
      sql += ' ORDER BY version DESC';
      const rows = db.prepare(sql).all(params) as SqliteRow[];
      return rows.map((r) => this.mapVersionRow(r));
    }

    async findPromptVersionById(id: string, promptId?: string, projectId?: string): Promise<IPromptVersion | null> {
      const db = this.getTenantDb();
      let sql = `SELECT * FROM ${TABLES.promptVersions} WHERE id = @id`;
      const params: Record<string, unknown> = { id };
      if (promptId) { sql += ' AND promptId = @promptId'; params.promptId = promptId; }
      if (projectId) { sql += ' AND projectId = @projectId'; params.projectId = projectId; }
      const row = db.prepare(sql).get(params) as SqliteRow | undefined;
      return row ? this.mapVersionRow(row) : null;
    }

    async deletePromptVersions(promptId: string, projectId?: string): Promise<number> {
      const db = this.getTenantDb();
      let sql = `DELETE FROM ${TABLES.promptVersions} WHERE promptId = @promptId`;
      const params: Record<string, unknown> = { promptId };
      if (projectId) { sql += ' AND projectId = @projectId'; params.projectId = projectId; }
      return db.prepare(sql).run(params).changes;
    }

    // ── Prompt Comments ──────────────────────────────────────────────

    async createPromptComment(comment: Omit<IPromptComment, '_id' | 'createdAt' | 'updatedAt'>): Promise<IPromptComment> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();

      db.prepare(`
        INSERT INTO ${TABLES.promptComments}
        (id, tenantId, projectId, promptId, versionId, version, content, createdBy, createdByName, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @promptId, @versionId, @version, @content, @createdBy, @createdByName, @createdAt, @updatedAt)
      `).run({
        id,
        tenantId: comment.tenantId,
        projectId: comment.projectId ?? null,
        promptId: comment.promptId,
        versionId: comment.versionId ?? null,
        version: comment.version ?? null,
        content: comment.content,
        createdBy: comment.createdBy,
        createdByName: comment.createdByName ?? null,
        createdAt: now,
        updatedAt: now,
      });

      return { ...comment, _id: id, createdAt: new Date(now), updatedAt: new Date(now) };
    }

    async listPromptComments(
      promptId: string,
      options?: { versionId?: string; projectId?: string },
    ): Promise<IPromptComment[]> {
      const db = this.getTenantDb();
      const clauses = ['promptId = @promptId'];
      const params: Record<string, unknown> = { promptId };
      if (options?.versionId) { clauses.push('versionId = @versionId'); params.versionId = options.versionId; }
      if (options?.projectId) { clauses.push('projectId = @projectId'); params.projectId = options.projectId; }
      const rows = db.prepare(
        `SELECT * FROM ${TABLES.promptComments} WHERE ${clauses.join(' AND ')} ORDER BY createdAt DESC`,
      ).all(params) as SqliteRow[];
      return rows.map((r) => this.mapCommentRow(r));
    }

    async updatePromptComment(id: string, data: Partial<Pick<IPromptComment, 'content'>>): Promise<IPromptComment | null> {
      const db = this.getTenantDb();
      const now = this.now();
      if (data.content !== undefined) {
        db.prepare(`UPDATE ${TABLES.promptComments} SET content = @content, updatedAt = @updatedAt WHERE id = @id`)
          .run({ id, content: data.content, updatedAt: now });
      }
      const row = db.prepare(`SELECT * FROM ${TABLES.promptComments} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapCommentRow(row) : null;
    }

    async deletePromptComment(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      return db.prepare(`DELETE FROM ${TABLES.promptComments} WHERE id = @id`).run({ id }).changes > 0;
    }

    async deletePromptCommentsByPromptId(promptId: string): Promise<number> {
      const db = this.getTenantDb();
      return db.prepare(`DELETE FROM ${TABLES.promptComments} WHERE promptId = @promptId`).run({ promptId }).changes;
    }

    // ── Row mappers ──────────────────────────────────────────────────

    protected mapPromptRow(r: SqliteRow): IPrompt {
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        projectId: r.projectId as string | undefined,
        key: r.key as string,
        name: r.name as string,
        description: r.description as string | undefined,
        template: r.template as string,
        metadata: this.parseJson(r.metadata, {}),
        currentVersion: r.currentVersion as number | undefined,
        deployments: this.parseJson(r.deployments, {}),
        deploymentHistory: this.parseJson(r.deploymentHistory, []),
        createdBy: r.createdBy as string,
        updatedBy: r.updatedBy as string | undefined,
        createdAt: this.toDate(r.createdAt),
        updatedAt: this.toDate(r.updatedAt),
      };
    }

    protected mapVersionRow(r: SqliteRow): IPromptVersion {
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        projectId: r.projectId as string | undefined,
        promptId: r.promptId as string,
        version: r.version as number,
        name: r.name as string,
        description: r.description as string | undefined,
        template: r.template as string,
        metadata: this.parseJson(r.metadata, {}),
        comment: r.comment as string | undefined,
        createdBy: r.createdBy as string,
        createdAt: this.toDate(r.createdAt),
      };
    }

    protected mapCommentRow(r: SqliteRow): IPromptComment {
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        projectId: r.projectId as string | undefined,
        promptId: r.promptId as string,
        versionId: r.versionId as string | undefined,
        version: r.version as number | undefined,
        content: r.content as string,
        createdBy: r.createdBy as string,
        createdByName: r.createdByName as string | undefined,
        createdAt: this.toDate(r.createdAt),
        updatedAt: this.toDate(r.updatedAt),
      };
    }
  };
}
