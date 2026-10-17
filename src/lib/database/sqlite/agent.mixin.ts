/**
 * SQLite Provider – Agent operations mixin
 *
 * Includes agent CRUD and conversation management.
 */

import type {
  IAgent,
  AgentStatus,
  AgentSessionRuntimeStatus,
  IAgentConversation,
  IAgentConversationListItem,
  IAgentConversationSearchHit,
  IAgentConversationState,
  IAgentPendingAction,
  IAgentMessageFeedback,
  AgentMessageFeedbackFilter,
  AgentMessageFeedbackTotals,
  AgentFeedbackReason,
  IAgentSessionEvent,
  IAgentVersion,
  NewAgentSessionEvent,
} from '../provider.interface';
import { AgentSessionEventSeqConflictError } from '../provider/errors';
import { findConversationSearchMatch, normalizeConversationSearch, toLikePattern } from '../provider/conversationSearch';
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
        (id, tenantId, projectId, agentKey, title, messages, metadata, createdBy, createdAt, updatedAt,
         runtimeStatus, stopReason, pendingActionIds, lastEventSeq, budget, spentUsd)
        VALUES (@id, @tenantId, @projectId, @agentKey, @title, @messages, @metadata, @createdBy, @createdAt, @updatedAt,
         @runtimeStatus, @stopReason, @pendingActionIds, @lastEventSeq, @budget, @spentUsd)
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
        runtimeStatus: conversation.runtimeStatus ?? null,
        stopReason: conversation.stopReason ?? null,
        pendingActionIds: conversation.pendingActionIds ? this.toJson(conversation.pendingActionIds) : null,
        lastEventSeq: conversation.lastEventSeq ?? null,
        budget: conversation.budget ? this.toJson(conversation.budget) : null,
        spentUsd: conversation.spentUsd ?? null,
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
      if (data.runtimeStatus !== undefined) { sets.push('runtimeStatus = @runtimeStatus'); params.runtimeStatus = data.runtimeStatus; }
      if (data.stopReason !== undefined) { sets.push('stopReason = @stopReason'); params.stopReason = data.stopReason; }
      if (data.pendingActionIds !== undefined) { sets.push('pendingActionIds = @pendingActionIds'); params.pendingActionIds = this.toJson(data.pendingActionIds); }
      if (data.lastEventSeq !== undefined) { sets.push('lastEventSeq = @lastEventSeq'); params.lastEventSeq = data.lastEventSeq; }
      if (data.budget !== undefined) { sets.push('budget = @budget'); params.budget = data.budget ? this.toJson(data.budget) : null; }
      if (data.spentUsd !== undefined) { sets.push('spentUsd = @spentUsd'); params.spentUsd = data.spentUsd; }

      db.prepare(`UPDATE ${TABLES.agentConversations} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      return this.findAgentConversationById(id);
    }

    async updateAgentConversationRuntime(
      id: string,
      patch: Partial<Pick<IAgentConversation, 'runtimeStatus' | 'stopReason' | 'pendingActionIds' | 'lastEventSeq' | 'budget' | 'spentUsd' | 'runtimeTurnId' | 'transcriptHash'>>,
      options?: { onlyIfTurn?: string },
    ): Promise<boolean> {
      const sets: string[] = [];
      const params: Record<string, unknown> = { id };
      if (patch.runtimeStatus !== undefined) { sets.push('runtimeStatus = @runtimeStatus'); params.runtimeStatus = patch.runtimeStatus; }
      if (patch.stopReason !== undefined) { sets.push('stopReason = @stopReason'); params.stopReason = patch.stopReason; }
      if (patch.pendingActionIds !== undefined) { sets.push('pendingActionIds = @pendingActionIds'); params.pendingActionIds = this.toJson(patch.pendingActionIds); }
      if (patch.lastEventSeq !== undefined) { sets.push('lastEventSeq = @lastEventSeq'); params.lastEventSeq = patch.lastEventSeq; }
      if (patch.budget !== undefined) { sets.push('budget = @budget'); params.budget = patch.budget ? this.toJson(patch.budget) : null; }
      if (patch.spentUsd !== undefined) { sets.push('spentUsd = @spentUsd'); params.spentUsd = patch.spentUsd; }
      if (patch.runtimeTurnId !== undefined) { sets.push('runtimeTurnId = @runtimeTurnId'); params.runtimeTurnId = patch.runtimeTurnId; }
      if (patch.transcriptHash !== undefined) { sets.push('transcriptHash = @transcriptHash'); params.transcriptHash = patch.transcriptHash; }
      if (sets.length === 0) return true;
      // One statement, so "is it still my turn?" and the write cannot be separated by another writer.
      let where = 'id = @id';
      if (options?.onlyIfTurn !== undefined) {
        where += ' AND (runtimeTurnId IS NULL OR runtimeTurnId = @onlyIfTurn)';
        params.onlyIfTurn = options.onlyIfTurn;
      }
      const result = this.getTenantDb().prepare(`UPDATE ${TABLES.agentConversations} SET ${sets.join(', ')} WHERE ${where}`).run(params);
      return result.changes > 0;
    }

    async addAgentConversationSpend(id: string, change: { addUsd?: number; atLeastUsd?: number }): Promise<void> {
      const addUsd = typeof change.addUsd === 'number' && Number.isFinite(change.addUsd) ? Math.max(0, change.addUsd) : 0;
      const atLeastUsd = typeof change.atLeastUsd === 'number' && Number.isFinite(change.atLeastUsd) ? Math.max(0, change.atLeastUsd) : 0;
      if (addUsd === 0 && atLeastUsd === 0) return;
      // One statement: SQLite serializes it, so concurrent spends cannot interleave a read and a write.
      this.getTenantDb().prepare(
        `UPDATE ${TABLES.agentConversations} SET spentUsd = MAX(COALESCE(spentUsd, 0), @atLeastUsd) + @addUsd WHERE id = @id`,
      ).run({ id, addUsd, atLeastUsd });
    }

    async deleteAgentConversation(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      db.prepare(`DELETE FROM ${TABLES.agentConversationStates} WHERE conversationId = @id`).run({ id });
      // The session's event log and pending approvals die with it.
      db.prepare(`DELETE FROM ${TABLES.agentSessionEvents} WHERE conversationId = @id`).run({ id });
      db.prepare(`DELETE FROM ${TABLES.agentPendingActions} WHERE conversationId = @id`).run({ id });
      db.prepare(`DELETE FROM ${TABLES.agentMessageFeedback} WHERE conversationId = @id`).run({ id });
      return db.prepare(`DELETE FROM ${TABLES.agentConversations} WHERE id = @id`).run({ id }).changes === 1;
    }

    async findAgentConversationState(conversationId: string): Promise<IAgentConversationState | null> {
      const db = this.getTenantDb();
      const row = db.prepare(
        `SELECT * FROM ${TABLES.agentConversationStates} WHERE conversationId = @conversationId`,
      ).get({ conversationId }) as SqliteRow | undefined;
      if (!row) return null;
      return {
        _id: String(row.id),
        conversationId: String(row.conversationId),
        tenantId: String(row.tenantId),
        projectId: String(row.projectId ?? ''),
        agentKey: String(row.agentKey),
        snapshot: String(row.snapshot),
        ...(row.pausedSnapshot ? { pausedSnapshot: String(row.pausedSnapshot) } : {}),
        messageCount: Number(row.messageCount) || 0,
        sizeBytes: Number(row.sizeBytes) || 0,
        createdAt: row.createdAt ? new Date(row.createdAt as string) : undefined,
        updatedAt: row.updatedAt ? new Date(row.updatedAt as string) : undefined,
      };
    }

    async saveAgentConversationState(
      state: Omit<IAgentConversationState, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<void> {
      const db = this.getTenantDb();
      const now = this.now();
      db.prepare(`
        INSERT INTO ${TABLES.agentConversationStates}
        (id, conversationId, tenantId, projectId, agentKey, snapshot, pausedSnapshot, messageCount, sizeBytes, createdAt, updatedAt)
        VALUES (@id, @conversationId, @tenantId, @projectId, @agentKey, @snapshot, @pausedSnapshot, @messageCount, @sizeBytes, @now, @now)
        ON CONFLICT(conversationId) DO UPDATE SET
          snapshot = excluded.snapshot,
          pausedSnapshot = excluded.pausedSnapshot,
          messageCount = excluded.messageCount,
          sizeBytes = excluded.sizeBytes,
          updatedAt = excluded.updatedAt
      `).run({
        id: this.newId(),
        conversationId: state.conversationId,
        tenantId: state.tenantId,
        projectId: state.projectId,
        agentKey: state.agentKey,
        snapshot: state.snapshot,
        // Null clears a paused state left by an earlier pause.
        pausedSnapshot: state.pausedSnapshot ?? null,
        messageCount: state.messageCount,
        sizeBytes: state.sizeBytes,
        now,
      });
    }

    async deleteAgentConversationState(conversationId: string): Promise<boolean> {
      const db = this.getTenantDb();
      return db.prepare(
        `DELETE FROM ${TABLES.agentConversationStates} WHERE conversationId = @conversationId`,
      ).run({ conversationId }).changes === 1;
    }

    async findAgentConversationById(id: string): Promise<IAgentConversation | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.agentConversations} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapConversation(row) : null;
    }

    async findAgentConversationByTranscriptHash(filter: {
      projectId: string;
      agentKey: string;
      createdBy: string;
      transcriptHash: string;
    }): Promise<IAgentConversation | null> {
      const row = this.getTenantDb().prepare(
        `SELECT * FROM ${TABLES.agentConversations}
         WHERE projectId = @projectId AND agentKey = @agentKey AND createdBy = @createdBy AND transcriptHash = @transcriptHash
         ORDER BY updatedAt DESC LIMIT 1`,
      ).get(filter) as SqliteRow | undefined;
      return row ? this.mapConversation(row) : null;
    }

    async listAgentConversations(
      agentKey: string,
      filters?: { projectId?: string; limit?: number; skip?: number; createdBy?: string },
    ): Promise<IAgentConversation[]> {
      const db = this.getTenantDb();
      const conditions: string[] = ['agentKey = @agentKey'];
      const params: Record<string, unknown> = { agentKey };

      if (filters?.projectId !== undefined) { conditions.push('projectId = @projectId'); params.projectId = filters.projectId; }
      if (filters?.createdBy !== undefined) { conditions.push('createdBy = @createdBy'); params.createdBy = filters.createdBy; }

      let sql = `SELECT * FROM ${TABLES.agentConversations} WHERE ${conditions.join(' AND ')} ORDER BY updatedAt DESC`;
      if (filters?.limit) sql += ` LIMIT ${filters.limit}`;
      if (filters?.skip) sql += ` OFFSET ${filters.skip}`;

      const rows = db.prepare(sql).all(params) as SqliteRow[];
      return rows.map((r) => this.mapConversation(r));
    }

    async listAgentConversationPage(filters: {
      projectId: string;
      agentKey?: string;
      runtimeStatus?: AgentSessionRuntimeStatus;
      limit: number;
      after?: { createdAt: Date; id: string };
      ownOnly?: { userId: string; viewableAgentKeys?: string[] };
    }): Promise<IAgentConversationListItem[]> {
      const db = this.getTenantDb();
      const conditions: string[] = ['projectId = @projectId'];
      const params: Record<string, unknown> = { projectId: filters.projectId, limit: filters.limit };
      if (filters.agentKey) { conditions.push('agentKey = @agentKey'); params.agentKey = filters.agentKey; }
      if (filters.ownOnly) {
        // The caller's own sessions, and every session of the agents they may view; nothing else - an agent that
        // is not named (including one that no longer exists) shows only what the caller started.
        params.ownOnlyUser = filters.ownOnly.userId;
        const keys = filters.ownOnly.viewableAgentKeys ?? [];
        if (keys.length === 0) {
          conditions.push('createdBy = @ownOnlyUser');
        } else {
          const names = keys.map((key, i) => { params[`ownOnlyKey${i}`] = key; return `@ownOnlyKey${i}`; });
          conditions.push(`(createdBy = @ownOnlyUser OR agentKey IN (${names.join(', ')}))`);
        }
      }
      if (filters.runtimeStatus === 'idle') {
        conditions.push("(runtimeStatus IS NULL OR runtimeStatus = 'idle')");
      } else if (filters.runtimeStatus) {
        conditions.push('runtimeStatus = @runtimeStatus');
        params.runtimeStatus = filters.runtimeStatus;
      }
      if (filters.after) {
        // Keyset on (createdAt, id), newest first: the rows strictly after the last one of the previous page.
        conditions.push('(createdAt < @afterCreatedAt OR (createdAt = @afterCreatedAt AND id < @afterId))');
        params.afterCreatedAt = filters.after.createdAt.toISOString();
        params.afterId = filters.after.id;
      }
      // No `messages` column: the transcript is the heavy part, and a list only needs how many there are.
      const rows = db.prepare(`
        SELECT id, tenantId, projectId, agentKey, title, metadata, createdBy, createdAt, updatedAt,
               runtimeStatus, stopReason, pendingActionIds, lastEventSeq, budget, spentUsd,
               json_array_length(messages) AS messageCount
        FROM ${TABLES.agentConversations}
        WHERE ${conditions.join(' AND ')}
        ORDER BY createdAt DESC, id DESC
        LIMIT @limit
      `).all(params) as SqliteRow[];
      return rows.map((row) => {
        const { messages: _messages, ...conversation } = this.mapConversation(row);
        void _messages;
        return { ...conversation, messageCount: Number(row.messageCount ?? 0) };
      });
    }

    async searchAgentConversations(filters: {
      projectId: string;
      search: string;
      agentKeys?: string[];
      createdBy?: string;
      limit?: number;
      skip?: number;
    }): Promise<IAgentConversationSearchHit[]> {
      const needle = normalizeConversationSearch(filters.search);
      if (!needle || filters.agentKeys?.length === 0) return [];
      const db = this.getTenantDb();
      const conditions: string[] = ['projectId = @projectId'];
      const params: Record<string, unknown> = {
        projectId: filters.projectId,
        pattern: toLikePattern(needle),
        limit: Math.max(1, Math.floor(filters.limit ?? 20)),
        offset: Math.max(0, Math.floor(filters.skip ?? 0)),
      };
      if (filters.agentKeys) {
        const names = filters.agentKeys.map((key, i) => { params[`agentKey${i}`] = key; return `@agentKey${i}`; });
        conditions.push(`agentKey IN (${names.join(', ')})`);
      }
      if (filters.createdBy !== undefined) { conditions.push('createdBy = @createdBy'); params.createdBy = filters.createdBy; }
      // The needle is only ever a bound LIKE pattern (its % _ \ escaped); message text is read out of the JSON
      // transcript, so keys and escape sequences of the JSON itself never match.
      conditions.push(`(title LIKE @pattern ESCAPE '\\' OR EXISTS (
        SELECT 1 FROM json_each(${TABLES.agentConversations}.messages)
        WHERE json_extract(json_each.value, '$.content') LIKE @pattern ESCAPE '\\'))`);
      const rows = db.prepare(`
        SELECT * FROM ${TABLES.agentConversations}
        WHERE ${conditions.join(' AND ')}
        ORDER BY updatedAt DESC, id DESC
        LIMIT @limit OFFSET @offset
      `).all(params) as SqliteRow[];
      return rows.map((row) => {
        const { messages, ...conversation } = this.mapConversation(row);
        const searchMatch = findConversationSearchMatch(conversation.title, messages, needle);
        return { ...conversation, messageCount: messages.length, ...(searchMatch ? { searchMatch } : {}) };
      });
    }

    // ── Agent session event log ──────────────────────────────────

    async appendAgentSessionEvents(events: NewAgentSessionEvent[]): Promise<void> {
      if (events.length === 0) return;
      const db = this.getTenantDb();
      const insert = db.prepare(`
        INSERT INTO ${TABLES.agentSessionEvents}
        (id, tenantId, projectId, agentKey, conversationId, seq, type, data, runId, createdAt, expiresAt)
        VALUES (@id, @tenantId, @projectId, @agentKey, @conversationId, @seq, @type, @data, @runId, @createdAt, @expiresAt)
      `);
      // One transaction: a conflicting seq keeps nothing of the batch.
      const run = db.transaction(() => {
        for (const event of events) {
          insert.run({
            id: event._id ?? `sevt_${this.newId().replace(/-/g, '').slice(0, 24)}`,
            tenantId: event.tenantId,
            projectId: event.projectId,
            agentKey: event.agentKey,
            conversationId: event.conversationId,
            seq: event.seq,
            type: event.type,
            data: this.toJson(event.data ?? {}),
            runId: event.runId ?? null,
            createdAt: new Date(event.createdAt).toISOString(),
            expiresAt: new Date(event.expiresAt).toISOString(),
          });
        }
      });
      try {
        run();
      } catch (error) {
        if ((error as { code?: string } | null)?.code === 'SQLITE_CONSTRAINT_UNIQUE'
          || (error as { code?: string } | null)?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
          throw new AgentSessionEventSeqConflictError(events[0].conversationId);
        }
        throw error;
      }
    }

    async listAgentSessionEvents(
      conversationId: string,
      options?: { afterSeq?: number; types?: string[]; limit?: number; runId?: string },
    ): Promise<IAgentSessionEvent[]> {
      const db = this.getTenantDb();
      const conditions = ['conversationId = @conversationId'];
      const params: Record<string, unknown> = { conversationId };
      if (options?.runId) {
        conditions.push('runId = @runId');
        params.runId = options.runId;
      }
      if (options?.afterSeq !== undefined && options.afterSeq > 0) {
        conditions.push('seq > @afterSeq');
        params.afterSeq = options.afterSeq;
      }
      if (options?.types && options.types.length > 0) {
        const names = options.types.map((_, i) => `@type${i}`);
        options.types.forEach((t, i) => { params[`type${i}`] = t; });
        conditions.push(`type IN (${names.join(', ')})`);
      }
      let sql = `SELECT * FROM ${TABLES.agentSessionEvents} WHERE ${conditions.join(' AND ')} ORDER BY seq ASC`;
      if (options?.limit) sql += ` LIMIT ${Math.max(1, Math.floor(options.limit))}`;
      const rows = db.prepare(sql).all(params) as SqliteRow[];
      return rows.map((row) => ({
        _id: String(row.id),
        tenantId: String(row.tenantId),
        projectId: String(row.projectId ?? ''),
        agentKey: String(row.agentKey),
        conversationId: String(row.conversationId),
        seq: Number(row.seq),
        type: String(row.type),
        data: this.parseJson<Record<string, unknown>>(row.data, {}),
        ...(row.runId ? { runId: String(row.runId) } : {}),
        createdAt: new Date(row.createdAt as string),
        expiresAt: new Date(row.expiresAt as string),
      }));
    }

    async getAgentSessionMaxSeq(conversationId: string): Promise<number> {
      const db = this.getTenantDb();
      const row = db.prepare(
        `SELECT MAX(seq) AS maxSeq FROM ${TABLES.agentSessionEvents} WHERE conversationId = @conversationId`,
      ).get({ conversationId }) as { maxSeq: number | null } | undefined;
      return Number(row?.maxSeq ?? 0) || 0;
    }

    async deleteAgentSessionEvents(conversationId: string): Promise<number> {
      const db = this.getTenantDb();
      return db.prepare(`DELETE FROM ${TABLES.agentSessionEvents} WHERE conversationId = @conversationId`).run({ conversationId }).changes;
    }

    async cleanupAgentSessionEventRetention(options: { olderThan: Date; batchSize?: number }): Promise<{ deletedCount: number }> {
      const db = this.getTenantDb();
      const params: Record<string, unknown> = { olderThan: options.olderThan.toISOString() };
      const batched = Boolean(options.batchSize && options.batchSize > 0);
      const sql = batched
        ? `DELETE FROM ${TABLES.agentSessionEvents} WHERE id IN (SELECT id FROM ${TABLES.agentSessionEvents} WHERE expiresAt < @olderThan LIMIT @batchSize)`
        : `DELETE FROM ${TABLES.agentSessionEvents} WHERE expiresAt < @olderThan`;
      return { deletedCount: db.prepare(sql).run(batched ? { ...params, batchSize: options.batchSize } : params).changes };
    }

    // ── Agent pending actions ────────────────────────────────────

    async createAgentPendingActions(
      actions: Array<Omit<IAgentPendingAction, '_id'>>,
    ): Promise<IAgentPendingAction[]> {
      if (actions.length === 0) return [];
      const db = this.getTenantDb();
      const insert = db.prepare(`
        INSERT INTO ${TABLES.agentPendingActions}
        (id, tenantId, projectId, agentKey, conversationId, runId, kind, sdkId, toolCallId, toolName, args, questions,
         allowFreeText, status, requestedAt, expiresAt, resolvedAt, resolvedBy, resolution, agentVersion, usePublished, createdBy,
         clientTool)
        VALUES (@id, @tenantId, @projectId, @agentKey, @conversationId, @runId, @kind, @sdkId, @toolCallId, @toolName, @args,
         @questions, @allowFreeText, @status, @requestedAt, @expiresAt, @resolvedAt, @resolvedBy, @resolution, @agentVersion,
         @usePublished, @createdBy, @clientTool)
      `);
      const created: IAgentPendingAction[] = actions.map((action) => ({
        ...action,
        _id: `act_${this.newId().replace(/-/g, '').slice(0, 24)}`,
      }));
      db.transaction(() => {
        for (const action of created) {
          insert.run({
            id: action._id,
            tenantId: action.tenantId,
            projectId: action.projectId,
            agentKey: action.agentKey,
            conversationId: action.conversationId,
            runId: action.runId ?? null,
            kind: action.kind,
            sdkId: action.sdkId,
            toolCallId: action.toolCallId ?? null,
            toolName: action.toolName ?? null,
            args: action.args === undefined ? null : this.toJson(action.args),
            questions: action.questions ? this.toJson(action.questions) : null,
            allowFreeText: action.allowFreeText === undefined ? null : action.allowFreeText ? 1 : 0,
            status: action.status,
            requestedAt: new Date(action.requestedAt).toISOString(),
            expiresAt: action.expiresAt ? new Date(action.expiresAt).toISOString() : null,
            resolvedAt: action.resolvedAt ? new Date(action.resolvedAt).toISOString() : null,
            resolvedBy: action.resolvedBy ?? null,
            resolution: action.resolution ? this.toJson(action.resolution) : null,
            agentVersion: action.agentVersion ?? null,
            usePublished: action.usePublished === undefined ? null : action.usePublished ? 1 : 0,
            createdBy: action.createdBy ?? null,
            clientTool: action.clientTool ? this.toJson(action.clientTool) : null,
          });
        }
      })();
      return created;
    }

    async findAgentPendingActionById(id: string): Promise<IAgentPendingAction | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.agentPendingActions} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapPendingAction(row) : null;
    }

    async listAgentPendingActions(
      conversationId: string,
      options?: { status?: IAgentPendingAction['status'] },
    ): Promise<IAgentPendingAction[]> {
      const db = this.getTenantDb();
      const params: Record<string, unknown> = { conversationId };
      let sql = `SELECT * FROM ${TABLES.agentPendingActions} WHERE conversationId = @conversationId`;
      if (options?.status) { sql += ' AND status = @status'; params.status = options.status; }
      sql += ' ORDER BY requestedAt ASC, rowid ASC';
      return (db.prepare(sql).all(params) as SqliteRow[]).map((row) => this.mapPendingAction(row));
    }

    async updateAgentPendingAction(
      id: string,
      data: Partial<Omit<IAgentPendingAction, '_id' | 'tenantId' | 'projectId' | 'conversationId'>>,
      options?: { onlyIfStatus?: IAgentPendingAction['status'] },
    ): Promise<IAgentPendingAction | null> {
      const db = this.getTenantDb();
      const sets: string[] = [];
      const params: Record<string, unknown> = { id, onlyIfStatus: options?.onlyIfStatus ?? 'pending' };
      const scalar = ['status', 'resolvedBy', 'toolName', 'toolCallId', 'sdkId', 'runId', 'createdBy'] as const;
      for (const field of scalar) {
        if (data[field] !== undefined) { sets.push(`${field} = @${field}`); params[field] = data[field]; }
      }
      for (const field of ['requestedAt', 'expiresAt', 'resolvedAt'] as const) {
        if (data[field] !== undefined) {
          sets.push(`${field} = @${field}`);
          params[field] = data[field] ? new Date(data[field] as Date).toISOString() : null;
        }
      }
      for (const field of ['args', 'questions', 'resolution'] as const) {
        if (data[field] !== undefined) { sets.push(`${field} = @${field}`); params[field] = data[field] === null ? null : this.toJson(data[field]); }
      }
      if (data.agentVersion !== undefined) { sets.push('agentVersion = @agentVersion'); params.agentVersion = data.agentVersion; }
      for (const field of ['allowFreeText', 'usePublished'] as const) {
        if (data[field] !== undefined) { sets.push(`${field} = @${field}`); params[field] = data[field] ? 1 : 0; }
      }
      if (sets.length === 0) return this.findAgentPendingActionById(id);
      const result = db.prepare(
        `UPDATE ${TABLES.agentPendingActions} SET ${sets.join(', ')} WHERE id = @id AND status = @onlyIfStatus`,
      ).run(params);
      if (result.changes === 0) return null;
      return this.findAgentPendingActionById(id);
    }

    async listExpiredAgentPendingActions(now: Date, limit = 100): Promise<IAgentPendingAction[]> {
      const db = this.getTenantDb();
      const rows = db.prepare(
        `SELECT * FROM ${TABLES.agentPendingActions}
         WHERE status = 'pending' AND expiresAt IS NOT NULL AND expiresAt < @now
         ORDER BY expiresAt ASC LIMIT @limit`,
      ).all({ now: now.toISOString(), limit }) as SqliteRow[];
      return rows.map((row) => this.mapPendingAction(row));
    }

    async deleteAgentPendingActions(conversationId: string): Promise<number> {
      const db = this.getTenantDb();
      return db.prepare(`DELETE FROM ${TABLES.agentPendingActions} WHERE conversationId = @conversationId`).run({ conversationId }).changes;
    }

    // ── Message feedback ─────────────────────────────────────────

    async upsertAgentMessageFeedback(
      feedback: Omit<IAgentMessageFeedback, '_id' | 'createdAt' | 'updatedAt' | 'removedAt'>,
    ): Promise<{ feedback: IAgentMessageFeedback; created: boolean }> {
      const db = this.getTenantDb();
      const now = this.now();
      const params = {
        id: `fb_${this.newId().replace(/-/g, '').slice(0, 24)}`,
        tenantId: feedback.tenantId,
        projectId: feedback.projectId,
        agentKey: feedback.agentKey,
        agentVersion: feedback.agentVersion ?? null,
        conversationId: feedback.conversationId,
        messageId: feedback.messageId,
        messageIndex: feedback.messageIndex,
        userId: feedback.userId,
        channel: feedback.channel,
        portalId: feedback.portalId ?? null,
        rating: feedback.rating,
        reasons: this.toJson(feedback.reasons ?? []),
        comment: feedback.comment ?? null,
        now,
      };
      const existed = db.prepare(
        `SELECT 1 FROM ${TABLES.agentMessageFeedback} WHERE conversationId = @conversationId AND messageId = @messageId AND userId = @userId`,
      ).get(params) !== undefined;
      // A replacement keeps its id and createdAt and is live again (a cleared `removedAt`).
      db.prepare(`
        INSERT INTO ${TABLES.agentMessageFeedback}
        (id, tenantId, projectId, agentKey, agentVersion, conversationId, messageId, messageIndex, userId, channel,
         portalId, rating, reasons, comment, removedAt, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @agentKey, @agentVersion, @conversationId, @messageId, @messageIndex, @userId,
         @channel, @portalId, @rating, @reasons, @comment, NULL, @now, @now)
        ON CONFLICT(conversationId, messageId, userId) DO UPDATE SET
          agentVersion = excluded.agentVersion,
          messageIndex = excluded.messageIndex,
          channel = excluded.channel,
          portalId = excluded.portalId,
          rating = excluded.rating,
          reasons = excluded.reasons,
          comment = excluded.comment,
          removedAt = NULL,
          updatedAt = excluded.updatedAt
      `).run(params);
      const stored = (await this.findAgentMessageFeedback(feedback.conversationId, feedback.messageId, feedback.userId))!;
      return { feedback: stored, created: !existed };
    }

    async findAgentMessageFeedback(conversationId: string, messageId: string, userId: string): Promise<IAgentMessageFeedback | null> {
      const row = this.getTenantDb().prepare(
        `SELECT * FROM ${TABLES.agentMessageFeedback} WHERE conversationId = @conversationId AND messageId = @messageId AND userId = @userId`,
      ).get({ conversationId, messageId, userId }) as SqliteRow | undefined;
      return row ? this.mapMessageFeedback(row) : null;
    }

    async deleteAgentMessageFeedback(conversationId: string, messageId: string, userId: string): Promise<boolean> {
      return this.getTenantDb().prepare(
        `DELETE FROM ${TABLES.agentMessageFeedback} WHERE conversationId = @conversationId AND messageId = @messageId AND userId = @userId`,
      ).run({ conversationId, messageId, userId }).changes > 0;
    }

    async listAgentMessageFeedbackByConversation(conversationId: string, options?: { userId?: string }): Promise<IAgentMessageFeedback[]> {
      const params: Record<string, unknown> = { conversationId };
      let sql = `SELECT * FROM ${TABLES.agentMessageFeedback} WHERE conversationId = @conversationId`;
      if (options?.userId) { sql += ' AND userId = @userId'; params.userId = options.userId; }
      sql += ' ORDER BY messageIndex ASC, createdAt ASC, rowid ASC';
      return (this.getTenantDb().prepare(sql).all(params) as SqliteRow[]).map((row) => this.mapMessageFeedback(row));
    }

    async listAgentMessageFeedback(
      filter: AgentMessageFeedbackFilter,
      options?: { limit?: number; skip?: number },
    ): Promise<{ items: IAgentMessageFeedback[]; total: number }> {
      const db = this.getTenantDb();
      const { where, params } = this.feedbackWhere(filter);
      const total = Number((db.prepare(`SELECT COUNT(*) AS cnt FROM ${TABLES.agentMessageFeedback} ${where}`).get(params) as SqliteRow).cnt) || 0;
      const limit = Math.max(1, Math.min(options?.limit ?? 50, 200));
      const skip = Math.max(0, options?.skip ?? 0);
      const rows = db.prepare(
        `SELECT * FROM ${TABLES.agentMessageFeedback} ${where} ORDER BY createdAt DESC, rowid DESC LIMIT @limit OFFSET @skip`,
      ).all({ ...params, limit, skip }) as SqliteRow[];
      return { items: rows.map((row) => this.mapMessageFeedback(row)), total };
    }

    async aggregateAgentMessageFeedback(filter: AgentMessageFeedbackFilter): Promise<AgentMessageFeedbackTotals> {
      const db = this.getTenantDb();
      const { where, params } = this.feedbackWhere(filter);
      const counts = db.prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN rating = 'up' THEN 1 ELSE 0 END), 0) AS up,
           COALESCE(SUM(CASE WHEN rating = 'down' THEN 1 ELSE 0 END), 0) AS down,
           COALESCE(SUM(CASE WHEN comment IS NOT NULL AND comment <> '' THEN 1 ELSE 0 END), 0) AS withComment
         FROM ${TABLES.agentMessageFeedback} ${where}`,
      ).get(params) as SqliteRow;
      const reasonRows = db.prepare(
        `SELECT j.value AS reason, COUNT(*) AS cnt
         FROM (SELECT reasons FROM ${TABLES.agentMessageFeedback} ${where}) AS f, json_each(f.reasons) AS j
         GROUP BY j.value`,
      ).all(params) as SqliteRow[];
      const reasons: Partial<Record<AgentFeedbackReason, number>> = {};
      for (const row of reasonRows) reasons[String(row.reason) as AgentFeedbackReason] = Number(row.cnt) || 0;
      return { up: Number(counts.up) || 0, down: Number(counts.down) || 0, withComment: Number(counts.withComment) || 0, reasons };
    }

    async markAgentMessageFeedbackRemoved(conversationId: string, fromIndex: number, at: Date = new Date()): Promise<number> {
      return this.getTenantDb().prepare(
        `UPDATE ${TABLES.agentMessageFeedback} SET removedAt = @at
         WHERE conversationId = @conversationId AND messageIndex >= @fromIndex AND removedAt IS NULL`,
      ).run({ conversationId, fromIndex, at: at.toISOString() }).changes;
    }

    async deleteAgentMessageFeedbackByConversation(conversationId: string): Promise<number> {
      return this.getTenantDb().prepare(
        `DELETE FROM ${TABLES.agentMessageFeedback} WHERE conversationId = @conversationId`,
      ).run({ conversationId }).changes;
    }

    // ── Private helpers ──────────────────────────────────────────

    private feedbackWhere(filter: AgentMessageFeedbackFilter): { where: string; params: Record<string, unknown> } {
      const clauses = ['projectId = @projectId', 'agentKey = @agentKey'];
      const params: Record<string, unknown> = { projectId: filter.projectId, agentKey: filter.agentKey };
      if (filter.rating) { clauses.push('rating = @rating'); params.rating = filter.rating; }
      if (filter.portalId) { clauses.push('portalId = @portalId'); params.portalId = filter.portalId; }
      if (filter.reason) {
        clauses.push('EXISTS (SELECT 1 FROM json_each(reasons) WHERE value = @reason)');
        params.reason = filter.reason;
      }
      if (filter.hasComment) clauses.push("comment IS NOT NULL AND comment <> ''");
      if (filter.from) { clauses.push('createdAt >= @from'); params.from = filter.from.toISOString(); }
      if (filter.to) { clauses.push('createdAt <= @to'); params.to = filter.to.toISOString(); }
      return { where: `WHERE ${clauses.join(' AND ')}`, params };
    }

    private mapMessageFeedback(row: SqliteRow): IAgentMessageFeedback {
      return {
        _id: String(row.id),
        tenantId: String(row.tenantId),
        projectId: String(row.projectId ?? ''),
        agentKey: String(row.agentKey),
        agentVersion: row.agentVersion === null || row.agentVersion === undefined ? null : Number(row.agentVersion),
        conversationId: String(row.conversationId),
        messageId: String(row.messageId),
        messageIndex: Number(row.messageIndex) || 0,
        userId: String(row.userId),
        channel: String(row.channel),
        ...(row.portalId ? { portalId: String(row.portalId) } : {}),
        rating: String(row.rating) as IAgentMessageFeedback['rating'],
        reasons: this.parseJson<AgentFeedbackReason[]>(row.reasons, []),
        ...(row.comment ? { comment: String(row.comment) } : {}),
        removedAt: row.removedAt ? new Date(row.removedAt as string) : null,
        createdAt: new Date(row.createdAt as string),
        updatedAt: new Date(row.updatedAt as string),
      };
    }

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

    private mapPendingAction(row: SqliteRow): IAgentPendingAction {
      return {
        _id: String(row.id),
        tenantId: String(row.tenantId),
        projectId: String(row.projectId ?? ''),
        agentKey: String(row.agentKey),
        conversationId: String(row.conversationId),
        ...(row.runId ? { runId: String(row.runId) } : {}),
        kind: String(row.kind) as IAgentPendingAction['kind'],
        sdkId: String(row.sdkId),
        ...(row.toolCallId ? { toolCallId: String(row.toolCallId) } : {}),
        ...(row.toolName ? { toolName: String(row.toolName) } : {}),
        ...(row.args !== null && row.args !== undefined ? { args: this.parseJson<unknown>(row.args, undefined) } : {}),
        ...(row.questions ? { questions: this.parseJson<IAgentPendingAction['questions']>(row.questions, []) } : {}),
        ...(row.allowFreeText !== null && row.allowFreeText !== undefined ? { allowFreeText: Number(row.allowFreeText) === 1 } : {}),
        status: String(row.status) as IAgentPendingAction['status'],
        requestedAt: new Date(row.requestedAt as string),
        expiresAt: row.expiresAt ? new Date(row.expiresAt as string) : null,
        resolvedAt: row.resolvedAt ? new Date(row.resolvedAt as string) : null,
        ...(row.resolvedBy ? { resolvedBy: String(row.resolvedBy) } : {}),
        ...(row.resolution ? { resolution: this.parseJson<IAgentPendingAction['resolution']>(row.resolution, {}) } : {}),
        agentVersion: row.agentVersion === null || row.agentVersion === undefined ? null : Number(row.agentVersion),
        ...(row.usePublished !== null && row.usePublished !== undefined ? { usePublished: Number(row.usePublished) === 1 } : {}),
        ...(row.createdBy ? { createdBy: String(row.createdBy) } : {}),
        ...(row.clientTool ? { clientTool: this.parseJson<NonNullable<IAgentPendingAction['clientTool']>>(row.clientTool, { timeoutSeconds: 60 }) } : {}),
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
        ...(row.runtimeStatus ? { runtimeStatus: String(row.runtimeStatus) as IAgentConversation['runtimeStatus'] } : {}),
        ...(row.stopReason ? { stopReason: String(row.stopReason) as IAgentConversation['stopReason'] } : {}),
        ...(row.pendingActionIds ? { pendingActionIds: this.parseJson<string[]>(row.pendingActionIds, []) } : {}),
        ...(row.lastEventSeq !== null && row.lastEventSeq !== undefined ? { lastEventSeq: Number(row.lastEventSeq) } : {}),
        ...(row.budget ? { budget: this.parseJson<IAgentConversation['budget']>(row.budget, null) } : {}),
        ...(row.spentUsd !== null && row.spentUsd !== undefined ? { spentUsd: Number(row.spentUsd) } : {}),
        ...(row.transcriptHash ? { transcriptHash: String(row.transcriptHash) } : {}),
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
