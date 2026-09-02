'use client';

/**
 * USAGE — the five places this guardrail can actually run, and what each one
 * can and cannot enforce.
 *
 * Replaces the old "API Usage" tab, which showed ONE endpoint
 * (`/api/client/v1/guardrails/evaluate`) and never mentioned that a hook plane
 * exists. That tab was thorough about the surface almost nobody enforces with
 * and silent about every surface that does: the gateway binding, the hook
 * endpoint, the agent-SDK bridge and the MCP seam. Worse, it presented the
 * legacy endpoint as "the" way to use a guardrail — while that route evaluates
 * `input.pre` and nothing else, so a guardrail whose policies all sit on
 * `output.pre` answers it with a vacuous pass.
 *
 * ── THE AGENT-SDK TAB SHOWS THE PLUGIN PATH ───────────────────────────────
 * The agent SDK has TWO planes and they do not have the same powers, so this
 * screen states which one the installed build is on before it states anything
 * else. On the PLUGIN plane a guardrail reaches tool calls (preToolUse /
 * postToolUse), a redact verdict is a real rewrite of the payload, and the
 * plugin is forwarded to sub-agents. On the older ConversationGuardrail plane
 * none of the three is true. Reporting one plane's limits as the other's is
 * exactly the failure that made this tab claim a served hook was unservable, so
 * every capability sentence here comes from the probe, per plane, and the
 * sub-agent claim — which is a SECURITY claim — is rendered only when the probe
 * says `subagentInheritance` and `plane: 'plugin'`.
 *
 * ── WHAT THIS COMPONENT MAY NOT IMPORT ────────────────────────────────────
 * `hooks/contract` only — the leaf of the hook plane (types plus pure
 * constants). `hooks/legacy`, `hooks/engine` and `sdkAdapter` all reach the
 * `@/lib/database` barrel, which constructs providers and registers shutdown
 * handlers the moment it loads. So every wire fact below is either IMPORTED
 * from the contract (hook ids, subject kinds, header names, status codes,
 * visibility defaults) or FETCHED from the server: the agent-SDK capability
 * table comes from `GET /api/guardrails/:key/compiled?target=agent-sdk`, which
 * serves `sdkAdapter.capabilities()` verbatim. Restating that table here would
 * make this screen lie the day the installed SDK gains the plugin layer — which
 * is the single worst failure mode a guardrail UI has: a policy that says
 * "enforce" while nothing fires, or a screen that says "impossible" about
 * something the build in front of it does.
 *
 * `declaredHooks()` re-derives what the server computes in
 * `declaredGuardrailHooks` / `activeHooks`, for the same reason and with the
 * same trade-off as `GuardrailBindingList.declaredHooks` — the server stays
 * authoritative.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Code,
  CopyButton,
  Group,
  List,
  Paper,
  Stack,
  Table,
  Tabs,
  Text,
  Tooltip,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconApi,
  IconBolt,
  IconCheck,
  IconCopy,
  IconInfoCircle,
  IconRobot,
  IconServer,
  IconWebhook,
} from '@tabler/icons-react';
import {
  DEFAULT_VERDICT_VISIBILITY,
  HOOK_IDS,
  HOOK_SUBJECT_KIND,
  VERDICT_HEADERS,
  VERDICT_STATUS,
} from '@/lib/services/guardrail/hooks/contract';
import type {
  GuardrailHooksConfig,
  HookId,
  VerdictVisibility,
} from '@/lib/services/guardrail/hooks/contract';

// ── vocabulary ────────────────────────────────────────────────────────────

/** Used only when the page is rendered without a browser origin (SSR pass,
 *  tests). The effect below replaces it with the real one. */
const FALLBACK_BASE = 'https://your-cognipeer-host';

/** Short labels, matching `GuardrailBindingList` so one hook is not called two
 *  different things on two screens. */
const HOOK_LABEL: Readonly<Record<HookId, string>> = {
  'prompt.pre': 'Prompt',
  'input.pre': 'Input',
  'output.pre': 'Output',
  'output.stream.delta': 'Streaming output',
  'tool.pre': 'Before a tool',
  'tool.post': 'After a tool',
};

/**
 * What a guardrail written before the hook plane covers. Mirrors
 * `liftLegacyHooks()`: a legacy row was bindable to the two direction slots and
 * nothing else, so those are the hooks it declares once lifted. Rendering such
 * a guardrail as covering NOTHING would show an empty screen for the guardrails
 * most consumers are actually bound to.
 */
const LEGACY_DECLARED_HOOKS: readonly HookId[] = ['input.pre', 'output.pre'];

/** The consumers a guardrail can be bound to from the dashboard. */
export type UsageSurface = 'model' | 'agent' | 'mcp';

/**
 * WHICH HOOKS EACH CONSUMER ACTUALLY EMITS. Not "which hooks the column
 * accepts" — every consumer stores the same binding shape — but which ones have
 * a live emitter on that path:
 *
 *  · model — the gateway (`inferenceService`) evaluates the prompt, the answer,
 *    and the stream through `createStreamGate`. A model never calls a tool, so
 *    the tool hooks have no emitter there at all.
 *  · agent — `agentService` evaluates the prompt, the answer and BOTH tool
 *    hooks around every tool the agent runs. It does NOT emit
 *    `output.stream.delta`: the SDK's `onStream` is a synchronous
 *    void-returning callback, so there is no awaitable decision point and no
 *    channel to withhold a chunk (verified against the installed SDK). A
 *    CONNECTED agent additionally serves neither tool hook — its tools run on
 *    the remote endpoint — which is a per-record fact this table cannot carry;
 *    the runtime warns instead.
 *  · mcp — the MCP seam evaluates tool arguments and tool results. An MCP
 *    server has no prompt and no answer of its own.
 *
 * `prompt.pre` is absent from ALL THREE and that is the whole point of it: no
 * console surface emits it, only a remote enforcement point does (hooks/contract
 * HOOK_IDS). It therefore renders as inert on every consumer, which is true.
 *
 * The runtime says the same thing once per run through
 * `agentService.warnUnservableAgentBindings` (the stream and prompt hooks) and
 * `warnUnservableExternalBindings` (those plus the tool hooks, on a connected
 * agent), so a binding that cannot fire is reported on both the screen where it
 * is made and the log of the run that ignored it.
 */
export const SURFACE_HOOKS: Readonly<Record<UsageSurface, readonly HookId[]>> = {
  model: ['input.pre', 'output.pre', 'output.stream.delta'],
  agent: ['input.pre', 'output.pre', 'tool.pre', 'tool.post'],
  mcp: ['tool.pre', 'tool.post'],
};

/**
 * The one sentence this screen falls back to when the live capability table
 * cannot be read, kept in step with `sdkAdapter.HOOK_CAPABILITY_REASON` and
 * rendered ONLY with an explicit "this is static" caveat — a stale capability
 * claim presented as current is the failure this panel exists to prevent.
 *
 * It is the ONE claim on this screen that holds on BOTH SDK planes, which is
 * why it is safe to keep as a static fallback at all: the SDK's own plugin
 * capability report says the same thing about `features.streamGate`, quoted
 * here, so an operator reading this and an engineer reading the SDK are reading
 * one sentence.
 */
export const STATIC_STREAM_LIMITATION =
  'There is no hook on stream deltas. onStream is synchronous and void, so a chunk cannot '
  + 'be held back or blocked in real time. A postModelCall rewrite fixes the transcript, '
  + 'never what was already emitted — so a streamed answer is audited after the fact at '
  + 'output.pre, once the bytes have already left. Real-time hold-back exists on the '
  + 'gateway, which owns the socket.';

// ── derivations (pure, unit-tested) ───────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A record whose `hooks` were DERIVED from the legacy columns rather than
 * authored. Same fail-safe as `ensureHooks`: a config with no usable `policies`
 * array is treated as absent rather than trusted.
 */
export function isLegacyConfig(hooks: GuardrailHooksConfig | undefined): boolean {
  return !hooks || !Array.isArray(hooks.policies);
}

/**
 * Hooks this guardrail will ACTUALLY do something on: the hook needs an enabled
 * binding AND an enabled policy naming it. Either half missing is the
 * "configured and never runs" state, and listing it here would tell an operator
 * they are protected on a hook nothing fires on.
 */
export function declaredHooks(hooks: GuardrailHooksConfig | undefined): HookId[] {
  if (isLegacyConfig(hooks) || !hooks) return [...LEGACY_DECLARED_HOOKS];
  const policies = hooks.policies;
  return HOOK_IDS.filter(
    (hook) =>
      hooks.bindings?.[hook]?.enabled === true
      && policies.some((policy) => policy.enabled && policy.hooks?.includes(hook)),
  );
}

/** The master switch. A stream binding with this off is post-hoc audit only —
 *  the text has already reached the caller. */
export function streamingEnforced(hooks: GuardrailHooksConfig | undefined): boolean {
  return hooks?.stream?.enabled === true;
}

/**
 * Verdict visibility with defaults filled in FIELD BY FIELD, mirroring
 * `resolveVerdictVisibility` on the server. Not a spread over the defaults:
 * every stored field is optional, so `{ ...defaults, ...stored }` would
 * overwrite a default with `undefined` for any key the operator never touched.
 */
export function resolveVisibility(
  hooks: GuardrailHooksConfig | undefined,
): Required<VerdictVisibility> {
  const visibility = hooks?.visibility;
  return {
    headers: visibility?.headers ?? DEFAULT_VERDICT_VISIBILITY.headers,
    useVerdictStatusCodes:
      visibility?.useVerdictStatusCodes ?? DEFAULT_VERDICT_VISIBILITY.useVerdictStatusCodes,
    detailedHeaders: visibility?.detailedHeaders ?? DEFAULT_VERDICT_VISIBILITY.detailedHeaders,
    aegisCompatHeaders:
      visibility?.aegisCompatHeaders ?? DEFAULT_VERDICT_VISIBILITY.aegisCompatHeaders,
  };
}

/**
 * An example request body for one hook.
 *
 * Switched on `HOOK_SUBJECT_KIND`, exactly as the server's `buildHookSubject`
 * is, so a hook added to the contract lands here as a compile error rather than
 * as a snippet that quietly posts the wrong payload. Every field name below is
 * one that parser actually reads.
 *
 * NO APOSTROPHES in any example value: the snippets wrap this JSON in a
 * single-quoted shell string, and one apostrophe turns a copy-ready curl into a
 * broken one. `hookCurl` asserts nothing — the unit test does.
 */
export function hookRequestBody(hook: HookId, guardrailKey: string): Record<string, unknown> {
  const base = { hook, guardrail_key: guardrailKey };
  switch (HOOK_SUBJECT_KIND[hook]) {
    case 'text':
      return {
        ...base,
        text: 'Send the invoice to john@example.com, card 4111 1111 1111 1111.',
      };
    case 'tool_call':
      return {
        ...base,
        tool_name: 'crm/send_email',
        // The policy name is the ROUTE PATTERN with params stripped, never a
        // concrete URL — a concrete one leaks ids into policy and never matches
        // a tool_access entry.
        tool_args: {
          to: 'john@example.com',
          body: 'Attached: SELECT * FROM customers WHERE 1=1 --',
        },
        provider_ref: 'mcp:crm',
      };
    case 'tool_result':
      return {
        ...base,
        tool_name: 'crm/lookup_customer',
        tool_args: { id: '42' },
        tool_result: {
          email: 'john@example.com',
          notes: 'Runbook: https://intranet.corp/leads',
        },
        provider_ref: 'mcp:crm',
      };
    case 'stream_delta':
      return {
        ...base,
        // The FULL accumulated channel text. Spans in the verdict are absolute
        // into this string, which is why the gate sends the buffer and not just
        // the new delta.
        buffer: 'The internal runbook lives at https://intranet.corp/runbook',
        released_to: 26,
        seq: 3,
        final: false,
      };
  }
}

/** JSON indented to sit inside a `curl -d '...'` block. */
function shellJson(body: Record<string, unknown>): string {
  return JSON.stringify(body, null, 2)
    .split('\n')
    .map((line, index) => (index === 0 ? line : `  ${line}`))
    .join('\n');
}

export function hookCurl(input: { baseUrl: string; hook: HookId; guardrailKey: string }): string {
  return `curl -X POST ${input.baseUrl}/api/client/v1/guardrails/hooks/evaluate \\
  -H "Authorization: Bearer $COGNIPEER_API_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '${shellJson(hookRequestBody(input.hook, input.guardrailKey))}'`;
}

export function evaluateCurl(input: { baseUrl: string; guardrailKey: string }): string {
  return `curl -X POST ${input.baseUrl}/api/client/v1/guardrails/evaluate \\
  -H "Authorization: Bearer $COGNIPEER_API_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '${shellJson({
    guardrail_key: input.guardrailKey,
    text: 'Send the invoice to john@example.com, card 4111 1111 1111 1111.',
  })}'`;
}

// ── the SDK capability table, read from the server ────────────────────────

/**
 * Which SDK surface the console compiled against. Mirrors `sdkAdapter.SdkPlane`
 * and is the single fact this whole tab now branches on: the plugin plane and
 * the ConversationGuardrail plane serve DIFFERENT hooks with DIFFERENT
 * guarantees, and stating one plane's limits as the other's is the bug this
 * screen is being corrected for.
 */
export type SdkPlaneView = 'plugin' | 'legacy' | 'unknown';

export interface SdkHookCapabilityView {
  supported: boolean;
  /** The SDK surface that serves it: a plugin hook name, or a GuardrailPhase. */
  phase?: string;
  sdkHook?: string;
  /** True when a redact verdict lands as a real rewrite on this hook. */
  rewrites?: boolean;
  reason: string;
}

export interface SdkCapabilitiesView {
  contractVersion?: number;
  plane: SdkPlaneView;
  /** False until the adapter has actually asked the installed SDK. */
  probed: boolean;
  /** `pluginCapabilities().hookContractVersion`, when there is a plugin layer. */
  hookContractVersion?: number;
  sdkVersion?: string;
  hooks: Partial<Record<HookId, SdkHookCapabilityView>>;
  /** Whether a verdict can rewrite content at all on this plane. */
  mutations: boolean;
  /** The hooks whose payload a redact verdict actually rewrites. */
  mutableHooks: HookId[];
  /** 'plugin' — `GateResult.mutatedBy` names plugins, never spans. */
  mutationProvenance: 'plugin' | 'none';
  /** A block can never be delivered before bytes reach the caller. */
  streamHoldBack: boolean;
  /** Whether the compiled artifact is forwarded to SUB-AGENTS. */
  subagentInheritance: boolean;
  /** Phases the INSTALLED SDK declares that the adapter does not map — the
   *  signal that the SDK grew a surface the console is not using yet. */
  unmappedPhases?: string[];
  /** Plugin slots/features the installed build reports as not implemented. */
  unimplemented?: string[];
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/**
 * Read `sdkAdapter.capabilities()` out of the compiled-policy payload.
 *
 * Accepts either the whole `GET /guardrails/:key/compiled` envelope or the bare
 * capability object, and returns null for anything it cannot recognise — the
 * caller then renders the static note WITH a caveat rather than an empty table
 * or, worse, an optimistic default.
 *
 * EVERY BOOLEAN DEFAULTS TO THE PESSIMISTIC READING, and `plane` defaults to
 * 'unknown' rather than to 'plugin'. An older console serving a payload without
 * these keys must render as "we do not know yet", never as "you are on the
 * plugin plane and your tool policy reaches sub-agents" — that sentence is a
 * security claim, and a claim inferred from a missing field is a false one.
 */
export function parseSdkCapabilities(payload: unknown): SdkCapabilitiesView | null {
  if (!isRecord(payload)) return null;
  const caps = isRecord(payload.capabilities) ? payload.capabilities : payload;
  if (!isRecord(caps.hooks)) return null;

  const table = caps.hooks;
  const hooks: Partial<Record<HookId, SdkHookCapabilityView>> = {};
  for (const hook of HOOK_IDS) {
    const entry = table[hook];
    if (!isRecord(entry) || typeof entry.reason !== 'string') continue;
    // `sdkHook` and `rewrites` are OMITTED rather than defaulted when the
    // payload does not carry them: an older console has no opinion about either,
    // and writing `rewrites: false` in would state as fact something it never
    // said. The renderer falls back to `phase` and to "block only".
    hooks[hook] = {
      supported: entry.supported === true,
      ...(typeof entry.phase === 'string' ? { phase: entry.phase } : {}),
      ...(typeof entry.sdkHook === 'string' ? { sdkHook: entry.sdkHook } : {}),
      ...(entry.rewrites === true ? { rewrites: true } : {}),
      reason: entry.reason,
    };
  }
  if (Object.keys(hooks).length === 0) return null;

  const plane: SdkPlaneView =
    caps.plane === 'plugin' || caps.plane === 'legacy' ? caps.plane : 'unknown';
  const unmapped = stringList(caps.unmappedPhases);
  const unimplemented = stringList(caps.unimplemented);
  const mutableHooks = stringList(caps.mutableHooks).filter((hook): hook is HookId =>
    (HOOK_IDS as readonly string[]).includes(hook));

  return {
    contractVersion: typeof caps.contractVersion === 'number' ? caps.contractVersion : undefined,
    plane,
    probed: caps.probed === true,
    hookContractVersion:
      typeof caps.hookContractVersion === 'number' ? caps.hookContractVersion : undefined,
    sdkVersion: typeof caps.sdkVersion === 'string' ? caps.sdkVersion : undefined,
    hooks,
    mutations: caps.mutations === true,
    mutableHooks:
      mutableHooks.length > 0
        ? mutableHooks
        // An older payload has no `mutableHooks`; derive it from the per-hook
        // flags rather than reporting none, which would read as "redaction never
        // lands" on a build where it does.
        : HOOK_IDS.filter((hook) => hooks[hook]?.rewrites === true),
    mutationProvenance: caps.mutationProvenance === 'plugin' ? 'plugin' : 'none',
    streamHoldBack: caps.streamHoldBack === true,
    subagentInheritance: caps.subagentInheritance === true,
    unmappedPhases: unmapped.length > 0 ? unmapped : undefined,
    unimplemented: unimplemented.length > 0 ? unimplemented : undefined,
  };
}

/**
 * The copy-ready one-liner, PER PLANE.
 *
 * `compileToSdkPlugin` is the primary path and the default the screen shows: a
 * plugin can block a tool call before it runs, rewrite what a redact verdict
 * found, and ride into sub-agents. `compileToSdkGuardrail` is shown only when
 * the installed build has no plugin layer — it is still what runs there, so
 * hiding it would leave an operator on 0.9.x with a snippet that throws.
 *
 * Both import from the adapter module rather than the service barrel, which is
 * the path that resolves today.
 */
export function sdkSnippet(input: { guardrailKey: string; plane: SdkPlaneView }): string {
  const preamble =
    '// Runs where the console runs: a self-hosted deployment, an in-process job,\n'
    + '// a route in this repo. The compile step needs the authenticated scope.\n'
    + "import { createSmartAgent } from '@cognipeer/agent-sdk';";
  const scope =
    '  scope: {\n'
    + '    tenantId, tenantDbName, projectId,      // from the authenticated context\n'
    + "    actor: { id: userId, kind: 'agent', roles },\n"
    + "    surface: 'agent',\n"
    + "    source: 'my-agent',\n"
    + '    traceId,\n'
    + '  },\n'
    + "  evaluation: 'split',   // deterministic families first, then the LLM/webhook pass";

  if (isLegacyPlane(input.plane)) {
    return `${preamble}
import { compileToSdkGuardrail } from '@/lib/services/guardrail/sdkAdapter';

// The installed SDK has no plugin layer, so this build compiles to the older
// ConversationGuardrail bridge: prompt/input/output only, no tool hooks, and a
// redact verdict is recorded rather than applied.
const guardrail = await compileToSdkGuardrail('${input.guardrailKey}', {
${scope}
});

const agent = createSmartAgent({ model, tools, guardrails: [guardrail] });`;
  }

  return `${preamble}
import { compileToSdkPlugin } from '@/lib/services/guardrail/sdkAdapter';

const plugin = await compileToSdkPlugin('${input.guardrailKey}', {
${scope}
  // failureMode comes from this guardrail's own failMode (console default: open).
  // inheritToSubagents defaults to true, so tool policy is not bypassable by
  // delegating the call to a child agent.
});

const agent = createSmartAgent({ model, tools, plugins: [plugin] });

// Not sure which SDK is installed? compileConsoleGuardrail() probes and returns
// { plane: 'plugin', plugin } or { plane: 'legacy', guardrail }.`;
}

/** Extracted so the branch has a name; `unknown` shows the plugin path, which is
 *  the one being migrated to, with the plane caveat rendered beside it. */
function isLegacyPlane(plane: SdkPlaneView): boolean {
  return plane === 'legacy';
}

// ── small presentational helpers ──────────────────────────────────────────

/** A titled, copyable code block. Same idiom as `PiiApiUsage.Snippet`. */
function Snippet({
  title,
  description,
  code,
}: {
  title: string;
  description?: string;
  code: string;
}) {
  return (
    <Paper withBorder radius="md" p="md">
      <Text fw={600} mb={description ? 4 : 'xs'}>{title}</Text>
      {description ? <Text size="xs" c="dimmed" mb="sm">{description}</Text> : null}
      <Box style={{ position: 'relative' }}>
        <CopyButton value={code} timeout={2000}>
          {({ copied, copy }) => (
            <Tooltip label={copied ? 'Copied' : 'Copy'} withArrow>
              <Button
                size="xs"
                variant={copied ? 'filled' : 'outline'}
                color={copied ? 'teal' : 'gray'}
                leftSection={copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
                style={{ position: 'absolute', top: 8, right: 8, zIndex: 1 }}
                onClick={copy}
              >
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </Tooltip>
          )}
        </CopyButton>
        <Code block fz="xs" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{code}</Code>
      </Box>
    </Paper>
  );
}

function SectionCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <Paper withBorder radius="md" p="md">
      <Text fw={600} mb={description ? 4 : 'xs'}>{title}</Text>
      {description ? <Text size="xs" c="dimmed" mb="sm">{description}</Text> : null}
      {children}
    </Paper>
  );
}

/** Green when this guardrail declares the hook, grey when it does not. */
function HookBadge({ hook, declared }: { hook: HookId; declared: boolean }) {
  return (
    <Badge size="xs" variant="light" color={declared ? 'teal' : 'gray'}>
      {hook}
    </Badge>
  );
}

// ── props ─────────────────────────────────────────────────────────────────

export interface GuardrailUsagePanelProps {
  /** The tenant-scoped slug every snippet below carries. */
  guardrailKey: string;
  guardrailName: string;
  /**
   * The guardrail's hook config as stored. `undefined` — or any config without
   * a usable `policies` array — is a LEGACY row: the panel then reports the two
   * hooks a legacy record lifts onto, and says so, rather than rendering a
   * guardrail that covers nothing.
   */
  hooks: GuardrailHooksConfig | undefined;
  /**
   * Origin for the copyable snippets. Defaults to the browser's own origin,
   * resolved in an effect so the server-rendered pass and the first client
   * render agree.
   */
  baseUrl?: string;
}

// ── component ─────────────────────────────────────────────────────────────

export default function GuardrailUsagePanel({
  guardrailKey,
  guardrailName,
  hooks,
  baseUrl,
}: GuardrailUsagePanelProps) {
  const [origin, setOrigin] = useState<string>(baseUrl ?? FALLBACK_BASE);
  const [sdk, setSdk] = useState<SdkCapabilitiesView | null>(null);
  const [sdkError, setSdkError] = useState<string | null>(null);

  useEffect(() => {
    if (baseUrl) {
      setOrigin(baseUrl);
      return;
    }
    if (typeof window !== 'undefined') setOrigin(window.location.origin);
  }, [baseUrl]);

  /**
   * The agent-SDK capability table, live.
   *
   * `?target=agent-sdk` is the only target the compiled endpoint emits, and its
   * `capabilities` block is `sdkAdapter.capabilities()` verbatim — the same
   * table both compilers are derived from. Reading it beats restating it: the
   * day the installed SDK gains the plugin layer, this screen stops describing
   * the ConversationGuardrail plane's limits without anyone editing this file.
   *
   * ONE RETRY, and only for `probed: false`. `capabilities()` is synchronous, so
   * the very first call in a fresh server process answers before it has managed
   * to load the SDK and ask it; it schedules that probe and every later call
   * returns the real table. Re-asking once turns that into a flicker instead of
   * a screen that says "which plane is in use has not been determined yet" until
   * the operator reloads. Bounded at one on purpose — a build that genuinely
   * cannot be probed must show that state, not poll forever.
   */
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setSdk(null);
    setSdkError(null);

    const read = (attempt: number): void => {
      fetch(
        `/api/guardrails/${encodeURIComponent(guardrailKey)}/compiled?target=agent-sdk`,
        { cache: 'no-store' },
      )
        .then(async (res) => {
          if (!res.ok) throw new Error(`the compiled policy answered HTTP ${res.status}`);
          return (await res.json()) as unknown;
        })
        .then((payload) => {
          if (cancelled) return;
          const parsed = parseSdkCapabilities(payload);
          if (!parsed) throw new Error('the compiled policy carried no capability table');
          setSdk(parsed);
          if (!parsed.probed && attempt === 0) {
            timer = setTimeout(() => {
              if (!cancelled) read(1);
            }, 750);
          }
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          setSdk(null);
          setSdkError(error instanceof Error ? error.message : 'unknown error');
        });
    };

    read(0);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [guardrailKey]);

  const declared = useMemo(() => declaredHooks(hooks), [hooks]);
  const legacy = isLegacyConfig(hooks);
  const visibility = useMemo(() => resolveVisibility(hooks), [hooks]);
  const streaming = streamingEnforced(hooks);
  const declaresToolHook = declared.some((hook) => hook === 'tool.pre' || hook === 'tool.post');

  const evaluateSnippet = evaluateCurl({ baseUrl: origin, guardrailKey });

  const evaluateResponse = `{
  "passed": false,
  "action": "block",
  "disabled": false,
  "findings": [
    { "type": "pii", "category": "creditCard", "severity": "high",
      "message": "Payment card number detected", "action": "redact",
      "block": false, "value": "4111 1111 1111 1111" }
  ],
  "guardrail_key": "${guardrailKey}",
  "guardrail_name": "${guardrailName}",
  "message": null,
  "redacted_text": "Send the invoice to john@example.com, card [REDACTED:creditCard].",
  "verdict": { "...": "the full hook verdict — same object the Hook tab documents" }
}`;

  /** The plane the installed build is on. `unknown` until the probe answers;
   *  the SDK tab renders that state rather than picking a plane for it. */
  const plane: SdkPlaneView = sdk?.plane ?? 'unknown';
  const onPlugin = plane === 'plugin';
  const integrationSnippet = sdkSnippet({ guardrailKey, plane });

  const mcpBinding = `// Persisted on the MCP server record, not on the guardrail:
{
  "guardrail": {
    "guardrailKey": "${guardrailKey}",
    "mode": "enforce"        // "off" | "monitor" | "enforce"
  }
}`;

  return (
    <Stack gap="md">
      {/* ── key + what this guardrail declares ── */}
      <Paper withBorder radius="md" p="md">
        <Text fw={600} mb="xs">Guardrail Key</Text>
        <Group gap="sm">
          <Code fz="sm" style={{ flex: 1 }}>{guardrailKey}</Code>
          <CopyButton value={guardrailKey} timeout={2000}>
            {({ copied, copy }) => (
              <Tooltip label={copied ? 'Copied' : 'Copy'} withArrow>
                <Button
                  size="xs"
                  variant={copied ? 'filled' : 'light'}
                  color={copied ? 'teal' : 'blue'}
                  onClick={copy}
                  leftSection={copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
                >
                  {copied ? 'Copied' : 'Copy key'}
                </Button>
              </Tooltip>
            )}
          </CopyButton>
        </Group>

        <Group gap="xs" mt="sm" wrap="wrap">
          <Text size="xs" c="dimmed">Runs on:</Text>
          {declared.length === 0 ? (
            <Badge size="xs" variant="light" color="orange">
              no hook — every policy is unbound or disabled
            </Badge>
          ) : (
            declared.map((hook) => <HookBadge key={hook} hook={hook} declared />)
          )}
        </Group>

        <Text size="xs" c="dimmed" mt="sm">
          Every snippet below already carries this key. Replace{' '}
          <Code fz="xs">$COGNIPEER_API_TOKEN</Code> with a token from Settings → API Tokens;
          the token is what selects the tenant, so no request body ever names one.
        </Text>
      </Paper>

      {legacy ? (
        <Alert
          color="yellow"
          variant="light"
          icon={<IconInfoCircle size={16} />}
          title="This guardrail predates the hook plane"
        >
          <Text size="xs">
            It has no authored hook config, so it is lifted on every read onto{' '}
            <Code fz="xs">input.pre</Code> and <Code fz="xs">output.pre</Code>, and its policies
            carry <Code fz="xs">legacy:</Code> ids. Everything on this screen works against it —
            the endpoints, the gateway binding and the compiled policy all lift it the same way —
            but the hook list above is derived, not authored, and a later fix to that derivation
            reaches this guardrail without an edit.
          </Text>
        </Alert>
      ) : null}

      <Tabs defaultValue="gateway" variant="pills" radius="md" keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="gateway" leftSection={<IconBolt size={14} />}>Gateway</Tabs.Tab>
          <Tabs.Tab value="client" leftSection={<IconApi size={14} />}>Client API</Tabs.Tab>
          <Tabs.Tab value="hook" leftSection={<IconWebhook size={14} />}>Hook</Tabs.Tab>
          <Tabs.Tab value="sdk" leftSection={<IconRobot size={14} />}>agent-sdk</Tabs.Tab>
          <Tabs.Tab value="mcp" leftSection={<IconServer size={14} />}>MCP</Tabs.Tab>
        </Tabs.List>

        {/* ══ 1 · GATEWAY ═══════════════════════════════════════════════ */}
        <Tabs.Panel value="gateway">
          <Stack gap="md">
            <SectionCard
              title="Bind it, and it runs. No code."
              description="A guardrail is attached to the consumer, not called from your application. Once bound, the hooks below fire on every request through that model or agent — nothing to deploy, nothing to import."
            >
              <List size="sm" spacing="xs">
                <List.Item>
                  <b>On a model</b> —{' '}
                  <Anchor href="/dashboard/models" size="sm">Model Hub</Anchor> → the model row menu →{' '}
                  <b>Guardrail settings</b> → tick the hooks this guardrail should cover there.
                </List.Item>
                <List.Item>
                  <b>On an agent</b> —{' '}
                  <Anchor href="/dashboard/agents" size="sm">Agents</Anchor> → the agent →{' '}
                  <b>Configuration → Guardrails</b> → attach it and tick its hooks.
                </List.Item>
              </List>
              <Text size="xs" c="dimmed" mt="sm">
                A binding decides where a guardrail DOES run; the Hooks tab on this page decides
                where it CAN. A hook ticked on the binding but unbound here never fires, and the
                checkbox is disabled for exactly that reason.
              </Text>
            </SectionCard>

            <SectionCard
              title="A model is not an agent"
              description="Both accept the same binding shape, so the difference is invisible until something silently does not run. It is not a permission difference — it is which hooks have an emitter on that path."
            >
              <Table.ScrollContainer minWidth={620}>
                <Table striped withColumnBorders verticalSpacing="xs" fz="xs">
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th style={{ width: 170 }}>Hook</Table.Th>
                      <Table.Th>On a model (gateway)</Table.Th>
                      <Table.Th>On an agent</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    <Table.Tr>
                      <Table.Td><Code fz="xs">input.pre</Code></Table.Td>
                      <Table.Td>Runs — the prompt, before the model is called.</Table.Td>
                      <Table.Td>Runs — once per loop iteration, each message scanned once.</Table.Td>
                    </Table.Tr>
                    <Table.Tr>
                      <Table.Td><Code fz="xs">output.pre</Code></Table.Td>
                      <Table.Td>Runs — the complete answer, before it reaches the caller.</Table.Td>
                      <Table.Td>Runs — after every model call, including tool-only turns.</Table.Td>
                    </Table.Tr>
                    <Table.Tr>
                      <Table.Td><Code fz="xs">output.stream.delta</Code></Table.Td>
                      <Table.Td>
                        Runs, with <b>real hold-back</b>: bytes are withheld until the window is
                        adjudicated, so a block lands before the text leaves.
                      </Table.Td>
                      <Table.Td c="orange">
                        Does not run. The agent SDK has no awaitable stream hook. Bind{' '}
                        <Code fz="xs">output.pre</Code> as well, or a stream-only binding does
                        nothing at all.
                      </Table.Td>
                    </Table.Tr>
                    <Table.Tr>
                      <Table.Td><Code fz="xs">tool.pre</Code></Table.Td>
                      <Table.Td c="dimmed">Never — a model does not call tools.</Table.Td>
                      <Table.Td>Runs — arguments, before the tool executes.</Table.Td>
                    </Table.Tr>
                    <Table.Tr>
                      <Table.Td><Code fz="xs">tool.post</Code></Table.Td>
                      <Table.Td c="dimmed">Never.</Table.Td>
                      <Table.Td>Runs — the result, before the model sees it.</Table.Td>
                    </Table.Tr>
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>

              {declared.includes('output.stream.delta') && !streaming ? (
                <Alert color="orange" variant="light" mt="sm" icon={<IconAlertTriangle size={16} />}>
                  <Text size="xs">
                    This guardrail is bound to the stream hook but streaming enforcement is OFF in
                    its hook settings, so even on a model a streamed answer is only audited after it
                    has reached the caller.
                  </Text>
                </Alert>
              ) : null}
            </SectionCard>

            <SectionCard
              title={`What "${guardrailName}" would actually do`}
              description="Its own declared hooks, intersected with what each consumer emits."
            >
              <Stack gap="sm">
                {(['model', 'agent', 'mcp'] as const).map((surface) => {
                  const fires = declared.filter((hook) => SURFACE_HOOKS[surface].includes(hook));
                  const inert = declared.filter((hook) => !SURFACE_HOOKS[surface].includes(hook));
                  return (
                    <Group key={surface} gap="xs" wrap="wrap" align="baseline">
                      <Text size="xs" fw={600} style={{ width: 60 }}>
                        {surface === 'mcp' ? 'MCP' : surface}
                      </Text>
                      {fires.length === 0 ? (
                        <Text size="xs" c="orange">
                          nothing fires here
                        </Text>
                      ) : (
                        fires.map((hook) => (
                          <Badge key={hook} size="xs" variant="light" color="teal">
                            {HOOK_LABEL[hook]}
                          </Badge>
                        ))
                      )}
                      {inert.length > 0 ? (
                        <Text size="xs" c="dimmed">
                          · never here: {inert.join(', ')}
                        </Text>
                      ) : null}
                    </Group>
                  );
                })}
              </Stack>
            </SectionCard>
          </Stack>
        </Tabs.Panel>

        {/* ══ 2 · CLIENT API ════════════════════════════════════════════ */}
        <Tabs.Panel value="client">
          <Stack gap="md">
            <SectionCard
              title="POST /api/client/v1/guardrails/evaluate"
              description="The original text shape: one key, one string, one answer. Kept exactly as published — every field it has ever returned still means what it meant."
            >
              <Alert color="blue" variant="light" icon={<IconInfoCircle size={16} />}>
                <Text size="xs">
                  <b>Always 200.</b> Findings or not, would-be-block or not, this endpoint answers
                  200 — that is part of its published shape, and the opt-in 246/446 codes live on
                  the Hook endpoint instead. The decision is in the body, never in the status line.
                  A non-200 here is an auth, key or server error.
                </Text>
              </Alert>

              <Alert
                color="orange"
                variant="light"
                mt="sm"
                icon={<IconAlertTriangle size={16} />}
                title="It evaluates input.pre and nothing else"
              >
                <Text size="xs">
                  The route sends no phase, so policies bound only to{' '}
                  <Code fz="xs">output.pre</Code>, <Code fz="xs">tool.pre</Code> or{' '}
                  <Code fz="xs">tool.post</Code> never run here. A guardrail with nothing on{' '}
                  <Code fz="xs">input.pre</Code> answers <Code fz="xs">disabled: true</Code> — a
                  vacuous pass, not a clean one. Use the Hook endpoint for every other hook.
                  {declared.length > 0 && !declared.includes('input.pre') ? (
                    <>
                      {' '}
                      <b>
                        This guardrail declares no input.pre policy, so this endpoint would return a
                        vacuous pass for it today.
                      </b>
                    </>
                  ) : null}
                </Text>
              </Alert>
            </SectionCard>

            <Snippet
              title="Evaluate text"
              description="Copy-ready against this guardrail."
              code={evaluateSnippet}
            />

            <Snippet title="Response" code={evaluateResponse} />

            <SectionCard title="The four fields that decide behaviour">
              <List size="xs" spacing="xs">
                <List.Item>
                  <Code fz="xs">passed</Code> — was there a BLOCKING finding. Not &quot;was the
                  request blocked&quot;; see the Hook tab, where the two diverge.
                </List.Item>
                <List.Item>
                  <Code fz="xs">action</Code> — the guardrail record&apos;s configured action, NOT
                  the decision this call reached. It is the same value on every response.
                </List.Item>
                <List.Item>
                  <Code fz="xs">disabled</Code> — nothing ran: the guardrail is off, or nothing is
                  bound to <Code fz="xs">input.pre</Code>. Treat it as <b>unknown</b>, never as
                  clean.
                </List.Item>
                <List.Item>
                  <Code fz="xs">redacted_text</Code> — present only when a redaction actually
                  rewrote something. Absent when the verdict blocked (there is nothing to hand back)
                  and when the guardrail is not enforcing.
                </List.Item>
              </List>
              <Text size="xs" c="dimmed" mt="sm">
                <Code fz="xs">verdict</Code> is additive and carries the full hook verdict — spans,
                mutations, risk score, codes and <Code fz="xs">would_be_decision</Code>. It is{' '}
                <Code fz="xs">null</Code> when the guardrail was disabled and nothing was evaluated.
              </Text>
            </SectionCard>
          </Stack>
        </Tabs.Panel>

        {/* ══ 3 · HOOK ══════════════════════════════════════════════════ */}
        <Tabs.Panel value="hook">
          <Stack gap="md">
            <SectionCard
              title="POST /api/client/v1/guardrails/hooks/evaluate"
              description="The real one. One hook, one subject, one merged verdict — what an enforcement point that runs your model or your tools somewhere else should call."
            >
              <List size="xs" spacing={4}>
                <List.Item>
                  <Code fz="xs">hook</Code> — one of {HOOK_IDS.join(', ')}.
                </List.Item>
                <List.Item>
                  <Code fz="xs">guardrail_key</Code>, or <Code fz="xs">guardrail_keys</Code> for
                  several: one hook can be governed by several guardrails and their verdicts merge
                  by max() over allow &lt; flag &lt; warn &lt; redact &lt; block.
                </List.Item>
                <List.Item>
                  <Code fz="xs">only</Code> — run just these policy families, for a latency-sensitive
                  caller that wants the deterministic pass and not the model one.
                </List.Item>
                <List.Item>
                  <Code fz="xs">shadow</Code> — evaluate without writing an evaluation log or a
                  usage event. Opt-IN: a connected enforcement point is real traffic and belongs in
                  the audit trail.
                </List.Item>
                <List.Item>
                  <Code fz="xs">budget_ms</Code>, <Code fz="xs">request_id</Code> — wall-clock
                  budget for synchronous policies (on expiry each policy&apos;s fail mode decides), and
                  your correlation id, reused as the verdict&apos;s trace id.
                </List.Item>
              </List>
              <Text size="xs" c="dimmed" mt="sm">
                There is no tenant field on this body and there must never be one: the tenant and
                the actor come from the API token, because an actor a caller can choose is an actor
                a caller can borrow — and tool policy is keyed on it.
              </Text>
            </SectionCard>

            <Snippet
              title="text — input.pre / output.pre"
              description="The subject is one string; segments are addressed as /text."
              code={hookCurl({ baseUrl: origin, hook: 'input.pre', guardrailKey })}
            />

            <Snippet
              title="tool_call — tool.pre"
              description="Every string leaf of tool_args becomes a scannable segment addressed by JSON Pointer (/args/to, /args/body), so a finding names a place, not just a value. tool_name is policy identity and is deliberately NOT scanned."
              code={hookCurl({ baseUrl: origin, hook: 'tool.pre', guardrailKey })}
            />

            <Snippet
              title="tool_result — tool.post"
              description="Segments cover the RESULT only. The arguments ride along so a tool policy can still see them, but re-scanning them would double-report every finding tool.pre already raised."
              code={hookCurl({ baseUrl: origin, hook: 'tool.post', guardrailKey })}
            />

            <Snippet
              title="stream_delta — output.stream.delta"
              description="Send the full accumulated buffer, not just the new delta: spans come back absolute into it. Holding bytes back is the caller's job here — the console only adjudicates the window."
              code={hookCurl({ baseUrl: origin, hook: 'output.stream.delta', guardrailKey })}
            />

            <SectionCard
              title="What the response says"
              description="snake_case, and every key /guardrails/evaluate returns keeps its exact meaning — the hook plane only adds keys."
            >
              <Table.ScrollContainer minWidth={560}>
                <Table striped withColumnBorders verticalSpacing="xs" fz="xs">
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th style={{ width: 190 }}>Field</Table.Th>
                      <Table.Th>Means</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    <Table.Tr>
                      <Table.Td><Code fz="xs">decision</Code></Table.Td>
                      <Table.Td>
                        The EFFECTIVE decision, already neutralised to{' '}
                        <Code fz="xs">allow</Code> when the guardrail is not enforcing. This is the
                        one to act on; you need no mode policy of your own.
                      </Table.Td>
                    </Table.Tr>
                    <Table.Tr>
                      <Table.Td><Code fz="xs">would_be_decision</Code></Table.Td>
                      <Table.Td>
                        What it would have been under enforcement. The dry-run affordance — report
                        it, never enforce it.
                      </Table.Td>
                    </Table.Tr>
                    <Table.Tr>
                      <Table.Td><Code fz="xs">enforced</Code></Table.Td>
                      <Table.Td>Whether the decision was applied. See below.</Table.Td>
                    </Table.Tr>
                    <Table.Tr>
                      <Table.Td><Code fz="xs">passed</Code></Table.Td>
                      <Table.Td>No blocking finding. See below.</Table.Td>
                    </Table.Tr>
                    <Table.Tr>
                      <Table.Td><Code fz="xs">disabled</Code></Table.Td>
                      <Table.Td>
                        No policy ran — off, or nothing bound to this hook. The{' '}
                        <Code fz="xs">allow</Code> is vacuous, not a clean bill of health.
                      </Table.Td>
                    </Table.Tr>
                    <Table.Tr>
                      <Table.Td>
                        <Code fz="xs">mutations</Code>, <Code fz="xs">subject</Code>,{' '}
                        <Code fz="xs">redacted_text</Code>
                      </Table.Td>
                      <Table.Td>
                        Present only when a redaction actually rewrote something. When they are
                        present, send the rewritten subject onward instead of what you posted —
                        otherwise the redaction did not happen.
                      </Table.Td>
                    </Table.Tr>
                    <Table.Tr>
                      <Table.Td><Code fz="xs">blocked_message</Code></Table.Td>
                      <Table.Td>
                        The rendered end-user message, its reason class, its mode (error or replace)
                        and its status — what you need to refuse the call in your own client&apos;s
                        dialect. Its template variables exclude the matched value on purpose.
                      </Table.Td>
                    </Table.Tr>
                    <Table.Tr>
                      <Table.Td><Code fz="xs">degraded</Code></Table.Td>
                      <Table.Td>
                        Policies that could NOT run, with a reason. Each policy&apos;s fail mode has
                        already been applied — but a pass with a non-empty{' '}
                        <Code fz="xs">degraded</Code> is a pass with a policy missing from it.
                      </Table.Td>
                    </Table.Tr>
                    <Table.Tr>
                      <Table.Td><Code fz="xs">cancelled</Code></Table.Td>
                      <Table.Td>
                        Policies that STARTED and were then abandoned, contributing no finding and
                        no mutation. This engine never abandons work it has started — it decides
                        what to START, so the key is always empty here — but it stays on the wire
                        because a remote enforcement point can populate it, and a policy named
                        there is the one thing a replay of the run cannot reconstruct.
                      </Table.Td>
                    </Table.Tr>
                    <Table.Tr>
                      <Table.Td><Code fz="xs">policy_version</Code></Table.Td>
                      <Table.Td>
                        <Code fz="xs">{'<key>@<updatedAt ISO>'}</Code>, joined with{' '}
                        <Code fz="xs">+</Code> when several guardrails merged. Cache on it.
                      </Table.Td>
                    </Table.Tr>
                    <Table.Tr>
                      <Table.Td>
                        <Code fz="xs">findings</Code>, <Code fz="xs">codes</Code>,{' '}
                        <Code fz="xs">risk_score</Code>, <Code fz="xs">latency_ms</Code>,{' '}
                        <Code fz="xs">trace_id</Code>
                      </Table.Td>
                      <Table.Td>
                        Per-finding detail with family, hook, policy id and (for span-capable
                        detectors) absolute offsets; the machine codes; 0–100; and the correlation
                        id that also appears in the evaluation log.
                      </Table.Td>
                    </Table.Tr>
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>
            </SectionCard>

            <Alert
              color="red"
              variant="light"
              icon={<IconAlertTriangle size={16} />}
              title="enforced: false means the decision was NOT applied"
            >
              <Text size="xs">
                The guardrail is in monitor mode. <Code fz="xs">decision</Code> has already been
                neutralised to <Code fz="xs">allow</Code>, and{' '}
                <Code fz="xs">would_be_decision</Code> is what it would have been.{' '}
                <b>Log it. Do not block on it.</b> An enforcement point that refuses on{' '}
                <Code fz="xs">would_be_decision</Code> is enforcing a policy the operator
                deliberately set to observe — and the operator has no way to see that from here.
              </Text>
            </Alert>

            <Alert
              color="orange"
              variant="light"
              icon={<IconAlertTriangle size={16} />}
              title="passed means &quot;no blocking finding&quot; — not &quot;the request was not blocked&quot;"
            >
              <Text size="xs">
                <Code fz="xs">passed</Code> is <Code fz="xs">false</Code> whenever any finding
                carries <Code fz="xs">block: true</Code>, <b>including in monitor mode, where
                nothing was blocked at all</b>. The two readings diverge exactly there. It keeps
                the legacy meaning because every existing caller reads it that way; to decide
                whether to refuse, read <Code fz="xs">decision === &apos;block&apos;</Code>, which
                is already mode-aware.
              </Text>
            </Alert>

            <SectionCard
              title="Response headers"
              description="The core set is always emitted — you can always see what a guardrail decided without opting into a status code your HTTP client may not survive."
            >
              <List size="xs" spacing={4}>
                <List.Item>
                  <Code fz="xs">{VERDICT_HEADERS.decision}</Code> — allow | flag | warn | redact |
                  block
                </List.Item>
                <List.Item>
                  <Code fz="xs">{VERDICT_HEADERS.enforced}</Code> — true | false, the dry-run signal
                </List.Item>
                <List.Item>
                  <Code fz="xs">{VERDICT_HEADERS.mode}</Code> — enforce | monitor | disabled
                </List.Item>
                <List.Item>
                  <Code fz="xs">{VERDICT_HEADERS.key}</Code>,{' '}
                  <Code fz="xs">{VERDICT_HEADERS.hook}</Code>,{' '}
                  <Code fz="xs">{VERDICT_HEADERS.trace}</Code>
                </List.Item>
              </List>
              <Group gap="xs" mt="sm" wrap="wrap">
                <Badge
                  size="xs"
                  variant="light"
                  color={visibility.detailedHeaders ? 'teal' : 'gray'}
                >
                  detailed headers {visibility.detailedHeaders ? 'on' : 'off'}
                </Badge>
                <Text size="xs" c="dimmed">
                  adds <Code fz="xs">{VERDICT_HEADERS.risk}</Code> and{' '}
                  <Code fz="xs">{VERDICT_HEADERS.codes}</Code> — policy detail in a place proxies
                  log by default, which is why it is opt-in.
                </Text>
              </Group>
              <Group gap="xs" mt="xs" wrap="wrap">
                <Badge
                  size="xs"
                  variant="light"
                  color={visibility.aegisCompatHeaders ? 'teal' : 'gray'}
                >
                  compat aliases {visibility.aegisCompatHeaders ? 'on' : 'off'}
                </Badge>
                <Text size="xs" c="dimmed">
                  <Code fz="xs">{VERDICT_HEADERS.legacyDecision}</Code> /{' '}
                  <Code fz="xs">{VERDICT_HEADERS.legacyTrace}</Code>, plus{' '}
                  <Code fz="xs">{VERDICT_HEADERS.legacyPost}</Code> at{' '}
                  <Code fz="xs">tool.post</Code>. Deprecated; removed in contract v3.
                </Text>
              </Group>
            </SectionCard>

            <SectionCard
              title="Status codes"
              description="200 by default, whatever the verdict — the body carries the decision."
            >
              <Group gap="xs" wrap="wrap">
                <Badge
                  size="xs"
                  variant="light"
                  color={visibility.useVerdictStatusCodes ? 'teal' : 'gray'}
                >
                  verdict status codes {visibility.useVerdictStatusCodes ? 'on' : 'off'}
                </Badge>
                <Text size="xs" c="dimmed">
                  opt in per guardrail, in its verdict visibility settings
                </Text>
              </Group>
              <List size="xs" spacing={4} mt="sm">
                <List.Item>
                  <Code fz="xs">{VERDICT_STATUS.passedWithFindings}</Code> — passed, with findings
                </List.Item>
                <List.Item>
                  <Code fz="xs">{VERDICT_STATUS.blocked}</Code> — blocked. A monitored would-be
                  block reports {VERDICT_STATUS.passedWithFindings}, which is the truth: nothing was
                  blocked.
                </List.Item>
                <List.Item>
                  <Code fz="xs">404</Code> — unknown guardrail key. Deliberate: an unknown key
                  returns an error rather than a vacuous allow an enforcement point would read as
                  &quot;safe&quot;.
                </List.Item>
                <List.Item><Code fz="xs">400</Code> — the body is missing what the hook needs.</List.Item>
              </List>
              <Text size="xs" c="dimmed" mt="sm">
                {VERDICT_STATUS.passedWithFindings} and {VERDICT_STATUS.blocked} are non-standard —
                some HTTP clients and proxies mangle them. That is why they are off unless you ask.
              </Text>
            </SectionCard>

            <Text size="xs" c="dimmed">
              The dashboard twin is{' '}
              <Code fz="xs">POST /api/guardrails/{'{key}'}/hooks/{'{hook}'}</Code> — same shapes,
              same verdict, session-authenticated. It is what the Test tab on this page calls.
            </Text>
          </Stack>
        </Tabs.Panel>

        {/* ══ 4 · AGENT-SDK ═════════════════════════════════════════════ */}
        <Tabs.Panel value="sdk">
          <Stack gap="md">
            <SectionCard
              title="Compile the policy into an agent-SDK plugin"
              description="One console guardrail becomes one PLUGIN the agent runs itself, instead of your code calling an endpoint at each turn. The plugin plane is the target: it reaches tool calls, it can rewrite what a redact verdict found, and it rides into sub-agents."
            >
              <Group gap="xs" wrap="wrap" mb="sm">
                <Badge
                  size="xs"
                  variant="light"
                  color={onPlugin ? 'teal' : plane === 'legacy' ? 'orange' : 'gray'}
                >
                  {onPlugin
                    ? 'installed build: plugin layer'
                    : plane === 'legacy'
                      ? 'installed build: no plugin layer'
                      : 'installed build: not determined yet'}
                </Badge>
                {sdk?.sdkVersion ? (
                  <Badge size="xs" variant="light" color="gray">
                    @cognipeer/agent-sdk {sdk.sdkVersion}
                  </Badge>
                ) : null}
                {sdk?.hookContractVersion !== undefined ? (
                  <Badge size="xs" variant="light" color="gray">
                    hookContractVersion {sdk.hookContractVersion}
                  </Badge>
                ) : null}
                {sdk && !sdk.probed ? (
                  <Badge size="xs" variant="light" color="gray">
                    probe pending
                  </Badge>
                ) : null}
              </Group>
              <Text size="xs" c="dimmed">
                The policy is NOT frozen at compile time: every handler invocation re-resolves the
                record, so a mode change, an action change or a disable takes effect mid-run. Only
                the family/hook plan is read once — a policy ADDED mid-run is picked up on the next
                run.
              </Text>
              {plane === 'legacy' ? (
                <Text size="xs" c="dimmed" mt="xs">
                  This deployment&apos;s SDK has no plugin layer, so the snippet below shows the
                  fallback — <Code fz="xs">compileToSdkGuardrail</Code>, the older
                  ConversationGuardrail bridge. It is what actually runs here. Upgrading the SDK is
                  what turns on the tool hooks and real redaction; nothing on this screen changes
                  until it does.
                </Text>
              ) : null}
            </SectionCard>

            <Snippet
              title={onPlugin ? 'The one-liner' : 'The one-liner, for the SDK installed here'}
              code={integrationSnippet}
            />

            <SectionCard title="What it compiles to">
              <List size="xs" spacing="xs">
                <List.Item>
                  {onPlugin ? (
                    <>
                      One handler per served hook, registered under the plugin hook names the
                      installed build declares in <Code fz="xs">CONSOLE_HOOK_MAP</Code>. A hook that
                      build does not implement gets no handler at all, rather than one that is
                      registered and never called.
                    </>
                  ) : (
                    <>
                      One <Code fz="xs">ConversationGuardrail</Code> with rules on the conversation
                      phases this build declares. There is no tool-level phase on that plane, so
                      tool policy is enforced where the console constructs the tool instead.
                    </>
                  )}
                </List.Item>
                <List.Item>
                  <b><Code fz="xs">split</Code></b> (default) — the deterministic families (pii,
                  secrets, word_filter, regex, tool_access) are adjudicated first, the model and
                  webhook families second. A block from the cheap pass halts the guardrail before
                  the expensive one runs.
                </List.Item>
                <List.Item>
                  <b><Code fz="xs">single</Code></b> — every family in one call: one audit row, one
                  usage event, and the engine&apos;s own ordering intact. A policy with{' '}
                  <Code fz="xs">runIf: onFinding</Code> needs this one.
                </List.Item>
                <List.Item>
                  The deterministic families are adjudicated <b>in process</b>, with no evaluation
                  hop. The model and webhook families are the expensive half, and they can be moved
                  over <Code fz="xs">POST /api/client/v1/guardrails/hooks/evaluate</Code> with{' '}
                  <Code fz="xs">callback: {'{ mode: \'endpoint\', … }'}</Code> — same engine, same
                  verdict, same audit row, so an agent worker need not hold the outbound model and
                  webhook credentials.
                </List.Item>
                <List.Item>
                  Both compile to a <b>console module</b>, not a published client. An agent running{' '}
                  <b>outside</b> the console evaluates nothing locally: it calls the Hook endpoint
                  for every hook, which is what that endpoint is for.
                </List.Item>
              </List>
            </SectionCard>

            <SectionCard
              title="Which hooks the INSTALLED build serves"
              description={
                sdk
                  ? 'Read live from the compiled policy, which serves the adapter’s own capability table — asked of the SDK, not inferred from its version.'
                  : 'The live capability table could not be read; the note below is static and may lag the installed SDK.'
              }
            >
              {sdk ? (
                <Table.ScrollContainer minWidth={640}>
                  <Table striped withColumnBorders verticalSpacing="xs" fz="xs">
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th style={{ width: 170 }}>Hook</Table.Th>
                        <Table.Th style={{ width: 120 }}>Served by</Table.Th>
                        <Table.Th style={{ width: 90 }}>Can redact</Table.Th>
                        <Table.Th>Why</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {HOOK_IDS.map((hook) => {
                        const entry = sdk.hooks[hook];
                        if (!entry) return null;
                        return (
                          <Table.Tr key={hook}>
                            <Table.Td>
                              <Code fz="xs">{hook}</Code>
                              {declared.includes(hook) ? (
                                <Badge size="xs" variant="light" color="teal" ml={6}>
                                  declared
                                </Badge>
                              ) : null}
                            </Table.Td>
                            <Table.Td>
                              <Badge
                                size="xs"
                                variant="light"
                                color={entry.supported ? 'teal' : 'red'}
                              >
                                {entry.supported ? entry.sdkHook ?? entry.phase ?? 'yes' : 'no'}
                              </Badge>
                            </Table.Td>
                            <Table.Td>
                              {entry.supported ? (
                                <Badge
                                  size="xs"
                                  variant="light"
                                  color={entry.rewrites ? 'teal' : 'gray'}
                                >
                                  {entry.rewrites ? 'rewrites' : 'block only'}
                                </Badge>
                              ) : (
                                <Text size="xs" c="dimmed">
                                  —
                                </Text>
                              )}
                            </Table.Td>
                            <Table.Td>{entry.reason}</Table.Td>
                          </Table.Tr>
                        );
                      })}
                    </Table.Tbody>
                  </Table>
                </Table.ScrollContainer>
              ) : (
                <Text size="xs" c="dimmed">
                  {sdkError ? `Could not read it: ${sdkError}.` : 'Reading the capability table…'}
                </Text>
              )}

              {sdk && !sdk.probed ? (
                <Alert color="gray" variant="light" mt="sm" icon={<IconInfoCircle size={16} />}>
                  <Text size="xs">
                    The console has not finished asking the installed SDK which plane it is on, so
                    the rows above report only what BOTH planes can serve. Nothing here is a claim
                    that a hook is impossible — reload in a moment for the probed table.
                  </Text>
                </Alert>
              ) : null}

              {sdk?.unmappedPhases?.length ? (
                <Alert color="blue" variant="light" mt="sm" icon={<IconInfoCircle size={16} />}>
                  <Text size="xs">
                    The installed SDK declares phases the console does not map yet:{' '}
                    {sdk.unmappedPhases.join(', ')}. A new SDK surface shows up here as a
                    diagnostic rather than silently doing nothing.
                  </Text>
                </Alert>
              ) : null}

              {sdk?.unimplemented?.length ? (
                <Alert color="blue" variant="light" mt="sm" icon={<IconInfoCircle size={16} />}>
                  <Text size="xs">
                    The installed build reports these plugin slots and features as not implemented:{' '}
                    <Code fz="xs">{sdk.unimplemented.join(', ')}</Code>. Nothing on this screen
                    depends on them — they are listed so a capability the console might reach for
                    next shows up before someone builds against it.
                  </Text>
                </Alert>
              ) : null}
            </SectionCard>

            {/* ── the sub-agent claim: TRUE ONLY ON THE PLUGIN PLANE ── */}
            <SectionCard title="Sub-agents">
              {onPlugin ? (
                <Text size="xs">
                  <b>Tool policy is inherited by sub-agents on this build.</b> Plugins are forwarded
                  when the agent builds a child, so a tool call the agent delegates is evaluated by
                  the same guardrail as one it makes itself. Compile with{' '}
                  <Code fz="xs">inheritToSubagents: false</Code> to opt out — and know that a child
                  then runs under none of this guardrail&apos;s policy.
                </Text>
              ) : (
                <Text size="xs" c="orange">
                  <b>Tool policy is NOT inherited by sub-agents on this build.</b> The
                  ConversationGuardrail plane&apos;s <Code fz="xs">guardrails</Code> array is not
                  forwarded to a child agent, so an agent that delegates a tool call to a sub-agent
                  is outside this guardrail. That is bypassable by design, not by accident, and it
                  is the main reason the plugin plane exists. Until the SDK is upgraded, enforce
                  tool policy on the MCP server binding as well.
                  {plane === 'unknown' ? (
                    <> The plane has not been probed yet, so this is the conservative reading.</>
                  ) : null}
                </Text>
              )}
            </SectionCard>

            {/* ── honest limit 1 of 2 ── */}
            <Alert
              color="red"
              variant="light"
              icon={<IconAlertTriangle size={16} />}
              title="No real-time blocking on the agent path"
            >
              <Text size="xs">
                {sdk
                  ? sdk.hooks['output.stream.delta']?.reason ?? STATIC_STREAM_LIMITATION
                  : STATIC_STREAM_LIMITATION}
              </Text>
              {!sdk ? (
                <Text size="xs" c="dimmed" mt={6}>
                  Static note: this screen normally reads the console adapter&apos;s table from the
                  compiled policy — and that read did not succeed here.
                </Text>
              ) : null}
              {sdk && !sdk.streamHoldBack ? (
                <Text size="xs" c="dimmed" mt={6}>
                  Confirmed by the live table: <Code fz="xs">streamHoldBack: false</Code>. Bind{' '}
                  <Code fz="xs">output.pre</Code> for the post-hoc audit, and the gateway binding
                  when you need bytes actually withheld.
                </Text>
              ) : null}
            </Alert>

            {/* ── honest limit 2 of 2 ── */}
            {sdk?.mutations ? (
              <Alert color="orange" variant="light" icon={<IconAlertTriangle size={16} />}>
                <Text size="xs">
                  <b>Redaction lands, but its provenance is plugin-level, not span-level.</b> A{' '}
                  <Code fz="xs">redact</Code> verdict rewrites the payload on{' '}
                  {sdk.mutableHooks.length > 0
                    ? sdk.mutableHooks.map((hook) => HOOK_LABEL[hook]).join(', ').toLowerCase()
                    : 'the hooks marked “rewrites” above'}
                  . What the agent records is which PLUGINS rewrote it and in what order
                  (<Code fz="xs">mutatedBy</Code>) — not which policy touched which span. For
                  span-level detail, read the evaluation log by{' '}
                  <Code fz="xs">trace_id</Code>. Rewrites also chain: a later plugin sees the
                  earlier one&apos;s output, so several redacting guardrails compose rather than
                  overwrite each other.
                </Text>
              </Alert>
            ) : null}

            {sdk && !sdk.mutations ? (
              <Alert color="orange" variant="light" icon={<IconAlertTriangle size={16} />}>
                <Text size="xs">
                  <b>A redact verdict cannot be applied on this build.</b> The
                  ConversationGuardrail plane carries no mutation channel, so a redaction is
                  reported as a warning carrying <Code fz="xs">redact_unsupported</Code> — never as
                  a silent pass, and never escalated into a block. Bind redacting policies on the
                  gateway, which can rewrite what it sends, or upgrade to an SDK with the plugin
                  layer, where the rewrite lands on the payload itself.
                </Text>
              </Alert>
            ) : null}
          </Stack>
        </Tabs.Panel>

        {/* ══ 5 · MCP ═══════════════════════════════════════════════════ */}
        <Tabs.Panel value="mcp">
          <Stack gap="md">
            <SectionCard
              title="Bind it on the MCP server, not in the tool"
              description="Every tool call on a server whose binding is not off is evaluated by the hook plane: the arguments at tool.pre before the tool runs, the result at tool.post before the model sees it."
            >
              <List size="sm" spacing="xs">
                <List.Item>
                  <Anchor href="/dashboard/mcp" size="sm">MCP Servers</Anchor> → the server →{' '}
                  <b>Overview → Guardrail</b>.
                </List.Item>
                <List.Item>
                  <b>Mode</b> — Off, Monitor (log only) or Enforce (block tool calls).
                </List.Item>
                <List.Item>
                  <b>Guardrail</b> — this one, or leave it on <i>Default tool guardrail</i>, which
                  is what an absent key means: the tenant default, not &quot;unguarded&quot;.
                </List.Item>
              </List>
              <Text size="xs" c="dimmed" mt="sm">
                It is a console setting with no client-API route: the binding lives on the server
                record, so a server is never guarded by something its own config does not name.
              </Text>
            </SectionCard>

            <Snippet title="How it is stored" code={mcpBinding} />

            <SectionCard title="What runs, and what does not">
              <Group gap="xs" wrap="wrap">
                {SURFACE_HOOKS.mcp.map((hook) => (
                  <HookBadge key={hook} hook={hook} declared={declared.includes(hook)} />
                ))}
              </Group>
              <Text size="xs" c="dimmed" mt="sm">
                Only these two. An MCP server has no prompt and no answer of its own, so{' '}
                <Code fz="xs">input.pre</Code>, <Code fz="xs">output.pre</Code> and the stream hook
                have no emitter there.
              </Text>
              {declaresToolHook ? null : (
                <Alert color="orange" variant="light" mt="sm" icon={<IconAlertTriangle size={16} />}>
                  <Text size="xs">
                    <b>&quot;{guardrailName}&quot; has no enabled policy bound to a tool hook.</b>{' '}
                    Binding it to an MCP server would change nothing — even in Enforce mode. Add a
                    policy on <Code fz="xs">tool.pre</Code> or <Code fz="xs">tool.post</Code> first;
                    a <Code fz="xs">tool_access</Code> policy is the one that can allow-list tools, cap argument size and
                    deny egress domains.
                  </Text>
                </Alert>
              )}
            </SectionCard>

            <SectionCard title="Failure posture">
              <Text size="xs">
                A stale or deleted key degrades to <b>not evaluated</b>, never to a broken server:
                the hook plane returns a vacuous allow for an unresolvable key rather than throwing
                into the tool call. Only a genuine engine failure reaches the fail posture — closed
                in Enforce, open otherwise. That means a monitor-mode MCP binding cannot break tool
                calls, and an enforce-mode one can.
              </Text>
            </SectionCard>
          </Stack>
        </Tabs.Panel>
      </Tabs>

      {/* ── remote mode management, true on every tab ── */}
      <Paper withBorder radius="md" p="md">
        <Group gap="xs" mb={4}>
          <IconInfoCircle size={16} />
          <Text fw={600}>Changing your mind costs nothing</Text>
        </Group>
        <Text size="xs" c="dimmed" mb="sm">
          Moving a hook from log to block does not need a deploy, a restart or a client change.
        </Text>
        <List size="xs" spacing="xs">
          <List.Item>
            Every verdict carries <Code fz="xs">policy_version</Code> —{' '}
            <Code fz="xs">{'<key>@<updatedAt ISO>'}</Code>, joined with <Code fz="xs">+</Code> when
            several guardrails merged. A connected enforcement point caches by it and re-reads the
            moment it changes; editing this guardrail changes it.
          </List.Item>
          <List.Item>
            The console re-resolves the record on its own short cache, so an edit here reaches live
            traffic within about a minute — including a change made while a run is in flight.
          </List.Item>
          <List.Item>
            The compiled policy (<Code fz="xs">GET /api/guardrails/{'{key}'}/compiled</Code>, with
            an <Code fz="xs">ETag</Code> and <Code fz="xs">If-None-Match</Code> → 304) is what this
            screen reads for the capability table above. It is session-authenticated today, so a
            remote point cannot poll it with an API token — watch{' '}
            <Code fz="xs">policy_version</Code> on each verdict instead.
          </List.Item>
        </List>
      </Paper>
    </Stack>
  );
}
