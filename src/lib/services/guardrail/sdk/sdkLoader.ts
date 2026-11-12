import { HOOK_IDS } from '@/lib/services/guardrail/hooks/contract';
import type { HookId } from '@/lib/services/guardrail/hooks/contract';
import { CONSOLE_HOOK_MAP } from './hookMaps';
import { logger } from './logger';

// ═══════════════════════════════════════════════════════════════════════════
// SDK loading
// ═══════════════════════════════════════════════════════════════════════════

type AgentSdkModule = typeof import('@cognipeer/agent-sdk');

/**
 * The plugin layer as this file uses it, declared STRUCTURALLY.
 *
 * Structural rather than imported ON PURPOSE, even though 0.10.0 exports most
 * of these names now. This file has to compile and behave correctly against an
 * SDK it did not choose — a self-hosted install pins its own version — so every
 * member below stays optional and every read of it stays guarded. Importing the
 * types would move the failure from a runtime `undefined` this code already
 * handles to a build error on someone else's machine.
 *
 * `SdkCapabilities` is the one name to be careful with: this file exports its
 * OWN type by that name, keyed by console `HookId`, while the SDK exports a
 * different one keyed by its `HookName`. Alias on import, always.
 */
interface AgentSdkPluginSurface {
  pluginCapabilities?: () => unknown;
  CONSOLE_HOOK_MAP?: unknown;
  // `definePlugin` is deliberately NOT declared here. It exists in 0.10.0 but
  // is curried (`(factory) => (config) => plugin`) and takes a factory, not a
  // literal — declaring it with the wrong shape is what let the compiler bless
  // a call that could only ever fail. Nothing in this file may call it.

  version?: unknown;
  VERSION?: unknown;
}

export type LoadedAgentSdk = AgentSdkModule & AgentSdkPluginSurface;

/**
 * The import PROMISE is memoised, not the module. Two reasons, one of them a
 * trap this repo has already paid for: concurrent `await import()` calls for the
 * same MOCKED module deadlock under vitest, so a single shared promise is the
 * only shape that is safe to await from several rules at once. A rejection is
 * deliberately NOT memoised — a transient module-load failure must not disable
 * the bridge for the life of the process.
 */
let sdkPromise: Promise<LoadedAgentSdk> | null = null;

export function loadAgentSdk(): Promise<LoadedAgentSdk> {
  if (!sdkPromise) {
    sdkPromise = (import('@cognipeer/agent-sdk') as Promise<LoadedAgentSdk>).catch(
      (error: unknown) => {
        sdkPromise = null;
        throw error;
      },
    );
  }
  return sdkPromise;
}

/** Test seam: drops the memoised SDK import so a suite can mock the module again. */
export function resetAgentSdkCacheForTests(): void {
  sdkPromise = null;
}

// ── reading `pluginCapabilities()` ────────────────────────────────────────

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read an OPTIONAL export off the loaded module.
 *
 * Never `sdk.pluginCapabilities` directly. A module namespace is not always a
 * plain object: an ESM namespace proxy — and the one vitest substitutes for a
 * mocked module — THROWS on a property that is not an export ("No X export is
 * defined on the mock") instead of answering `undefined`. Feature detection is
 * the one place that is guaranteed to hit, because the whole point is to ask
 * about names the installed build may not have; a throw there would turn "this
 * is 0.9.4, use the legacy bridge" into "the SDK could not be loaded at all"
 * and take every capability answer with it.
 */
export function sdkMember(sdk: object, name: string): unknown {
  try {
    return (sdk as Record<string, unknown>)[name];
  } catch {
    return undefined;
  }
}

/**
 * One entry of a plugin capability report.
 *
 * TOLERANT ON PURPOSE. The report is produced by an UNPUBLISHED build, so its
 * exact entry shape cannot be verified from this repo. Both spellings that
 * shape could plausibly take are accepted — a bare boolean, or a record with
 * `implemented` — and anything else reads as "not implemented" rather than as
 * an optimistic default. Guessing generously here would put the original bug
 * back, pointing the other way.
 */
export function readImplemented(entry: unknown): { implemented: boolean; note?: string } {
  if (typeof entry === 'boolean') return { implemented: entry };
  if (!isRecord(entry)) return { implemented: false };
  // `notes`, not `note`: the SDK writes the field plural (dist/index.d.ts:3403-3407).
  // Reading the singular silently dropped EVERY capability note the SDK ships,
  // leaving the panel showing only the console's hand-written copy — which is
  // precisely the drift this adapter exists to detect.
  const note = typeof entry.notes === 'string' ? entry.notes : undefined;
  return { implemented: entry.implemented === true, note };
}

/** `{ hooks: {...}, slots: {...}, features: {...} }`, flattened to dotted keys. */
export function unimplementedEntries(report: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const group of ['slots', 'features', 'hooks'] as const) {
    const table = report[group];
    if (!isRecord(table)) continue;
    for (const [name, entry] of Object.entries(table)) {
      if (!readImplemented(entry).implemented) out.push(`${group}.${name}`);
    }
  }
  return out.sort();
}

/**
 * The SDK's own `CONSOLE_HOOK_MAP` when it exports one, this file's copy
 * otherwise.
 *
 * The SDK's wins on every key it declares: it is the build that will actually
 * dispatch the handlers, so a disagreement means this file is stale, and
 * silently preferring the stale copy would register handlers under names
 * nothing calls. A disagreement is logged rather than swallowed.
 */
export function readConsoleHookMap(sdk: LoadedAgentSdk): Readonly<Record<HookId, string | null>> {
  const declared = sdkMember(sdk, 'CONSOLE_HOOK_MAP');
  if (!isRecord(declared)) return CONSOLE_HOOK_MAP;

  const map: Record<HookId, string | null> = { ...CONSOLE_HOOK_MAP };
  const drift: string[] = [];
  for (const hook of HOOK_IDS) {
    if (!(hook in declared)) continue;
    const value = declared[hook];
    const resolved = typeof value === 'string' && value !== '' ? value : null;
    if (resolved !== CONSOLE_HOOK_MAP[hook]) {
      drift.push(`${hook}: console=${CONSOLE_HOOK_MAP[hook] ?? 'null'} sdk=${resolved ?? 'null'}`);
    }
    map[hook] = resolved;
  }
  if (drift.length > 0) {
    logger.warn('CONSOLE_HOOK_MAP drift: the SDK spells a hook differently than this adapter', {
      drift,
    });
  }
  return map;
}

export function sdkVersionOf(sdk: LoadedAgentSdk): string | undefined {
  const raw = sdkMember(sdk, 'VERSION') ?? sdkMember(sdk, 'version');
  return typeof raw === 'string' && raw !== '' ? raw : undefined;
}
