/**
 * `tool_access` — the deterministic tool-call gate.
 *
 * This is the enforcement plane's `ToolRule` evaluation, ported field for field
 * into community: allow/deny tool lists, per-tool `sideEffects`, `allowedRoles`,
 * allowed/denied egress domains, allowed/denied filesystem path prefixes,
 * `argumentSchemas` (the 12-line JSON-Schema subset validator) and the
 * `maxArgBytes` / `maxResultBytes` size caps. Message strings and finding codes
 * are kept verbatim wherever the semantics survive, so a migrated policy
 * produces the same audit rows it produced before.
 *
 * THREE DEFECTS IN THE ORIGINAL ARE FIXED HERE, and they are the reason this is
 * a port rather than a copy:
 *
 *  1. PATH MATCHING WAS RAW `startsWith`. `/safe/../etc/passwd` starts with
 *     `/safe`, so it satisfied an allow-list of `['/safe']` and walked straight
 *     out. Every path is now POSIX-normalised and resolved against `fsRoot`
 *     before any comparison, control characters and NUL are rejected outright,
 *     and prefix comparison is segment-boundary aware so `/safe` no longer
 *     matches `/safety`.
 *
 *  2. TARGETS WERE SCRAPED OUT OF EVERY STRING with a regex looking for
 *     `https?://` or a leading `/`. That missed `//evil.com`, `file:`, `data:`
 *     and scheme-less hosts while false-positiving on any prose containing a
 *     slash. DECLARED argument paths (`urlArgPaths` / `pathArgPaths`) are now
 *     authoritative and are checked FIRST; the old scrape survives only behind
 *     `scanUndeclaredStrings`, clamped to 'medium'/'flag' and never allowed to
 *     resolve DNS.
 *
 *  3. THERE WAS NO SSRF GUARD AT ALL — only a domain list. Declared URL
 *     arguments now go through `assertPublicUrl` from `@/lib/security/
 *     outboundFetch`, which is the ONE SSRF definition in this codebase
 *     (loopback / private / link-local / CGNAT / cloud-metadata, DNS-resolved,
 *     operator-allowlist aware). Writing a second definition here is how the
 *     two drift and how one of them silently stops covering a new range.
 *
 * ── AND TWO DEFECTS OF THE PORT ITSELF, FIXED IN A SECOND PASS ─────────────
 * An operator configured `deniedDomains: ['*']` and watched a tool call to
 * `https://admin.acme.internal/ops` come back clean. Two separate causes, and
 * either one alone was enough to make the whole domain plane look decorative:
 *
 *  4. `*` MEANT NOTHING IN A DOMAIN LIST. Tool NAMES had glob support
 *     (`nameMatches`); host lists were suffix/exact only, so `*` was a literal
 *     host nobody owns. `hostDenied` / `hostAllowed` now route an entry
 *     CONTAINING a `*` through the same compiler and the same cache
 *     `nameMatches` uses — anchored, with the literal parts regex-escaped so a
 *     dot stays a dot. An entry WITHOUT a `*` keeps exactly the semantics it
 *     had, because every stored policy is written in those semantics.
 *
 *  5. A URL IN AN ARGUMENT WAS NOT DISCOVERED AT ALL. The exact host failed
 *     too: with `urlArgPaths` empty and `scanUndeclaredStrings` off (its
 *     default), the domain lists were consulted about nothing. `discoverTargets`
 *     now reads the argument strings directly — see the block above it for why
 *     that is a DECLARED-grade signal at the tool hooks and not a scrape.
 *
 * DELIBERATELY NOT PORTED: `limits.perActorPerMinute` and
 * `limits.perToolPerMinute`. The original limiter was a per-process `Map`, so
 * under N replicas it enforced N x the configured limit and every deploy reset
 * every window — a control that reports enforcement it does not deliver is
 * worse than no control, because operators stop looking. Re-introducing rate
 * limiting needs a SHARED counter store (Redis, or a `guardrail_rate_counters`
 * collection with a TTL index) and a decision about what to do when that store
 * is unreachable; until then the field is absent rather than silently wrong.
 *
 * PURITY: this family reports findings. It never decides the verdict. The
 * engine folds `SafetyFinding.action` across every policy into one decision and
 * neutralises it in monitor mode. The single place this family reads an action
 * out of its own config is `sideEffectActions`, which exists precisely so a
 * `destructive` side effect can warn while a deny-list hit blocks under the
 * same guardrail.
 */

import { posix as posixPath } from 'node:path';

import { assertPublicUrl, OutboundNetworkError } from '@/lib/security/outboundFetch';

import {
  LEGACY_FINDING_TYPE,
  escapePointerToken,
  isPlainRecord,
  toLegacyAction,
  walkStringLeaves,
} from '../hooks/contract';
import type {
  PolicyFamily,
  GuardrailPolicy,
  HookId,
  HookScope,
  HookSubject,
  JsonSchemaLite,
  Mutation,
  SafetyAction,
  SafetyFinding,
  SideEffect,
  ToolAccessPolicyConfig,
} from '../hooks/contract';

// ── The family run contract ─────────────────────────────────────────────────
/**
 * Every policy family exports one function of this shape so the engine can
 * dispatch on `policy.family` without knowing anything else about the family.
 *
 * NOTE: `hooks/contract.ts` describes the hook plane but does not declare this
 * shape, so it is declared here and should be hoisted to a shared
 * `families/types.ts` (or into the contract) once more than one family exists —
 * see the report accompanying this file.
 */
export interface FamilyRunInput<C extends GuardrailPolicy = GuardrailPolicy> {
  policy: C;
  hook: HookId;
  subject: HookSubject;
  scope: HookScope;
  /**
   * The action the engine already resolved for THIS policy
   * (`policy.action ?? record.action`). Families stamp it onto their findings
   * and never choose it — choosing is the fold, and the fold is the engine's.
   */
  action: SafetyAction;
}

export interface FamilyRunResult {
  findings: SafetyFinding[];
  mutations: Mutation[];
  /** Sub-policies that could not run. The engine applies `failMode` to these. */
  degraded?: Array<{ policyId: string; family: PolicyFamily; reason: string }>;
}

export type FamilyRunner<C extends GuardrailPolicy = GuardrailPolicy> = (
  input: FamilyRunInput<C>,
) => Promise<FamilyRunResult>;

// ── Constants ───────────────────────────────────────────────────────────────

const FAMILY: PolicyFamily = 'tool_access';

/** `tool_access` persists as the legacy `custom` type — see LEGACY_FINDING_TYPE. */
const LEGACY_TYPE = LEGACY_FINDING_TYPE.tool_access;

/**
 * The original hardcoded 'external' for any tool it had no entry for, which
 * made every unknown tool suspicious and buried the genuinely dangerous ones in
 * noise. 'read' is the honest default for an undeclared tool.
 */
const DEFAULT_SIDE_EFFECT: SideEffect = 'read';

/**
 * Side effect -> action when the operator declares none. `destructive` and
 * `external` warn rather than block because that reproduces what the original
 * ACTUALLY did: those two resolved to a `sandbox` decision whose adapter is a
 * pass-through, so the tool ran anyway. An operator who wants the stricter
 * posture sets `sideEffectActions.destructive = 'block'`.
 */
const DEFAULT_SIDE_EFFECT_ACTIONS: Readonly<Record<SideEffect, SafetyAction>> = {
  none: 'allow',
  read: 'allow',
  write: 'allow',
  destructive: 'warn',
  external: 'warn',
};

/** Risk weight of each side effect, independent of what the operator does about it. */
const SIDE_EFFECT_SEVERITY: Readonly<Record<SideEffect, SafetyFinding['severity']>> = {
  none: 'low',
  read: 'low',
  write: 'medium',
  destructive: 'high',
  external: 'high',
};

/**
 * JSON-bomb defence, and hard-capped at 32 rather than merely defaulted to it:
 * `walkStringLeaves` in the contract stops descending at 32, so a policy
 * declaring 64 would advertise a scan depth the subject builder never reaches.
 * The two constants are pinned to each other; changing one requires changing
 * the other.
 */
const MAX_ARG_DEPTH = 32;

/**
 * DNS budget for the SSRF guard. Each declared URL costs a resolution (cached
 * for 30s inside outboundFetch), and a tool argument carrying a hundred URLs
 * would otherwise turn one tool call into a hundred serial lookups on the
 * blocking path. Anything past the cap is reported as degraded, never as safe.
 */
const MAX_URL_DNS_CHECKS = 16;

/** Fan-out cap for a wildcard argument spec (`attachments.*.url`). */
const MAX_SPEC_MATCHES = 256;

/** The clamped part of the clamped fallback scrape. */
const MAX_SCRAPE_CANDIDATES = 200;
const MAX_SCRAPE_CHARS_PER_SEGMENT = 8192;

/**
 * Fan-out cap for undeclared argument discovery. It walks the same string
 * leaves the subject builder already walked (bounded by `MAX_WALK_DEPTH`), so
 * this only bounds BREADTH — a thousand-element array of urls costs at most
 * this many parses, and anything past it still reaches the declared path and
 * the SSRF budget, which report their own overflow.
 */
const MAX_DISCOVERED_VALUES = 256;

/** The original scrape, verbatim. Kept exactly so `scanUndeclaredStrings`
 *  reproduces the old behaviour and not a new approximation of it. */
const SCRAPE_PATTERN = /https?:\/\/[^\s"']+|(?:^|\s)(\/[^\s"']+)/g;

/** NUL plus C0/C1 controls. In a path argument these are an attack signature,
 *  not a typo: `"/safe/x\0/../../etc/passwd"` truncates in a C string. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

// ── Glob matching ───────────────────────────────────────────────────────────

const globCache = new Map<string, RegExp>();

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * THE ONE GLOB COMPILER. Tool names and host names both come through here, so
 * there is one answer to "what does `*` mean" and one cache holding it.
 *
 * ANCHORED, and every literal run is regex-escaped: without the escape a dot in
 * `api.example.com` would be "any character" and the pattern would match
 * `apiXexample.com`, which for an ALLOW list is a hole and for a DENY list is a
 * surprise. `*` is the only metacharacter, and it spans any run of characters
 * including dots and slashes.
 */
function compileGlob(pattern: string): RegExp {
  let regex = globCache.get(pattern);
  if (!regex) {
    regex = new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`);
    // Patterns come from stored policy, so the key space is small and bounded
    // by the tenant's own config; the cap only guards against a pathological row.
    if (globCache.size < 512) globCache.set(pattern, regex);
  }
  return regex;
}

/**
 * Exact match, or a `*` glob. The original special-cased exactly one pattern —
 * `deny.includes('*')` — and this is the minimal generalisation of it: `*`
 * still denies everything, and `github/*` now means what an operator staring at
 * a list of `${serverKey}/${tool}` names already assumes it means.
 */
function nameMatches(pattern: string, name: string): boolean {
  if (pattern === name) return true;
  if (!pattern.includes('*')) return false;
  return compileGlob(pattern).test(name);
}

/**
 * Look a tool up in one of the per-tool maps (`sideEffects`, `allowedRoles`,
 * `argumentSchemas`, `urlArgPaths`, `pathArgPaths`). Exact keys win over globs,
 * and among globs the one with the most literal text wins, so `github/*` cannot
 * shadow `github/delete_repo`.
 */
function lookupByToolName<T>(
  map: Record<string, T> | undefined,
  names: readonly string[],
): T | undefined {
  if (!map) return undefined;
  for (const name of names) {
    const exact = map[name];
    if (exact !== undefined) return exact;
  }
  const globs = Object.keys(map)
    .filter((key) => key.includes('*'))
    .sort((a, b) => b.replace(/\*/g, '').length - a.replace(/\*/g, '').length);
  for (const key of globs) {
    for (const name of names) {
      if (nameMatches(key, name)) return map[key];
    }
  }
  return undefined;
}

// ── Declared argument paths (fix 2) ─────────────────────────────────────────

interface DeclaredValue {
  /** RFC-6901 pointer into the subject, so it lines up with the subject's own
   *  segments and with any mutation a sibling family emits. */
  pointer: string;
  text: string;
}

/**
 * `a.b[0].c`, `a/b/0/c` and `/a/b/0/c` all parse the same way. Specs are always
 * relative to the tool's ARGUMENTS — there is deliberately no second root to
 * disambiguate, because `urlArgPaths` names argument paths and nothing else.
 */
function splitArgSpec(spec: string): string[] {
  return spec
    .replace(/\[(\d+)\]/g, '.$1')
    .split(/[./]/)
    .filter((segment) => segment.length > 0);
}

/**
 * Resolve one spec against the arguments, supporting `*` as "every element of
 * this array / every value of this object" — without it, `attachments.*.url`
 * would have to be written out per index, which nobody does, which is how a
 * declared path silently stops covering the second attachment.
 */
function resolveArgSpec(
  args: Record<string, unknown>,
  spec: string,
): Array<{ pointer: string; value: unknown }> {
  const segments = splitArgSpec(spec);
  if (segments.length === 0) return [];

  let frontier: Array<{ pointer: string; value: unknown }> = [{ pointer: '/args', value: args }];
  for (const segment of segments) {
    const next: Array<{ pointer: string; value: unknown }> = [];
    for (const node of frontier) {
      if (segment === '*') {
        if (Array.isArray(node.value)) {
          node.value.forEach((item, index) => next.push({ pointer: `${node.pointer}/${index}`, value: item }));
        } else if (isPlainRecord(node.value)) {
          for (const [key, item] of Object.entries(node.value)) {
            next.push({ pointer: `${node.pointer}/${escapePointerToken(key)}`, value: item });
          }
        }
        continue;
      }
      if (Array.isArray(node.value)) {
        const index = Number(segment);
        if (Number.isInteger(index) && index >= 0 && index < node.value.length) {
          next.push({ pointer: `${node.pointer}/${index}`, value: node.value[index] });
        }
        continue;
      }
      if (isPlainRecord(node.value) && segment in node.value) {
        next.push({
          pointer: `${node.pointer}/${escapePointerToken(segment)}`,
          value: node.value[segment],
        });
      }
    }
    frontier = next.length > MAX_SPEC_MATCHES ? next.slice(0, MAX_SPEC_MATCHES) : next;
    if (frontier.length === 0) break;
  }
  return frontier;
}

/** Every string a set of specs resolves to, deduplicated by pointer. A spec
 *  that resolves to nothing is NOT an error: an optional argument is absent on
 *  most calls, and a finding per absent optional would drown the log. */
function collectDeclared(args: Record<string, unknown>, specs: readonly string[]): DeclaredValue[] {
  const out: DeclaredValue[] = [];
  const seen = new Set<string>();
  for (const spec of specs) {
    for (const match of resolveArgSpec(args, spec)) {
      if (typeof match.value !== 'string' || match.value.length === 0) continue;
      if (seen.has(match.pointer)) continue;
      seen.add(match.pointer);
      out.push({ pointer: match.pointer, text: match.value });
    }
  }
  return out;
}

// ── Path normalisation (fix 1) ──────────────────────────────────────────────

type PathVerdict =
  | { ok: true; path: string }
  | { ok: false; code: 'path_invalid' | 'path_outside_root'; message: string };

/** Absolute, normalised, no trailing slash. An undeclared root is '/', which
 *  makes a relative path resolve to an absolute one and clamps `../..` at the
 *  top — deliberately fail-safe, and the reason `fsRoot` is worth declaring. */
function normalizeRoot(fsRoot: string | undefined): string {
  if (!fsRoot) return '/';
  const unified = fsRoot.replace(/\\/g, '/');
  const absolute = posixPath.normalize(posixPath.isAbsolute(unified) ? unified : `/${unified}`);
  return absolute === '/' ? '/' : absolute.replace(/\/+$/, '');
}

/** Segment-boundary containment. `/safe` contains `/safe/x` but NOT `/safety`,
 *  which raw `startsWith` got wrong in both directions. */
function isWithin(path: string, root: string): boolean {
  if (root === '/') return true;
  return path === root || path.startsWith(`${root}/`);
}

/**
 * THE fix for the traversal hole. Backslashes are folded to '/' before
 * normalising: on POSIX a backslash is a legal filename character, but a path
 * argument that reaches a shell or a Windows-side tool traverses on `..\..`,
 * and over-splitting here can only produce MORE `..` segments to catch — the
 * fail-safe direction.
 */
function normalizeToolPath(raw: string, root: string, rootDeclared: boolean): PathVerdict {
  if (raw.length === 0) {
    return { ok: false, code: 'path_invalid', message: 'Empty path argument' };
  }
  if (CONTROL_CHARS.test(raw)) {
    return { ok: false, code: 'path_invalid', message: 'Path argument contains control characters' };
  }

  const unified = raw.replace(/\\/g, '/');
  // An absolute argument is treated as absolute, NOT as relative to the root:
  // `/etc/passwd` under `fsRoot: '/workspace'` is a path outside the root, and
  // silently re-basing it would invent an intent the caller never expressed.
  const joined = posixPath.isAbsolute(unified) ? unified : posixPath.join(root, unified);
  const normalized = posixPath.normalize(joined);
  const target = normalized === '/' ? '/' : normalized.replace(/\/+$/, '');

  // Only reachable for a relative target under a relative root, which
  // `normalizeRoot` already rules out — kept because a residual `..` is the one
  // thing that must never survive into a prefix comparison.
  if (target.split('/').includes('..')) {
    return { ok: false, code: 'path_invalid', message: 'Path escapes the filesystem root' };
  }
  if (rootDeclared && !isWithin(target, root)) {
    return {
      ok: false,
      code: 'path_outside_root',
      message: `Path ${target} resolves outside the allowed root ${root}`,
    };
  }
  return { ok: true, path: target };
}

/** Prefixes are normalised against the same root as the target, so an operator
 *  can write them relative and still get an apples-to-apples comparison. */
function normalizePrefix(prefix: string, root: string): string | null {
  const unified = prefix.replace(/\\/g, '/');
  if (unified.length === 0 || CONTROL_CHARS.test(unified)) return null;
  const joined = posixPath.isAbsolute(unified) ? unified : posixPath.join(root, unified);
  const normalized = posixPath.normalize(joined);
  return normalized === '/' ? '/' : normalized.replace(/\/+$/, '');
}

/**
 * NO GLOB HERE, AND ON PURPOSE — audited when `*` was added to the domain lists.
 * A `*` in a prefix is a literal directory name and matches nothing, which is
 * why `catalog/families.ts` flags one rather than leaving it silent.
 *
 * Three reasons, in order of weight:
 *
 *  · A PREFIX IS ALREADY THE TRAILING WILDCARD. `isWithin` makes `/workspace`
 *    cover everything beneath it at a segment boundary, so `/workspace/*` would
 *    be a second spelling of the same rule — except a WORSE one, because
 *    `/workspace/*` would stop covering `/workspace` itself. On a deny list
 *    that is a NARROWING, i.e. the unsafe direction, produced by the spelling
 *    an operator would reach for first.
 *
 *  · A GLOB CANNOT SURVIVE `normalizePrefix`. Prefixes are resolved against
 *    `fsRoot` so they can be written relative; `posixPath.normalize('/*.pem')`
 *    root-anchors the pattern and `data/*` gains a root it never asked for. A
 *    glob would need its own normalisation rule, so this would not be a third
 *    matching language in the family — it would be a fourth.
 *
 *  · `*` COMPILED TO `.*` CROSSES A SLASH. A one-segment wildcard written as
 *    `/data/<star>/public` would then also allow `/data/a/b/public`, which on
 *    an ALLOW list is silent widening — the same class of bug as matching
 *    `apiXexample.com`, and the reason the domain glob escapes its literals.
 *
 * The expressiveness genuinely lost is the mid-path wildcard — "every user's
 * `.ssh`". The answer for that today is the parent prefix, and if it ever
 * becomes worth having it needs a segment-aware `<star>` distinct from a
 * crossing `<star><star>`, plus its own normalisation — not a borrowed host
 * matcher.
 */
function matchesAnyPrefix(target: string, prefixes: readonly string[], root: string): boolean {
  return prefixes.some((prefix) => {
    const normalized = normalizePrefix(prefix, root);
    return normalized !== null && isWithin(target, normalized);
  });
}

// ── URL handling (fix 3) ────────────────────────────────────────────────────

type UrlVerdict =
  | { ok: true; url: URL }
  | { ok: false; code: 'invalid_url' | 'egress_scheme_denied'; message: string };

function parseUrlArgument(raw: string): UrlVerdict {
  const trimmed = raw.trim();
  // Protocol-relative — one of the forms the old scrape missed entirely. It
  // inherits the caller's scheme in a browser and is a real egress target here.
  const candidate = trimmed.startsWith('//') ? `https:${trimmed}` : trimmed;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, code: 'invalid_url', message: 'Malformed URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      ok: false,
      code: 'egress_scheme_denied',
      message: `URL scheme ${url.protocol} is not allowed in tool arguments`,
    };
  }
  return { ok: true, url };
}

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
}

/**
 * A GLOB ENTRY MEANS THE SAME THING IN BOTH LISTS. `hostDenied` and
 * `hostAllowed` disagree about what a BARE entry covers (below), and that
 * disagreement is exactly what made an operator expect one and get the other.
 * An entry containing `*` sidesteps it: the pattern is anchored to the whole
 * host and says its own reach, so there is nothing left for the two lists to
 * differ about.
 *
 * `*.example.com` therefore means SUBDOMAINS AND NOT THE APEX — the literal dot
 * before `example.com` needs at least one label in front of it. That is the
 * natural reading, and it is deliberately NOT a synonym for anything else the
 * lists already offer:
 *
 *   deny  `example.com`     apex + subdomains  (the bare-entry suffix rule)
 *   deny  `*.example.com`   subdomains only    (the glob)
 *   allow `example.com`     apex only          (the bare-entry exact rule)
 *   allow `.example.com`    apex + subdomains  (the leading-dot shorthand)
 *   allow `*.example.com`   subdomains only    (the glob)
 *
 * A leading dot on a glob entry is dropped before compiling: `.` is the "and
 * its subdomains" shorthand, the glob already states its own reach, and an
 * entry written with both would otherwise compile to `^\.` and match no host
 * that has ever existed — a silent nothing, which is the failure this pass is
 * here to end.
 */
function hostGlobMatches(entry: string, host: string): boolean {
  const pattern = normalizeHost(entry).replace(/^\./, '');
  return pattern.length > 0 && compileGlob(pattern).test(host);
}

/**
 * Deny entries keep the original's suffix semantics (`example.com` also denies
 * `api.example.com`) because denying more is the fail-safe direction. Allow
 * entries stay EXACT unless written with a leading dot — the same
 * `.suffix` convention `outboundFetch`'s operator allowlist already uses, so an
 * operator only has to learn it once.
 *
 * NEITHER RULE CHANGED when globs arrived, and that is load-bearing rather than
 * conservative: relaxing `hostAllowed` to a suffix would silently widen every
 * allow-list already stored, and every one of them was written against the
 * exact rule.
 */
function hostDenied(host: string, entries: readonly string[]): boolean {
  return entries.some((entry) => {
    if (entry.includes('*')) return hostGlobMatches(entry, host);
    const e = normalizeHost(entry).replace(/^\./, '');
    return e.length > 0 && (host === e || host.endsWith(`.${e}`));
  });
}

function hostAllowed(host: string, entries: readonly string[]): boolean {
  return entries.some((entry) => {
    if (entry.includes('*')) return hostGlobMatches(entry, host);
    const e = normalizeHost(entry);
    if (e.length === 0) return false;
    if (e.startsWith('.')) return host === e.slice(1) || host.endsWith(e);
    return host === e;
  });
}

// ── Undeclared argument discovery (fix 5) ───────────────────────────────────
/**
 * WHY THIS IS NOT THE SCRAPE, AND WHY ITS FINDINGS ARE NOT CLAMPED.
 *
 * `scanUndeclaredStrings` is pinned to 'medium'/'flag' for one stated reason:
 * it cannot tell a url in an argument from a url quoted inside a paragraph of
 * prose. That caveat was checked against the subject builder before this was
 * written, and at the TOOL hooks it does not hold:
 *
 *   · `toolCallSubject` builds its segments as `walkStringLeaves(args,
 *     '/args')`. Every segment at `tool.pre` IS an argument value, addressed by
 *     its own pointer. `toolName` and `providerRef` are deliberately excluded.
 *   · `toolResultSubject` builds its segments from the RESULT, so the caveat
 *     survives there in full — a tool result really can be a paragraph, or a
 *     whole web page of links. Discovery therefore reads `subject.args`, which
 *     rides along on that subject too, and never the result segments.
 *
 * The residue of the caveat is a url sitting INSIDE a longer argument (a url in
 * an email body). `wholeValue*` is the line drawn against it: a value is only
 * discovered when the ENTIRE argument, trimmed, is the target. Nothing has to
 * be inferred about a string that is a url and only a url, so a discovered
 * target is treated exactly as a declared one — full severity, the policy's own
 * action, able to block, and eligible for the SSRF guard. A url embedded in
 * prose stays behind `scanUndeclaredStrings` and stays clamped.
 */

/**
 * The whole trimmed value parsed as an http(s) url, or null.
 *
 * NO INTERNAL WHITESPACE, because `new URL()` percent-encodes a space rather
 * than throwing: `new URL('https://x/y here')` succeeds, and accepting it would
 * make "a url with a sentence after it" a discovered argument, i.e. exactly the
 * prose case this is drawing a line against. Trimming first is deliberate too —
 * without it a trailing newline would be a one-character bypass.
 *
 * A NON-HTTP SCHEME IS SKIPPED RATHER THAN REPORTED. `new URL('project:ABC')`
 * parses happily, so reporting `egress_scheme_denied` from a value nobody
 * declared would turn a Jira query argument into a blocking finding. Declared
 * url arguments still report it: there the operator said the argument is a url.
 */
function wholeValueUrl(raw: string): URL | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || /\s/.test(trimmed)) return null;
  // A scheme-relative `//host/path` is a real egress target and one of the
  // forms the old scrape missed; `parseUrlArgument` gives it https.
  if (!trimmed.startsWith('//') && !/^https?:\/\//i.test(trimmed)) return null;
  const parsed = parseUrlArgument(trimmed);
  if (!parsed.ok || parsed.url.hostname.length === 0) return null;
  return parsed.url;
}

/**
 * The whole trimmed value as an ABSOLUTE filesystem path, or null. Relative
 * values are not discovered: `"report"` is a legal relative path and also every
 * other string an argument has ever held, so discovering them would make the
 * prefix lists fire on prose.
 *
 * A backslash start is accepted because `normalizeToolPath` folds backslashes —
 * `\etc\passwd` traverses in a shell or a Windows-side tool, and the fold can
 * only ever produce more `..` segments to catch.
 */
function wholeValueAbsolutePath(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (!trimmed.startsWith('/') && !trimmed.startsWith('\\')) return null;
  // `//evil.com/x` starts with a slash and is a scheme-relative URL, not a
  // path. It belongs to the domain lists, which see it through
  // `wholeValueUrl`; letting it fall through to here would compare a hostname
  // against filesystem prefixes.
  if (trimmed.startsWith('//') || trimmed.startsWith('\\\\')) return null;
  return trimmed;
}

/**
 * Argument string leaves, by pointer, for a subject of either tool kind.
 *
 * At `tool.pre` this IS `subject.segments` — same function, same base pointer —
 * so the common path costs no second walk. At `tool.post` the segments cover
 * the result instead, and the arguments have to be walked, which is what lets a
 * policy bound only to `tool.post` still consult its own domain list.
 */
function argumentSegments(subject: HookSubject): ReadonlyArray<{ path: string; text: string }> {
  if (subject.kind === 'tool_call') return subject.segments;
  if (subject.kind === 'tool_result') return walkStringLeaves(subject.args, '/args');
  return [];
}

// ── Argument schema validation ──────────────────────────────────────────────

interface SchemaError {
  pointer: string;
  message: string;
}

/**
 * The 12-line validator, ported 1:1 — including the things it does NOT do, so
 * that a stored schema keeps meaning what it meant: no `$ref`, no remote
 * schemas, no `items` validation for arrays, no numeric/length constraints, and
 * an absent `type` validates everything. The one addition is the RFC-6901
 * pointer alongside the human-readable message, so a finding can name the
 * offending argument the same way every other family does.
 */
function validateArguments(
  value: unknown,
  schema: JsonSchemaLite,
  pointer = '/args',
  label = 'arguments',
): SchemaError[] {
  if (!schema.type) return [];

  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return [{ pointer, message: `${label} must be object` }];
    }
    const obj = value as Record<string, unknown>;
    const errors: SchemaError[] = (schema.required ?? [])
      .filter((key) => obj[key] === undefined)
      .map((key) => ({
        pointer: `${pointer}/${escapePointerToken(key)}`,
        message: `${label}.${key} required`,
      }));
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (obj[key] !== undefined) {
        errors.push(
          ...validateArguments(obj[key], child, `${pointer}/${escapePointerToken(key)}`, `${label}.${key}`),
        );
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in (schema.properties ?? {}))) {
          errors.push({
            pointer: `${pointer}/${escapePointerToken(key)}`,
            message: `${label}.${key} not allowed`,
          });
        }
      }
    }
    return errors;
  }

  if (schema.type === 'array') {
    return Array.isArray(value) ? [] : [{ pointer, message: `${label} must be array` }];
  }
  if (typeof value !== schema.type) {
    return [{ pointer, message: `${label} must be ${schema.type}` }];
  }
  if (schema.enum && !schema.enum.includes(value)) {
    return [{ pointer, message: `${label} must be one of allowed values` }];
  }
  return [];
}

// ── Size and depth ──────────────────────────────────────────────────────────

/** `null` when the value cannot be serialised at all — a cycle or a BigInt.
 *  The original called `JSON.stringify` bare, so such a call threw out of the
 *  whole evaluation instead of degrading one size policy. */
function jsonByteLength(value: unknown): number | null {
  try {
    return Buffer.byteLength(JSON.stringify(value ?? null) ?? 'null');
  } catch {
    return null;
  }
}

/** Depth of the deepest container, early-exiting one level past `limit`. The
 *  early exit is also what terminates on a cyclic structure. */
function jsonDepth(value: unknown, limit: number): number {
  const measure = (node: unknown, depth: number): number => {
    if (depth > limit) return depth;
    const children = Array.isArray(node)
      ? node
      : isPlainRecord(node)
        ? Object.values(node)
        : null;
    if (children === null) return depth;
    let deepest = depth;
    for (const child of children) {
      deepest = Math.max(deepest, measure(child, depth + 1));
      if (deepest > limit) return deepest;
    }
    return deepest;
  };
  return measure(value, 0);
}

// ── The runner ──────────────────────────────────────────────────────────────

export const runToolAccessPolicy: FamilyRunner<ToolAccessPolicyConfig> = async (input) => {
  const { policy, hook, subject, scope } = input;
  const findings: SafetyFinding[] = [];
  const degraded: NonNullable<FamilyRunResult['degraded']> = [];

  // `mutations` is always empty and that is a decision, not an omission:
  // deleting a denied argument would hand the tool a call the model never made
  // and never learns was altered. A tool policy blocks or it allows.
  const result = (): FamilyRunResult => ({
    findings,
    mutations: [],
    degraded: degraded.length > 0 ? degraded : undefined,
  });

  if (subject.kind !== 'tool_call' && subject.kind !== 'tool_result') {
    // POLICY_VALID_HOOKS already restricts this family to the tool hooks, so
    // reaching here means the engine dispatched wrongly. Reporting it as
    // degraded lets `failMode` decide instead of passing the call silently.
    degraded.push({
      policyId: policy.id,
      family: FAMILY,
      reason: `tool_access cannot evaluate a ${subject.kind} subject`,
    });
    return result();
  }

  const emitted = new Set<string>();
  const push = (params: {
    code: string;
    message: string;
    severity: SafetyFinding['severity'];
    path?: string;
    /** Only `sideEffectActions` and the clamped scrape override the action. */
    override?: SafetyAction;
  }): void => {
    const key = `${params.code}|${params.path ?? ''}|${params.message}`;
    // A wildcard spec over a 50-element array would otherwise write 50 copies
    // of the same denial into the evaluation log and the block message.
    if (emitted.has(key)) return;
    emitted.add(key);

    const resolved = params.override ?? input.action;
    findings.push({
      type: LEGACY_TYPE,
      // The code doubles as the category so the findings-by-category
      // aggregations break tool policy down by WHAT was violated rather than
      // bucketing every violation under one label.
      category: params.code,
      severity: params.severity,
      message: params.message,
      action: toLegacyAction(resolved),
      block: resolved === 'block',
      // `value` is deliberately never set. `guardrailService.ts:368` redacts on
      // `action === 'redact' && value` by splitting the text on that value —
      // putting a tool name or a hostname there would strip it out of unrelated
      // content the moment a guardrail's action is 'redact'.
      family: FAMILY,
      hook,
      policyId: policy.id,
      code: params.code,
      path: params.path,
    });
  };

  const toolName = subject.toolName;
  const requestedName = subject.kind === 'tool_call' ? subject.requestedName : undefined;
  /**
   * Deny and the per-tool maps are matched against BOTH the canonical name and
   * the pre-rename name the model used; the allow list is matched against the
   * canonical name only. Both directions are the fail-safe one: a deny written
   * against either spelling fires, and an allow written against the wrong
   * spelling does not silently open the tool.
   */
  const names = requestedName && requestedName !== toolName ? [toolName, requestedName] : [toolName];
  const args = subject.args;

  /**
   * A policy bound ONLY to `tool.post` would otherwise enforce nothing but the
   * result size cap — an allow-list that never runs is exactly the silent
   * no-op this rewrite exists to eliminate. Running the `tool.pre` rules at
   * `tool.post` cannot un-run the tool, but it does keep the result out of the
   * model's context, which is the part that still matters.
   */
  const runsPreHookRules = hook === 'tool.pre' || !policy.hooks.includes('tool.pre');

  /** Pointers already examined with a real parser — declared, then discovered.
   *  The opt-in scrape skips them so one argument cannot produce both a
   *  blocking finding and a clamped duplicate of it. */
  const checkedPointers = new Set<string>();

  /**
   * The two list checks, shared by the declared and the discovered path so the
   * verdict cannot drift between them. Returns true when the target was
   * rejected, which is also "do not spend a DNS lookup on it".
   */
  const checkEgressDomains = (pointer: string, url: URL): boolean => {
    const host = normalizeHost(url.hostname);
    if (policy.deniedDomains?.length && hostDenied(host, policy.deniedDomains)) {
      push({
        code: 'egress_domain_denied',
        severity: 'high',
        message: `Domain ${host} is deny-listed`,
        path: pointer,
      });
      return true;
    }
    if (policy.allowedDomains?.length && !hostAllowed(host, policy.allowedDomains)) {
      push({
        code: 'egress_domain_denied',
        severity: 'high',
        message: `Domain ${host} is not allowed`,
        path: pointer,
      });
      return true;
    }
    return false;
  };

  const checkPathPrefixes = (pointer: string, path: string, root: string): boolean => {
    if (policy.deniedPathPrefixes?.length && matchesAnyPrefix(path, policy.deniedPathPrefixes, root)) {
      push({ code: 'path_denied', severity: 'high', message: `Path ${path} is deny-listed`, path: pointer });
      return true;
    }
    if (policy.allowedPathPrefixes?.length && !matchesAnyPrefix(path, policy.allowedPathPrefixes, root)) {
      push({ code: 'path_denied', severity: 'high', message: `Path ${path} is not allowed`, path: pointer });
      return true;
    }
    return false;
  };

  if (runsPreHookRules) {
    // 1. Allow / deny lists.
    const denied = (policy.deny ?? []).some((pattern) => names.some((name) => nameMatches(pattern, name)));
    const allowed = !policy.allow?.length || policy.allow.some((pattern) => nameMatches(pattern, toolName));
    if (denied || !allowed) {
      push({ code: 'tool_not_allowed', severity: 'high', message: `Tool ${toolName} is not allowed` });
    }

    // 2. Roles. `scope.actor.roles` comes from the authenticated context; a
    //    caller-supplied role would make this policy decorative.
    const requiredRoles = lookupByToolName(policy.allowedRoles, names);
    if (requiredRoles && !requiredRoles.some((role) => scope.actor.roles.includes(role))) {
      push({
        code: 'role_not_allowed',
        severity: 'high',
        message: 'Actor role is not authorized for this tool',
      });
    }

    // 3. Argument schema.
    const schema = lookupByToolName(policy.argumentSchemas, names);
    if (schema) {
      for (const error of validateArguments(args, schema)) {
        push({ code: 'invalid_arguments', severity: 'high', message: error.message, path: error.pointer });
      }
    }

    // 4. Argument byte cap.
    if (policy.maxArgBytes && policy.maxArgBytes > 0) {
      const size = jsonByteLength(args);
      if (size === null) {
        degraded.push({
          policyId: policy.id,
          family: FAMILY,
          reason: 'tool arguments are not JSON-serialisable, so maxArgBytes could not be enforced',
        });
      } else if (size > policy.maxArgBytes) {
        push({
          code: 'arg_size_exceeded',
          severity: 'high',
          message: `Arguments ${size}B exceed limit ${policy.maxArgBytes}B`,
        });
      }
    }

    // 5. Nesting depth. Always on, because the cap is what stops "hide the
    //    secret 40 levels down" from being an evasion primitive against every
    //    OTHER family — the subject builder stops walking at the same depth.
    const declaredDepth = Number(policy.maxArgDepth);
    const maxDepth =
      Number.isFinite(declaredDepth) && declaredDepth > 0
        ? Math.min(Math.trunc(declaredDepth), MAX_ARG_DEPTH)
        : MAX_ARG_DEPTH;
    if (jsonDepth(args, maxDepth) > maxDepth) {
      push({
        code: 'arg_depth_exceeded',
        severity: 'high',
        message: `Arguments nest deeper than ${maxDepth} levels`,
      });
    }

    const root = normalizeRoot(policy.fsRoot);
    const rootDeclared = Boolean(policy.fsRoot);

    // 6. Declared URL arguments — checked BEFORE anything is discovered, so a
    //    declared spec always wins, and the only place a malformed url or a
    //    non-http scheme is reported.
    const urlSpecs = lookupByToolName(policy.urlArgPaths, names) ?? [];
    const urlTargets = collectDeclared(args, urlSpecs);
    const ssrfCandidates: Array<{ pointer: string; url: URL }> = [];

    for (const target of urlTargets) {
      checkedPointers.add(target.pointer);
      const parsed = parseUrlArgument(target.text);
      if (!parsed.ok) {
        push({ code: parsed.code, severity: 'high', message: parsed.message, path: target.pointer });
        continue;
      }
      if (checkEgressDomains(target.pointer, parsed.url)) continue;
      if (policy.denyPrivateNetworks) ssrfCandidates.push({ pointer: target.pointer, url: parsed.url });
    }

    // 6b. UNDECLARED ARGUMENTS, AT DECLARED GRADE. The fix for "I configured a
    //     domain list and nothing ever fired": before this, a policy with no
    //     `urlArgPaths` and `scanUndeclaredStrings` off consulted its domain
    //     lists about nothing at all. An argument whose ENTIRE value is a url
    //     or an absolute path needs no inference to identify — see the block
    //     above `wholeValueUrl` for why that is not the clamped scrape.
    //
    //     Gated on there being a rule to apply, so a policy with no domain and
    //     no path list does not walk its arguments for nothing, and so `fsRoot`
    //     alone never starts denying paths.
    const wantsDomainChecks = Boolean(
      policy.deniedDomains?.length || policy.allowedDomains?.length || policy.denyPrivateNetworks,
    );
    const wantsPathChecks = Boolean(policy.deniedPathPrefixes?.length || policy.allowedPathPrefixes?.length);
    /** Held back so a discovered path is reported beside the declared ones. */
    const discoveredPaths: Array<{ pointer: string; path: string }> = [];

    if (wantsDomainChecks || wantsPathChecks) {
      let remaining = MAX_DISCOVERED_VALUES;
      for (const segment of argumentSegments(subject)) {
        if (remaining <= 0) break;
        if (checkedPointers.has(segment.path)) continue;

        if (wantsDomainChecks) {
          const url = wholeValueUrl(segment.text);
          if (url) {
            remaining -= 1;
            checkedPointers.add(segment.path);
            if (!checkEgressDomains(segment.path, url) && policy.denyPrivateNetworks) {
              ssrfCandidates.push({ pointer: segment.path, url });
            }
            continue;
          }
        }

        if (wantsPathChecks) {
          const candidate = wholeValueAbsolutePath(segment.text);
          if (candidate === null) continue;
          remaining -= 1;
          // `rootDeclared` is FALSE here on purpose. A discovered value is
          // normalised so the prefix comparison is honest, but it is never
          // reported as `path_outside_root`: that finding says "you declared a
          // root and this argument left it", and nobody declared this argument.
          // Passing true would also make the value fail normalisation and skip
          // the prefix lists entirely — an out-of-root path that an allow-list
          // must deny would then produce no finding at all.
          const verdict = normalizeToolPath(candidate, root, false);
          if (!verdict.ok) continue;
          checkedPointers.add(segment.path);
          discoveredPaths.push({ pointer: segment.path, path: verdict.path });
        }
      }
    }

    // 7. SSRF, through the one guard. Deduplicated by origin: two arguments
    //    pointing at the same host cost one lookup, and the verdict is the same.
    if (ssrfCandidates.length > 0) {
      const seenOrigins = new Set<string>();
      let budget = MAX_URL_DNS_CHECKS;
      for (const candidate of ssrfCandidates) {
        if (scope.signal?.aborted) {
          degraded.push({
            policyId: policy.id,
            family: FAMILY,
            reason: 'aborted before the private-network check completed',
          });
          break;
        }
        const origin = candidate.url.origin;
        if (seenOrigins.has(origin)) continue;
        if (budget <= 0) {
          degraded.push({
            policyId: policy.id,
            family: FAMILY,
            reason: `more than ${MAX_URL_DNS_CHECKS} distinct URL arguments; the rest were not resolved`,
          });
          break;
        }
        seenOrigins.add(origin);
        budget -= 1;
        try {
          // `forceBlock`: this is a POLICY check, not a transport call. The
          // deployment's `OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK=false` and its
          // host allowlist say what the console process may reach; a tenant's
          // `denyPrivateNetworks` says what a TOOL may reach, and without the
          // flag the former silently disarmed the latter while the policy
          // editor kept showing it on.
          await assertPublicUrl(candidate.url.toString(), { forceBlock: true });
        } catch (error) {
          if (error instanceof OutboundNetworkError) {
            push({
              code: 'egress_private_network',
              severity: 'high',
              // The guard's own message names the host and the reason; the
              // hostname is the only part of the URL that reaches the log, so a
              // query string carrying a token is never persisted.
              message: `Host ${normalizeHost(candidate.url.hostname)} is not a permitted egress target`,
              path: candidate.pointer,
            });
          } else {
            degraded.push({
              policyId: policy.id,
              family: FAMILY,
              reason: `private-network check failed: ${error instanceof Error ? error.message : 'unknown error'}`,
            });
          }
        }
      }
    }

    // 8. Declared filesystem path arguments.
    const pathSpecs = lookupByToolName(policy.pathArgPaths, names) ?? [];
    for (const target of collectDeclared(args, pathSpecs)) {
      checkedPointers.add(target.pointer);
      const verdict = normalizeToolPath(target.text, root, rootDeclared);
      if (!verdict.ok) {
        push({ code: verdict.code, severity: 'high', message: verdict.message, path: target.pointer });
        continue;
      }
      checkPathPrefixes(target.pointer, verdict.path, root);
    }

    // 8b. …and the ones discovered at 6b, at the same grade and through the
    //     same comparison.
    for (const target of discoveredPaths) {
      checkPathPrefixes(target.pointer, target.path, root);
    }

    // 9. Side effects. The only place this family reads an action out of its
    //    own config — see the purity note at the top of the file.
    const effect = lookupByToolName(policy.sideEffects, names) ?? policy.defaultSideEffect ?? DEFAULT_SIDE_EFFECT;
    const effectAction = policy.sideEffectActions?.[effect] ?? DEFAULT_SIDE_EFFECT_ACTIONS[effect];
    if (effectAction !== 'allow') {
      push({
        code: `side_effect_${effect}`,
        severity: SIDE_EFFECT_SEVERITY[effect],
        message: `Tool has ${effect} side effects`,
        override: effectAction,
      });
    }
  }

  // 10. Result byte cap — the one thing that can only be known after the call.
  if (hook === 'tool.post' && subject.kind === 'tool_result' && policy.maxResultBytes && policy.maxResultBytes > 0) {
    const size = jsonByteLength(subject.result);
    if (size === null) {
      degraded.push({
        policyId: policy.id,
        family: FAMILY,
        reason: 'tool result is not JSON-serialisable, so maxResultBytes could not be enforced',
      });
    } else if (size > policy.maxResultBytes) {
      push({
        code: 'result_size_exceeded',
        severity: 'high',
        message: `Result ${size}B exceeds limit ${policy.maxResultBytes}B`,
      });
    }
  }

  // 11. The old scrape, opt-in and clamped. What is left for it AFTER 6b:
  //     a target quoted inside a longer string — a url in an email body, a path
  //     mentioned in a sentence — and, at `tool.post`, the tool's RESULT, where
  //     a denied domain can come back from a tool the original never looked at.
  //     Both are cases where the text genuinely may be prose, so findings stay
  //     pinned to 'medium'/'flag' and still never resolve DNS. Everything 6b
  //     already examined is skipped, so one argument cannot produce both a
  //     blocking finding and a clamped duplicate of it.
  if (policy.scanUndeclaredStrings) {
    const root = normalizeRoot(policy.fsRoot);
    const rootDeclared = Boolean(policy.fsRoot);
    let remaining = MAX_SCRAPE_CANDIDATES;

    for (const segment of subject.segments) {
      if (remaining <= 0) break;
      // Already checked precisely, with a real parser, above.
      if (checkedPointers.has(segment.path)) continue;

      const text = segment.text.length > MAX_SCRAPE_CHARS_PER_SEGMENT
        ? segment.text.slice(0, MAX_SCRAPE_CHARS_PER_SEGMENT)
        : segment.text;
      SCRAPE_PATTERN.lastIndex = 0;
      const candidates = (text.match(SCRAPE_PATTERN) ?? []).map((match) => match.trim());

      for (const candidate of candidates) {
        if (remaining <= 0) break;
        remaining -= 1;

        if (candidate.startsWith('http')) {
          const parsed = parseUrlArgument(candidate);
          if (!parsed.ok) continue; // A malformed fragment of prose is not a finding.
          const host = normalizeHost(parsed.url.hostname);
          if (policy.deniedDomains?.length && hostDenied(host, policy.deniedDomains)) {
            push({
              code: 'egress_domain_denied',
              severity: 'medium',
              message: `Domain ${host} is deny-listed`,
              path: segment.path,
              override: 'flag',
            });
          } else if (policy.allowedDomains?.length && !hostAllowed(host, policy.allowedDomains)) {
            push({
              code: 'egress_domain_denied',
              severity: 'medium',
              message: `Domain ${host} is not allowed`,
              path: segment.path,
              override: 'flag',
            });
          }
          continue;
        }

        const verdict = normalizeToolPath(candidate, root, rootDeclared);
        if (!verdict.ok) continue; // Ditto: an unparseable scrape hit is noise.
        if (policy.deniedPathPrefixes?.length && matchesAnyPrefix(verdict.path, policy.deniedPathPrefixes, root)) {
          push({
            code: 'path_denied',
            severity: 'medium',
            message: `Path ${verdict.path} is deny-listed`,
            path: segment.path,
            override: 'flag',
          });
        } else if (
          policy.allowedPathPrefixes?.length
          && !matchesAnyPrefix(verdict.path, policy.allowedPathPrefixes, root)
        ) {
          push({
            code: 'path_denied',
            severity: 'medium',
            message: `Path ${verdict.path} is not allowed`,
            path: segment.path,
            override: 'flag',
          });
        }
      }
    }
  }

  return result();
};

// Exported for the test wave: each of these encodes one of the three fixes and
// is worth pinning independently of the runner's orchestration.
export {
  hostAllowed,
  hostDenied,
  jsonDepth,
  nameMatches,
  normalizeRoot,
  normalizeToolPath,
  resolveArgSpec,
  validateArguments,
};
