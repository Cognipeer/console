import type { HookId } from '@/lib/services/guardrail/hooks/contract';
import type { Message, SmartState } from '@cognipeer/agent-sdk';
import { isRecord } from './sdkLoader';
import { messageText } from './subject';
import type { RunScanState } from './subject';
import type { PluginHandlerContext, PluginMessageRewrite } from './types';

/**
 * The per-run store, keyed on whichever stable object the payload offers.
 *
 * On the legacy plane this is `state.ctx`, the one object the SDK keeps across
 * iterations. The plugin payload's equivalent is guessed in the same spirit and
 * degrades safely: with no stable key, the fallback state scans only the newest
 * message on each call, which over-scans nothing and under-scans only a
 * parallel multi-tool turn.
 */
const RUN_STATE_STORE_KEY = 'cognipeerGuardrailRunState';

export function pluginRunState(
  hookCtx: PluginHandlerContext | undefined,
  payload: Record<string, unknown>,
  fallback: WeakMap<object, RunScanState>,
): RunScanState {
  // THE REAL STORE, first. `HookContext.store` is per-plugin and per-run
  // scratch space that the host creates in `beginRun` and drops when the
  // invoke ends (dist/index.d.ts:298-299), which is exactly the lifetime this
  // state wants — and it is isolated per plugin, so two guardrails on the same
  // agent cannot read each other's high-water mark.
  //
  // Before this, the state was guessed out of the PAYLOAD
  // (`payload.ctx/context/state/run/session`). No hook input in 0.10.0 carries
  // any of those keys, so every call fell through to `freshRunState()` — whose
  // `MAX_SAFE_INTEGER` means "scan only the newest message". Harmless while the
  // plugin plane was unused; a cost incident the moment `input.pre` is bound,
  // because `preModelCall` fires once per MODEL CALL rather than once per turn
  // and the per-run billing set was being thrown away between them.
  if (hookCtx?.store && isRecord(hookCtx.store)) {
    const store = hookCtx.store;
    const existing = store[RUN_STATE_STORE_KEY];
    if (isRunScanState(existing)) return existing;
    const fresh = freshRunState();
    store[RUN_STATE_STORE_KEY] = fresh;
    return fresh;
  }

  // No context — a host that predates `HookContext`, or a direct unit-test
  // call. Keyed on whatever stable object the payload offers, which is what
  // this function did before and still degrades the same safe way.
  const candidates = [payload.ctx, payload.context, payload.state, payload.run, payload.session];
  const key = candidates.find((value): value is object => isRecord(value));
  if (!key) return freshRunState();
  const existing = fallback.get(key);
  if (existing) return existing;
  const fresh = freshRunState();
  fallback.set(key, fresh);
  return fresh;
}

/**
 * Checked rather than cast: `store` is a shared bag typed `unknown`, and a
 * value under our key that is not our shape means something else wrote there.
 * Trusting it would corrupt the scan window rather than fail.
 */
function isRunScanState(value: unknown): value is RunScanState {
  return (
    isRecord(value)
    && typeof value.scanned === 'number'
    && value.billed instanceof Set
    && value.warned instanceof Set
    && value.rewrites instanceof Map
  );
}

function freshRunState(): RunScanState {
  // MAX_SAFE_INTEGER, not 0: the first evaluation of a run must scan only the
  // newest message, and `sliceMessages`'s out-of-range branch is exactly that
  // rule. Starting at 0 would scan the system prompt and every prior turn.
  return { scanned: Number.MAX_SAFE_INTEGER, billed: new Set(), warned: new Set(), rewrites: new Map() };
}

/**
 * Remember what a `preModelCall` rewrite changed — in the run state, so later
 * model calls of the same run can re-apply it (`carryMessageRewrites`), and
 * through `onMessageRewrite`, so the caller can persist it.
 */
export function recordMessageRewrites(input: {
  before: readonly (Message | undefined)[];
  after: readonly Message[];
  state: RunScanState;
  report: ((rewrite: PluginMessageRewrite) => void) | undefined;
  guardrailKey: string;
  hook: HookId;
  sdkHook: string;
}): void {
  input.after.forEach((rewritten, index) => {
    const original = input.before[index];
    if (!original || rewritten === original) return;
    const beforeText = messageText(original);
    const afterText = messageText(rewritten);
    if (beforeText === afterText) return;
    input.state.rewrites.set(beforeText, rewritten.content);
    input.report?.({
      guardrailKey: input.guardrailKey,
      hook: input.hook,
      sdkHook: input.sdkHook,
      index,
      role: String(original.role ?? 'unknown'),
      before: beforeText,
      after: afterText,
    });
  });
}

/**
 * Re-apply this run's earlier rewrites to a wire transcript. Returns the new
 * array only when something changed, so a clean pass stays free of a
 * GateResult entry. Never touches the system prompt.
 */
export function carryMessageRewrites(
  messages: readonly (Message | undefined)[],
  state: RunScanState,
): Message[] | undefined {
  if (state.rewrites.size === 0) return undefined;
  let changed = false;
  const next: Message[] = [];
  for (const message of messages) {
    if (!message) continue;
    if (message.role === 'system') {
      next.push(message);
      continue;
    }
    const recorded = state.rewrites.get(messageText(message));
    if (recorded === undefined) {
      next.push(message);
      continue;
    }
    changed = true;
    next.push({ ...message, content: recorded } as Message);
  }
  return changed ? next : undefined;
}

/**
 * The per-run store, keyed on `state.ctx` — the ONE object the SDK keeps stable
 * across iterations. `state` itself is replaced on every iteration
 * (`state = { ...state, messages }`), so keying on it would reset the high-water
 * mark every time and re-scan the whole transcript.
 */
export function runStateFor(store: WeakMap<object, RunScanState>, state: SmartState): RunScanState {
  const key: object = state.ctx ?? state;
  const existing = store.get(key);
  if (existing) return existing;
  const fresh = freshRunState();
  store.set(key, fresh);
  return fresh;
}
