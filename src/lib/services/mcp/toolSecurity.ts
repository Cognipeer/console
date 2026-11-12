/**
 * Tool-definition trust for an MCP server: which definition of each tool an
 * operator approved, which changed since, and what a definition scan flagged.
 *
 * Stored in `server.metadata`, keyed by the REAL tool name like the other
 * per-tool operator settings, so neither database tree needs a schema change:
 *   · `toolPins`          realName -> hash of the approved definition
 *   · `toolReview`        realName -> a definition waiting for review; the tool
 *                         is neither listed nor callable until it is approved
 *   · `toolScan`          realName -> findings of the last definition scan
 *   · `toolChangePolicy`  'approve' (default) | 'notify'
 *
 * Changes the UPSTREAM makes (a tool refresh) follow the policy. Changes the
 * OPERATOR makes (creating the server, editing its source) are approved by
 * that act, except a definition the scan rates high, which always waits.
 */
import { createHash } from 'crypto';
import type { IMcpTool, McpSourceType } from '@/lib/database';
import { scanToolDefinitions, type McpDefinitionFinding } from './definitionScan';

export type McpToolChangePolicy = 'approve' | 'notify';
export type McpToolReviewReason = 'new' | 'changed' | 'scan';

export interface McpToolReviewEntry {
  reason: McpToolReviewReason;
  /** Hash of the definition waiting for approval. */
  hash: string;
  /** Hash of the definition approved before (absent for a new tool). */
  previousHash?: string;
  /** The approved definition, for the diff view (omitted when large). */
  previous?: { title?: string; description?: string; inputSchema?: Record<string, unknown> };
  /** ISO time the pending definition was first seen. */
  detectedAt: string;
}

/** Sources whose tool definitions come from outside Console and are pinned. */
const PINNED_SOURCES: ReadonlySet<McpSourceType> = new Set(['remote', 'stdio', 'openapi']);
const MAX_PREVIOUS_SNAPSHOT_CHARS = 32_000;

type Metadata = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A map keyed by tool names. Tool names come from the upstream, so the map has
 * no prototype: a name like `__proto__` or `constructor` is an ordinary key.
 */
function nameMap<T>(entries: Iterable<readonly [string, T]> = []): Record<string, T> {
  const out = Object.create(null) as Record<string, T>;
  for (const [key, value] of entries) out[key] = value;
  return out;
}

/** A name map as stored in metadata: a plain object whose keys are all own data properties. */
function stored<T>(map: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(map));
}

function hasName(map: Record<string, unknown>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(map, name);
}

export function isPinnedSource(sourceType: McpSourceType): boolean {
  return PINNED_SOURCES.has(sourceType);
}

export function getToolChangePolicy(metadata: Metadata | undefined): McpToolChangePolicy {
  return metadata?.toolChangePolicy === 'notify' ? 'notify' : 'approve';
}

export function getToolPins(metadata: Metadata | undefined): Record<string, string> | undefined {
  const raw = metadata?.toolPins;
  if (!isRecord(raw)) return undefined;
  return nameMap(Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

export function getToolReview(metadata: Metadata | undefined): Record<string, McpToolReviewEntry> {
  const raw = metadata?.toolReview;
  if (!isRecord(raw)) return nameMap();
  const out = nameMap<McpToolReviewEntry>();
  for (const [name, entry] of Object.entries(raw)) {
    if (isRecord(entry) && typeof entry.hash === 'string') out[name] = entry as unknown as McpToolReviewEntry;
  }
  return out;
}

export function getToolScan(metadata: Metadata | undefined): Record<string, McpDefinitionFinding[]> {
  const raw = metadata?.toolScan;
  if (!isRecord(raw)) return nameMap();
  return nameMap(Object.entries(raw).filter((entry): entry is [string, McpDefinitionFinding[]] => Array.isArray(entry[1])));
}

/** True when the tool's current definition waits for an operator's approval. */
export function isToolAwaitingReview(metadata: Metadata | undefined, realName: string): boolean {
  return hasName(getToolReview(metadata), realName);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

/** Stable hash of everything in a definition that tells a model (or a request) what the tool does. */
export function toolDefinitionHash(tool: IMcpTool): string {
  const { name, title, description, inputSchema, annotations, httpMethod, httpPath } = tool;
  return createHash('sha256')
    .update(JSON.stringify(canonical({ name, title, description, inputSchema, annotations, httpMethod, httpPath })))
    .digest('hex');
}

function previousSnapshot(tool: IMcpTool | undefined): McpToolReviewEntry['previous'] {
  if (!tool) return undefined;
  const snapshot = { title: tool.title, description: tool.description, inputSchema: tool.inputSchema };
  return JSON.stringify(snapshot).length <= MAX_PREVIOUS_SNAPSHOT_CHARS ? snapshot : { title: tool.title };
}

export interface ToolDefinitionReconcileInput {
  sourceType: McpSourceType;
  metadata: Metadata | undefined;
  /** The definitions stored before this discovery. */
  previousTools: IMcpTool[];
  /** The definitions just discovered. */
  nextTools: IMcpTool[];
  /** The operator made this change (create, source edit): approved by that act, unless the scan rates it high. */
  operatorChange: boolean;
  now?: Date;
}

export interface ToolDefinitionReconcileResult {
  /** The full metadata to store (input metadata plus the trust fields). */
  metadata: Metadata;
  added: string[];
  removed: string[];
  changed: string[];
  /** Tools that started waiting for review with this discovery. */
  newlyPending: string[];
  /** Tools whose definition the scan rates high. */
  flagged: string[];
}

/** Compare a fresh discovery with what was approved, and record what now waits for review. */
export function reconcileToolDefinitions(input: ToolDefinitionReconcileInput): ToolDefinitionReconcileResult {
  const metadata: Metadata = { ...(input.metadata ?? {}) };
  const previousByName = new Map(input.previousTools.map((tool) => [tool.name, tool]));
  const nextNames = new Set(input.nextTools.map((tool) => tool.name));
  const added = input.nextTools.filter((tool) => !previousByName.has(tool.name)).map((tool) => tool.name);
  const removed = input.previousTools.filter((tool) => !nextNames.has(tool.name)).map((tool) => tool.name);
  const changed = input.nextTools
    .filter((tool) => {
      const before = previousByName.get(tool.name);
      return before !== undefined && toolDefinitionHash(before) !== toolDefinitionHash(tool);
    })
    .map((tool) => tool.name);

  if (!isPinnedSource(input.sourceType)) {
    delete metadata.toolPins;
    delete metadata.toolReview;
    delete metadata.toolScan;
    return { metadata, added, removed, changed, newlyPending: [], flagged: [] };
  }

  const scan = scanToolDefinitions(input.nextTools);
  const policy = getToolChangePolicy(input.metadata);
  // A server stored before pinning existed: what it holds was in use, so it counts as approved.
  const pins: Record<string, string> = getToolPins(input.metadata)
    ?? nameMap(input.previousTools.map((tool) => [tool.name, toolDefinitionHash(tool)] as const));
  const previousReview = getToolReview(input.metadata);
  const review = nameMap<McpToolReviewEntry>();
  const newlyPending: string[] = [];
  const flagged: string[] = [];
  const now = (input.now ?? new Date()).toISOString();

  for (const tool of input.nextTools) {
    const hash = toolDefinitionHash(tool);
    const pinned = pins[tool.name];
    const high = (scan[tool.name] ?? []).some((finding) => finding.severity === 'high');
    if (high) flagged.push(tool.name);
    if (pinned === hash) continue;

    const mustWait = high || (!input.operatorChange && policy === 'approve');
    if (!mustWait) {
      pins[tool.name] = hash;
      continue;
    }
    const earlier = previousReview[tool.name];
    // The APPROVED definition is the baseline of the diff: an earlier pending entry
    // already holds it; otherwise it is what was stored until this discovery.
    const previous = pinned === undefined
      ? undefined
      : earlier?.previous ?? previousSnapshot(previousByName.get(tool.name));
    review[tool.name] = {
      reason: high ? 'scan' : pinned === undefined ? 'new' : 'changed',
      hash,
      ...(pinned !== undefined ? { previousHash: pinned } : {}),
      ...(previous ? { previous } : {}),
      detectedAt: earlier?.hash === hash ? earlier.detectedAt : now,
    };
    if (earlier?.hash !== hash) newlyPending.push(tool.name);
  }

  // A tool that is gone keeps no pin: if it comes back, it is new again.
  for (const name of Object.keys(pins)) if (!nextNames.has(name)) delete pins[name];

  metadata.toolPins = stored(pins);
  if (Object.keys(review).length) metadata.toolReview = stored(review);
  else delete metadata.toolReview;
  if (Object.keys(scan).length) metadata.toolScan = stored(scan);
  else delete metadata.toolScan;
  return { metadata, added, removed, changed, newlyPending, flagged };
}

/**
 * A tool named in a review decision. With `hash` (the `hash` of its review
 * entry), the decision holds only for the definition the reviewer saw.
 */
export type ToolReviewItem = string | { name: string; hash: string };

export interface ToolReviewDecision {
  approve?: ToolReviewItem[];
  reject?: ToolReviewItem[];
}

/**
 * Apply an operator's review decision. Approving pins the tool's current
 * definition. Rejecting pins it too (so the same definition is not raised
 * again) and disables the tool; enabling it later is a separate, explicit act.
 * Names that are not waiting for review are ignored. A tool whose definition
 * is no longer the one the decision names is left waiting and listed in
 * `stale`.
 */
export function applyToolReviewDecision(
  metadata: Metadata | undefined,
  tools: IMcpTool[],
  decision: ToolReviewDecision,
): { metadata: Metadata; approved: string[]; rejected: string[]; stale: string[] } {
  const next: Metadata = { ...(metadata ?? {}) };
  const review = getToolReview(metadata);
  const pins = getToolPins(metadata)
    ?? nameMap(tools.map((tool) => [tool.name, toolDefinitionHash(tool)] as const));
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const disabled = new Set(Array.isArray(next.disabledTools) ? (next.disabledTools as string[]) : []);
  const approved: string[] = [];
  const rejected: string[] = [];
  const stale = new Set<string>();

  const settle = (item: ToolReviewItem): boolean => {
    const name = typeof item === 'string' ? item : item.name;
    const tool = byName.get(name);
    const entry = hasName(review, name) ? review[name] : undefined;
    if (!entry || !tool) return false;
    const current = toolDefinitionHash(tool);
    if (entry.hash !== current || (typeof item !== 'string' && item.hash !== current)) {
      stale.add(name);
      return false;
    }
    pins[name] = current;
    delete review[name];
    return true;
  };
  for (const item of decision.approve ?? []) {
    if (settle(item)) approved.push(typeof item === 'string' ? item : item.name);
  }
  for (const item of decision.reject ?? []) {
    if (settle(item)) {
      const name = typeof item === 'string' ? item : item.name;
      disabled.add(name);
      rejected.push(name);
    }
  }

  next.toolPins = stored(pins);
  if (Object.keys(review).length) next.toolReview = stored(review);
  else delete next.toolReview;
  if (rejected.length) next.disabledTools = [...disabled];
  return { metadata: next, approved, rejected, stale: [...stale] };
}
