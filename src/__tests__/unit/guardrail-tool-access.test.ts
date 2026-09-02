/**
 * `tool_access` — the port of the enterprise enforcement plane's engine test
 * (`console-ee/.../__tests__/unit/aegis-engine.test.ts`), rewritten against the
 * community family that replaced it.
 *
 * The old test drove a whole engine (shield store, audit sink, approval store,
 * LLM judge) to assert what were, underneath, tool-policy rules. This one calls
 * `runToolAccessPolicy` directly: it is pure, synchronous apart from the SSRF
 * lookup, and needs no database, so every assertion below is about the rule
 * rather than about the plumbing that used to surround it.
 *
 * ── WHAT MOVED, RATHER THAN DISAPPEARED ────────────────────────────────────
 * Six of the twelve original cases are not here because their subject is no
 * longer this family's:
 *   · "redacts secrets"          → the `secrets` family owns credential
 *                                  detection and the `replace_span` mutation.
 *                                  `tool_access` deliberately emits NO
 *                                  mutations: rewriting an argument would hand
 *                                  a tool a call the model never made.
 *   · "simulate mode allows"     → `monitor` mode, applied by the engine when
 *   · "disabled shield allows"     it folds verdicts. A family reports; it
 *   · "DLP toggles"                never decides, so none of these can be
 *   · "LLM judge fails closed"     observed from here.
 *   · "default shield cannot be
 *      removed"                  → the shield store is gone entirely.
 *
 * ── AND THE ONE THAT IS GONE ON PURPOSE ────────────────────────────────────
 * "Rate limits block bursts of tool calls" has NO replacement, and that is a
 * deliberate removal documented in `families/toolAccess.ts`: the original
 * limiter was a per-process `Map`, so under N replicas it enforced N x the
 * configured limit and every deploy reset every window. A control that reports
 * enforcement it does not deliver is worse than no control. There is nothing
 * here to assert until a shared counter store exists.
 *
 * ── THREE CASES THE ORIGINAL COULD NOT HAVE PASSED ─────────────────────────
 * `path-traversal`, `path-outside-root` and `ssrf-declared-url` pin the three
 * defects the port fixed. The original matched paths with a raw `startsWith`
 * (so `/workspace/../etc/shadow` satisfied an allow-list of `['/workspace']`)
 * and had no SSRF policy at all — only a domain list, which a metadata-service
 * IP literal walks straight past.
 */

import { describe, expect, it } from 'vitest';

import { toolCallSubject, toolResultSubject } from '@/lib/services/guardrail/hooks/contract';
import type {
  HookId,
  HookScope,
  SafetyFinding,
  ToolAccessPolicyConfig,
} from '@/lib/services/guardrail/hooks/contract';
import {
  hostAllowed,
  hostDenied,
  normalizeToolPath,
  runToolAccessPolicy,
} from '@/lib/services/guardrail/families/toolAccess';
import { catalogFor, validatePolicyFields } from '@/lib/services/guardrail/catalog';

// ── Fixtures ────────────────────────────────────────────────────────────────

/** The original's `base.actor` — a developer, so `allowedRoles` cases are
 *  meaningful rather than vacuously satisfied. */
const scope: HookScope = {
  tenantId: 'tenant-a',
  tenantDbName: 't_tenant_a',
  actor: { id: 'u1', kind: 'user', roles: ['developer'] },
  surface: 'sandbox',
  source: 'unit-test',
  traceId: 'trace-1',
};

function policy(config: Partial<ToolAccessPolicyConfig>): ToolAccessPolicyConfig {
  return {
    id: 'tp1',
    family: 'tool_access',
    enabled: true,
    hooks: ['tool.pre', 'tool.post'],
    schedule: { timing: 'sync', onFail: 'block' },
    ...config,
  };
}

/**
 * `action: 'block'` is the action the ENGINE resolved for this policy, i.e. what
 * a finding inherits unless the family overrides it. Passing 'block' is what
 * makes `finding.block` legible: a true means "this rule fired", and the two
 * places that override it (`sideEffectActions`, the clamped scrape) show up as
 * a false.
 */
async function evaluate(
  policy: ToolAccessPolicyConfig,
  args: Record<string, unknown>,
  options: { toolName?: string; hook?: HookId; result?: unknown } = {},
): Promise<{ codes: string[]; findings: SafetyFinding[]; degraded: number }> {
  const toolName = options.toolName ?? 'repo.write';
  const hook = options.hook ?? 'tool.pre';
  const subject = hook === 'tool.post'
    ? toolResultSubject({ toolName, args, result: options.result, providerRef: 'sandbox:test' })
    : toolCallSubject({ toolName, args, providerRef: 'sandbox:test', sandboxAvailable: true });

  const outcome = await runToolAccessPolicy({ policy, hook, subject, scope, action: 'block' });
  return {
    codes: outcome.findings.map((finding) => finding.category),
    findings: outcome.findings,
    degraded: outcome.degraded?.length ?? 0,
  };
}

// ── Ported cases ────────────────────────────────────────────────────────────

describe('tool_access: allow / deny lists and egress', () => {
  it('denies cross-tenant egress to a host outside the allow list', async () => {
    // The original: "Aegis blocks denied cross-tenant egress and redacts
    // secrets". The redaction half now belongs to the `secrets` family — this
    // family emits no mutations at all, which the assertion below pins.
    const outcome = await runToolAccessPolicy({
      policy: policy({
        allow: ['repo.write'],
        allowedDomains: ['api.github.com'],
        urlArgPaths: { 'repo.write': ['target'] },
        sideEffects: { 'repo.write': 'write' },
      }),
      hook: 'tool.pre',
      subject: toolCallSubject({
        toolName: 'repo.write',
        args: { target: 'https://evil.example/x', token: 'api_key=abcdefghijklmnop' },
        providerRef: 'sandbox:test',
      }),
      scope,
      action: 'block',
    });

    const denial = outcome.findings.find((f) => f.category === 'egress_domain_denied');
    expect(denial).toBeDefined();
    expect(denial?.block).toBe(true);
    // The finding names the PLACE, not the value — the pointer is what lets a
    // reviewer see which argument carried the target.
    expect(denial?.path).toBe('/args/target');
    // Never the matched value: `guardrailService` redacts by splitting text on
    // a finding's `value`, so a hostname there would strip it out of unrelated
    // content the moment a guardrail's action is 'redact'.
    expect(denial?.value).toBeUndefined();
    expect(outcome.mutations).toEqual([]);
  });

  it('a tool absent from the allow list is denied even with no deny entry', async () => {
    const { codes } = await evaluate(policy({ allow: ['repo.read'] }), {});
    expect(codes).toContain('tool_not_allowed');
  });

  it('deny lists win over allow lists for domains, with suffix semantics', async () => {
    // Ported verbatim in intent from "Deny lists win over allow lists for
    // domains and paths": `evil.example` denies `api.evil.example` even though
    // the latter is explicitly allowed. Denying more is the fail-safe direction.
    const { codes, findings } = await evaluate(
      policy({
        urlArgPaths: { 'repo.write': ['target'] },
        allowedDomains: ['api.evil.example'],
        deniedDomains: ['evil.example'],
        sideEffects: { 'repo.write': 'read' },
      }),
      { target: 'https://api.evil.example/x' },
    );
    expect(codes).toContain('egress_domain_denied');
    expect(findings[0]?.message).toContain('deny-listed');
  });

  it('deny lists win over allow lists for filesystem paths', async () => {
    const { codes } = await evaluate(
      policy({
        pathArgPaths: { 'repo.write': ['file'] },
        deniedPathPrefixes: ['/etc'],
        sideEffects: { 'repo.write': 'read' },
      }),
      { file: '/etc/passwd' },
    );
    expect(codes).toContain('path_denied');
  });
});

describe('tool_access: argument validation and size', () => {
  it('rejects arguments that violate the declared schema', async () => {
    const schemaPolicy = policy({
      argumentSchemas: {
        'repo.write': { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
      },
      sideEffects: { 'repo.write': 'read' },
    });

    expect((await evaluate(schemaPolicy, { path: '/x' })).codes).toEqual([]);

    const bad = await evaluate(schemaPolicy, {});
    expect(bad.codes).toContain('invalid_arguments');
    // The pointer names the missing argument — the original reported only a
    // bare `invalid_arguments` reason with no way to see which field it meant.
    expect(bad.findings[0]?.path).toBe('/args/path');
  });

  it('blocks oversized argument payloads', async () => {
    const { codes } = await evaluate(
      policy({ maxArgBytes: 50, sideEffects: { 'repo.write': 'read' } }),
      { blob: 'x'.repeat(200) },
    );
    expect(codes).toContain('arg_size_exceeded');
  });

  it('blocks oversized results at tool.post', async () => {
    const { codes } = await evaluate(
      policy({ maxResultBytes: 50, sideEffects: { 'repo.write': 'read' } }),
      {},
      { hook: 'tool.post', result: { blob: 'y'.repeat(200) } },
    );
    expect(codes).toContain('result_size_exceeded');
  });

  it('reports a non-serialisable payload as degraded rather than passing it', async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const { codes, degraded } = await evaluate(
      policy({ maxArgBytes: 50, sideEffects: { 'repo.write': 'read' } }),
      cyclic,
    );
    // The original called `JSON.stringify` bare, so a cycle threw out of the
    // whole evaluation. Here the size cap degrades and `failMode` decides.
    expect(codes).not.toContain('arg_size_exceeded');
    expect(degraded).toBe(1);
  });
});

describe('tool_access: roles and side effects', () => {
  it('denies a tool whose allowedRoles the actor does not hold', async () => {
    const { codes } = await evaluate(
      policy({ allowedRoles: { 'repo.write': ['admin'] }, sideEffects: { 'repo.write': 'read' } }),
      {},
    );
    expect(codes).toContain('role_not_allowed');
  });

  it('a read-only sandbox tool with no declaration produces no finding', async () => {
    // The original: "Default shield allows read-only sandbox tools". The
    // default side effect is 'read' — the original defaulted an undeclared tool
    // to 'external', which made every unknown tool suspicious and buried the
    // genuinely dangerous ones in noise.
    const { codes } = await evaluate(policy({}), { path: '/x' }, { toolName: 'sandbox.fs.read' });
    expect(codes).toEqual([]);
  });

  it('an external side effect warns by default and blocks only when the operator says so', async () => {
    // The original: "…and gates external ones", where the gate was
    // `require_approval`. That rung has no store and no UI in the hook plane, so
    // it is gone; 'warn' reproduces what the original ACTUALLY did, since the
    // `sandbox` decision those side effects resolved to had a pass-through
    // adapter and ran the tool anyway.
    const warned = await evaluate(
      policy({ sideEffects: { 'sandbox.git.push': 'external' } }),
      {},
      { toolName: 'sandbox.git.push' },
    );
    expect(warned.codes).toContain('side_effect_external');
    expect(warned.findings[0]?.action).toBe('warn');
    expect(warned.findings[0]?.block).toBe(false);

    const blocked = await evaluate(
      policy({
        sideEffects: { 'sandbox.git.push': 'external' },
        sideEffectActions: { external: 'block' },
      }),
      {},
      { toolName: 'sandbox.git.push' },
    );
    expect(blocked.findings[0]?.block).toBe(true);
  });
});

// ── The three fixes the port introduced ─────────────────────────────────────

describe('tool_access: defects the enforcement plane shipped', () => {
  it('catches a traversal out of an allowed prefix (raw startsWith did not)', async () => {
    const { codes } = await evaluate(
      policy({
        pathArgPaths: { 'repo.write': ['file'] },
        allowedPathPrefixes: ['/workspace'],
        sideEffects: { 'repo.write': 'read' },
      }),
      { file: '/workspace/../etc/shadow' },
    );
    expect(codes).toContain('path_denied');
  });

  it('normalises before comparing, and does not confuse /safe with /safety', () => {
    // Direct, because this is the exact string the original let through.
    const traversed = normalizeToolPath('/workspace/../etc/shadow', '/', false);
    expect(traversed).toEqual({ ok: true, path: '/etc/shadow' });

    // Segment-boundary containment: `/safe` must not contain `/safety`.
    const outside = normalizeToolPath('/safety/x', '/safe', true);
    expect(outside.ok).toBe(false);

    const inside = normalizeToolPath('/safe/x', '/safe', true);
    expect(inside).toEqual({ ok: true, path: '/safe/x' });

    // A backslash traversal is folded to '/' first: it is a legal POSIX
    // filename character, but it traverses in a shell or a Windows-side tool.
    const windowsish = normalizeToolPath('workspace\\..\\etc\\shadow', '/', false);
    expect(windowsish).toEqual({ ok: true, path: '/etc/shadow' });
  });

  it('rejects a path that resolves outside a declared fsRoot', async () => {
    const { codes } = await evaluate(
      policy({
        pathArgPaths: { 'repo.write': ['file'] },
        fsRoot: '/workspace',
        sideEffects: { 'repo.write': 'read' },
      }),
      { file: '/etc/passwd' },
    );
    expect(codes).toContain('path_outside_root');
  });

  it('runs declared URL arguments through the SSRF guard, which a domain list never was', async () => {
    // `169.254.169.254` is a LITERAL address, so the guard classifies it
    // without a DNS lookup — the assertion is hermetic. The original had no
    // SSRF policy at all: an empty `deniedDomains` meant the cloud metadata
    // service was reachable from any tool that took a URL.
    const { codes, findings } = await evaluate(
      policy({
        urlArgPaths: { 'sandbox.git.clone': ['url'] },
        denyPrivateNetworks: true,
        sideEffects: { 'sandbox.git.clone': 'read' },
      }),
      { url: 'http://169.254.169.254/latest/meta-data/' },
      { toolName: 'sandbox.git.clone' },
    );
    expect(codes).toContain('egress_private_network');
    // Only the hostname reaches the log — a query string carrying a token must
    // never be persisted by the guard that rejected it.
    expect(findings[0]?.message).not.toContain('/latest/meta-data');
  });

  it('inspects the DECLARED argument, not every string that looks path-ish', async () => {
    // The original scraped every string for `https?://` or a leading slash, so
    // prose containing a slash produced findings and `//evil.com` produced
    // none. Declared paths are authoritative and the scrape is opt-in.
    const declaredPolicy = policy({
      pathArgPaths: { 'repo.write': ['file'] },
      deniedPathPrefixes: ['/etc'],
      sideEffects: { 'repo.write': 'read' },
    });

    const prose = await evaluate(declaredPolicy, { message: 'see /etc/passwd for an example' });
    expect(prose.codes).toEqual([]);

    // …until the operator opts back into it, and then the finding is clamped
    // to a non-blocking 'flag' because a scrape cannot tell an argument from a
    // sentence.
    const scraped = await evaluate(
      policy({ ...declaredPolicy, scanUndeclaredStrings: true }),
      { message: 'see /etc/passwd for an example' },
    );
    expect(scraped.codes).toContain('path_denied');
    expect(scraped.findings[0]?.action).toBe('flag');
    expect(scraped.findings[0]?.block).toBe(false);
  });
});

describe('tool_access: hook dispatch', () => {
  it('degrades rather than passing when handed a subject it cannot evaluate', async () => {
    // POLICY_VALID_HOOKS restricts this family to the tool hooks, so reaching
    // here means the engine dispatched wrongly. Reporting it lets `failMode`
    // decide instead of silently allowing the call.
    const outcome = await runToolAccessPolicy({
      policy: policy({ deny: ['*'] }),
      hook: 'input.pre',
      subject: { kind: 'text', text: 'hello', segments: [{ path: '/text', text: 'hello' }] },
      scope,
      action: 'block',
    });
    expect(outcome.findings).toEqual([]);
    expect(outcome.degraded).toHaveLength(1);
  });

  it('still runs the pre-call policy at tool.post when it is bound only there', async () => {
    // An allow-list bound only to `tool.post` used to enforce nothing but the
    // result size cap. Running the tool cannot be undone, but keeping its
    // result out of the model's context still matters.
    const { codes } = await evaluate(
      policy({ hooks: ['tool.post'], deny: ['repo.write'] }),
      {},
      { hook: 'tool.post', result: 'ok' },
    );
    expect(codes).toContain('tool_not_allowed');
  });
});

// ── The two defects of the port itself ──────────────────────────────────────
/**
 * A product owner configured `deniedDomains: ['*']`, called a tool with
 * `{ url: 'https://admin.acme.internal/ops' }`, and got "ran, clean". Probing
 * the stored shapes found TWO independent causes, and either one alone was
 * enough to make the whole domain plane read as decorative:
 *
 *   deniedDomains: ['*']                    not blocked — `*` was a literal host
 *   deniedDomains: ['acme.internal']        not blocked — nothing to match against
 *   deniedDomains: ['admin.acme.internal']  not blocked — same
 *   deny: ['*']                             blocked — tool NAMES already globbed
 *
 * The last row is what makes the first three a bug rather than a missing
 * feature: `*` worked in one of three look-alike lists.
 */

describe('tool_access: * in a domain list', () => {
  it('denies every host — the owner’s exact configuration, end to end', async () => {
    // No `urlArgPaths`, no `scanUndeclaredStrings`: the configuration as it was
    // actually stored, and the call as it was actually made.
    const { codes, findings } = await evaluate(
      policy({ deniedDomains: ['*'], sideEffects: { 'repo.write': 'read' } }),
      { url: 'https://admin.acme.internal/ops' },
    );
    expect(codes).toContain('egress_domain_denied');
    // Declared grade: the policy's own action, and it blocks. A finding the
    // caller is never told about would have been a second silent failure.
    expect(findings[0]?.block).toBe(true);
    expect(findings[0]?.severity).toBe('high');
    expect(findings[0]?.path).toBe('/args/url');
  });

  it('allows every host when the * is on the allow list', async () => {
    const { codes } = await evaluate(
      policy({ allowedDomains: ['*'], sideEffects: { 'repo.write': 'read' } }),
      { url: 'https://anything.example/x' },
    );
    expect(codes).toEqual([]);
  });

  it('escapes the literal parts, so a dot is a dot and not "any character"', () => {
    // Unescaped, `*.example.com` compiles to /^.*.example.com$/ and matches
    // `wwwXexampleXcom` — an allow-list hole and a deny-list surprise.
    expect(hostDenied('www.example.com', ['*.example.com'])).toBe(true);
    expect(hostDenied('wwwXexampleXcom', ['*.example.com'])).toBe(false);
    expect(hostAllowed('wwwXexampleXcom', ['*.example.com'])).toBe(false);
    expect(hostDenied('apiXexample.com', ['api.*.com'])).toBe(false);
  });

  it('anchors the pattern at both ends', () => {
    // Leading anchor: a glob is not a "contains".
    expect(hostDenied('evil.test.api.example.com', ['api.example.*'])).toBe(false);
    expect(hostAllowed('evil.test.api.example.com', ['api.example.*'])).toBe(false);
    // Trailing anchor: the literal tail has to BE the tail.
    expect(hostDenied('api.example.com.evil.test', ['*.example.com'])).toBe(false);
  });

  it('a trailing * is an open suffix, which on an ALLOW list is a foot-gun', () => {
    // Anchoring cannot save an operator here and the help says so: the tail of
    // `api.example.*` is whatever the pattern's author left open, and
    // `api.example.com.evil.test` is a domain somebody else can register. The
    // documented form, `*.example.com`, has a literal tail and does not.
    expect(hostAllowed('api.example.com.evil.test', ['api.example.*'])).toBe(true);
    expect(hostAllowed('api.example.com.evil.test', ['*.example.com'])).toBe(false);
  });

  it('*.example.com is the SUBDOMAINS and not the apex, which the bare entry already covers', () => {
    // The decision, pinned: the two spellings are not synonyms, so an operator
    // who wants both writes the bare entry (deny) or the leading dot (allow).
    expect(hostDenied('api.example.com', ['*.example.com'])).toBe(true);
    expect(hostDenied('example.com', ['*.example.com'])).toBe(false);
    expect(hostDenied('example.com', ['example.com'])).toBe(true);
    expect(hostDenied('api.example.com', ['example.com'])).toBe(true);
  });

  it('a glob means the same thing in both lists, unlike a bare entry', () => {
    // The asymmetry that produced the bug report lives ONLY in bare entries.
    for (const host of ['example.com', 'api.example.com', 'a.b.example.com', 'notexample.com']) {
      expect(hostAllowed(host, ['*.example.com'])).toBe(hostDenied(host, ['*.example.com']));
    }
  });

  it('drops a leading dot on a glob rather than matching nothing', () => {
    // `.` is the "and its subdomains" shorthand and a glob states its own
    // reach; an entry carrying both would otherwise compile to /^\./ and match
    // no host that has ever existed.
    expect(hostDenied('api.example.com', ['.*.example.com'])).toBe(true);
    expect(hostAllowed('api.example.com', ['.*.example.com'])).toBe(true);
  });

  it('leaves every entry without a * behaving exactly as it did', () => {
    // Deny is a SUFFIX rule, allow is EXACT unless written with a leading dot.
    // Changing either would silently rewrite every stored policy.
    expect(hostDenied('api.example.com', ['example.com'])).toBe(true);
    expect(hostDenied('notexample.com', ['example.com'])).toBe(false);
    expect(hostDenied('api.example.com', ['.example.com'])).toBe(true);

    expect(hostAllowed('example.com', ['example.com'])).toBe(true);
    expect(hostAllowed('api.example.com', ['example.com'])).toBe(false);
    expect(hostAllowed('api.example.com', ['.example.com'])).toBe(true);
    expect(hostAllowed('example.com', ['.example.com'])).toBe(true);

    // The ENTRY is folded — case and a trailing root dot. The HOST arrives
    // already normalised (the runner calls `normalizeHost` on `url.hostname`
    // first), which is why these take a lowercase host and always did.
    expect(hostDenied('api.example.com', ['API.Example.COM.'])).toBe(true);
    expect(hostAllowed('api.example.com', ['API.Example.COM.'])).toBe(true);
    expect(hostDenied('api.example.com', ['*.EXAMPLE.com'])).toBe(true);
    // An empty entry matches nothing rather than everything.
    expect(hostDenied('example.com', [''])).toBe(false);
    expect(hostAllowed('example.com', [''])).toBe(false);
  });

  it('a port in an entry still matches nothing, glob or not', () => {
    // `url.hostname` never carries the port; the field validator says so.
    expect(hostDenied('example.com', ['example.com:8443'])).toBe(false);
    expect(hostDenied('example.com', ['*.com:8443'])).toBe(false);
  });
});

describe('tool_access: allow these, deny the rest', () => {
  /** The owner's requirement, in his words: "otomatik şu 20 domain'i destekle
   *  kalanların hepsini kapat". Non-empty `allowedDomains` was ALREADY that
   *  rule; it never fired because nothing ever reached it. */
  const twentyish = policy({
    allowedDomains: ['api.github.com', 'api.stripe.com', '.acme.com', '*.cdn.example.net'],
    sideEffects: { 'repo.write': 'read' },
  });

  it('denies a host on none of the listed domains, with no declared argument path', async () => {
    const { codes, findings } = await evaluate(twentyish, { url: 'https://admin.acme.internal/ops' });
    expect(codes).toEqual(['egress_domain_denied']);
    expect(findings[0]?.block).toBe(true);
    expect(findings[0]?.message).toContain('not allowed');
  });

  it('lets each of the listed spellings through', async () => {
    for (const url of [
      'https://api.github.com/repos',
      'https://api.stripe.com/v1/charges',
      'https://acme.com/x',
      'https://files.acme.com/x',
      'https://eu.cdn.example.net/asset.png',
    ]) {
      expect((await evaluate(twentyish, { url })).codes).toEqual([]);
    }
  });

  it('still denies the apex of a glob entry, because the glob says subdomains', async () => {
    expect((await evaluate(twentyish, { url: 'https://cdn.example.net/x' })).codes)
      .toContain('egress_domain_denied');
  });
});

describe('tool_access: a url in an argument is a declared target', () => {
  /**
   * The second defect. `urlArgPaths` was empty and the fallback scrape is
   * behind `scanUndeclaredStrings` (default false), so the domain lists were
   * consulted about NOTHING — the reason even the exact host did not fire.
   *
   * The caveat that pins the scrape to 'medium'/'flag' — "cannot tell an
   * argument url from one quoted in a paragraph" — was checked against the
   * subject builder and does not hold here: `toolCallSubject` builds its
   * segments as `walkStringLeaves(args, '/args')`, so every segment IS an
   * argument value. Discovery narrows it further, to an argument whose ENTIRE
   * value is the target, which leaves nothing to infer.
   */

  it('blocks the exact host with nothing declared', async () => {
    const { codes, findings } = await evaluate(
      policy({ deniedDomains: ['admin.acme.internal'], sideEffects: { 'repo.write': 'read' } }),
      { url: 'https://admin.acme.internal/ops' },
    );
    expect(codes).toEqual(['egress_domain_denied']);
    expect(findings[0]?.action).toBe('block');
  });

  it('blocks a suffix match with nothing declared', async () => {
    const { codes } = await evaluate(
      policy({ deniedDomains: ['acme.internal'], sideEffects: { 'repo.write': 'read' } }),
      { url: 'https://admin.acme.internal/ops' },
    );
    expect(codes).toEqual(['egress_domain_denied']);
  });

  it('finds a url at any argument name, at depth, and in an array', async () => {
    const denyAll = policy({ deniedDomains: ['*'], sideEffects: { 'repo.write': 'read' } });
    for (const args of [
      { endpoint: 'https://x.example/a' },
      { request: { webhook_url: 'https://x.example/a' } },
      { targets: ['https://x.example/a'] },
      { src: '//x.example/a' },
    ]) {
      expect((await evaluate(denyAll, args)).codes).toContain('egress_domain_denied');
    }
  });

  it('does NOT discover a url quoted inside a longer argument', async () => {
    // The residue of the caveat, and the line discovery draws: an email body
    // mentioning a host is not the tool reaching for it. Still reachable
    // through the opt-in scan, still clamped there.
    const denyAll = policy({ deniedDomains: ['*'], sideEffects: { 'repo.write': 'read' } });
    expect((await evaluate(denyAll, { body: 'see https://x.example/a for details' })).codes).toEqual([]);

    const scanned = await evaluate(
      policy({ ...denyAll, scanUndeclaredStrings: true }),
      { body: 'see https://x.example/a for details' },
    );
    expect(scanned.codes).toContain('egress_domain_denied');
    expect(scanned.findings[0]?.action).toBe('flag');
    expect(scanned.findings[0]?.block).toBe(false);
  });

  it('does not invent a scheme finding out of an argument nobody declared', async () => {
    // `new URL('project:ABC')` parses. Reporting `egress_scheme_denied` from a
    // value nobody declared would turn a Jira query into a blocking finding.
    const { codes } = await evaluate(
      policy({ deniedDomains: ['*'], sideEffects: { 'repo.write': 'read' } }),
      { jql: 'project:ABC', note: 'mailto:ops@acme.com', file: 'file:///etc/passwd' },
    );
    expect(codes).toEqual([]);
  });

  it('discovers an absolute path argument for the prefix lists', async () => {
    const { codes, findings } = await evaluate(
      policy({ deniedPathPrefixes: ['/etc'], sideEffects: { 'repo.write': 'read' } }),
      { file: '/etc/passwd' },
    );
    expect(codes).toEqual(['path_denied']);
    expect(findings[0]?.block).toBe(true);
    expect(findings[0]?.path).toBe('/args/file');
  });

  it('normalises a discovered path before comparing it', async () => {
    const { codes } = await evaluate(
      policy({ allowedPathPrefixes: ['/workspace'], sideEffects: { 'repo.write': 'read' } }),
      { file: '/workspace/../etc/shadow' },
    );
    expect(codes).toEqual(['path_denied']);
  });

  it('compares a discovered path against the prefixes even when it leaves fsRoot', async () => {
    // Discovery normalises with `rootDeclared: false` on purpose: enforcing the
    // root would make the value fail normalisation and skip the prefix lists
    // entirely, so an out-of-root path an allow-list must deny would produce no
    // finding at all. `path_outside_root` stays a DECLARED-argument finding.
    const { codes } = await evaluate(
      policy({
        fsRoot: '/workspace',
        allowedPathPrefixes: ['/workspace'],
        sideEffects: { 'repo.write': 'read' },
      }),
      { file: '/etc/passwd' },
    );
    expect(codes).toEqual(['path_denied']);
  });

  it('runs a discovered url through the SSRF guard too', async () => {
    // A literal metadata address, so the assertion is hermetic. Before this,
    // `denyPrivateNetworks` only ever saw a DECLARED argument — the same silent
    // non-enforcement, on the control that exists to stop SSRF.
    const { codes } = await evaluate(
      policy({ denyPrivateNetworks: true, sideEffects: { 'repo.write': 'read' } }),
      { url: 'http://169.254.169.254/latest/meta-data/' },
    );
    expect(codes).toContain('egress_private_network');
  });

  it('consults the list at tool.post for a policy bound only there', async () => {
    // The arguments ride along on a tool_result subject, so running the
    // pre-call rules late still has something to read. The RESULT is not
    // discovered from — a result really can be a paragraph.
    const { codes } = await evaluate(
      policy({ hooks: ['tool.post'], deniedDomains: ['*'], sideEffects: { 'repo.write': 'read' } }),
      { url: 'https://admin.acme.internal/ops' },
      { hook: 'tool.post', result: 'ok' },
    );
    expect(codes).toContain('egress_domain_denied');
  });

  it('walks nothing when there is no list to consult', async () => {
    // `fsRoot` alone must not start denying paths, and a policy with no domain
    // and no path rule must not pay for a walk it cannot act on.
    const { codes } = await evaluate(
      policy({ fsRoot: '/workspace', sideEffects: { 'repo.write': 'read' } }),
      { url: 'https://admin.acme.internal/ops', file: '/etc/passwd' },
    );
    expect(codes).toEqual([]);
  });

  it('reports a discovered target once, not twice, when the scan is also on', async () => {
    const { findings } = await evaluate(
      policy({
        deniedDomains: ['*'],
        scanUndeclaredStrings: true,
        sideEffects: { 'repo.write': 'read' },
      }),
      { url: 'https://admin.acme.internal/ops' },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.block).toBe(true);
  });

  it('lets a declared spec win over discovery at the same argument', async () => {
    // A declared path reports a malformed value; discovery skips one. The
    // declared answer must be the one that survives.
    const { codes } = await evaluate(
      policy({
        urlArgPaths: { 'repo.write': ['url'] },
        deniedDomains: ['*'],
        sideEffects: { 'repo.write': 'read' },
      }),
      { url: 'http://[not a url' },
    );
    expect(codes).toEqual(['invalid_url']);
  });
});

describe('tool_access: path prefixes took no glob, and say so', () => {
  const specFields = catalogFor('tool_access')?.fields ?? [];
  const defaults = () => catalogFor('tool_access')?.defaults() ?? {};
  const issuesFor = (config: Record<string, unknown>, key: string) =>
    validatePolicyFields(specFields, { ...defaults(), ...config }).filter((issue) => issue.key === key);

  it('a * in a prefix still matches nothing — the semantics did not change', async () => {
    // `matchesAnyPrefix` is unchanged: a prefix already covers everything
    // beneath it, and a glob could not survive the normalisation against
    // `fsRoot` that lets a prefix be written relative.
    const { codes } = await evaluate(
      policy({
        pathArgPaths: { 'repo.write': ['file'] },
        deniedPathPrefixes: ['/etc/*'],
        sideEffects: { 'repo.write': 'read' },
      }),
      { file: '/etc/passwd' },
    );
    expect(codes).toEqual([]);

    // …and the prefix that DOES work is the plain one.
    const plain = await evaluate(
      policy({
        pathArgPaths: { 'repo.write': ['file'] },
        deniedPathPrefixes: ['/etc'],
        sideEffects: { 'repo.write': 'read' },
      }),
      { file: '/etc/passwd' },
    );
    expect(plain.codes).toEqual(['path_denied']);
  });

  it('says so in the editor rather than matching nothing in silence', () => {
    const denied = issuesFor({ deniedPathPrefixes: ['/etc/*'] }, 'deniedPathPrefixes');
    expect(denied).toHaveLength(1);
    expect(denied[0]?.message).toContain('not a wildcard');
    expect(denied[0]?.message).toContain('/workspace');

    const allowed = issuesFor({ allowedPathPrefixes: ['/workspace/*'] }, 'allowedPathPrefixes');
    expect(allowed).toHaveLength(1);

    // A plain prefix is not flagged, and neither is the url-in-a-path-list
    // check it shares the field with.
    expect(issuesFor({ deniedPathPrefixes: ['/etc'] }, 'deniedPathPrefixes')).toEqual([]);
    expect(issuesFor({ deniedPathPrefixes: ['https://x.example'] }, 'deniedPathPrefixes')[0]?.message)
      .toContain('url');
  });

  it('flags the undeclared scan when there is nothing for it to compare against', () => {
    const orphan = issuesFor({ scanUndeclaredStrings: true }, 'scanUndeclaredStrings');
    expect(orphan).toHaveLength(1);
    expect(orphan[0]?.message).toContain('no domain and no path list');

    expect(issuesFor(
      { scanUndeclaredStrings: true, deniedDomains: ['internal.corp'] },
      'scanUndeclaredStrings',
    )).toEqual([]);
    expect(issuesFor({ scanUndeclaredStrings: false }, 'scanUndeclaredStrings')).toEqual([]);
  });

  it('does not flag a * in a domain list, where it now works', () => {
    expect(issuesFor({ deniedDomains: ['*'] }, 'deniedDomains')).toEqual([]);
    expect(issuesFor({ allowedDomains: ['*.example.com'] }, 'allowedDomains')).toEqual([]);
  });
});


// ── The placeholder must not lie about the engine ────────────────────────────
describe('tool_access: sideEffectActions placeholders match the engine', () => {
  it('every closed key resolves to the action the engine actually applies', () => {
    // The placeholder is the ONLY place an operator learns what an UNSET side
    // effect does. A single `defaultValue` said 'allow' for all five while the
    // engine warns on two of them, so the form was telling operators that a
    // destructive tool they never configured would be allowed.
    const spec = (catalogFor('tool_access')?.fields ?? []).find(
      (f) => f.key === 'sideEffectActions',
    ) as { defaultValue?: string; defaultValues?: Record<string, string>; keys?: readonly { value: string }[] } | undefined;
    expect(spec).toBeDefined();

    const shown = (key: string) => spec?.defaultValues?.[key] ?? spec?.defaultValue;

    // These five are `DEFAULT_SIDE_EFFECT_ACTIONS`, restated here on purpose:
    // importing the engine's private map would make this test agree with
    // itself, and the point is that the two files agree with EACH OTHER.
    const engine: Record<string, string> = {
      none: 'allow',
      read: 'allow',
      write: 'allow',
      destructive: 'warn',
      external: 'warn',
    };

    for (const [key, action] of Object.entries(engine)) {
      expect(shown(key), `placeholder for "${key}"`).toBe(action);
    }
    // …and the form draws a row for each of them, so none is silently unshown.
    expect((spec?.keys ?? []).map((k) => k.value).sort()).toEqual(Object.keys(engine).sort());
  });
});
