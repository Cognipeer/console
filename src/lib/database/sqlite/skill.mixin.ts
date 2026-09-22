/**
 * SQLite Provider – Agent Skill operations mixin
 *
 * Mirrors `prompt.mixin.ts` — see that file's header for why a skill uses the
 * same CRUD shape as a prompt rather than a new pattern.
 */

import type { IAgentSkill } from '../provider.interface';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase, TABLES } from './base';

export function SkillMixin<TBase extends Constructor<SQLiteProviderBase>>(Base: TBase) {
  return class SkillOps extends Base {
    async createSkill(skill: Omit<IAgentSkill, '_id' | 'createdAt' | 'updatedAt'>): Promise<IAgentSkill> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();

      db.prepare(`
        INSERT INTO ${TABLES.agentSkills}
        (id, tenantId, projectId, key, title, header, body, minModelTier, status, createdBy, updatedBy, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @key, @title, @header, @body, @minModelTier, @status, @createdBy, @updatedBy, @createdAt, @updatedAt)
      `).run({
        id,
        tenantId: skill.tenantId,
        projectId: skill.projectId ?? null,
        key: skill.key,
        title: skill.title,
        header: skill.header,
        body: skill.body,
        minModelTier: skill.minModelTier ?? null,
        status: skill.status,
        createdBy: skill.createdBy,
        updatedBy: skill.updatedBy ?? null,
        createdAt: now,
        updatedAt: now,
      });

      return { ...skill, _id: id, createdAt: new Date(now), updatedAt: new Date(now) };
    }

    async updateSkill(id: string, data: Partial<IAgentSkill>): Promise<IAgentSkill | null> {
      const db = this.getTenantDb();
      const now = this.now();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: now };

      if (data.title !== undefined) { sets.push('title = @title'); params.title = data.title; }
      if (data.header !== undefined) { sets.push('header = @header'); params.header = data.header; }
      if (data.body !== undefined) { sets.push('body = @body'); params.body = data.body; }
      if (data.minModelTier !== undefined) { sets.push('minModelTier = @minModelTier'); params.minModelTier = data.minModelTier; }
      if (data.status !== undefined) { sets.push('status = @status'); params.status = data.status; }
      if (data.updatedBy !== undefined) { sets.push('updatedBy = @updatedBy'); params.updatedBy = data.updatedBy; }
      if (data.projectId !== undefined) { sets.push('projectId = @projectId'); params.projectId = data.projectId; }

      db.prepare(`UPDATE ${TABLES.agentSkills} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      return this.findSkillById(id);
    }

    async deleteSkill(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      return db.prepare(`DELETE FROM ${TABLES.agentSkills} WHERE id = @id`).run({ id }).changes > 0;
    }

    async findSkillById(id: string, projectId?: string): Promise<IAgentSkill | null> {
      const db = this.getTenantDb();
      let sql = `SELECT * FROM ${TABLES.agentSkills} WHERE id = @id`;
      const params: Record<string, unknown> = { id };
      if (projectId) { sql += ' AND projectId = @projectId'; params.projectId = projectId; }
      const row = db.prepare(sql).get(params) as SqliteRow | undefined;
      return row ? this.mapSkillRow(row) : null;
    }

    async findSkillByKey(key: string, projectId?: string): Promise<IAgentSkill | null> {
      const db = this.getTenantDb();
      let sql = `SELECT * FROM ${TABLES.agentSkills} WHERE key = @key`;
      const params: Record<string, unknown> = { key };
      if (projectId) { sql += ' AND projectId = @projectId'; params.projectId = projectId; }
      const row = db.prepare(sql).get(params) as SqliteRow | undefined;
      return row ? this.mapSkillRow(row) : null;
    }

    async listSkills(filters?: {
      projectId?: string;
      status?: IAgentSkill['status'];
      search?: string;
    }): Promise<IAgentSkill[]> {
      const db = this.getTenantDb();
      const clauses: string[] = [];
      const params: Record<string, unknown> = {};

      if (filters?.projectId) { clauses.push('projectId = @projectId'); params.projectId = filters.projectId; }
      if (filters?.status) { clauses.push('status = @status'); params.status = filters.status; }
      if (filters?.search) {
        const pattern = this.likePattern(filters.search.trim());
        clauses.push('(title LIKE @search OR key LIKE @search OR header LIKE @search)');
        params.search = pattern;
      }

      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = db.prepare(`SELECT * FROM ${TABLES.agentSkills} ${where} ORDER BY updatedAt DESC, createdAt DESC`)
        .all(params) as SqliteRow[];
      return rows.map((r) => this.mapSkillRow(r));
    }

    protected mapSkillRow(r: SqliteRow): IAgentSkill {
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        projectId: r.projectId as string | undefined,
        key: r.key as string,
        title: r.title as string,
        header: r.header as string,
        body: r.body as string,
        minModelTier: (r.minModelTier as IAgentSkill['minModelTier']) ?? undefined,
        status: r.status as IAgentSkill['status'],
        createdBy: r.createdBy as string,
        updatedBy: r.updatedBy as string | undefined,
        createdAt: this.toDate(r.createdAt),
        updatedAt: this.toDate(r.updatedAt),
      };
    }
  };
}
