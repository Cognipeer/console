/**
 * Deterministic scan of MCP tool definitions for text aimed at the model
 * rather than at the operator: hidden characters, instructions that override
 * or conceal, directives about other tools, requests for local secrets.
 *
 * Runs on every discovery; pure and cheap. A `high` finding keeps the tool
 * out of reach until an operator approves it (see toolSecurity.ts); `medium`
 * and `low` findings are shown on the server's Security tab only.
 */
import type { IMcpTool } from '@/lib/database';

export type McpDefinitionSeverity = 'high' | 'medium' | 'low';

export interface McpDefinitionFinding {
  rule: string;
  severity: McpDefinitionSeverity;
  /** Where in the definition: `name`, `title`, `description`, `annotations.title`, `inputSchema.<path>`. */
  field: string;
  /** The matched text with some context; hidden characters are shown escaped. */
  excerpt: string;
}

interface TextRule {
  rule: string;
  severity: McpDefinitionSeverity;
  pattern: RegExp;
}

const MAX_FINDINGS_PER_TOOL = 8;
const MAX_TEXT_CHARS = 20_000;
const MAX_SCHEMA_STRINGS = 400;
const OVERSIZED_DESCRIPTION_CHARS = 8_000;

/** Unicode tag characters and bidirectional overrides: no legitimate use in a tool definition. */
const SMUGGLING_CHARS = /[‪-‮⁦-⁩]|[\u{E0000}-\u{E007F}]/u;
/** Zero-width and soft characters: occasionally pasted by accident, so one or two are only noted. */
const ZERO_WIDTH_CHARS = /[­᠎​-‍⁠-⁤﻿]/gu;

const TEXT_RULES: TextRule[] = [
  {
    rule: 'instruction-override',
    severity: 'high',
    pattern: /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,30}?\b(?:all|any|previous|prior|above|earlier|preceding|system|your|other)\b[^.\n]{0,20}?\b(?:instructions?|prompts?|rules|guidelines|directives)\b/i,
  },
  {
    rule: 'instruction-override',
    severity: 'high',
    pattern: /(?:önceki|yukarıdaki|tüm|bütün|diğer)\s+(?:talimat|komut|kural|yönerge)\S*\s+(?:yok\s*say|görmezden\s*gel|unut|dikkate\s*alma)/i,
  },
  {
    rule: 'concealment',
    severity: 'high',
    pattern: /\b(?:do\s+not|don['’]t|never|without)\s+(?:tell(?:ing)?|inform(?:ing)?|mention(?:ing)?|reveal(?:ing)?|show(?:ing)?|notify(?:ing)?|alert(?:ing)?)\b[^.\n]{0,25}?\b(?:the\s+)?(?:user|human|operator)s?\b/i,
  },
  {
    rule: 'concealment',
    severity: 'high',
    pattern: /kullanıcıya\s+(?:söyleme|bahsetme|gösterme|bildirme|haber\s+verme)/i,
  },
  {
    rule: 'hidden-markup',
    severity: 'medium',
    pattern: /<\s*\/?\s*(?:important|system|instructions?|secret|hidden|admin|override)\s*>/i,
  },
  {
    rule: 'role-marker',
    severity: 'medium',
    pattern: /(?:^|\n)\s*(?:system|assistant)\s*:|<\|im_start\|>|\[\/?INST\]/i,
  },
  {
    rule: 'sensitive-file',
    severity: 'medium',
    pattern: /~\/\.ssh|\bid_(?:rsa|ed25519|ecdsa)\b|\.aws\/credentials|\/etc\/(?:passwd|shadow)|\.kube\/config|\.npmrc|\.netrc|\bmcp\.json\b/i,
  },
  {
    rule: 'conversation-exfiltration',
    severity: 'medium',
    pattern: /\b(?:send|forward|upload|post|transmit|include|append|attach|pass|copy)\b[^.\n]{0,40}?\b(?:system\s+prompt|conversation\s+history|chat\s+history|previous\s+messages|all\s+messages|entire\s+conversation|full\s+conversation)\b/i,
  },
  {
    rule: 'cross-tool-directive',
    severity: 'medium',
    pattern: /\b(?:before|after|instead\s+of|whenever)\s+(?:using|calling|invoking|running)\s+(?:any|every|all|other|another|the\s+other)\b[^.\n]{0,30}?\btools?\b/i,
  },
  {
    rule: 'encoded-payload',
    severity: 'medium',
    pattern: /[A-Za-z0-9+/]{200,}={0,2}/,
  },
];

function escapeHidden(text: string): string {
  return text.replace(/[­᠎​-‏‪-‮⁠-⁩﻿]|[\u{E0000}-\u{E007F}]/gu,
    (ch) => `\\u{${ch.codePointAt(0)!.toString(16).toUpperCase()}}`);
}

function excerptAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + length + 40);
  const raw = `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
  const escaped = escapeHidden(raw).replace(/\s+/g, ' ');
  return escaped.length > 200 ? `${escaped.slice(0, 199)}…` : escaped;
}

function scanText(field: string, value: string, out: McpDefinitionFinding[]): void {
  const text = value.length > MAX_TEXT_CHARS ? value.slice(0, MAX_TEXT_CHARS) : value;
  const smuggled = SMUGGLING_CHARS.exec(text);
  if (smuggled) {
    out.push({ rule: 'hidden-characters', severity: 'high', field, excerpt: excerptAround(text, smuggled.index, 1) });
  }
  const zeroWidth = [...text.matchAll(ZERO_WIDTH_CHARS)];
  if (zeroWidth.length) {
    out.push({
      rule: 'hidden-characters',
      // A run of them hides text; one or two are usually a paste artefact.
      severity: zeroWidth.length >= 3 ? 'high' : 'low',
      field,
      excerpt: excerptAround(text, zeroWidth[0].index ?? 0, 1),
    });
  }
  for (const { rule, severity, pattern } of TEXT_RULES) {
    const match = pattern.exec(text);
    if (match) out.push({ rule, severity, field, excerpt: excerptAround(text, match.index, match[0].length) });
  }
}

function collectSchemaStrings(
  node: unknown,
  path: string,
  out: Array<{ field: string; value: string }>,
  depth: number,
): void {
  if (out.length >= MAX_SCHEMA_STRINGS || depth > 12) return;
  if (typeof node === 'string') {
    out.push({ field: path, value: node });
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item, index) => collectSchemaStrings(item, `${path}[${index}]`, out, depth + 1));
    return;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      // Property NAMES reach the model too: check them for hidden characters.
      if (SMUGGLING_CHARS.test(key) || ZERO_WIDTH_CHARS.test(key)) out.push({ field: `${path}.<key>`, value: key });
      ZERO_WIDTH_CHARS.lastIndex = 0;
      collectSchemaStrings(value, `${path}.${key}`, out, depth + 1);
    }
  }
}

/** Findings of one tool definition (empty when nothing stands out). */
export function scanToolDefinition(tool: IMcpTool): McpDefinitionFinding[] {
  const findings: McpDefinitionFinding[] = [];
  scanText('name', tool.name ?? '', findings);
  if (tool.title) scanText('title', tool.title, findings);
  if (tool.description) {
    scanText('description', tool.description, findings);
    if (tool.description.length > OVERSIZED_DESCRIPTION_CHARS) {
      findings.push({
        rule: 'oversized-description',
        severity: 'low',
        field: 'description',
        excerpt: `${tool.description.length} characters`,
      });
    }
  }
  if (tool.annotations?.title) scanText('annotations.title', tool.annotations.title, findings);
  const schemaStrings: Array<{ field: string; value: string }> = [];
  collectSchemaStrings(tool.inputSchema, 'inputSchema', schemaStrings, 0);
  for (const { field, value } of schemaStrings) scanText(field, value, findings);

  const order: Record<McpDefinitionSeverity, number> = { high: 0, medium: 1, low: 2 };
  return findings.sort((a, b) => order[a.severity] - order[b.severity]).slice(0, MAX_FINDINGS_PER_TOOL);
}

/** Findings per tool, keyed by the real tool name; tools without findings are absent. */
export function scanToolDefinitions(tools: IMcpTool[]): Record<string, McpDefinitionFinding[]> {
  const out: Record<string, McpDefinitionFinding[]> = {};
  for (const tool of tools) {
    const findings = scanToolDefinition(tool);
    if (findings.length) out[tool.name] = findings;
  }
  return out;
}
