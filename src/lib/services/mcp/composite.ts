/**
 * Composite MCP servers — pure domain logic (no DB, no execution).
 *
 * A composite server (sourceType 'composite') republishes tools from other
 * MCP servers on the same tenant under one endpoint: each member keeps its
 * own auth, its own enable/disable + rename overrides, its own request logs
 * and its own Aegis binding — the composite only decides *which* member
 * tools are included and what name they're exposed under.
 *
 * This module owns the config shape, the public-exposure gate (an
 * internal-service member must never be reachable without a token — see
 * `isInternalSourced`), and the naming/collision algorithm. The DB-touching
 * orchestration (fetching members, persisting the rebuilt snapshot,
 * executing a routed call) lives in `mcpService.ts`, which imports from
 * here — never the other way, to keep this module import-cycle-free.
 */

import type { IMcpServer, IMcpTool, McpAccessMode, McpSourceType } from '@/lib/database';
import slugify from 'slugify';

/** One member entry as stored in a composite server's `metadata.composite.members`. */
export interface IMcpCompositeMemberConfig {
  /** The member MCP server's _id — the durable reference; keys can be renamed. */
  serverId: string;
  /** Denormalised for display; refreshed on every reconcile. */
  serverKey: string;
  /** Exposed-name prefix for this member's tools. Defaults to slug(serverKey). */
  toolPrefix?: string;
  /** Always prefix this member's tools, even when the name wouldn't collide. */
  alwaysPrefix?: boolean;
}

/** Cached display summary for one member, refreshed on every reconcile. */
export interface IMcpCompositeMemberSummary {
  serverId: string;
  serverKey: string;
  name: string;
  sourceType: McpSourceType;
  status: string;
  toolCount: number;
}

export interface IMcpCompositeConfig {
  members: IMcpCompositeMemberConfig[];
  /** True when any member is sourceType 'internal' — gates public exposure. */
  hasInternalMember: boolean;
}

/** A composite's total published tool count is capped — disable unused tools
 *  on the member servers rather than publishing everything through one gateway. */
export const MAX_COMPOSITE_MEMBER_TOOLS = 512;

const EMPTY_CONFIG: IMcpCompositeConfig = { members: [], hasInternalMember: false };

export function getCompositeConfig(server: Pick<IMcpServer, 'metadata'>): IMcpCompositeConfig {
  const raw = (server.metadata as Record<string, unknown> | undefined)?.composite;
  if (!raw || typeof raw !== 'object') return EMPTY_CONFIG;
  const value = raw as { members?: unknown; hasInternalMember?: unknown };
  const members = Array.isArray(value.members)
    ? value.members.filter(
      (m): m is IMcpCompositeMemberConfig => Boolean(m) && typeof m === 'object'
        && typeof (m as { serverId?: unknown }).serverId === 'string',
    )
    : [];
  return { members, hasInternalMember: value.hasInternalMember === true };
}

export function getCompositeMemberSummaries(
  server: Pick<IMcpServer, 'metadata'>,
): IMcpCompositeMemberSummary[] {
  const raw = (server.metadata as Record<string, unknown> | undefined)?.composite as
    | { memberSummaries?: unknown }
    | undefined;
  return Array.isArray(raw?.memberSummaries) ? (raw!.memberSummaries as IMcpCompositeMemberSummary[]) : [];
}

/** Store the rebuilt member config + display cache back onto a metadata blob. */
export function metadataWithComposite(
  metadata: Record<string, unknown> | undefined,
  config: IMcpCompositeConfig,
  memberSummaries: IMcpCompositeMemberSummary[],
): Record<string, unknown> {
  return {
    ...(metadata ?? {}),
    composite: { members: config.members, hasInternalMember: config.hasInternalMember, memberSummaries },
  };
}

/**
 * A server is "internal-sourced" when calling it can read tenant-private
 * data with no external credential of its own — a direct 'internal' server,
 * or a composite that includes one as a member. Gates public exposure both
 * at write time (`assertPublicExposureAllowed`) and at the public-endpoint
 * read path (defense in depth — see `public-mcp.ts`).
 */
export function isInternalSourced(server: Pick<IMcpServer, 'sourceType' | 'metadata'>): boolean {
  const sourceType = server.sourceType ?? 'openapi';
  if (sourceType === 'internal') return true;
  if (sourceType === 'composite') return getCompositeConfig(server).hasInternalMember;
  return false;
}

export function assertPublicExposureAllowed(
  sourceType: McpSourceType,
  hasInternalMember: boolean,
  accessMode: McpAccessMode | undefined,
): void {
  if (accessMode !== 'public') return;
  if (sourceType === 'internal') {
    throw new Error(
      'Internal-service MCP servers read tenant-private data and cannot be exposed publicly. Use "API token required" access instead.',
    );
  }
  if (sourceType === 'composite' && hasInternalMember) {
    throw new Error(
      'This composite includes an internal-service member and cannot be exposed publicly. Use "API token required" access instead.',
    );
  }
}

/** Reference to the composite record itself, for the self/tenant/project checks below. */
export interface CompositeSelfRef {
  /** Absent when the composite is still being created (no id yet). */
  id?: string;
  tenantId: string;
  projectId?: string;
}

/**
 * Validate a candidate member against the composite it would join: it must
 * exist, not be the composite itself, not be composite-sourced (no nesting),
 * and live in the same tenant + project.
 */
export function assertMemberUsable(
  self: CompositeSelfRef,
  member: IMcpServer | null,
  requestedServerId: string,
): void {
  if (!member) {
    throw new Error(`Member server "${requestedServerId}" no longer exists`);
  }
  if (self.id && String(member._id) === String(self.id)) {
    throw new Error('A composite server cannot include itself as a member');
  }
  if ((member.sourceType ?? 'openapi') === 'composite') {
    throw new Error(`"${member.name}" is itself a composite server — nested composites are not supported`);
  }
  if (member.tenantId !== self.tenantId) {
    throw new Error(`"${member.name}" belongs to a different tenant`);
  }
  if ((member.projectId ?? null) !== (self.projectId ?? null)) {
    throw new Error(`"${member.name}" belongs to a different project`);
  }
}

const PREFIX_PATTERN = /^[a-zA-Z0-9_-]{1,32}$/;

/** Sanitize an operator-supplied tool-name prefix; undefined falls back to the member's key slug. */
export function sanitizeCompositePrefix(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed || !PREFIX_PATTERN.test(trimmed)) return undefined;
  return trimmed;
}

export function defaultMemberPrefix(serverKey: string): string {
  return slugify(serverKey, { lower: true, strict: true, trim: true, replacement: '_' }) || 'member';
}

const TOOL_NAME_INVALID_CHARS = /[^a-zA-Z0-9_-]/g;

function sanitizeToolNamePart(raw: string): string {
  const cleaned = raw.replace(TOOL_NAME_INVALID_CHARS, '_').replace(/_{2,}/g, '_').replace(/^_+|_+$/g, '');
  return cleaned.slice(0, 128) || 'tool';
}

export interface CompositeToolEntry {
  serverId: string;
  serverKey: string;
  /** The tool's real (member-side) name — after the member's own rename, if any. */
  realName: string;
  prefixBase: string;
  alwaysPrefix: boolean;
}

/**
 * Assign the exposed (composite-facing) name for each tool entry.
 *
 * Real names are kept as-is unless they collide across members or the
 * member opted into `alwaysPrefix` — MCP clients that expect a specific
 * tool name (e.g. OpenAI's deep-research connectors expect `search`/`fetch`)
 * keep working when there's only one such tool in the composite. On
 * collision, `{prefix}_{name}` is tried, then `_2`, `_3`, ... .
 *
 * Stability: a tool keeps its previous exposed name across rebuilds
 * (member reorder, another member's tools changing) as long as that name is
 * still free in this round — so callers that cached `tools/list` don't see
 * names shift under them for unrelated reasons.
 */
export function allocateExposedNames(
  entries: CompositeToolEntry[],
  previousTools: Array<Pick<IMcpTool, 'name' | 'origin'>> = [],
): string[] {
  const nameCounts = new Map<string, number>();
  for (const e of entries) {
    if (!e.alwaysPrefix) nameCounts.set(e.realName, (nameCounts.get(e.realName) ?? 0) + 1);
  }

  const previousByOrigin = new Map<string, string>();
  for (const t of previousTools) {
    if (t.origin) previousByOrigin.set(`${t.origin.serverId}::${t.origin.realName}`, t.name);
  }

  const used = new Set<string>();
  const result: string[] = [];

  for (const e of entries) {
    const needsPrefix = e.alwaysPrefix || (nameCounts.get(e.realName) ?? 0) > 1;
    const base = sanitizeToolNamePart(needsPrefix ? `${e.prefixBase}_${e.realName}` : e.realName);

    let candidate = base;
    const prevName = previousByOrigin.get(`${e.serverId}::${e.realName}`);
    if (prevName && !used.has(prevName)) candidate = prevName;

    if (used.has(candidate)) {
      let n = 2;
      candidate = `${base}_${n}`;
      while (used.has(candidate)) {
        n += 1;
        candidate = `${base}_${n}`;
      }
    }

    used.add(candidate);
    result.push(candidate);
  }

  return result;
}
