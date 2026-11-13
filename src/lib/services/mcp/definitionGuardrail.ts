/**
 * A guardrail chosen to check an MCP server's tool definitions, next to the
 * deterministic scan (definitionScan.ts). A definition is text from outside
 * that the model reads, so the guardrail's input checks (`input.pre`) and its
 * tool-result checks (`tool.post`) run on each definition: name, title,
 * description and the strings of its input schema. Tool access rules do not
 * run: a definition is not a call.
 *
 * What a finding does follows the guardrail's own mode:
 *   · a block (enforce mode): a high finding, so the tool waits for review,
 *     even an approved one when this definition was not blocked before;
 *   · a block the guardrail only reports (monitor mode): a medium finding;
 *   · any other finding: a low finding.
 * Findings are shown on the server's Security tab; the evaluations are in the
 * guardrail's evaluation log (source `mcp-definition`).
 *
 * Results are kept per tool with the hash of the definition they were made for
 * (`metadata.definitionGuardrail.checked`), so a refresh checks only new and
 * changed definitions. Saving the selection checks every tool again.
 */
import { randomUUID } from 'node:crypto';
import type { IMcpTool, McpSourceType } from '@/lib/database';
import {
  GUARDRAIL_CONTRACT_VERSION,
  POLICY_FAMILIES,
  textSubject,
  toolResultSubject,
} from '@/lib/services/guardrail/hooks/contract';
import type { HookScope, HookSubject, HookVerdict } from '@/lib/services/guardrail/hooks/contract';
import { runHook } from '@/lib/services/guardrail/hooks/engine';
import { createLogger } from '@/lib/core/logger';
import type { McpDefinitionFinding, McpDefinitionSeverity } from './definitionScan';
import { isPinnedSource, toolDefinitionHash } from './toolSecurity';

const logger = createLogger('mcp-definition-guardrail');

type Metadata = Record<string, unknown>;

const MAX_FINDINGS_PER_TOOL = 4;
const MAX_EXCERPT_CHARS = 200;
/** Text families only: tool access rules judge calls, not definitions. */
const DEFINITION_FAMILIES = POLICY_FAMILIES.filter((family) => family !== 'tool_access');
const DEFINITION_HOOKS = ['input.pre', 'tool.post'] as const;

export interface McpDefinitionGuardrailCheck {
  /** Hash of the definition this result was made for. */
  hash: string;
  findings: McpDefinitionFinding[];
  /** The guardrail blocked this definition (enforce mode). */
  blocked?: boolean;
}

export interface McpDefinitionGuardrail {
  guardrailKey: string;
  /** Results of the last check, keyed by the real tool name. */
  checked?: Record<string, McpDefinitionGuardrailCheck>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Keyed by names the upstream chose: no prototype, so `__proto__` is an ordinary key. */
function nameMap<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function hasName(map: Record<string, unknown>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(map, name);
}

/** The guardrail selected to check this server's tool definitions, or undefined when none is. */
export function getDefinitionGuardrail(metadata: Metadata | undefined): McpDefinitionGuardrail | undefined {
  const raw = metadata?.definitionGuardrail;
  if (!isRecord(raw) || typeof raw.guardrailKey !== 'string' || !raw.guardrailKey) return undefined;
  const checked = nameMap<McpDefinitionGuardrailCheck>();
  if (isRecord(raw.checked)) {
    for (const [name, entry] of Object.entries(raw.checked)) {
      if (!isRecord(entry) || typeof entry.hash !== 'string' || !Array.isArray(entry.findings)) continue;
      checked[name] = {
        hash: entry.hash,
        findings: entry.findings as McpDefinitionFinding[],
        ...(entry.blocked === true ? { blocked: true } : {}),
      };
    }
  }
  return { guardrailKey: raw.guardrailKey, checked };
}

/** What the model reads of a definition, as the strings the guardrail checks. */
function definitionText(tool: IMcpTool): Record<string, unknown> {
  return {
    name: tool.name,
    ...(tool.title ? { title: tool.title } : {}),
    ...(tool.description ? { description: tool.description } : {}),
    ...(tool.annotations?.title ? { annotations: { title: tool.annotations.title } } : {}),
    ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
  };
}

/** `/result/inputSchema/properties/q/description` → `inputSchema.properties.q.description`. */
function fieldOf(path: string | undefined): string {
  if (!path || !path.startsWith('/result/')) return 'definition';
  return path
    .slice('/result/'.length)
    .split('/')
    .map((token) => token.replace(/~1/g, '/').replace(/~0/g, '~'))
    .join('.');
}

function excerptOf(guardrailName: string, message: string): string {
  const text = `${guardrailName}: ${message}`.replace(/\s+/g, ' ').trim();
  return text.length > MAX_EXCERPT_CHARS ? `${text.slice(0, MAX_EXCERPT_CHARS - 1)}…` : text;
}

function findingsOf(verdict: HookVerdict<HookSubject>): { findings: McpDefinitionFinding[]; blocked: boolean } {
  const blocked = verdict.decision === 'block';
  const reported = !blocked && verdict.wouldBeDecision === 'block';
  const name = verdict.guardrailName || verdict.guardrailKey || 'Guardrail';
  const findings = verdict.findings.map((finding): McpDefinitionFinding => {
    const severity: McpDefinitionSeverity = finding.block && blocked ? 'high' : finding.block && reported ? 'medium' : 'low';
    return {
      rule: `guardrail:${finding.category || finding.family}`,
      severity,
      field: fieldOf(finding.path),
      excerpt: excerptOf(name, finding.message),
    };
  });
  return { findings, blocked };
}

async function checkDefinition(
  tool: IMcpTool,
  input: { tenantDbName: string; tenantId: string; projectId?: string; serverKey: string; guardrailKey: string },
): Promise<{ findings: McpDefinitionFinding[]; blocked: boolean }> {
  const text = definitionText(tool);
  const toolName = `${input.serverKey}/${tool.name}`;
  const providerRef = `mcp:${input.serverKey}`;
  const scope: HookScope = {
    tenantId: input.tenantId,
    tenantDbName: input.tenantDbName,
    projectId: input.projectId,
    actor: { id: 'mcp-definition-check', kind: 'system', roles: ['mcp'] },
    surface: 'mcp',
    source: 'mcp-definition',
    traceId: randomUUID(),
  };
  const resultSubject = toolResultSubject({ toolName, args: {}, result: text, providerRef });
  const subjects: Record<(typeof DEFINITION_HOOKS)[number], HookSubject> = {
    'input.pre': textSubject(resultSubject.text, '/definition'),
    'tool.post': resultSubject,
  };

  const findings: McpDefinitionFinding[] = [];
  let blocked = false;
  for (const hook of DEFINITION_HOOKS) {
    const verdict = await runHook({
      contractVersion: GUARDRAIL_CONTRACT_VERSION,
      hook,
      subject: subjects[hook],
      scope,
      guardrailKeys: [input.guardrailKey],
      only: DEFINITION_FAMILIES,
    });
    const outcome = findingsOf(verdict);
    findings.push(...outcome.findings);
    blocked ||= outcome.blocked;
  }
  const order: Record<McpDefinitionSeverity, number> = { high: 0, medium: 1, low: 2 };
  return {
    findings: findings.sort((a, b) => order[a.severity] - order[b.severity]).slice(0, MAX_FINDINGS_PER_TOOL),
    blocked,
  };
}

export interface DefinitionGuardrailCheckResult {
  /** The metadata with this check's results stored. */
  metadata: Metadata;
  /** The guardrail's findings per tool, for the current definitions. */
  findings: Record<string, McpDefinitionFinding[]>;
  /** Tools whose current definition the guardrail now blocks and did not block before. */
  newlyBlocked: string[];
}

/**
 * Check the tool definitions with the server's definition guardrail, if one is
 * selected. Only definitions without a result for their hash are checked,
 * unless `all` is set. A definition the guardrail cannot evaluate (the
 * guardrail was deleted) yields no findings.
 */
export async function checkToolDefinitionsWithGuardrail(input: {
  tenantDbName: string;
  tenantId: string;
  projectId?: string;
  serverKey: string;
  sourceType: McpSourceType;
  metadata: Metadata | undefined;
  tools: IMcpTool[];
  /** Check every definition again (the selection was just saved). */
  all?: boolean;
}): Promise<DefinitionGuardrailCheckResult> {
  const metadata: Metadata = { ...(input.metadata ?? {}) };
  const findings = nameMap<McpDefinitionFinding[]>();
  const selection = getDefinitionGuardrail(metadata);
  if (!selection || !isPinnedSource(input.sourceType)) {
    if (!selection) delete metadata.definitionGuardrail;
    return { metadata, findings, newlyBlocked: [] };
  }

  const before = selection.checked ?? nameMap<McpDefinitionGuardrailCheck>();
  const checked = nameMap<McpDefinitionGuardrailCheck>();
  const newlyBlocked: string[] = [];
  for (const tool of input.tools) {
    const hash = toolDefinitionHash(tool);
    const earlier = hasName(before, tool.name) && before[tool.name].hash === hash ? before[tool.name] : undefined;
    let entry = !input.all ? earlier : undefined;
    if (!entry) {
      const outcome = await checkDefinition(tool, { ...input, guardrailKey: selection.guardrailKey });
      entry = { hash, findings: outcome.findings, ...(outcome.blocked ? { blocked: true } : {}) };
    }
    checked[tool.name] = entry;
    if (entry.findings.length) findings[tool.name] = entry.findings;
    if (entry.blocked && !earlier?.blocked) newlyBlocked.push(tool.name);
  }
  if (newlyBlocked.length) {
    logger.warn('Guardrail blocks MCP tool definitions', {
      tenantId: input.tenantId,
      serverKey: input.serverKey,
      guardrailKey: selection.guardrailKey,
      tools: newlyBlocked.slice(0, 20),
    });
  }

  metadata.definitionGuardrail = {
    guardrailKey: selection.guardrailKey,
    checked: Object.fromEntries(Object.entries(checked)),
  };
  return { metadata, findings, newlyBlocked };
}
