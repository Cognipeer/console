/**
 * What a trigger's webhook reads from a delivery: one bounded view of
 * it (filters, the `events` check and the prompt template all see the same
 * copy), the filter rules over that view, the Mustache prompt template and the
 * mapping of declared inputs.
 *
 * The view is a deep copy with null prototypes and caps on size (arrays,
 * strings, depth, node count), so a lookup only ever reaches data the sender
 * sent, and the cost of a filter or a template is bounded whatever the payload.
 * A template inserts every value as JSON (strings quoted, line separators
 * escaped), so text from the event cannot add lines to the prompt or pose as
 * its structure.
 */

import Mustache from 'mustache';
import type { AgentTriggerWebhookFilterRule, IAgentInputField } from '@/lib/database';
import { resolveRunInputs, type InputIssue } from './agentInputs';

// ── Bounds ───────────────────────────────────────────────────────────────

export const VIEW_MAX_ARRAY_ITEMS = 100;
export const VIEW_MAX_STRING_LENGTH = 8 * 1024;
export const VIEW_MAX_DEPTH = 16;
export const VIEW_MAX_NODES = 5_000;

export const TEMPLATE_MAX_LENGTH = 16 * 1024;
const TEMPLATE_MAX_SECTION_DEPTH = 2;
/** Characters a render may produce before it stops (the result is cut to `RENDERED_MAX_LENGTH` after). */
const RENDER_OUTPUT_BUDGET = 128_000;
export const RENDERED_MAX_LENGTH = 32_000;

export const FILTER_MAX_RULES = 20;
const PATH_MAX_SEGMENTS = 16;
const PATH_MAX_LENGTH = 256;
const FILTER_MAX_IN_ITEMS = 50;
const FILTER_MAX_VALUE_LENGTH = 1024;
const GLOB_MAX_PATTERN_LENGTH = 256;

/** The names a delivery's context has at its top. */
export const WEBHOOK_CONTEXT_ROOTS = ['payload', 'headers', 'event', 'delivery_id', 'preset', 'received_at', 'trigger', 'agent'] as const;
const ROOTS: ReadonlySet<string> = new Set(WEBHOOK_CONTEXT_ROOTS);

/** Property names a path may not use (they name built-ins, not data). */
const FORBIDDEN_SEGMENTS: ReadonlySet<string> = new Set([
  'constructor', 'prototype', '__proto__', 'hasOwnProperty', '__defineGetter__', '__defineSetter__',
  '__lookupGetter__', '__lookupSetter__', 'toString', 'valueOf',
]);
const SEGMENT_RE = /^[A-Za-z0-9_-]+$/;

// ── JSON text ────────────────────────────────────────────────────────────

/**
 * `JSON.stringify` with the line separators JavaScript tolerates inside
 * strings (U+2028, U+2029, U+0085) and the backtick escaped: the text stays
 * the same JSON value, but cannot end a line or a fenced block.
 */
export function jsonText(value: unknown): string {
  return (JSON.stringify(value) ?? 'null')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
    .replace(/\u0085/g, '\\u0085')
    .replace(/`/g, '\\u0060');
}

// ── Bounded view ─────────────────────────────────────────────────────────

/** A null-prototype object: a lookup finds only its own keys. */
export function bareObject<T extends Record<string, unknown>>(entries: T): T {
  return Object.assign(Object.create(null) as T, entries);
}

/**
 * A deep copy of parsed JSON within the view bounds: arrays cut to their first
 * 100 items, strings to 8 KiB, nothing below depth 16, at most 5 000 nodes in
 * all (what does not fit is left out). Objects and arrays have no prototype;
 * `Array.isArray` and `JSON.stringify` still treat the arrays as arrays.
 */
export function boundedView(value: unknown): unknown {
  const budget = { nodes: VIEW_MAX_NODES };
  const copy = (node: unknown, depth: number): unknown => {
    if (budget.nodes <= 0) return undefined;
    budget.nodes -= 1;
    if (node === null || typeof node !== 'object') {
      return typeof node === 'string' && node.length > VIEW_MAX_STRING_LENGTH ? node.slice(0, VIEW_MAX_STRING_LENGTH) : node;
    }
    if (depth >= VIEW_MAX_DEPTH) return undefined;
    if (Array.isArray(node)) {
      const out: unknown[] = [];
      const length = Math.min(node.length, VIEW_MAX_ARRAY_ITEMS);
      for (let i = 0; i < length && budget.nodes > 0; i += 1) {
        const item = copy(node[i], depth + 1);
        out.push(item === undefined ? null : item);
      }
      Object.setPrototypeOf(out, null);
      return out;
    }
    const out = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(node)) {
      if (budget.nodes <= 0) break;
      const item = copy((node as Record<string, unknown>)[key], depth + 1);
      if (item !== undefined) out[key] = item;
    }
    return out;
  };
  return copy(value, 0);
}

/** A plain (prototype-bearing) copy of a view value, for storing it or handing it to code outside this module. */
function plainCopy(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

// ── Paths ────────────────────────────────────────────────────────────────

/** Why `path` is not a valid filter / template path, or null. `*` (every element) only where `allowWildcard`. */
export function pathProblem(path: string, options: { allowWildcard: boolean; requireRoot: boolean }): string | null {
  if (typeof path !== 'string' || path.length === 0) return 'path is required';
  if (path.length > PATH_MAX_LENGTH) return `path can be at most ${PATH_MAX_LENGTH} characters`;
  const segments = path.split('.');
  if (segments.length > PATH_MAX_SEGMENTS) return `path can have at most ${PATH_MAX_SEGMENTS} segments`;
  for (const segment of segments) {
    if (segment === '*') {
      if (!options.allowWildcard) return '"*" is only allowed in filter paths';
      continue;
    }
    if (!SEGMENT_RE.test(segment)) return `"${segment.slice(0, 40)}" is not a valid path segment (letters, digits, "_" and "-")`;
    if (FORBIDDEN_SEGMENTS.has(segment)) return `"${segment}" cannot be used in a path`;
  }
  if (options.requireRoot && !ROOTS.has(segments[0])) {
    return `path must start with one of: ${WEBHOOK_CONTEXT_ROOTS.join(', ')}`;
  }
  return null;
}

const own = (value: unknown, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
/** A plain array of a view array's items (a view array has no prototype, so no iterator). */
const items = (value: unknown[]): unknown[] => Array.prototype.slice.call(value);

/** One step down: an own property of an object, an index of an array; nothing on a scalar. */
function step(value: unknown, segment: string): { hit: boolean; value?: unknown } {
  if (value === null || typeof value !== 'object') return { hit: false };
  if (Array.isArray(value)) {
    if (!/^\d+$/.test(segment)) return { hit: false };
    const index = Number(segment);
    return index < value.length ? { hit: true, value: value[index] } : { hit: false };
  }
  return own(value, segment) ? { hit: true, value: (value as Record<string, unknown>)[segment] } : { hit: false };
}

/** The value at a path without `*`, and whether the whole path exists. */
function lookupPath(root: unknown, segments: string[]): { hit: boolean; value?: unknown } {
  let current: unknown = root;
  for (const segment of segments) {
    const next = step(current, segment);
    if (!next.hit) return { hit: false };
    current = next.value;
  }
  return { hit: true, value: current };
}

/** A filter path's value: a single value, or with `*` the list of every value found (absent ones left out). */
export function resolveFilterPath(root: unknown, path: string): { list: boolean; value: unknown } {
  let current: unknown[] = [root];
  let list = false;
  for (const segment of path.split('.')) {
    const next: unknown[] = [];
    for (const value of current) {
      if (segment === '*') {
        if (Array.isArray(value)) next.push(...items(value));
      } else {
        const found = step(value, segment);
        if (found.hit) next.push(found.value);
      }
    }
    if (segment === '*') list = true;
    current = next;
  }
  return list ? { list: true, value: current } : { list: false, value: current[0] };
}

// ── Filter ───────────────────────────────────────────────────────────────

const FILTER_OPS: ReadonlySet<AgentTriggerWebhookFilterRule['op']> = new Set([
  'eq', 'neq', 'in', 'not_in', 'exists', 'not_exists', 'contains', 'starts_with', 'glob',
]);
const isScalar = (value: unknown): value is string | number | boolean =>
  typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean';

/** Filter rules from a request body (save time) → the rules to store, or the problems (`field` relative to the rules). */
export function parseFilterRules(value: unknown): { ok: true; rules: AgentTriggerWebhookFilterRule[] } | { ok: false; errors: InputIssue[] } {
  if (value === null || value === undefined) return { ok: true, rules: [] };
  if (!Array.isArray(value)) return { ok: false, errors: [{ field: 'filter', message: 'filter must be a list of rules { path, op, value? }' }] };
  if (value.length > FILTER_MAX_RULES) return { ok: false, errors: [{ field: 'filter', message: `filter can have at most ${FILTER_MAX_RULES} rules` }] };
  const errors: InputIssue[] = [];
  const rules: AgentTriggerWebhookFilterRule[] = [];
  value.forEach((raw, index) => {
    const at = `filter[${index}]`;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push({ field: at, message: 'a rule must be an object { path, op, value? }' });
      return;
    }
    const rule = raw as Record<string, unknown>;
    const problem = pathProblem(rule.path as string, { allowWildcard: true, requireRoot: true });
    if (problem) errors.push({ field: `${at}.path`, message: problem });
    const op = rule.op as AgentTriggerWebhookFilterRule['op'];
    if (!FILTER_OPS.has(op)) {
      errors.push({ field: `${at}.op`, message: `op must be one of: ${[...FILTER_OPS].join(', ')}` });
      return;
    }
    let ruleValue: AgentTriggerWebhookFilterRule['value'];
    if (op === 'exists' || op === 'not_exists') {
      if (rule.value !== undefined && rule.value !== null) errors.push({ field: `${at}.value`, message: `${op} takes no value` });
    } else if (op === 'in' || op === 'not_in') {
      const list = rule.value;
      if (!Array.isArray(list) || list.length === 0 || list.length > FILTER_MAX_IN_ITEMS || !list.every(isScalar)) {
        errors.push({ field: `${at}.value`, message: `${op} takes a list of 1 to ${FILTER_MAX_IN_ITEMS} strings, numbers or booleans` });
      } else if (list.some((item) => String(item).length > FILTER_MAX_VALUE_LENGTH)) {
        errors.push({ field: `${at}.value`, message: `each value can be at most ${FILTER_MAX_VALUE_LENGTH} characters` });
      } else ruleValue = list as Array<string | number | boolean>;
    } else if (!isScalar(rule.value)) {
      errors.push({ field: `${at}.value`, message: `${op} takes a string, number or boolean` });
    } else if (String(rule.value).length > (op === 'glob' ? GLOB_MAX_PATTERN_LENGTH : FILTER_MAX_VALUE_LENGTH)) {
      errors.push({ field: `${at}.value`, message: `value can be at most ${op === 'glob' ? GLOB_MAX_PATTERN_LENGTH : FILTER_MAX_VALUE_LENGTH} characters` });
    } else ruleValue = rule.value;
    if (!problem) rules.push({ path: rule.path as string, op, ...(ruleValue !== undefined ? { value: ruleValue } : {}) });
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, rules };
}

/**
 * `*` any run of characters, `?` one character, case-sensitive. Iterative with
 * one backtrack point (no RegExp), so its cost is at most pattern × value.
 */
export function globMatch(pattern: string, value: string): boolean {
  let p = 0;
  let v = 0;
  let star = -1;
  let mark = 0;
  while (v < value.length) {
    if (p < pattern.length && (pattern[p] === '?' || pattern[p] === value[v])) {
      p += 1;
      v += 1;
    } else if (p < pattern.length && pattern[p] === '*') {
      star = p;
      p += 1;
      mark = v;
    } else if (star !== -1) {
      p = star + 1;
      mark += 1;
      v = mark;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === '*') p += 1;
  return p === pattern.length;
}

/** One scalar against a positive op (eq, in, contains, starts_with, glob). Objects never match. */
function scalarMatches(op: AgentTriggerWebhookFilterRule['op'], value: unknown, expected: AgentTriggerWebhookFilterRule['value']): boolean {
  if (!isScalar(value)) return false;
  const text = String(value);
  switch (op) {
    case 'eq':
    case 'neq':
      return text === String(expected);
    case 'in':
    case 'not_in':
      return Array.isArray(expected) && expected.some((item) => String(item) === text);
    case 'contains':
      return text.includes(String(expected));
    case 'starts_with':
      return text.startsWith(String(expected));
    case 'glob':
      return globMatch(String(expected), text);
    default:
      return false;
  }
}

/** Does one rule match the view? Absent (undefined / null / an empty list) matches only `not_exists`. */
export function filterRuleMatches(view: unknown, rule: AgentTriggerWebhookFilterRule): boolean {
  const resolved = resolveFilterPath(view, rule.path);
  const list = resolved.list ? (resolved.value as unknown[]) : Array.isArray(resolved.value) ? items(resolved.value) : null;
  const absent = list ? list.filter((item) => item !== null && item !== undefined).length === 0 : resolved.value === null || resolved.value === undefined;
  if (rule.op === 'not_exists') return absent;
  if (absent) return false;
  if (rule.op === 'exists') return true;
  const candidates = list ?? [resolved.value];
  if (rule.op === 'neq' || rule.op === 'not_in') return !candidates.some((item) => scalarMatches(rule.op, item, rule.value));
  return candidates.some((item) => scalarMatches(rule.op, item, rule.value));
}

/** A short description of a value for a delivery reason: its type (and a string's length), never its text. */
function describeValue(view: unknown, path: string): string {
  const resolved = resolveFilterPath(view, path);
  const value = resolved.value;
  if (resolved.list || Array.isArray(value)) return `list, ${(value as unknown[]).length} items`;
  if (value === null || value === undefined) return 'absent';
  if (typeof value === 'string') return `string, ${value.length} chars`;
  return typeof value;
}

/** The first rule that does not match, as a delivery reason, or null when all match (AND, in order). */
export function firstFilterMiss(view: unknown, rules: ReadonlyArray<AgentTriggerWebhookFilterRule> | null | undefined): string | null {
  for (const [index, rule] of (rules ?? []).entries()) {
    if (!filterRuleMatches(view, rule)) {
      return `rule ${index + 1} (${rule.path} ${rule.op}) did not match (value: ${describeValue(view, rule.path)})`;
    }
  }
  return null;
}

// ── Template ─────────────────────────────────────────────────────────────

type TemplateToken = [string, string, number, number, TemplateToken[]?, ...unknown[]];

/** Why a prompt template cannot be saved, or null. See SPEC W5 for the rules. */
export function templateProblem(template: string): string | null {
  if (template.length > TEMPLATE_MAX_LENGTH) return `the template can be at most ${TEMPLATE_MAX_LENGTH} characters`;
  let tokens: TemplateToken[];
  try {
    tokens = new Mustache.Writer().parse(template) as unknown as TemplateToken[];
  } catch (error) {
    return `the template does not parse: ${error instanceof Error ? error.message.split('\n')[0].slice(0, 120) : 'syntax error'}`;
  }
  const walk = (list: TemplateToken[], depth: number): string | null => {
    for (const token of list) {
      const [type, name] = token;
      if (type === 'text' || type === '!') continue;
      if (type === '>') return 'partials ({{> …}}) are not allowed';
      if (type === '=') return 'changing the delimiters ({{= … =}}) is not allowed';
      if (type === '&' || type === '{') return 'unescaped tags ({{{…}}} and {{& …}}) are not allowed: every value is inserted as JSON';
      if (type !== 'name' && type !== '#' && type !== '^') return `"{{${type}" is not allowed`;
      if (!(depth > 0 && name === '.')) {
        const problem = pathProblem(name, { allowWildcard: false, requireRoot: depth === 0 });
        if (problem) return `{{${name.slice(0, 60)}}}: ${problem}`;
      }
      if (type === '#' || type === '^') {
        if (depth + 1 > TEMPLATE_MAX_SECTION_DEPTH) return `sections can be nested at most ${TEMPLATE_MAX_SECTION_DEPTH} deep`;
        const nested = walk(token[4] ?? [], depth + 1);
        if (nested) return nested;
      }
    }
    return null;
  };
  return walk(tokens, 0);
}

/** A render stopped: the template could not be applied, or its output passed the budget. */
export class WebhookTemplateError extends Error {
  constructor(readonly reason: 'template error' | 'template error: output too large') {
    super(reason);
    this.name = 'WebhookTemplateError';
  }
}

/** Looks up only own properties of the view (no prototype, no methods of a string or number). */
class ViewContext extends Mustache.Context {
  override push(view: unknown): Mustache.Context {
    return new ViewContext(view, this);
  }

  override lookup(name: string): unknown {
    if (name === '.') return this.view;
    const segments = name.split('.');
    // Innermost context first, then each enclosing one (a section's item, then the view).
    const visit = (context: Mustache.Context | undefined): unknown => {
      if (!context) return undefined;
      const found = lookupPath(context.view, segments);
      return found.hit ? found.value : visit(context.parent);
    };
    return visit(this);
  }
}

/** Every inserted value as JSON; a number or boolean as is. */
const escapeAsJson = (value: unknown): string =>
  (typeof value === 'number' || typeof value === 'boolean' ? String(value) : jsonText(value));

/**
 * Renders a (validated) template over a bounded view. Every tag's value goes
 * in as JSON; the output is counted while it is written and stops past the
 * budget. Throws `WebhookTemplateError`.
 */
export function renderWebhookTemplate(template: string, view: unknown): string {
  const writer = new Mustache.Writer();
  let written = 0;
  const count = <T>(value: T): T => {
    if (typeof value === 'string') {
      written += value.length;
      if (written > RENDER_OUTPUT_BUDGET) throw new WebhookTemplateError('template error: output too large');
    }
    return value;
  };
  const config = { escape: escapeAsJson };
  const escaped = writer.escapedValue.bind(writer);
  const raw = writer.rawValue.bind(writer);
  writer.escapedValue = (token, context) => count(escaped(token, context, config));
  // Unescaped tags are refused at save; should one get here it is escaped all the same.
  writer.unescapedValue = (token, context) => count(escaped(token, context, config));
  writer.rawValue = (token) => count(raw(token));
  try {
    return writer.render(template, new ViewContext(view), Object.create(null), config);
  } catch (error) {
    if (error instanceof WebhookTemplateError) throw error;
    throw new WebhookTemplateError('template error');
  }
}

/** A rendered prompt within its cap. */
export function capRendered(text: string): string {
  return text.length > RENDERED_MAX_LENGTH ? `${text.slice(0, RENDERED_MAX_LENGTH)}\n…[truncated]` : text;
}

// ── Inputs ───────────────────────────────────────────────────────────────

const EXACT_TAG_RE = /^\{\{\s*([^{}#^/!>&=\s][^{}\s]*)\s*\}\}$/;

/** The path of a value that is exactly one tag (`{{ payload.number }}`), else null. */
function exactTagPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return EXACT_TAG_RE.exec(value)?.[1] ?? null;
}

const looksLikeTemplate = (value: unknown): value is string => typeof value === 'string' && value.includes('{{');

/**
 * Save-time check of a webhook trigger's input mapping: every name is declared;
 * a string with tags is a valid template (no `*`); any other value has the
 * declared type; a required input without a default is mapped or given.
 */
export function inputMappingProblems(
  declared: ReadonlyArray<IAgentInputField> | undefined,
  mapping: Record<string, unknown> | null | undefined,
): InputIssue[] {
  const fields = declared ?? [];
  const given = mapping ?? {};
  const issues: InputIssue[] = [];
  const literals: Record<string, unknown> = {};
  const byName = new Map(fields.map((field) => [field.name, field]));
  for (const [name, value] of Object.entries(given)) {
    if (!byName.has(name)) {
      issues.push({ field: name, message: fields.length === 0 ? 'This agent declares no inputs' : 'Not an input of this agent' });
    } else if (looksLikeTemplate(value)) {
      const problem = templateProblem(value);
      if (problem) issues.push({ field: name, message: problem });
    } else {
      literals[name] = value;
    }
  }
  if (issues.length > 0) return issues;
  // Literals are checked as a request's inputs would be; a mapped name counts as given for `required`.
  const mapped = new Set(Object.keys(given).filter((name) => looksLikeTemplate(given[name])));
  const relaxed = fields.map((field) => (mapped.has(field.name) ? { ...field, required: false } : field));
  const resolved = resolveRunInputs(relaxed, Object.keys(literals).length > 0 ? literals : null);
  return resolved.ok ? [] : resolved.errors;
}

/** A string brought to the declared type (number, integer, boolean, json); other types and failures stay as they are. */
function coerce(type: IAgentInputField['type'] | undefined, value: unknown): { ok: true; value: unknown } | { ok: false; message: string } {
  if (typeof value !== 'string' || !type || type === 'string') return { ok: true, value };
  const text = value.trim();
  switch (type) {
    case 'number':
    case 'integer':
      return /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text) ? { ok: true, value: Number(text) } : { ok: true, value };
    case 'boolean':
      return text === 'true' ? { ok: true, value: true } : text === 'false' ? { ok: true, value: false } : { ok: true, value };
    case 'json':
      try {
        return { ok: true, value: JSON.parse(text) };
      } catch {
        return { ok: false, message: 'Must be JSON' };
      }
    default:
      return { ok: true, value };
  }
}

/**
 * The run's inputs from the trigger's mapping over the view: a value that is
 * exactly one tag takes the value at that path (its type kept); other strings
 * with tags are rendered (values as JSON); anything else is used as is. Then
 * strings are brought to the declared type, `overrides` (a Run now's literal
 * values, never rendered) go on top, and the result is checked like a
 * request's inputs. Throws `WebhookTemplateError` for a render that fails.
 */
export function mapWebhookInputs(
  declared: ReadonlyArray<IAgentInputField> | undefined,
  mapping: Record<string, unknown> | null | undefined,
  view: unknown,
  overrides?: Record<string, unknown> | null,
): { ok: true; inputs: Record<string, unknown> | null } | { ok: false; errors: InputIssue[]; reason: string } {
  const byName = new Map((declared ?? []).map((field) => [field.name, field]));
  const values: Record<string, unknown> = {};
  const errors: InputIssue[] = [];
  for (const [name, spec] of Object.entries(mapping ?? {})) {
    let value: unknown;
    const path = exactTagPath(spec);
    if (path) {
      const found = lookupPath(view, path.split('.'));
      value = found.hit ? plainCopy(found.value) : undefined;
    } else if (looksLikeTemplate(spec)) {
      value = renderWebhookTemplate(spec, view);
    } else {
      value = spec;
    }
    if (value === undefined || value === null) continue;
    const coerced = coerce(byName.get(name)?.type, value);
    if (!coerced.ok) errors.push({ field: name, message: coerced.message });
    else values[name] = coerced.value;
  }
  if (errors.length === 0) {
    const resolved = resolveRunInputs(declared, { ...values, ...(overrides ?? {}) });
    if (resolved.ok) return { ok: true, inputs: resolved.inputs };
    errors.push(...resolved.errors);
  }
  return { ok: false, errors, reason: `invalid inputs: ${errors[0].field}: ${errors[0].message}` };
}
