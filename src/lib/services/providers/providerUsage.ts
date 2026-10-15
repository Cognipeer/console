import { getDatabase } from '@/lib/database';
import type { IAgent, IModel, IProviderRecord } from '@/lib/database';

export interface ProviderUsageProject {
  projectId: string;
  name: string;
  /** The provider is assigned to this project. Only assigned projects carry models and agents. */
  assigned: boolean;
  /** Models of this project that run on the provider. */
  models: Array<{ id: string; name: string }>;
  /** Agents of this project that use one of those models. */
  agents: Array<{ id: string; name: string }>;
  /** Requests of those models over the last 7 days. */
  requests7d?: number;
  /** Last day (UTC, `YYYY-MM-DD`) within the 7 days on which they were used. */
  lastUsedAt?: string;
}

export interface ProviderUsage {
  projects: ProviderUsageProject[];
}

const WINDOW_DAYS = 7;
/** One read covers the window; a tenant that outgrows it gets a lower bound, never a failure. */
const USAGE_ROW_LIMIT = 20_000;

function dayString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Projects the provider is assigned to (the legacy single `projectId` and the `projectIds` list). */
export function assignedProjectIds(record: Pick<IProviderRecord, 'projectId' | 'projectIds'>): string[] {
  const ids = [...(record.projectId ? [record.projectId] : []), ...(record.projectIds ?? [])].map(String);
  return [...new Set(ids)];
}

/** A model runs on the provider as its main deployment or as one of its replicas. */
function usesProvider(model: IModel, providerKey: string): boolean {
  if (model.providerKey === providerKey) return true;
  return (model.replicas ?? []).some((replica) => replica.providerKey === providerKey);
}

function agentModelKeys(agent: IAgent): string[] {
  const config = agent.config ?? {};
  return [
    ...(config.modelKey ? [config.modelKey] : []),
    ...(config.additionalModels ?? []).map((entry) => entry.modelKey),
  ];
}

/**
 * What would stop working if the provider were unassigned from a project: per project, the models
 * that run on it and the agents that use those models, plus the models' traffic of the last week.
 *
 * Tenant-wide reads, grouped in memory (a tenant has fewer than a hundred projects): a read per
 * project would multiply the round trips on Cosmos.
 */
export async function getProviderUsage(
  tenantDbName: string,
  tenantId: string,
  record: Pick<IProviderRecord, 'key' | 'projectId' | 'projectIds'>,
  now: Date = new Date(),
): Promise<ProviderUsage> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);

  const assigned = new Set(assignedProjectIds(record));
  const projects = await db.listProjects(tenantId);

  const rows: ProviderUsageProject[] = projects.map((project) => ({
    projectId: String(project._id),
    name: project.name,
    assigned: assigned.has(String(project._id)),
    models: [],
    agents: [],
  }));
  const byProject = new Map(rows.map((row) => [row.projectId, row]));

  if (assigned.size > 0) {
    const models = (await db.listModels()).filter(
      (model) => model.projectId && assigned.has(String(model.projectId)) && usesProvider(model, record.key),
    );

    // project -> keys of its models on this provider
    const modelKeys = new Map<string, Set<string>>();
    for (const model of models) {
      const projectId = String(model.projectId);
      byProject.get(projectId)?.models.push({ id: String(model._id), name: model.name });
      if (!modelKeys.has(projectId)) modelKeys.set(projectId, new Set());
      modelKeys.get(projectId)!.add(model.key);
    }

    if (models.length > 0) {
      const agents = await db.listAgents();
      for (const agent of agents) {
        const projectId = String(agent.projectId);
        const keys = modelKeys.get(projectId);
        if (!keys || !agentModelKeys(agent).some((key) => keys.has(key))) continue;
        byProject.get(projectId)?.agents.push({ id: String(agent._id), name: agent.name });
      }

      const fromDay = dayString(new Date(now.getTime() - (WINDOW_DAYS - 1) * 86_400_000));
      const usage = await db.listUsageDaily({
        service: 'models',
        fromDay,
        toDay: dayString(now),
        limit: USAGE_ROW_LIMIT,
      });
      for (const row of usage) {
        const projectId = String(row.projectId);
        if (!modelKeys.get(projectId)?.has(row.refKey)) continue;
        const target = byProject.get(projectId);
        if (!target) continue;
        target.requests7d = (target.requests7d ?? 0) + (row.requests ?? 0);
        if (!target.lastUsedAt || row.day > target.lastUsedAt) target.lastUsedAt = row.day;
      }
      // A project with models has a count, zero when nothing ran.
      for (const [projectId] of modelKeys) {
        const target = byProject.get(projectId);
        if (target && target.requests7d === undefined) target.requests7d = 0;
      }
    }
  }

  // Assigned projects first, each group by name.
  rows.sort((a, b) => Number(b.assigned) - Number(a.assigned) || a.name.localeCompare(b.name));
  return { projects: rows };
}
