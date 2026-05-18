/**
 * Cluster Admin Service
 *
 * Aggregates the data the Cluster UI needs: node registry + a single
 * "assignable instances" list across all tenants and entity types,
 * each annotated with its current node assignment (or the resolved
 * default).
 *
 * Cross-tenant iteration is unavoidable here — assignments are global
 * to the cluster but instance records live per-tenant. The volume is
 * modest (the UI page is tens to a few hundred rows) so a naive scan
 * is fine.
 */

import { createLogger } from '@/lib/core/logger';
import {
  findClusterNode,
  listClusterNodes,
  listInstanceAssignments,
  resolveDefaultNodeName,
  setInstanceAssignment,
  deleteInstanceAssignment,
  type IInstanceAssignment,
  type INodeRecord,
  type InstanceEntityType,
  type InstanceAssignmentMode,
} from '@/lib/core/cluster';
import { getDatabase, getTenantDatabase, type ITenant } from '@/lib/database';
import { agentEntityId } from '@/lib/services/agents/agentEntityId';
import { mcpEntityId } from '@/lib/services/mcp/mcpEntityId';
import { jsSandboxEntityId } from '@/lib/services/jsSandbox/entityId';
import { browserEntityId } from '@/lib/services/browser/entityId';

const log = createLogger('cluster.admin');

export interface AssignableInstance {
  entityType: InstanceEntityType;
  entityId: string;
  /** Display name for the UI. */
  name: string;
  /** Human-readable extra context (slug, project, etc.). */
  subtitle?: string;
  tenantId: string;
  tenantSlug: string;
  projectId?: string | null;
  nodeName: string;
  mode: InstanceAssignmentMode;
  /** True when the binding is explicit; false when falling back to default. */
  explicit: boolean;
}

export interface ClusterOverview {
  thisNodeName: string;
  defaultNodeName: string;
  nodes: INodeRecord[];
  assignments: IInstanceAssignment[];
}

export async function getClusterOverview(): Promise<ClusterOverview> {
  const [nodes, assignments, defaultNodeName] = await Promise.all([
    listClusterNodes(),
    listInstanceAssignments(),
    resolveDefaultNodeName(),
  ]);
  // We avoid importing nodeRegistry just for the name — use the default
  // resolver, which falls back to this node's name when no node is online.
  return {
    thisNodeName: defaultNodeName,
    defaultNodeName,
    nodes,
    assignments,
  };
}

export async function listAssignableInstances(): Promise<AssignableInstance[]> {
  const defaultNodeName = await resolveDefaultNodeName();
  const assignments = await listInstanceAssignments();
  const assignmentIndex = new Map<string, IInstanceAssignment>();
  for (const a of assignments) {
    assignmentIndex.set(`${a.entityType}:${a.entityId}`, a);
  }

  const mainDb = await getDatabase();
  const tenants = await mainDb.listTenants();
  const out: AssignableInstance[] = [];

  for (const tenant of tenants) {
    if (!tenant.dbName) continue;
    try {
      await collectTenant(tenant, assignmentIndex, defaultNodeName, out);
    } catch (error) {
      log.warn('Failed to collect assignable instances for tenant', {
        tenantSlug: tenant.slug,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  out.sort((a, b) => {
    if (a.entityType !== b.entityType) return a.entityType.localeCompare(b.entityType);
    return a.name.localeCompare(b.name);
  });
  return out;
}

async function collectTenant(
  tenant: ITenant,
  assignmentIndex: Map<string, IInstanceAssignment>,
  defaultNodeName: string,
  out: AssignableInstance[],
): Promise<void> {
  const db = await getTenantDatabase(tenant.dbName);
  const tenantId = String(tenant._id);

  const pushItem = (item: Omit<AssignableInstance, 'nodeName' | 'mode' | 'explicit'>) => {
    const key = `${item.entityType}:${item.entityId}`;
    const assignment = assignmentIndex.get(key);
    out.push({
      ...item,
      nodeName: assignment?.nodeName ?? defaultNodeName,
      mode: assignment?.mode ?? 'preferred',
      explicit: Boolean(assignment),
    });
  };

  const [agents, mcpServers, jsRuntimes, browsers, inferenceServers, alertRules] =
    await Promise.all([
      db.listAgents().catch(() => []),
      db.listMcpServers().catch(() => []),
      db.listJsSandboxRuntimes(tenantId).catch(() => []),
      db.listBrowsers(tenantId).catch(() => []),
      db.listInferenceServers(tenantId).catch(() => []),
      db.listAlertRules(tenantId).catch(() => []),
    ]);

  for (const a of agents) {
    pushItem({
      entityType: 'agent',
      entityId: agentEntityId(tenantId, a.key),
      name: a.name,
      subtitle: a.key,
      tenantId,
      tenantSlug: tenant.slug,
      projectId: a.projectId ?? null,
    });
  }

  for (const s of mcpServers) {
    pushItem({
      entityType: 'mcp',
      entityId: mcpEntityId(tenantId, s.key),
      name: s.name,
      subtitle: s.key,
      tenantId,
      tenantSlug: tenant.slug,
      projectId: s.projectId ?? null,
    });
  }

  for (const r of jsRuntimes) {
    pushItem({
      entityType: 'js-sandbox',
      entityId: jsSandboxEntityId(tenantId, r.key),
      name: r.name,
      subtitle: r.key,
      tenantId,
      tenantSlug: tenant.slug,
      projectId: r.projectId ?? null,
    });
  }

  for (const b of browsers) {
    pushItem({
      entityType: 'browser',
      entityId: browserEntityId(tenantId, String(b._id ?? '')),
      name: b.name,
      subtitle: b.key,
      tenantId,
      tenantSlug: tenant.slug,
      projectId: b.projectId ?? null,
    });
  }

  for (const s of inferenceServers) {
    pushItem({
      entityType: 'inference-server',
      entityId: `${tenantId}:${s.key}`,
      name: s.name,
      subtitle: s.key,
      tenantId,
      tenantSlug: tenant.slug,
    });
  }

  for (const r of alertRules) {
    const ruleId = String(r._id ?? '');
    if (!ruleId) continue;
    pushItem({
      entityType: 'alert-rule',
      entityId: `${tenantId}:${ruleId}`,
      name: r.name,
      tenantId,
      tenantSlug: tenant.slug,
      projectId: r.projectId ?? null,
    });
  }
}

export async function assignInstance(input: {
  entityType: InstanceEntityType;
  entityId: string;
  nodeName: string;
  mode?: InstanceAssignmentMode;
  updatedBy?: string | null;
}): Promise<IInstanceAssignment> {
  const target = await findClusterNode(input.nodeName);
  if (!target) {
    throw new Error(`Node "${input.nodeName}" not found in cluster registry`);
  }
  return setInstanceAssignment(input);
}

export async function unassignInstance(
  entityType: InstanceEntityType,
  entityId: string,
): Promise<boolean> {
  return deleteInstanceAssignment(entityType, entityId);
}
