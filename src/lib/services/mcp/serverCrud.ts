import { createLogger } from '@/lib/core/logger';
import { getDatabase } from '@/lib/database';
import type { DatabaseProvider, IMcpAuthConfig, IMcpExposureConfig, IMcpServer, IMcpStdioConfig, IMcpTool, McpSourceType, OwnedResourceListFilter } from '@/lib/database';
import type { CreateMcpServerInput, UpdateMcpServerInput, McpAuditContext } from './types';
import { readAccessList } from '@/lib/iam/accessList';
import { deleteInstanceAssignment } from '@/lib/core/cluster';
import { mcpEntityId } from './mcpEntityId';
import { McpServerConfigError } from './errors';
import { mergeAuthConfigUpdate, mergeStdioConfigUpdate, openAuthConfig, sealAuthConfig, sealStdioEnv } from './secretVault';
import { remoteDiscover } from './remoteMcpClient';
import { CONSOLE_IDENTITY_AUTH_TYPE } from '@/lib/iam/consoleIdentity';
import { stdioDiscover } from './stdioRunner';
import { mcpSandboxRunner } from '@/enterprise/registry';
import { invalidateMcpGuardrailBinding } from '@/lib/services/guardrail/hooks/mcpHook';
import { requireInternalMcpProvider } from './internal/registry';
import { getCompositeConfig, metadataWithComposite } from './composite';
import { buildCompositeTools, reconcileCompositesForMember, reconcileOneComposite } from './compositeReconcile';
import { assertConsoleIdentitySource, consoleIdentityAuthFor, prepareConsoleIdentityKey, withConsoleIdentityScrubbed } from './identityAuth';
import { generateUniqueKey, resolveEndpointSlug } from './keys';
import { parseOpenApiSpec } from './openApiSpec';
import { forgetLastErrorWrite, lastErrorRecord, logMcpAudit } from './requestLog';
import { discoverToolsForServer } from './serverDiscovery';
import { normalizeExposure, validateCreateInput } from './serverValidation';
import { isTokenOnlyServer, reachedTokenOnlyProvider, resolveExposure, resolveSourceType, tokenOnlyMessage, tokenOnlyProviderOf } from './serverView';
import { getDisabledToolNames, getMcpInstructionsOverride, getToolAnnotationOverrides, getToolDescriptionOverrides, getToolNameOverrides, metadataWithDisabledTools, metadataWithInstructions, metadataWithToolAnnotations, metadataWithToolDescriptions, metadataWithToolNames, sanitizeAnnotationOverride, sanitizeToolNameOverride } from './toolOverrides';

const logger = createLogger('mcp-service');

export async function createMcpServer(
  tenantDbName: string,
  tenantId: string,
  userId: string,
  projectId: string | undefined,
  input: CreateMcpServerInput,
  audit?: McpAuditContext,
): Promise<IMcpServer> {
  const sourceType = validateCreateInput(input);
  if (input.upstreamAuth?.type === CONSOLE_IDENTITY_AUTH_TYPE) await prepareConsoleIdentityKey(tenantDbName);

  const key = await generateUniqueKey(tenantDbName, projectId, input.key?.trim() || input.name);
  const endpointSlug = await resolveEndpointSlug(tenantDbName, input.endpointSlug);

  let tools: IMcpTool[] = [];
  let discoveredInstructions: string | null | undefined;
  let normalizedSpec: string | undefined;
  let upstreamBaseUrl = input.upstreamBaseUrl;
  const openedAuth: IMcpAuthConfig = { ...(input.upstreamAuth as IMcpAuthConfig) };

  if (sourceType === 'openapi') {
    const parsed = parseOpenApiSpec(input.openApiSpec!, input.specFormat);
    tools = parsed.tools;
    normalizedSpec = parsed.normalizedSpec;
    upstreamBaseUrl = upstreamBaseUrl || parsed.baseUrl;
    if (!upstreamBaseUrl) {
      throw new Error('Upstream base URL is required. Provide it explicitly or include a servers array in the spec.');
    }
  } else if (sourceType === 'remote') {
    // Discovery runs as the person saving the server.
    const identityAuth = await consoleIdentityAuthFor({
      authType: openedAuth.type,
      tenantId,
      tenantDbName,
      projectId,
      audience: input.remoteConfig!.url,
      identity: { userId, source: 'console' },
    });
    ({ tools, instructions: discoveredInstructions } = await withConsoleIdentityScrubbed(identityAuth, () => remoteDiscover({
      url: input.remoteConfig!.url,
      transport: input.remoteConfig!.transport,
      auth: openedAuth,
      ...(identityAuth ? { extraHeaders: identityAuth.headers } : {}),
    })));
  } else if (sourceType === 'stdio' && input.stdioConfig!.executionMode === 'subprocess') {
    // Discover eagerly so the create screen fails fast on a broken package.
    ({ tools, instructions: discoveredInstructions } = await stdioDiscover(input.stdioConfig!, { tenantId }));
  }

  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);

  const stdioConfig = input.stdioConfig ? sealStdioEnv(input.stdioConfig) : undefined;

  let internalMetadata: Record<string, unknown> | undefined;
  let compositeMetadata: Record<string, unknown> | undefined;
  let description = input.description?.trim();
  if (sourceType === 'internal') {
    const ctx = { tenantDbName, tenantId, projectId };
    const provider = requireInternalMcpProvider(input.internalConfig!.provider);
    if (provider.tokenOnly && normalizeExposure(input.exposure).accessMode === 'public') {
      throw new McpServerConfigError(tokenOnlyMessage(provider));
    }
    const instanceKey = input.internalConfig!.instanceKey;
    const config = input.internalConfig!.config ?? {};
    await provider.validateInstance(ctx, instanceKey, config);
    const built = await provider.buildTools(ctx, instanceKey, config);
    tools = built.tools;
    discoveredInstructions = built.instructions;
    description = description || built.suggestedDescription;
    internalMetadata = { provider: provider.id, instanceKey, config };
  }
  if (sourceType === 'composite') {
    const memberConfigs = input.compositeConfig!.members.map((m) => ({
      serverId: m.serverId,
      toolPrefix: m.toolPrefix,
      alwaysPrefix: m.alwaysPrefix,
    }));
    const built = await buildCompositeTools(db, { tenantId, projectId, ownerAgentId: input.owner?.agentId }, memberConfigs);
    if (built.tokenOnlyMember && normalizeExposure(input.exposure).accessMode === 'public') {
      throw new McpServerConfigError(tokenOnlyMessage(built.tokenOnlyMember));
    }
    tools = built.tools;
    discoveredInstructions = built.instructions;
    compositeMetadata = metadataWithComposite(
      undefined,
      { members: built.members, hasInternalMember: built.hasInternalMember },
      built.memberSummaries,
    );
  }

  let metadata: Record<string, unknown> | undefined = internalMetadata ? { internal: internalMetadata } : compositeMetadata;
  if (discoveredInstructions) metadata = metadataWithInstructions(metadata, 'discoveredInstructions', discoveredInstructions);
  if (input.instructions) metadata = metadataWithInstructions(metadata, 'instructions', input.instructions);

  const server = await db.createMcpServer({
    tenantId,
    projectId: projectId ?? undefined,
    key,
    name: input.name.trim(),
    description,
    sourceType,
    openApiSpec: normalizedSpec,
    remoteConfig: input.remoteConfig,
    stdioConfig,
    tools,
    toolsDiscoveredAt: sourceType === 'openapi' ? undefined : new Date(),
    upstreamBaseUrl,
    upstreamAuth: sealAuthConfig(openedAuth),
    exposure: normalizeExposure(input.exposure),
    // Omitted when not given, never `undefined` (BSON null on Mongo).
    ...(input.guardrail !== undefined ? { guardrail: input.guardrail } : {}),
    // Omitted when not given (a record without a list is open), never `undefined` (BSON null on Mongo).
    ...(input.access ? { access: input.access } : {}),
    ...(input.owner ? { owner: { kind: 'agent' as const, agentId: input.owner.agentId } } : {}),
    status: 'active',
    endpointSlug,
    totalRequests: 0,
    metadata,
    createdBy: userId,
  });

  // Sandbox-backed stdio servers provision after the record exists (the
  // runner needs the server identity); discovery failures are surfaced on
  // the record instead of failing the create.
  if (sourceType === 'stdio' && input.stdioConfig!.executionMode === 'sandbox') {
    try {
      const { tools: discovered } = await discoverToolsForServer({ ...server, stdioConfig });
      await db.switchToTenant(tenantDbName);
      forgetLastErrorWrite(server);
      await db.updateMcpServer(String(server._id), {
        tools: discovered,
        toolsDiscoveredAt: new Date(),
        lastError: null,
      });
      server.tools = discovered;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await db.updateMcpServer(String(server._id), {
        lastError: lastErrorRecord(server, message),
      });
      logger.warn('Sandbox MCP provisioning failed at create', { key, error: message });
    }
  }

  logger.info('MCP server created', { key, tenantId, sourceType, toolCount: server.tools.length });

  void logMcpAudit(tenantDbName, {
    tenantId,
    projectId,
    serverId: String(server._id ?? ''),
    serverKey: key,
    action: 'create',
    changes: {
      name: { to: input.name.trim() },
      sourceType: { to: sourceType },
      exposure: { to: normalizeExposure(input.exposure) },
      ...(input.access ? { access: { to: input.access } } : {}),
    },
    performedBy: audit?.performedBy ?? userId,
    ipAddress: audit?.ipAddress,
    userAgent: audit?.userAgent,
  });

  return server;
}

/** Fields compared for the audit diff (secrets excluded — masked separately). */
function diffForAudit(before: IMcpServer, after: Partial<IMcpServer>): Record<string, { from?: unknown; to?: unknown }> {
  const changes: Record<string, { from?: unknown; to?: unknown }> = {};
  const compare = (field: string, from: unknown, to: unknown) => {
    if (to === undefined) return;
    const fromJson = JSON.stringify(from ?? null);
    const toJson = JSON.stringify(to ?? null);
    if (fromJson !== toJson) changes[field] = { from, to };
  };

  compare('key', before.key, after.key);
  compare('name', before.name, after.name);
  compare('description', before.description, after.description);
  compare('status', before.status, after.status);
  compare('upstreamBaseUrl', before.upstreamBaseUrl, after.upstreamBaseUrl);
  compare('exposure', resolveExposure(before), after.exposure);
  compare('access', readAccessList(before.access), after.access);
  compare('guardrail', before.guardrail, after.guardrail);
  compare('remoteConfig', before.remoteConfig, after.remoteConfig);
  if (after.stdioConfig !== undefined) {
    const strip = (c?: IMcpStdioConfig) => c && {
      runtime: c.runtime,
      packageName: c.packageName,
      args: c.args,
      executionMode: c.executionMode,
      sandbox: c.sandbox,
      envKeys: Object.keys(c.env ?? {}),
    };
    compare('stdioConfig', strip(before.stdioConfig), strip(after.stdioConfig));
  }
  if (after.upstreamAuth !== undefined) {
    const beforeAuth = before.upstreamAuth ?? { type: 'none' };
    if (beforeAuth.type !== after.upstreamAuth.type
      || beforeAuth.headerName !== after.upstreamAuth.headerName
      || beforeAuth.username !== after.upstreamAuth.username
      || (after.upstreamAuth.sealed && after.upstreamAuth.sealed !== beforeAuth.sealed)) {
      changes.upstreamAuth = { from: beforeAuth.type, to: after.upstreamAuth.type };
    }
  }
  if (after.openApiSpec !== undefined && after.openApiSpec !== before.openApiSpec) {
    changes.openApiSpec = { from: '(previous spec)', to: '(updated spec)' };
  }
  if (after.metadata !== undefined) {
    // Record counts only — the full name list can run to thousands of entries.
    const fromList = getDisabledToolNames(before);
    const toList = getDisabledToolNames({ metadata: after.metadata });
    if (JSON.stringify(fromList) !== JSON.stringify(toList)) {
      changes.disabledTools = { from: `${fromList.length} disabled`, to: `${toList.length} disabled` };
    }
    // Lengths only — the text itself can run to thousands of characters.
    const fromInstructions = getMcpInstructionsOverride(before) ?? '';
    const toInstructions = getMcpInstructionsOverride({ metadata: after.metadata }) ?? '';
    if (fromInstructions !== toInstructions) {
      changes.instructions = { from: `${fromInstructions.length} chars`, to: `${toInstructions.length} chars` };
    }
  }
  return changes;
}

/**
 * What an update leaves behind must keep a token-only provider (a browser, a
 * sandbox) off public URLs: the server itself, a composite through its members,
 * and a server that becomes a token-only server while a public composite
 * includes it.
 */
async function assertTokenOnlyStaysTokenOnly(
  db: DatabaseProvider,
  existing: IMcpServer,
  sourceType: McpSourceType,
  updateData: Record<string, unknown>,
): Promise<void> {
  const after = {
    sourceType,
    metadata: (updateData.metadata as IMcpServer['metadata'] | undefined) ?? existing.metadata,
  };
  const exposure = (updateData.exposure as IMcpExposureConfig | undefined) ?? resolveExposure(existing);
  const reached = exposure.accessMode === 'public' ? await reachedTokenOnlyProvider(db, after) : null;
  if (reached) {
    throw new McpServerConfigError(tokenOnlyMessage(reached));
  }
  const becomes = tokenOnlyProviderOf(after);
  if (becomes && !isTokenOnlyServer(existing)) {
    const id = String(existing._id);
    const publicComposite = (await db.listMcpServers({ owned: 'include' })).find((server) => resolveSourceType(server) === 'composite'
      && resolveExposure(server).accessMode === 'public'
      && getCompositeConfig(server).members.some((member) => member.serverId === id));
    if (publicComposite) {
      throw new McpServerConfigError(
        `${tokenOnlyMessage(becomes)} This server is a member of the public composite server "${publicComposite.name}".`,
      );
    }
  }
}

export async function updateMcpServer(
  tenantDbName: string,
  serverId: string,
  userId: string,
  input: UpdateMcpServerInput,
  audit?: McpAuditContext,
): Promise<IMcpServer | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);

  const existing = await db.findMcpServerById(serverId);
  if (!existing) return null;

  const updateData: Record<string, unknown> = { updatedBy: userId };

  if (input.key !== undefined && input.key.trim()) {
    updateData.key = await generateUniqueKey(tenantDbName, existing.projectId, input.key, serverId);
  }
  if (input.name !== undefined) updateData.name = input.name.trim();
  if (input.description !== undefined) updateData.description = input.description.trim();
  if (input.status !== undefined) updateData.status = input.status;
  if (input.upstreamBaseUrl !== undefined) updateData.upstreamBaseUrl = input.upstreamBaseUrl;
  if (input.upstreamAuth !== undefined) {
    if (input.upstreamAuth.type === CONSOLE_IDENTITY_AUTH_TYPE) {
      assertConsoleIdentitySource(resolveSourceType(existing));
      await prepareConsoleIdentityKey(tenantDbName);
    }
    updateData.upstreamAuth = mergeAuthConfigUpdate(existing.upstreamAuth, input.upstreamAuth);
  }
  if (input.exposure !== undefined) updateData.exposure = normalizeExposure(input.exposure);
  if (input.access !== undefined) updateData.access = input.access;
  if (input.endpointSlug !== undefined) {
    updateData.endpointSlug = await resolveEndpointSlug(tenantDbName, input.endpointSlug, serverId);
  }
  // A body that names no binding leaves the stored one untouched.
  if (input.guardrail !== undefined) updateData.guardrail = input.guardrail;
  if (input.remoteConfig !== undefined) updateData.remoteConfig = input.remoteConfig;
  if (input.stdioConfig !== undefined) {
    updateData.stdioConfig = mergeStdioConfigUpdate(existing.stdioConfig, input.stdioConfig);
  }
  // Runtime-header passthrough policy lives in the metadata blob (no schema
  // migration needed in either DB tree).
  if (input.runtimeHeaders !== undefined) {
    updateData.metadata = {
      ...(existing.metadata ?? {}),
      runtimeHeaders: input.runtimeHeaders === null
        ? undefined
        : {
          allow: input.runtimeHeaders.allow === true,
          ...(input.runtimeHeaders.allowedNames?.length
            ? { allowedNames: input.runtimeHeaders.allowedNames.filter((n) => typeof n === 'string' && n.trim()) }
            : {}),
        },
    };
  }

  // Re-parse spec if updated (openapi source only)
  if (input.openApiSpec !== undefined) {
    const { tools, baseUrl: specBaseUrl, normalizedSpec } = parseOpenApiSpec(
      input.openApiSpec,
      input.specFormat,
    );
    updateData.openApiSpec = normalizedSpec;
    updateData.tools = tools;
    if (!input.upstreamBaseUrl && specBaseUrl) {
      updateData.upstreamBaseUrl = specBaseUrl;
    }
  }

  // Re-discover tools when the remote/stdio source configuration changed.
  // `undefined` = the source said nothing about instructions this time.
  let discoveredInstructions: string | null | undefined;
  const sourceType = resolveSourceType(existing);
  if (sourceType === 'remote' && input.remoteConfig !== undefined) {
    const auth = updateData.upstreamAuth
      ? openAuthConfig(updateData.upstreamAuth as IMcpAuthConfig)
      : openAuthConfig(existing.upstreamAuth);
    const remoteConfig = input.remoteConfig;
    // Discovery runs as the person saving the server.
    const identityAuth = await consoleIdentityAuthFor({
      authType: auth.type,
      tenantId: existing.tenantId,
      tenantDbName,
      projectId: existing.projectId,
      audience: remoteConfig.url,
      identity: { userId, source: 'console' },
    });
    const discovered = await withConsoleIdentityScrubbed(identityAuth, () => remoteDiscover({
      url: remoteConfig.url,
      transport: remoteConfig.transport,
      auth,
      ...(identityAuth ? { extraHeaders: identityAuth.headers } : {}),
    }));
    updateData.tools = discovered.tools;
    discoveredInstructions = discovered.instructions;
    updateData.toolsDiscoveredAt = new Date();
  }
  if (sourceType === 'stdio' && input.stdioConfig !== undefined
    && (updateData.stdioConfig as IMcpStdioConfig).executionMode === 'subprocess') {
    const discovered = await stdioDiscover(updateData.stdioConfig as IMcpStdioConfig, { tenantId: existing.tenantId });
    updateData.tools = discovered.tools;
    discoveredInstructions = discovered.instructions;
    updateData.toolsDiscoveredAt = new Date();
  }
  if (sourceType === 'internal' && input.internalConfig !== undefined) {
    const existingInternal = (existing.metadata as Record<string, unknown> | undefined)?.internal as
      | { provider?: string; instanceKey?: string; config?: Record<string, unknown> }
      | undefined;
    const providerId = input.internalConfig.provider || existingInternal?.provider;
    const instanceKey = input.internalConfig.instanceKey || existingInternal?.instanceKey;
    if (!providerId || !instanceKey) {
      throw new Error('internalConfig.provider and internalConfig.instanceKey are required');
    }
    const config = { ...(existingInternal?.config ?? {}), ...(input.internalConfig.config ?? {}) };
    const provider = requireInternalMcpProvider(providerId);
    const ctx = { tenantDbName, tenantId: existing.tenantId, projectId: existing.projectId };
    await provider.validateInstance(ctx, instanceKey, config);
    const built = await provider.buildTools(ctx, instanceKey, config);
    updateData.tools = built.tools;
    discoveredInstructions = built.instructions ?? null;
    updateData.toolsDiscoveredAt = new Date();
    updateData.metadata = {
      ...((updateData.metadata as Record<string, unknown> | undefined) ?? existing.metadata),
      internal: { provider: provider.id, instanceKey, config },
    };
  }

  // Composite: an explicit compositeConfig patch replaces the member list
  // and rebuilds the tool snapshot (passing the current tools as the
  // "previous" set keeps stable exposed names across the rebuild — see
  // allocateExposedNames). Omitting compositeConfig leaves the member list
  // untouched (e.g. a PATCH that only renames the server or flips status).
  if (sourceType === 'composite' && input.compositeConfig !== undefined) {
    if (!input.compositeConfig.members.length) {
      throw new Error('compositeConfig.members must include at least one member server');
    }
    const memberConfigs = input.compositeConfig.members.map((m) => ({
      serverId: m.serverId,
      toolPrefix: m.toolPrefix,
      alwaysPrefix: m.alwaysPrefix,
    }));
    const built = await buildCompositeTools(
      db,
      { id: serverId, tenantId: existing.tenantId, projectId: existing.projectId, ownerAgentId: existing.owner?.agentId },
      memberConfigs,
      existing.tools,
    );
    updateData.tools = built.tools;
    discoveredInstructions = built.instructions;
    updateData.toolsDiscoveredAt = new Date();
    updateData.metadata = metadataWithComposite(
      (updateData.metadata as Record<string, unknown> | undefined) ?? existing.metadata,
      { members: built.members, hasInternalMember: built.hasInternalMember },
      built.memberSummaries,
    );
  }

  // What the source said about its tools at rediscovery, and the operator's own text.
  if (discoveredInstructions !== undefined) {
    updateData.metadata = metadataWithInstructions(
      (updateData.metadata as Record<string, unknown> | undefined) ?? existing.metadata,
      'discoveredInstructions',
      discoveredInstructions,
    );
  }
  if (input.instructions !== undefined) {
    updateData.metadata = metadataWithInstructions(
      (updateData.metadata as Record<string, unknown> | undefined) ?? existing.metadata,
      'instructions',
      input.instructions,
    );
  }

  await assertTokenOnlyStaysTokenOnly(db, existing, sourceType, updateData);

  // Tool enable/disable list (metadata-backed). Runs after tool rediscovery so
  // the incoming names are validated against the tool list being persisted.
  if (input.disabledTools !== undefined) {
    const knownNames = new Set(
      ((updateData.tools as IMcpTool[] | undefined) ?? existing.tools ?? []).map((t) => t.name),
    );
    const disabled = [...new Set(
      input.disabledTools.filter((n) => typeof n === 'string' && knownNames.has(n)),
    )];
    updateData.metadata = metadataWithDisabledTools(
      (updateData.metadata as Record<string, unknown> | undefined) ?? existing.metadata,
      disabled,
    );
  } else if (updateData.tools !== undefined) {
    // Tool list changed without an explicit selection — prune disabled names
    // that no longer exist so stale entries don't linger.
    const knownNames = new Set((updateData.tools as IMcpTool[]).map((t) => t.name));
    const before = getDisabledToolNames(existing);
    const pruned = before.filter((n) => knownNames.has(n));
    if (pruned.length !== before.length) {
      updateData.metadata = metadataWithDisabledTools(
        (updateData.metadata as Record<string, unknown> | undefined) ?? existing.metadata,
        pruned,
      );
    }
  }

  // Per-tool annotation overrides (metadata-backed, partial patch: a null or
  // empty entry clears that tool's override).
  if (input.toolAnnotations !== undefined) {
    const knownNames = new Set(
      ((updateData.tools as IMcpTool[] | undefined) ?? existing.tools ?? []).map((t) => t.name),
    );
    const overrides = { ...getToolAnnotationOverrides(existing) };
    for (const [name, value] of Object.entries(input.toolAnnotations)) {
      if (!knownNames.has(name)) continue;
      const sanitized = value === null ? null : sanitizeAnnotationOverride(value);
      if (sanitized) overrides[name] = sanitized;
      else delete overrides[name];
    }
    updateData.metadata = metadataWithToolAnnotations(
      (updateData.metadata as Record<string, unknown> | undefined) ?? existing.metadata,
      overrides,
    );
  }

  // Per-tool description overrides (metadata-backed, partial patch: null or an
  // empty string restores the discovered description).
  if (input.toolDescriptions !== undefined) {
    const knownNames = new Set(
      ((updateData.tools as IMcpTool[] | undefined) ?? existing.tools ?? []).map((t) => t.name),
    );
    const overrides = { ...getToolDescriptionOverrides(existing) };
    for (const [name, value] of Object.entries(input.toolDescriptions)) {
      if (!knownNames.has(name)) continue;
      const text = typeof value === 'string' ? value.trim() : '';
      if (text) overrides[name] = text;
      else delete overrides[name];
    }
    updateData.metadata = metadataWithToolDescriptions(
      (updateData.metadata as Record<string, unknown> | undefined) ?? existing.metadata,
      overrides,
    );
  }

  // Per-tool name overrides (metadata-backed, partial patch: null or an
  // empty string restores the discovered name). Exposed names must stay
  // unique across the server's effective tool list — callers use them for
  // both tools/list and tools/call, so a collision would strand one tool.
  if (input.toolNames !== undefined) {
    const knownTools = ((updateData.tools as IMcpTool[] | undefined) ?? existing.tools ?? []);
    const knownNames = new Set(knownTools.map((t) => t.name));
    const overrides = { ...getToolNameOverrides(existing) };
    for (const [name, value] of Object.entries(input.toolNames)) {
      if (!knownNames.has(name)) continue;
      const custom = value === null ? null : sanitizeToolNameOverride(value);
      if (custom && custom !== name) overrides[name] = custom;
      else delete overrides[name];
    }

    const claimedBy = new Map<string, string>();
    for (const tool of knownTools) {
      const exposed = overrides[tool.name] ?? tool.name;
      const owner = claimedBy.get(exposed);
      if (owner && owner !== tool.name) {
        throw new Error(`Tool name "${exposed}" collides with another tool on this server`);
      }
      claimedBy.set(exposed, tool.name);
    }

    updateData.metadata = metadataWithToolNames(
      (updateData.metadata as Record<string, unknown> | undefined) ?? existing.metadata,
      overrides,
    );
  }

  const updated = await db.updateMcpServer(serverId, updateData as Partial<IMcpServer>);

  // The guardrail bridge caches "which guardrail is this server bound to" for a
  // minute, keyed by server KEY — so a rebinding (or a rename that moves the
  // binding to a new key) would otherwise keep evaluating against the previous
  // guardrail for up to that long. Both old and new keys are dropped because a
  // rename leaves an entry nothing will ever look up again.
  if (updated && (input.guardrail !== undefined || updateData.key !== undefined)) {
    invalidateMcpGuardrailBinding(tenantDbName, existing.key);
    if (updated.key !== existing.key) invalidateMcpGuardrailBinding(tenantDbName, updated.key);
  }

  if (updated) {
    const changes = diffForAudit(existing, updateData as Partial<IMcpServer>);
    const isSecretsChange = 'upstreamAuth' in changes || 'stdioConfig' in changes;
    void logMcpAudit(tenantDbName, {
      tenantId: existing.tenantId,
      projectId: existing.projectId,
      serverId,
      serverKey: existing.key,
      action: input.status !== undefined && Object.keys(changes).length === 1 && changes.status
        ? 'status_change'
        : changes.exposure && Object.keys(changes).length === 1
          ? 'exposure_change'
          : isSecretsChange && Object.keys(changes).length === 1
            ? 'secrets_change'
            : 'update',
      changes,
      performedBy: audit?.performedBy ?? userId,
      ipAddress: audit?.ipAddress,
      userAgent: audit?.userAgent,
    });

    // Composites can't nest (assertMemberUsable rejects it), so this never
    // recurses — it only ever touches composites that include `existing`.
    if (sourceType !== 'composite') {
      await reconcileCompositesForMember(tenantDbName, serverId);
    }
  }

  return updated;
}

/** Re-run tool discovery for remote/stdio servers. */
export async function refreshMcpServerTools(
  tenantDbName: string,
  serverId: string,
  userId: string,
  audit?: McpAuditContext,
): Promise<IMcpServer | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const server = await db.findMcpServerById(serverId);
  if (!server) return null;

  try {
    let updated: IMcpServer | null;
    if (resolveSourceType(server) === 'composite') {
      // Composite tools aren't "rediscovered" from an upstream — they're
      // rebuilt from the current state of each member (which also refreshes
      // the cached member display summary, unlike the incremental reconcile
      // triggered by a member's own update).
      updated = await reconcileOneComposite(db, server);
    } else {
      const { tools, instructions } = await discoverToolsForServer(server, { userId, source: 'console' });
      forgetLastErrorWrite(server);
      const refreshUpdate: Partial<IMcpServer> = {
        tools,
        toolsDiscoveredAt: new Date(),
        lastError: null,
        updatedBy: userId,
      };
      // Prune disabled names that vanished from the rediscovered tool list.
      const disabledBefore = getDisabledToolNames(server);
      const disabledKept = disabledBefore.filter((n) => tools.some((t) => t.name === n));
      if (disabledKept.length !== disabledBefore.length) {
        refreshUpdate.metadata = metadataWithDisabledTools(server.metadata, disabledKept);
      }
      if (instructions !== undefined) {
        refreshUpdate.metadata = metadataWithInstructions(
          refreshUpdate.metadata ?? server.metadata,
          'discoveredInstructions',
          instructions,
        );
      }
      updated = await db.updateMcpServer(serverId, refreshUpdate);
    }
    void logMcpAudit(tenantDbName, {
      tenantId: server.tenantId,
      projectId: server.projectId,
      serverId,
      serverKey: server.key,
      action: 'tools_refresh',
      changes: { toolCount: { from: server.tools?.length ?? 0, to: updated?.tools?.length ?? 0 } },
      performedBy: audit?.performedBy ?? userId,
      ipAddress: audit?.ipAddress,
      userAgent: audit?.userAgent,
    });
    return updated;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.updateMcpServer(serverId, { lastError: lastErrorRecord(server, message) });
    throw error;
  }
}

export async function deleteMcpServer(
  tenantDbName: string,
  serverId: string,
  audit?: McpAuditContext,
): Promise<boolean> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const existing = await db.findMcpServerById(serverId);
  const deleted = await db.deleteMcpServer(serverId);

  if (deleted && existing) {
    // Drop the node-pinning cache entry, keyed by tenantId+key: without this,
    // a server recreated under the same name would silently inherit the
    // deleted server's cluster placement (including a stale "strictly
    // assigned to an offline node" error).
    void deleteInstanceAssignment('mcp', mcpEntityId(existing.tenantId, existing.key))
      .catch((error) => logger.warn('Failed to clear MCP instance assignment', { serverId, error }));

    // Same reasoning one level down: the guardrail binding cache is keyed by
    // server key, so a recreated server would inherit the deleted one's
    // guardrail until the entry expired.
    invalidateMcpGuardrailBinding(tenantDbName, existing.key);

    // Release a sandbox-backed runtime if one exists (best-effort).
    if (existing.stdioConfig?.executionMode === 'sandbox' && mcpSandboxRunner.current) {
      void mcpSandboxRunner.current
        .release(
          {
            tenantDbName,
            tenantId: existing.tenantId,
            projectId: existing.projectId,
            serverId,
            serverKey: existing.key,
          },
          existing.stdioConfig.sandbox?.instanceId,
        )
        .catch((error) => logger.warn('Failed to release MCP sandbox', { serverId, error }));
    }
    void logMcpAudit(tenantDbName, {
      tenantId: existing.tenantId,
      projectId: existing.projectId,
      serverId,
      serverKey: existing.key,
      action: 'delete',
      performedBy: audit?.performedBy ?? existing.updatedBy ?? existing.createdBy,
      ipAddress: audit?.ipAddress,
      userAgent: audit?.userAgent,
    });

    if (resolveSourceType(existing) !== 'composite') {
      await reconcileCompositesForMember(tenantDbName, serverId, { removed: true });
    }
  }
  return deleted;
}

export async function getMcpServer(
  tenantDbName: string,
  serverId: string,
): Promise<IMcpServer | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.findMcpServerById(serverId);
}

export async function getMcpServerByKey(
  tenantDbName: string,
  key: string,
  projectId?: string | null,
): Promise<IMcpServer | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.findMcpServerByKey(key, projectId);
}

/** The project's shared servers; an agent's own ones only when `owned` / `ownerAgentId` ask for them. */
export async function listMcpServers(
  tenantDbName: string,
  filters?: { projectId?: string; status?: 'active' | 'disabled'; search?: string } & OwnedResourceListFilter,
): Promise<IMcpServer[]> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.listMcpServers(filters);
}
