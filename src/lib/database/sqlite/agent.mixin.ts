/**
 * SQLite Provider – Agent operations mixin
 *
 * Includes agent CRUD and conversation management.
 */

import type { IAgent, AgentStatus, IAgentConversation, IAgentVersion } from '../provider.interface';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase, TABLES } from './base';

export function AgentMixin<TBase extends Constructor<SQLiteProviderBase>>(Base: TBase) {
  return class AgentOps extends Base {
    // ── Agent CRUD ───────────────────────────────────────────────

    async createAgent(
      agent: Omit<IAgent, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IAgent> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();

      db.prepare(`
        INSERT INTO ${TABLES.agents}
        (id, tenantId, projectId, key, name, description, config, status,
         publishedVersion, latestVersion, metadata, createdBy, updatedBy, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @key, @name, @description, @config, @status,
         @publishedVersion, @latestVersion, @metadata, @createdBy, @updatedBy, @createdAt, @updatedAt)
      `).run({
        id,
        tenantId: agent.tenantId,
        projectId: agent.projectId,
        key: agent.key,
        name: agent.name,
        description: agent.description ?? null,
        config: this.toJson(agent.config),
        status: agent.status,
        publishedVersion: agent.publishedVersion ?? null,
        latestVersion: agent.latestVersion ?? null,
        metadata: this.toJson(agent.metadata ?? {}),
        createdBy: agent.createdBy,
        updatedBy: agent.updatedBy ?? null,
        createdAt: now,
        updatedAt: now,
      });

      return { ...agent, _id: id, createdAt: new Date(now), updatedAt: new Date(now) };
    }

    async updateAgent(
      id: string,
      data: Partial<Omit<IAgent, 'tenantId' | 'key' | 'createdBy'>>,
    ): Promise<IAgent | null> {
      const db = this.getTenantDb();
      const now = this.now();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: now };

      if (data.name !== undefined) { sets.push('name = @name'); params.name = data.name; }
      if (data.description !== undefined) { sets.push('description = @description'); params.description = data.description; }
      if (data.config !== undefined) { sets.push('config = @config'); params.config = this.toJson(data.config); }
      if (data.status !== undefined) { sets.push('status = @status'); params.status = data.status; }
      if (data.publishedVersion !== undefined) { sets.push('publishedVersion = @publishedVersion'); params.publishedVersion = data.publishedVersion; }
      if (data.latestVersion !== undefined) { sets.push('latestVersion = @latestVersion'); params.latestVersion = data.latestVersion; }
      if (data.metadata !== undefined) { sets.push('metadata = @metadata'); params.metadata = this.toJson(data.metadata); }
      if (data.updatedBy !== undefined) { sets.push('updatedBy = @updatedBy'); params.updatedBy = data.updatedBy; }
      if (data.projectId !== undefined) { sets.push('projectId = @projectId'); params.projectId = data.projectId; }

      db.prepare(`UPDATE ${TABLES.agents} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      return this.findAgentById(id);
    }

    async deleteAgent(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      return db.prepare(`DELETE FROM ${TABLES.agents} WHERE id = @id`).run({ id }).changes === 1;
    }

    async findAgentById(id: string): Promise<IAgent | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.agents} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapAgent(row) : null;
    }

    async findAgentByKey(key: string, projectId?: string): Promise<IAgent | null> {
      const db = this.getTenantDb();
      let sql = `SELECT * FROM ${TABLES.agents} WHERE key = @key`;
      const params: Record<string, unknown> = { key };
      if (projectId !== undefined) { sql += ' AND projectId = @projectId'; params.projectId = projectId; }
      const row = db.prepare(sql).get(params) as SqliteRow | undefined;
      return row ? this.mapAgent(row) : null;
    }

    async listAgents(filters?: {
      projectId?: string;
      status?: AgentStatus;
      search?: string;
    }): Promise<IAgent[]> {
      const db = this.getTenantDb();
      const conditions: string[] = [];
      const params: Record<string, unknown> = {};

      if (filters?.projectId !== undefined) { conditions.push('projectId = @projectId'); params.projectId = filters.projectId; }
      if (filters?.status) { conditions.push('status = @status'); params.status = filters.status; }
      if (filters?.search) {
        conditions.push('(name LIKE @search OR key LIKE @search OR description LIKE @search)');
        params.search = `%${filters.search}%`;
      }

      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const rows = db.prepare(`SELECT * FROM ${TABLES.agents} ${where} ORDER BY createdAt DESC`).all(params) as SqliteRow[];
      return rows.map((r) => this.mapAgent(r));
    }

    async countAgents(projectId?: string): Promise<number> {
      const db = this.getTenantDb();
      let sql = `SELECT COUNT(*) as cnt FROM ${TABLES.agents}`;
      const params: Record<string, unknown> = {};
      if (projectId !== undefined) { sql += ' WHERE projectId = @projectId'; params.projectId = projectId; }
      const row = db.prepare(sql).get(params) as SqliteRow;
      return Number(row.cnt) || 0;
    }

    // ── Agent Version operations ─────────────────────────────────

    async createAgentVersion(
      version: Omit<IAgentVersion, '_id' | 'createdAt'>,
    ): Promise<IAgentVersion> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();

      db.prepare(`
        INSERT INTO ${TABLES.agentVersions}
        (id, tenantId, projectId, agentId, agentKey, version, snapshot,
         changelog, publishedBy, createdAt)
        VALUES (@id, @tenantId, @projectId, @agentId, @agentKey, @version, @snapshot,
         @changelog, @publishedBy, @createdAt)
      `).run({
        id,
        tenantId: version.tenantId,
        projectId: version.projectId,
        agentId: version.agentId,
        agentKey: version.agentKey,
        version: version.version,
        snapshot: this.toJson(version.snapshot),
        changelog: version.changelog ?? null,
        publishedBy: version.publishedBy,
        createdAt: now,
      });

      return { ...version, _id: id, createdAt: new Date(now) };
    }

    async findAgentVersion(
      agentId: string,
      version: number,
    ): Promise<IAgentVersion | null> {
      const db = this.getTenantDb();
      const row = db.prepare(
        `SELECT * FROM ${TABLES.agentVersions} WHERE agentId = @agentId AND version = @version`,
      ).get({ agentId, version }) as SqliteRow | undefined;
      return row ? this.mapAgentVersion(row) : null;
    }

    async findLatestAgentVersion(
      agentId: string,
    ): Promise<IAgentVersion | null> {
      const db = this.getTenantDb();
      const row = db.prepare(
        `SELECT * FROM ${TABLES.agentVersions} WHERE agentId = @agentId ORDER BY version DESC LIMIT 1`,
      ).get({ agentId }) as SqliteRow | undefined;
      return row ? this.mapAgentVersion(row) : null;
    }

    async listAgentVersions(
      agentId: string,
      options?: { limit?: number; skip?: number },
    ): Promise<{ versions: IAgentVersion[]; total: number }> {
      const db = this.getTenantDb();
      const countRow = db.prepare(
        `SELECT COUNT(*) as cnt FROM ${TABLES.agentVersions} WHERE agentId = @agentId`,
      ).get({ agentId }) as SqliteRow;
      const total = Number(countRow.cnt) || 0;

      let sql = `SELECT * FROM ${TABLES.agentVersions} WHERE agentId = @agentId ORDER BY version DESC`;
      if (options?.limit) sql += ` LIMIT ${options.limit}`;
      if (options?.skip) sql += ` OFFSET ${options.skip}`;

      const rows = db.prepare(sql).all({ agentId }) as SqliteRow[];
      const versions = rows.map((r) => this.mapAgentVersion(r));
      return { versions, total };
    }

    // ── Agent Conversation operations ────────────────────────────

    async createAgentConversation(
      conversation: Omit<IAgentConversation, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IAgentConversation> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();

      db.prepare(`
        INSERT INTO ${TABLES.agentConversations}
        (id, tenantId, projectId, agentKey, title, messages, metadata, createdBy, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @agentKey, @title, @messages, @metadata, @createdBy, @createdAt, @updatedAt)
      `).run({
        id,
        tenantId: conversation.tenantId,
        projectId: conversation.projectId,
        agentKey: conversation.agentKey,
        title: conversation.title ?? null,
        messages: this.toJson(conversation.messages),
        metadata: this.toJson(conversation.metadata ?? {}),
        createdBy: conversation.createdBy,
        createdAt: now,
        updatedAt: now,
      });

      return { ...conversation, _id: id, createdAt: new Date(now), updatedAt: new Date(now) };
    }

    async updateAgentConversation(
      id: string,
      data: Partial<Omit<IAgentConversation, 'tenantId' | 'agentKey' | 'createdBy'>>,
    ): Promise<IAgentConversation | null> {
      const db = this.getTenantDb();
      const now = this.now();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: now };

      if (data.title !== undefined) { sets.push('title = @title'); params.title = data.title; }
      if (data.messages !== undefined) { sets.push('messages = @messages'); params.messages = this.toJson(data.messages); }
      if (data.metadata !== undefined) { sets.push('metadata = @metadata'); params.metadata = this.toJson(data.metadata); }

      db.prepare(`UPDATE ${TABLES.agentConversations} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      return this.findAgentConversationById(id);
    }

    async deleteAgentConversation(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      return db.prepare(`DELETE FROM ${TABLES.agentConversations} WHERE id = @id`).run({ id }).changes === 1;
    }

    async findAgentConversationById(id: string): Promise<IAgentConversation | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.agentConversations} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapConversation(row) : null;
    }

    async listAgentConversations(
      agentKey: string,
      filters?: { projectId?: string; limit?: number; skip?: number },
    ): Promise<IAgentConversation[]> {
      const db = this.getTenantDb();
      const conditions: string[] = ['agentKey = @agentKey'];
      const params: Record<string, unknown> = { agentKey };

      if (filters?.projectId !== undefined) { conditions.push('projectId = @projectId'); params.projectId = filters.projectId; }

      let sql = `SELECT * FROM ${TABLES.agentConversations} WHERE ${conditions.join(' AND ')} ORDER BY updatedAt DESC`;
      if (filters?.limit) sql += ` LIMIT ${filters.limit}`;
      if (filters?.skip) sql += ` OFFSET ${filters.skip}`;

      const rows = db.prepare(sql).all(params) as SqliteRow[];
      return rows.map((r) => this.mapConversation(r));
    }

    // ── Private helpers ──────────────────────────────────────────

    private mapAgent(row: SqliteRow): IAgent {
      return {
        _id: String(row.id),
        tenantId: String(row.tenantId),
        projectId: String(row.projectId),
        key: String(row.key),
        name: String(row.name),
        description: row.description ? String(row.description) : undefined,
        config: this.parseJson(row.config, { modelKey: '' }),
        status: String(row.status) as IAgent['status'],
        publishedVersion:
          row.publishedVersion === null || row.publishedVersion === undefined
            ? null
            : Number(row.publishedVersion),
        latestVersion:
          row.latestVersion === null || row.latestVersion === undefined
            ? undefined
            : Number(row.latestVersion),
        metadata: row.metadata ? this.parseJson(row.metadata, {}) : undefined,
        createdBy: String(row.createdBy),
        updatedBy: row.updatedBy ? String(row.updatedBy) : undefined,
        createdAt: row.createdAt ? new Date(row.createdAt as string) : undefined,
        updatedAt: row.updatedAt ? new Date(row.updatedAt as string) : undefined,
      };
    }

    private mapConversation(row: SqliteRow): IAgentConversation {
      return {
        _id: String(row.id),
        tenantId: String(row.tenantId),
        projectId: String(row.projectId),
        agentKey: String(row.agentKey),
        title: row.title ? String(row.title) : undefined,
        messages: this.parseJson(row.messages, []),
        metadata: row.metadata ? this.parseJson(row.metadata, {}) : undefined,
        createdBy: String(row.createdBy),
        createdAt: row.createdAt ? new Date(row.createdAt as string) : undefined,
        updatedAt: row.updatedAt ? new Date(row.updatedAt as string) : undefined,
      };
    }

    private mapAgentVersion(row: SqliteRow): IAgentVersion {
      return {
        _id: String(row.id),
        tenantId: String(row.tenantId),
        projectId: String(row.projectId),
        agentId: String(row.agentId),
        agentKey: String(row.agentKey),
        version: Number(row.version),
        snapshot: this.parseJson(row.snapshot, { name: '', config: { modelKey: '' }, status: 'draft' as const }),
        changelog: row.changelog ? String(row.changelog) : undefined,
        publishedBy: String(row.publishedBy),
        createdAt: row.createdAt ? new Date(row.createdAt as string) : undefined,
      };
    }
  };
}
