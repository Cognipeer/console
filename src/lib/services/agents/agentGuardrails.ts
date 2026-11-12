/**
 * Guardrails of an agent turn: the text hooks a connected agent runs, the
 * plugins a local agent hands the SDK, the message-rewrite ledger and the
 * conversion of an SDK denial back into a thrown error.
 */

import { randomUUID } from 'node:crypto';
import { evaluateGuardrail } from '@/lib/services/guardrail';
import type { HookId, HookScope } from '@/lib/services/guardrail';
// Imported BY PATH because the barrel does not re-export it. `resolveBindings`
// is the ONE implementation of "which guardrails run on this hook"; a
// hand-rolled legacy fallback here would drift from the gateway's and produce a
// guardrail that silently stops running on one surface while the UI still shows
// it attached.
import { resolveBindings } from '@/lib/services/guardrail/hooks/binding';
// `resolveGuardrail` is deliberately not on the barrel either; it is read here
// only to learn a guardrail's `failMode` when its plugin could not be compiled.
import { resolveGuardrail } from '@/lib/services/guardrail/hooks/engine';
import { CONSOLE_HOOK_MAP, SdkPluginLayerUnavailableError, consoleGuardrailPlugins, denyingSdkPlugin, toAgentPlugin } from '@/lib/services/guardrail/sdkAdapter';
import type { PluginMessageRewrite } from '@/lib/services/guardrail/sdkAdapter';
import type { AgentPlugin as AgentSdkPlugin } from '@cognipeer/agent-sdk';
import type { GuardrailBindingSource } from '@/lib/services/guardrail/hooks/binding';
import { stripAttachmentBlock } from './sessionFiles';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('agents');

// ── Guardrail binding ────────────────────────────────────────────────
//
// Two things live here: the TEXT hooks (`input.pre` / `output.pre`) an agent
// has always had, now resolved through `resolveBindings` so several guardrails
// compose; and the TOOL hooks (`tool.pre` / `tool.post`), which the agent's own
// tools never had at all — its MCP tools were guarded downstream in
// `executeMcpToolLocal` while its action, knowledge and browser tools ran
// unevaluated, so `tool_access` was bypassable by moving a capability out of
// MCP and into the unified tool system.

/**
 * Evaluate every guardrail bound to a TEXT hook, in binding order, and return
 * the text to carry forward.
 *
 * Used by `runExternalAgentTurn`; a local agent runs these hooks as SDK plugins.
 *
 * Redactions CHAIN: guardrail N+1 sees what guardrail N rewrote, so a redaction
 * cannot be undone by a later evaluation and the text that reaches the model
 * (or the user) is the one every bound guardrail agreed on.
 *
 * Throws on a block. The message strings are unchanged from the single-slot
 * implementation because operator runbooks grep for them.
 */
export async function evaluateBoundGuardrails(input: {
    tenantDbName: string;
    tenantId: string;
    projectId?: string;
    config: GuardrailBindingSource;
    hook: Extract<HookId, 'input.pre' | 'output.pre'>;
    text: string;
    source: string;
}): Promise<string> {
    const keys = resolveBindings(input.config, input.hook);
    if (keys.length === 0 || !input.text) return input.text;

    const phase = input.hook === 'input.pre' ? 'input' : 'output';
    const label = phase === 'input' ? 'Input' : 'Output';
    let text = input.text;

    for (const guardrailKey of keys) {
        const result = await evaluateGuardrail({
            tenantDbName: input.tenantDbName,
            tenantId: input.tenantId,
            projectId: input.projectId,
            guardrailKey,
            text,
            phase,
            source: input.source,
        });
        // `blocked` is the Mode-neutralised decision; `passed` is the
        // counterfactual and stays false in monitor mode. See the note on
        // `GuardrailEvaluationResult.blocked`.
        if (result.blocked) {
            const reasons = result.findings.map((finding) => finding.category || finding.type).join(', ');
            // Same message as before (runbooks grep for it), now TYPED so the
            // HTTP layer answers 4xx with the gateway's `guardrail_block`
            // envelope instead of reporting a policy decision as a server fault.
            throw new AgentGuardrailBlockedError(
                `${label} blocked by guardrail: ${reasons}`,
                { guardrailKey: result.guardrailKey || guardrailKey, reason: reasons, hook: input.hook },
            );
        }
        if (result.redactedText !== undefined) text = result.redactedText;
    }

    return text;
}

/**
 * A guardrail refused the turn.
 *
 * Typed — rather than a bare `Error` — because a policy decision is not a
 * server fault: `plugins/agents.ts` and `plugins/client-agents.ts` map this to
 * HTTP 400 with the same `{ error: { type: 'guardrail_block', … } }` envelope
 * the inference routes send for `GuardrailBlockError`, so an SDK client can
 * branch on `type` regardless of whether it called a model or an agent. Before
 * this it surfaced as a 500 whose body, on the client API, was
 * `Internal server error` — no reason, no key, no way to tell it from an outage.
 *
 * `hook` is the console hook id when it is known (`prompt.pre` for a
 * `userPromptSubmit` denial, `input.pre`/`output.pre` for the model-call gates,
 * the text hook for a connected agent) and undefined when the SDK's denial
 * record did not say.
 */
export class AgentGuardrailBlockedError extends Error {
    readonly guardrailKey: string | undefined;
    readonly reason: string;
    readonly hook: HookId | undefined;

    constructor(
        message: string,
        detail: { guardrailKey?: string; reason: string; hook?: HookId },
    ) {
        super(message);
        this.name = 'AgentGuardrailBlockedError';
        this.guardrailKey = detail.guardrailKey;
        this.reason = detail.reason;
        this.hook = detail.hook;
    }

    /** The status the gateway uses for `GuardrailBlockError`; kept identical on purpose. */
    get status(): number {
        return 400;
    }
}

/**
 * AGENT-SIDE STREAM GATING IS BLOCKED ON AN SDK CAPABILITY — verified, not
 * assumed, against the installed `@cognipeer/agent-sdk`:
 *
 *   · `InvokeConfig.onStream?: (chunk: StreamChunk) => void` (dist/index.d.ts).
 *     Synchronous and void-returning: the SDK neither awaits a decision nor
 *     offers a return channel to withhold a chunk, so there is no point at
 *     which `createStreamGate` could hold bytes back.
 *   · When a caller passes `onTextChunk`, `onStream` is forwarded only as a
 *     fire-and-forget copy of the deltas (`textStreamOptions`), so there is
 *     still no point at which a chunk can be withheld. That is why an agent
 *     bound to `output.pre` does not stream at all (agentMayStreamAnswer):
 *     its caller gets the guarded answer in one piece.
 *
 * So nothing on this path can gate a chunk, and claiming otherwise would be
 * the one failure the hook plane exists to prevent: a verdict claiming
 * enforcement it did not deliver. Streaming IS enforced on the gateway, which
 * owns its socket (`inferenceService`, `output.stream.delta`).
 *
 * A legacy `outputGuardrailKey` projects onto `output.stream.delta` as well as
 * `output.pre`, so it is still fully enforced here by the post-hoc check. Only
 * a binding scoped to the stream hook ALONE would silently do nothing — which
 * is what this warns about, once per run.
 */
export function warnUnservableStreamBinding(config: GuardrailBindingSource, agentKey: string): void {
    const streamOnly = resolveBindings(config, 'output.stream.delta')
        .filter((key) => !resolveBindings(config, 'output.pre').includes(key));
    if (streamOnly.length === 0) return;
    logger.warn(
        'Guardrail bound only to output.stream.delta will not run on this agent: '
        + 'the agent SDK has no awaitable stream hook. Bind it to output.pre as well.',
        { agentKey, guardrailKeys: streamOnly },
    );
}

/**
 * THE TEXT HOOKS RUN AS AN SDK PLUGIN; THE TOOL HOOKS DO NOT. Both halves of
 * that sentence are load-bearing.
 *
 * agent-sdk 0.10.0 finally has a real plugin layer, so `prompt.pre`,
 * `input.pre` and `output.pre` can be served by the host itself instead of by
 * the brackets this module used to put around `sdkAgent.invoke`. That is a
 * straight win: `userPromptSubmit` fires exactly once for a user turn, which is
 * what `prompt.pre` has always meant and what no console surface could emit
 * before.
 *
 * The TOOL hooks deliberately stay on `createAgentToolGuard`, and moving them
 * would be a silent data-loss bug rather than a refactor. The plugin sees the
 * name the MODEL called (`payload.name`); the guard names the same call
 * `agent.tool.<toolKey>.<actionKey>` — the canonical, key-based spelling
 * documented at the top of this file, and the spelling every stored
 * `tool_access` policy is written in. `tool_access` matches a DENY against
 * either spelling but an ALLOW against the canonical one only, so switching
 * planes would leave deny lists working and disarm every allow list, which is
 * the failure that looks like nothing at all. Porting the tool hooks means
 * carrying the name map (and the withheld-result messages) into the plugin;
 * that is its own change, not a passenger on this one.
 *
 * MCP tools stay out of BOTH when their SERVER carries a guardrail binding:
 * `executeMcpToolLocal` guards them against that binding, one layer down, and
 * also covers the surfaces that have no agent at all. A server with NO binding
 * evaluates nothing there, so for that case — and only that case — the agent's
 * own tool guard wraps the tool under the MCP canonical name; see
 * `buildBoundTools`.
 */
const AGENT_PLUGIN_HOOKS: readonly HookId[] = ['prompt.pre', 'input.pre', 'output.pre'];

/**
 * Which way a guardrail whose plugin could NOT be compiled should fail.
 *
 * The record's own `failMode` decides, exactly as it would have inside the
 * plugin (`failureMode` is written from it). The console default is OPEN, so a
 * readable record with no `failMode` fails open. A record that cannot be READ
 * — deleted, or the tenant database did not answer — fails CLOSED: "the binding
 * points at nothing" is the one case where no operator intent is recoverable,
 * and it is also what the connected-agent branch does (`evaluateGuardrail`
 * throws on an unknown key), so the two branches agree.
 */
async function agentGuardrailFailMode(
    input: { tenantDbName: string; projectId: string },
    guardrailKey: string,
): Promise<'open' | 'closed'> {
    try {
        const record = await resolveGuardrail(input.tenantDbName, guardrailKey, input.projectId);
        if (!record) return 'closed';
        return record.failMode === 'closed' ? 'closed' : 'open';
    } catch {
        return 'closed';
    }
}

/**
 * Compile this agent's bound guardrails into SDK plugins.
 *
 * Returns [] when nothing is bound, which is the same thing as "no plugins" to
 * the SDK.
 *
 * PER KEY, NOT ALL-OR-NOTHING. The first version awaited every compile with
 * `Promise.all` inside one try/catch, so ONE key that failed to compile — a
 * colleague deleted the guardrail, the probe answered `unknown`, a transient
 * tenant-DB error — threw away every other key's plugin too, and the record's
 * `failMode` never got a say because the plugin that would have honoured it
 * was never built. Now each key settles on its own:
 *
 *   · compiled        → its plugins are used;
 *   · failed, CLOSED  → an inert plugin that DENIES every hook the binding
 *                       asked for stands in (`denyingSdkPlugin`), so the outage
 *                       is a visible block, not a silent pass;
 *   · failed, OPEN    → skipped with a warning naming the key and the error.
 *
 * The one failure that still refuses the whole run is a missing plugin layer
 * (`SdkPluginLayerUnavailableError`): with no host to run them, a denying plugin
 * would enforce nothing either, and an agent whose guardrails cannot run at all
 * must not start looking guarded.
 */
export async function buildAgentGuardrailPlugins(input: {
    tenantDbName: string;
    tenantId: string;
    projectId: string;
    agentKey: string;
    config: GuardrailBindingSource;
    actorId?: string;
    /** 'agent' on the live path, 'agent-playground' for a rehearsal. */
    source?: string;
    /** Receives every `preModelCall` message rewrite; see `MessageRewriteLedger`. */
    onMessageRewrite?: (rewrite: PluginMessageRewrite) => void;
}): Promise<AgentSdkPlugin[]> {
    // PER GUARDRAIL, its OWN hooks — not the union.
    //
    // The first version collected the keys across all three hooks and compiled
    // every key with all three enabled. Measured end-to-end, that over-enforces:
    // a guardrail an operator bound only to `output.pre` also ran on
    // `prompt.pre`, because the compiler asks the POLICY which hooks it serves
    // and the caller had said "all of them". The operator sees an evaluation
    // they did not ask for, pays for it, and can be blocked by it.
    const byKey = new Map<string, Set<HookId>>();
    for (const hook of AGENT_PLUGIN_HOOKS) {
        for (const key of resolveBindings(input.config, hook)) {
            const set = byKey.get(key) ?? new Set<HookId>();
            set.add(hook);
            byKey.set(key, set);
        }
    }
    if (byKey.size === 0) return [];
    const entries = [...byKey];
    const keys = entries.map(([key]) => key);

    // ONE traceId for the run's text hooks, unlike the tool guard's one-per-call:
    // `prompt.pre`, `input.pre` and `output.pre` are three moments of the SAME
    // turn, so correlating them is the point. The tool guard splits per call
    // because a multi-tool run would otherwise collapse into one unreadable id.
    const traceId = randomUUID();
    const scope: HookScope = {
        tenantDbName: input.tenantDbName,
        tenantId: input.tenantId,
        projectId: input.projectId,
        // `surface: 'agent'` so this run's text decisions land in the same
        // bucket as its tool decisions. The old bracket logged them under
        // 'api', which split one run across two surfaces.
        surface: 'agent',
        source: input.source ?? 'agent',
        // Identical to `createAgentToolGuard`'s actor, so the text and tool
        // decisions of one run agree about who acted.
        actor: { id: input.actorId ?? 'agent', kind: 'agent', roles: ['agent'] },
        traceId,
    };

    const settled = await Promise.allSettled(entries.map(([key, hooks]) => consoleGuardrailPlugins({
        scope,
        guardrailKeys: [key],
        hooks: [...hooks],
        onMessageRewrite: input.onMessageRewrite,
    })));

    // Flattened in binding order, so a rewrite chain over several guardrails is
    // reproducible rather than dependent on Map iteration.
    const plugins: AgentSdkPlugin[] = [];
    for (let index = 0; index < entries.length; index += 1) {
        const [key, hooks] = entries[index];
        const outcome = settled[index];
        if (outcome.status === 'fulfilled') {
            plugins.push(...outcome.value.map(toAgentPlugin));
            continue;
        }

        const message = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);

        if (outcome.reason instanceof SdkPluginLayerUnavailableError) {
            // No plugin layer means NOTHING here can run — not the compiled
            // keys, not a denying stand-in. This repo's lockfile pins 0.10.1,
            // but the dependency is a caret range, so a self-hosted build that
            // resolves it differently would otherwise disarm every agent
            // guardrail with no signal at all. Refusing the run is the honest
            // outcome: the caller sees an error naming the keys and why.
            logger.error('Failed to compile agent guardrail plugins; refusing the run', {
                agentKey: input.agentKey,
                guardrailKeys: keys,
                error: message,
            });
            throw new Error(
                `Agent "${input.agentKey}" has guardrails bound (${keys.join(', ')}) that could not be `
                + `compiled, so the run was refused rather than executed unchecked: ${message}`,
            );
        }

        const failMode = await agentGuardrailFailMode(input, key);
        if (failMode === 'closed') {
            logger.error('Agent guardrail could not be compiled; denying its hooks (fail closed)', {
                agentKey: input.agentKey,
                guardrailKey: key,
                hooks: [...hooks],
                error: message,
            });
            plugins.push(toAgentPlugin(denyingSdkPlugin({
                guardrailKey: key,
                hooks: [...hooks],
                reason: message,
                priority: index,
            })));
            continue;
        }

        logger.warn('Agent guardrail could not be compiled; skipped (fail open)', {
            agentKey: input.agentKey,
            guardrailKey: key,
            hooks: [...hooks],
            error: message,
        });
    }
    return plugins;
}

/**
 * The text a `preModelCall` redaction produced for each message it rewrote, so
 * the console can PERSIST what the model saw.
 *
 * The host applies that rewrite to the wire transcript only and leaves
 * `state.messages` — and therefore `result.messages` — carrying the original
 * (`SdkGuardrailContext.onMessageRewrite` explains the mechanics). Without this
 * ledger the raw user turn would be written to the conversation and replayed as
 * history on every later turn, where neither `userPromptSubmit` (tail message
 * only) nor `preModelCall` (high-water mark) re-scans it.
 *
 * Keyed by content rather than by index because wire indices and persisted
 * indices differ (the system prompt sits at wire index 0). Rewrites CHAIN across
 * guardrails — A turns X into Y, B turns Y into Z — so `resolve` follows the
 * chain, bounded so a pathological cycle cannot spin.
 */
export class MessageRewriteLedger {
    private readonly byBefore = new Map<string, string>();

    record(rewrite: PluginMessageRewrite): void {
        if (rewrite.before === rewrite.after) return;
        this.byBefore.set(rewrite.before, rewrite.after);
    }

    resolve(text: string): string {
        let current = text;
        for (let hops = 0; hops < 8; hops += 1) {
            const next = this.byBefore.get(current);
            if (next === undefined || next === current) break;
            current = next;
        }
        return current;
    }

    get size(): number {
        return this.byBefore.size;
    }
}

/** Flattened text of a message's content — a string, or the text parts joined. */
export function agentMessageText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .map((part) => {
            const text = (part as { text?: unknown } | null | undefined)?.text;
            return typeof text === 'string' ? text : '';
        })
        .filter(Boolean)
        .join('\n');
}

/**
 * The user turn to PERSIST and to cut the title from: the rewritten one, never
 * the raw request text.
 *
 * Two rewrite channels compose here. A `prompt.pre` (`userPromptSubmit`)
 * redaction is written by the host into `state.messages` in place, so it is read
 * back from `result.messages` at the index the turn was appended at. An
 * `input.pre` (`preModelCall`) redaction never reaches `state.messages` and is
 * read from the ledger instead, matched by content — which also covers the case
 * where both fired (the ledger's `before` is then the prompt-rewritten text).
 * Falls back to the raw message when the result no longer holds a user turn at
 * that index (a compaction mid-run), and the ledger still applies to it.
 */
export function persistedUserTurn(input: {
    result: { messages?: Array<{ role?: string; content?: unknown }> };
    /** Index the user turn was appended at in the invoke input. */
    index: number;
    fallback: string;
    ledger: MessageRewriteLedger;
}): string {
    const entry = input.result.messages?.[input.index];
    const fromResult = entry?.role === 'user' ? agentMessageText(entry.content) : '';
    // What the turn added for attached files (sessionFiles.ts) is not the person's text.
    return stripAttachmentBlock(input.ledger.resolve(fromResult || input.fallback));
}

/**
 * The connected-agent counterpart, warning once per run about every binding
 * this surface cannot serve.
 *
 * A connected agent is reached over ONE HTTP call that carries text in and text
 * out (`invokeExternalAgent`). Its tools run inside the remote agent: we never
 * see a tool name, its arguments or its result, so `tool.pre` / `tool.post`
 * have no subject to evaluate and no tool guard is built for that branch. A
 * binding an operator wrote against those hooks is therefore unservable — and
 * unservable-and-silent is exactly the failure the hook plane exists to end, so
 * it is said out loud.
 *
 * The STREAM case is delegated — no agent surface serves it, the remedy is the
 * same, and two copies of that message would drift.
 *
 * `prompt.pre` is warned about HERE and no longer on the local path, because
 * since agent-sdk 0.10.0 the two surfaces genuinely differ: the local agent
 * serves the hook through the plugin layer's `userPromptSubmit`, while a
 * connected agent still cannot — the remote runtime owns the loop, so only it
 * knows which model call opens a turn, and all this process sees is one HTTP
 * round trip. The remedy differs too: on a connected agent the operator either
 * binds `input.pre` as well, or moves enforcement into the remote runtime with
 * the SDK's own `cognipeerGuardrail` preset, which POSTs to
 * `/api/client/v1/guardrails/hooks/evaluate`.
 */
export function warnUnservableExternalBindings(config: GuardrailBindingSource, agentKey: string): void {
    warnUnservableStreamBinding(config, agentKey);

    const promptOnly = resolveBindings(config, 'prompt.pre')
        .filter((key) => !resolveBindings(config, 'input.pre').includes(key));
    if (promptOnly.length > 0) {
        logger.warn(
            'Guardrail bound only to prompt.pre will not run on this connected agent: the '
            + 'remote runtime owns the turn, so the console cannot emit prompt.pre for it. '
            + 'Bind it to input.pre as well, or enforce inside the remote runtime through '
            + 'POST /api/client/v1/guardrails/hooks/evaluate.',
            { agentKey, guardrailKeys: promptOnly },
        );
    }

    // Both tool hooks in one warning: an operator who bound a guardrail to
    // `tool.pre` and `tool.post` has one mistake, not two.
    const toolKeys = [...new Set([
        ...resolveBindings(config, 'tool.pre'),
        ...resolveBindings(config, 'tool.post'),
    ])];
    if (toolKeys.length === 0) return;
    logger.warn(
        'Guardrail bound to tool.pre/tool.post will not run on this connected agent: '
        + 'its tools execute on the remote endpoint and are never visible here. '
        + 'Only input.pre and output.pre are enforceable on a connected agent.',
        { agentKey, guardrailKeys: toolKeys },
    );
}

/**
 * A guardrail DENY on the plugin plane is not a thrown error — and the console
 * has to turn it back into one.
 *
 * When a plugin denies, agent-sdk does not reject `invoke()`. It appends an
 * assistant message carrying the reason, sets `state.ctx.__guardrailBlocked`,
 * and resolves normally. Left alone that would be a silent contract change on
 * this deploy: the brackets this replaced THREW, every caller of
 * `executeAgentChatLocal` is written against a throw, and a blocked run would
 * instead have been persisted and returned as a perfectly ordinary answer.
 *
 * The reason also needs cleaning. The host prefixes every denial with the
 * plugin's own name (`dist/index.mjs:6744`, `${entry.plugin}: ${output.reason}`)
 * with no way to opt out, and our plugins are named
 * `cognipeer-guardrail:<guardrailKey>` — so the raw string would show an
 * internal key to whoever typed the message. The prefix is stripped here rather
 * than by renaming the plugin, because that name is also `deniedBy`, the key in
 * every plugin log line, and what `childPlugins()` matches on.
 */
/** The shape both detectors read; `AgentInvokeResult` satisfies it structurally. */
interface DeniableInvokeResult {
    state?: unknown;
    messages?: Array<{ role?: string; name?: string; content?: unknown; metadata?: unknown }>;
}

/** What the SDK records about a denial, on `ctx.__guardrailBlocked.incident` and on the marker message's `metadata.plugin`. */
interface SdkDenialIncident {
    reason?: string;
    deniedBy?: string;
    hook?: string;
}

function denialIncident(result: DeniableInvokeResult): SdkDenialIncident | undefined {
    const ctx = (result.state as { ctx?: Record<string, unknown> } | undefined)?.ctx;
    const blocked = ctx?.__guardrailBlocked as { incident?: SdkDenialIncident } | undefined;
    return blocked?.incident;
}

export function guardrailDenial(result: DeniableInvokeResult): string | undefined {
    const incident = denialIncident(result);

    // TWO DETECTORS, kept deliberately.
    //
    // `ctx.__guardrailBlocked` is set for a denial at `preModelCall` and
    // `postModelCall` (dist/index.mjs:4074, :4201) and — since agent-sdk 0.10.1
    // — for a `userPromptSubmit` denial on BOTH `createAgent` (:7619) and
    // `createSmartAgent` (:10325), the one `buildLocalAgentRun` creates. On
    // 0.10.0 the smart-agent prompt branch returned the blocked state WITHOUT
    // the ctx marker, measured end-to-end: a guardrail bound to `prompt.pre`
    // decided `block`, the evaluation log recorded `decision: "block"`, and the
    // run completed normally because nothing here could see it.
    //
    // The trailing assistant message the SDK names `guardrail` is set by every
    // denial path on every 0.10.x build, so it stays as the fallback: the
    // dependency is a caret range, and a self-hosted build resolving 0.10.0
    // would otherwise bring the silent pass back. Detecting the block is not
    // optional: without it a denied prompt is persisted and returned as an
    // ordinary answer.
    const tail = result.messages?.[result.messages.length - 1];
    const messageMarker = tail?.role === 'assistant' && tail?.name === 'guardrail'
        ? (typeof tail.content === 'string' ? tail.content : '')
        : undefined;

    if (!incident && messageMarker === undefined) return undefined;

    const raw = incident?.reason ?? messageMarker ?? '';
    const deniedBy = incident?.deniedBy;
    // Strip only OUR prefix, and only from the front: a reason that happens to
    // contain the plugin name later on is the operator's own message text.
    // With `deniedBy` known, strip exactly that prefix. Without it — the
    // message-marker path carries no `deniedBy` — fall back to the shape the
    // host always writes, `cognipeer-guardrail:<key>: `, anchored at the front
    // so a reason that merely mentions the name later is left alone.
    const cleaned = deniedBy && raw.startsWith(`${deniedBy}: `)
        ? raw.slice(deniedBy.length + 2)
        : raw.replace(/^cognipeer-guardrail:[^\s:]+:\s*/, '');
    return cleaned.trim() || 'Blocked by a guardrail policy.';
}

/** Plugin name -> console guardrail key; `undefined` for a plugin that is not ours. */
const GUARDRAIL_PLUGIN_PREFIX = 'cognipeer-guardrail:';

/** SDK plugin hook name -> console hook id, the inverse of `CONSOLE_HOOK_MAP`. */
function consoleHookFor(sdkHook: string | undefined): HookId | undefined {
    if (!sdkHook) return undefined;
    for (const [hook, mapped] of Object.entries(CONSOLE_HOOK_MAP) as Array<[HookId, string | null]>) {
        if (mapped === sdkHook) return hook;
    }
    return undefined;
}

/**
 * `guardrailDenial`, as the typed error the callers throw.
 *
 * The key and hook come from the SDK's incident record when it carries them
 * (`deniedBy` is our plugin name; `hook` is the SDK hook that denied) and from
 * the marker message's `metadata.plugin` otherwise; both are absent on the
 * message-only path, and the error then carries the reason alone.
 */
export function guardrailBlockedError(result: DeniableInvokeResult): AgentGuardrailBlockedError | undefined {
    const reason = guardrailDenial(result);
    if (reason === undefined) return undefined;

    const incident = denialIncident(result);
    const tail = result.messages?.[result.messages.length - 1];
    const markerPlugin = (tail?.metadata as { plugin?: SdkDenialIncident } | undefined)?.plugin;
    const deniedBy = incident?.deniedBy ?? markerPlugin?.deniedBy;
    const guardrailKey = deniedBy?.startsWith(GUARDRAIL_PLUGIN_PREFIX)
        ? deniedBy.slice(GUARDRAIL_PLUGIN_PREFIX.length)
        : undefined;

    const hook = consoleHookFor(incident?.hook ?? markerPlugin?.hook);
    // Which side was refused: the prompt (`input.*`) or the answer.
    const side = hook?.startsWith('input.') ? 'input' : 'response';
    return new AgentGuardrailBlockedError(`Agent ${side} blocked by guardrail: ${reason}`, {
        guardrailKey,
        reason,
        hook,
    });
}
