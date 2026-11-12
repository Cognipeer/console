import { createLogger } from '@/lib/core/logger';
import { getDatabase } from '@/lib/database';
import type { DatabaseProvider, IMcpServer, IMcpTool } from '@/lib/database';
import { normalizeMcpInstructions } from './discovery';
import { defaultAnnotationsForSource } from './toolAnnotations';
import type { InternalMcpProvider } from './internal/types';
import { allocateExposedNames, assertMemberUsable, defaultMemberPrefix, getCompositeConfig, getCompositeMemberSummaries, MAX_COMPOSITE_MEMBER_TOOLS, metadataWithComposite, type CompositeSelfRef, type CompositeToolEntry, type IMcpCompositeMemberConfig, type IMcpCompositeMemberSummary } from './composite';
import { forgetLastErrorWrite, lastErrorRecord } from './requestLog';
import { resolveSourceType, tokenOnlyProviderOf } from './serverView';
import { listEnabledMcpTools, metadataWithInstructions, resolveMcpInstructions } from './toolOverrides';

const logger = createLogger('mcp-service');

// ── Composite servers ──────────────────────────────────────────────────────
// A composite republishes tools from other MCP servers on the same tenant.
// Its `tools[]` is a *materialized snapshot*, not a live join — the five
// protocol surfaces that read `server.tools` (tools/list, client v1, public
// MCP, agent bindings, the EE Hub catalog) all stay synchronous. The
// snapshot is rebuilt here and re-persisted whenever the composite's own
// member list changes (create/update) or a member changes underneath it
// (`reconcileCompositesForMember`, called from updateMcpServer/deleteMcpServer).

interface BuiltCompositeTools {
  tools: IMcpTool[];
  members: IMcpCompositeMemberConfig[];
  memberSummaries: IMcpCompositeMemberSummary[];
  hasInternalMember: boolean;
  /** The first member on a token-only provider (see `tokenOnlyProviderOf`), else null. */
  tokenOnlyMember: InternalMcpProvider | null;
  /** The active members' instructions, one headed section each; `null` when none has any. */
  instructions: string | null;
}

export async function buildCompositeTools(
  db: DatabaseProvider,
  self: CompositeSelfRef,
  memberConfigs: Array<{ serverId: string; toolPrefix?: string; alwaysPrefix?: boolean }>,
  previousTools: IMcpTool[] = [],
): Promise<BuiltCompositeTools> {
  if (memberConfigs.length === 0) {
    throw new Error('A composite server needs at least one member');
  }

  const entries: CompositeToolEntry[] = [];
  const entryTools: IMcpTool[] = [];
  const members: IMcpCompositeMemberConfig[] = [];
  const memberSummaries: IMcpCompositeMemberSummary[] = [];
  const memberInstructions: string[] = [];
  let hasInternalMember = false;
  let tokenOnlyMember: InternalMcpProvider | null = null;

  for (const cfg of memberConfigs) {
    const member = await db.findMcpServerById(cfg.serverId);
    assertMemberUsable(self, member, cfg.serverId);
    const m = member!;
    const memberSourceType = resolveSourceType(m);
    if (memberSourceType === 'internal') hasInternalMember = true;
    tokenOnlyMember ??= tokenOnlyProviderOf(m);

    members.push({
      serverId: cfg.serverId,
      serverKey: m.key,
      toolPrefix: cfg.toolPrefix,
      alwaysPrefix: cfg.alwaysPrefix,
    });
    memberSummaries.push({
      serverId: cfg.serverId,
      serverKey: m.key,
      name: m.name,
      sourceType: memberSourceType,
      status: m.status,
      toolCount: m.tools?.length ?? 0,
    });

    // Inactive members contribute no tools but stay in the member list —
    // re-enabling them on the member's own page brings their tools back on
    // the next reconcile, no need to re-add them here.
    if (m.status !== 'active') continue;

    const instructions = resolveMcpInstructions(m);
    if (instructions) memberInstructions.push(`## ${m.name}\n${instructions}`);

    const prefixBase = cfg.toolPrefix || defaultMemberPrefix(m.key);
    const fallbackAnnotations = defaultAnnotationsForSource(memberSourceType);
    for (const tool of listEnabledMcpTools(m)) {
      entries.push({
        serverId: cfg.serverId,
        serverKey: m.key,
        realName: tool.name,
        prefixBase,
        alwaysPrefix: cfg.alwaysPrefix === true,
      });
      entryTools.push({
        ...tool,
        annotations: tool.annotations ?? fallbackAnnotations,
      });
    }
  }

  if (entries.length > MAX_COMPOSITE_MEMBER_TOOLS) {
    throw new Error(
      `This composite would publish ${entries.length} tools, over the ${MAX_COMPOSITE_MEMBER_TOOLS} limit. `
      + 'Disable unused tools on the member servers first.',
    );
  }

  const exposedNames = allocateExposedNames(entries, previousTools);
  const tools: IMcpTool[] = entryTools.map((tool, i) => ({
    ...tool,
    name: exposedNames[i],
    origin: { serverId: entries[i].serverId, serverKey: entries[i].serverKey, realName: entries[i].realName },
  }));

  return {
    tools,
    members,
    memberSummaries,
    hasInternalMember,
    tokenOnlyMember,
    instructions: normalizeMcpInstructions(memberInstructions.join('\n\n')) ?? null,
  };
}

/** Rebuild + persist one composite's snapshot from its stored member config. */
export async function reconcileOneComposite(
  db: DatabaseProvider,
  composite: IMcpServer,
): Promise<IMcpServer | null> {
  const config = getCompositeConfig(composite);
  if (config.members.length === 0) {
    // Nothing left to publish — disable rather than leave an always-empty,
    // always-failing endpoint. The operator adds a member or deletes it.
    return db.updateMcpServer(String(composite._id), {
      status: 'disabled',
      tools: [],
      lastError: { message: 'All members were removed from this composite server.', at: new Date() },
      metadata: metadataWithInstructions(
        metadataWithComposite(composite.metadata, { members: [], hasInternalMember: false }, []),
        'discoveredInstructions',
        null,
      ),
    });
  }
  const built = await buildCompositeTools(
    db,
    {
      id: String(composite._id ?? ''),
      tenantId: composite.tenantId,
      projectId: composite.projectId,
      ownerAgentId: composite.owner?.agentId,
    },
    config.members,
    composite.tools,
  );
  forgetLastErrorWrite(composite);
  return db.updateMcpServer(String(composite._id), {
    tools: built.tools,
    toolsDiscoveredAt: new Date(),
    lastError: null,
    metadata: metadataWithInstructions(
      metadataWithComposite(
        composite.metadata,
        { members: built.members, hasInternalMember: built.hasInternalMember },
        built.memberSummaries,
      ),
      'discoveredInstructions',
      built.instructions,
    ),
  });
}

/**
 * Called after a server changes (update) or is deleted, so every composite
 * that includes it as a member gets a fresh snapshot. Best-effort per
 * composite — one failing composite (e.g. a member vanished mid-request)
 * doesn't block the others; the failure lands on that composite's
 * `lastError` instead.
 */
export async function reconcileCompositesForMember(
  tenantDbName: string,
  memberId: string,
  opts: { removed?: boolean } = {},
): Promise<void> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  // Every composite, agents' own ones included: a member that changes must reach each of them.
  const all = await db.listMcpServers({ owned: 'include' });
  const composites = all.filter((s) => resolveSourceType(s) === 'composite'
    && getCompositeConfig(s).members.some((m) => m.serverId === memberId));

  for (const composite of composites) {
    try {
      if (opts.removed) {
        const prunedMembers = getCompositeConfig(composite).members.filter((m) => m.serverId !== memberId);
        await db.updateMcpServer(String(composite._id), {
          metadata: metadataWithComposite(
            composite.metadata,
            { members: prunedMembers, hasInternalMember: getCompositeConfig(composite).hasInternalMember },
            getCompositeMemberSummaries(composite),
          ),
        });
        const refreshed = await db.findMcpServerById(String(composite._id));
        if (refreshed) await reconcileOneComposite(db, refreshed);
      } else {
        await reconcileOneComposite(db, composite);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await db.updateMcpServer(String(composite._id), { lastError: lastErrorRecord(composite, message) });
      logger.warn('Composite reconcile failed', { compositeKey: composite.key, memberId, error: message });
    }
  }
}
