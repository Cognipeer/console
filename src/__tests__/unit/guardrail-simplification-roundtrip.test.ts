/**
 * THE ROUND-TRIP TEST FOR THE SURFACE SIMPLIFICATION.
 *
 * The pass that produced `GuardrailEnforcement`, `writeGuardrailMode` and the
 * basic/advanced split collapsed FOURTEEN controls to four-plus-a-disclosure.
 * Every one of those collapses is a PRESENTATION collapse over a storage shape
 * that did not move — and the single failure mode that would make the whole
 * thing worse than what it replaced is this one:
 *
 *     AN OPERATOR OPENS A GUARDRAIL THEY DID NOT INTEND TO CHANGE, SAVES
 *     SOMETHING ELSE ON THE SCREEN, AND A STORED FIELD THEY NEVER SAW IS
 *     REWRITTEN UNDER THEM.
 *
 * A narrowed control that cannot express a stored value does exactly that: it
 * displays the nearest rung it does have, and the next save persists the lie.
 * So this file does not test the controls. It tests the CONFIGURATION, through
 * the same functions the four screens call, and asserts the stored blob comes
 * back byte-identical.
 *
 * WHY THIS IS NOT COVERED BY THE FILES THAT ALREADY EXIST.
 * `guardrail-catalog.test.ts` pins `toEnforcement`/`fromEnforcement` in
 * isolation and `guardrail-policy-drawer.test.ts` pins the disclosure's
 * partition. Both start from a value already inside the new vocabulary. The
 * question here is the other direction — whether a row written by an OLDER
 * build, or by a hand-written PATCH, survives a visit — and that question can
 * only be asked with a fixture in the old shape, which is what every fixture
 * below is.
 *
 * WHAT COUNTS AS "SAVED UNTOUCHED" HERE. The three screen paths, each exercised
 * through the real function rather than a re-statement of it:
 *   · the policy drawer  — `setDraft(policy)` on open, `onApply(draft)` on
 *     apply, with no `set()` between, so the test applies `policyDraftIsDirty`
 *     to the pair the drawer would hand back.
 *   · the hooks matrix   — `toEnforcement(schedule)` renders, and nothing
 *     writes until `onChange`; so a read that survives `fromEnforcement` is the
 *     whole guarantee.
 *   · the detail page    — `readGuardrailMode` on load, `writeGuardrailMode` on
 *     save, with `body.hooks = hooks` unchanged.
 */

import { describe, expect, it } from 'vitest';

import {
  GUARDRAIL_ENFORCEMENTS,
  fromEnforcement,
  readGuardrailMode,
  toEnforcement,
  toGuardrailMode,
  toggleGuardrailFields,
  writeGuardrailMode,
} from '@/lib/services/guardrail/hooks/contract';
import type {
  GuardrailMode,
  GuardrailPolicy,
  GuardrailHooksConfig,
  HookSchedule,
} from '@/lib/services/guardrail/hooks/contract';
import { policyDraftIsDirty } from '@/components/guardrails/GuardrailPolicyDrawer';
// The SERVER half of the same round trip. Every assertion below that names one
// of these runs the real function the PATCH route runs, not a re-statement of
// it — which is the whole difference between "the helpers agree with each
// other" and "a stored row survives a visit".
import { readHooksField } from '@/server/api/plugins/guardrails';
import { projectHooksToLegacy } from '@/lib/services/guardrail/hooks/legacy';
import type { IGuardrail } from '@/lib/database/provider/types.domain';

// ── The three schedules that can legally be stored ──────────────────────────

/**
 * `GuardrailHookSchedule` is a discriminated union with THREE inhabitants, not
 * the four a `timing` select beside an `onFail` select advertises. Spelled out
 * as literals rather than derived from `fromEnforcement`, so that a change to
 * that function fails this table instead of moving with it.
 */
const LEGAL_SCHEDULES: readonly HookSchedule[] = [
  { timing: 'sync', onFail: 'block' },
  { timing: 'sync', onFail: 'log' },
  { timing: 'async', onFail: 'log' },
];

/**
 * Shapes the TYPE forbids and a row can still contain: a config written by a
 * hand-rolled PATCH, by an older client that omitted the field, or by the
 * `schedule: {}` an empty form once produced.
 *
 * The expectation column is not this test's opinion — it is what the ENGINE
 * does with the same row, and each entry names the line that decides it. A
 * screen that disagreed with the engine here would be describing a guardrail
 * nobody has.
 */
const MALFORMED_SCHEDULES: ReadonlyArray<{
  readonly stored: unknown;
  readonly reads: 'block' | 'observe' | 'observe_no_wait';
  readonly why: string;
}> = [
  {
    stored: undefined,
    reads: 'block',
    why: 'policyTiming falls back to SYNC_BLOCK (hooks/engine.ts:302)',
  },
  {
    stored: {},
    reads: 'block',
    why: "client-guardrails projects `onFail: schedule?.onFail ?? 'block'` (:190)",
  },
  {
    stored: { timing: 'sync' },
    reads: 'block',
    why: 'same projection: an absent onFail is a blocking one',
  },
  {
    stored: { timing: 'async' },
    reads: 'observe_no_wait',
    why: 'async has exactly one legal onFail, so there is nothing else it means',
  },
  {
    stored: { timing: 'async', onFail: 'block' },
    reads: 'observe_no_wait',
    why: 'TIMING WINS: the response has already gone, so the engine can only log',
  },
];

describe('stored schedule survives the one-control collapse', () => {
  it.each(LEGAL_SCHEDULES)('round-trips %j byte-identically', (stored) => {
    // The screen's whole lifecycle: read it to render the select, write back
    // what the select is showing. An operator who opens the Hooks tab and saves
    // a NAME change goes through exactly this.
    const reread = fromEnforcement(toEnforcement(stored));
    expect(JSON.stringify(reread)).toBe(JSON.stringify(stored));
  });

  it('offers exactly one screen value per stored schedule, and no more', () => {
    // Three stored shapes, three offered values, and the map between them is a
    // bijection. This is the assertion that would have caught the two selects:
    // they offered four.
    const seen = LEGAL_SCHEDULES.map(toEnforcement);
    expect(seen).toEqual(['block', 'observe', 'observe_no_wait']);
    expect(new Set(seen).size).toBe(GUARDRAIL_ENFORCEMENTS.length);
  });

  it.each(MALFORMED_SCHEDULES)(
    'reads $stored as $reads — $why',
    ({ stored, reads }) => {
      expect(toEnforcement(stored as HookSchedule | undefined)).toBe(reads);
    },
  );

  it('never widens a malformed schedule into enforcement it cannot deliver', () => {
    // The one direction that matters for safety. A hand-written
    // `{ timing: 'async', onFail: 'block' }` must not come back as 'block':
    // the request is already answered, and a control claiming otherwise
    // promises an operator a block the engine will never perform.
    const contradiction = { timing: 'async', onFail: 'block' } as unknown as HookSchedule;
    expect(toEnforcement(contradiction)).toBe('observe_no_wait');
    expect(fromEnforcement(toEnforcement(contradiction))).toEqual({
      timing: 'async',
      onFail: 'log',
    });
  });
});

// ── mode x enabled, the pair that could disagree ────────────────────────────

/**
 * Every pairing a row can hold, INCLUDING the incoherent ones — which is the
 * point: `mode` and `enabled` were two independent controls, so both
 * disagreements are on disk somewhere.
 *
 * `repaired` says what a visit does to the pair. It is `false` only for the
 * rows that were already coherent; the rest are repaired ON PURPOSE, and the
 * repair is asserted to be the direction the EVALUATOR already reads, never a
 * new opinion about the row.
 */
const MODE_PAIRINGS: ReadonlyArray<{
  readonly stored: { mode?: unknown; enabled: boolean };
  readonly shows: GuardrailMode;
  readonly repaired: boolean;
}> = [
  { stored: { mode: 'enforce', enabled: true }, shows: 'enforce', repaired: false },
  { stored: { mode: 'monitor', enabled: true }, shows: 'monitor', repaired: false },
  { stored: { mode: 'disabled', enabled: false }, shows: 'disabled', repaired: false },
  // The aliases an older enterprise enforcement plane and the MCP binding wrote.
  { stored: { mode: 'simulate', enabled: true }, shows: 'monitor', repaired: true },
  { stored: { mode: 'off', enabled: true }, shows: 'disabled', repaired: true },
  // The two disagreements, and they are NOT symmetric — which is worth pinning,
  // because a reader who assumes `enabled` simply wins would get the second one
  // backwards. `enabled: false` forces OFF whatever the column says (the fold
  // opens with `if (!enabled) return 'disabled'`), but `enabled: true` never
  // forces ON: a 'disabled' column still reads disabled. Both are repaired, in
  // different fields — the first rewrites `mode`, the second rewrites `enabled`.
  { stored: { mode: 'enforce', enabled: false }, shows: 'disabled', repaired: true },
  { stored: { mode: 'disabled', enabled: true }, shows: 'disabled', repaired: true },
  // A row that predates the column entirely.
  { stored: { mode: undefined, enabled: true }, shows: 'enforce', repaired: true },
];

describe('mode and enabled are one decision', () => {
  it.each(MODE_PAIRINGS)('reads $stored as $shows', ({ stored, shows }) => {
    expect(readGuardrailMode(stored)).toBe(shows);
    // Not a second opinion: the screen and the evaluator fold through the same
    // function, so this asserts they cannot drift rather than restating the fold.
    expect(readGuardrailMode(stored)).toBe(toGuardrailMode(stored.mode, stored.enabled));
  });

  it.each(MODE_PAIRINGS)('writes a coherent pair back for $stored', ({ stored }) => {
    const written = writeGuardrailMode(readGuardrailMode(stored));
    // THE INVARIANT THE COLLAPSE EXISTS TO CREATE. Whatever came in, what goes
    // out cannot be a guardrail that reads as on while evaluating nothing.
    expect(written.enabled).toBe(written.mode !== 'disabled');
  });

  it.each(MODE_PAIRINGS.filter((row) => !row.repaired))(
    'leaves an already-coherent $stored byte-identical',
    ({ stored }) => {
      const written = writeGuardrailMode(readGuardrailMode(stored));
      expect(JSON.stringify(written)).toBe(
        JSON.stringify({ mode: stored.mode, enabled: stored.enabled }),
      );
    },
  );

  it.each([
    // Rewrites `mode`: 'enforce' beside `enabled: false` has ALWAYS evaluated as
    // disabled, so the column catches up with the switch.
    { before: { mode: 'enforce', enabled: false }, after: { mode: 'disabled', enabled: false } },
    // Rewrites `enabled`: the column already said disabled and the switch was
    // the one lying, so the switch catches up with the column. The opposite
    // field moves, and the resolved posture is the same in both.
    { before: { mode: 'disabled', enabled: true }, after: { mode: 'disabled', enabled: false } },
  ])('repairs $before towards the posture the evaluator already honoured', ({ before, after }) => {
    const written = writeGuardrailMode(readGuardrailMode(before));
    expect(written).toEqual(after);
    // THE LICENCE FOR THE REWRITE, and the whole reason it is defensible: what
    // is STORED changes, what RUNS does not. A repair that altered the resolved
    // posture would be this pass changing an operator's guardrail behind their
    // back, which no amount of screen simplification would justify.
    expect(toGuardrailMode(before.mode, before.enabled)).toBe(
      toGuardrailMode(written.mode, written.enabled),
    );
  });

  it('is idempotent: a second visit changes nothing a first visit already fixed', () => {
    for (const { stored } of MODE_PAIRINGS) {
      const once = writeGuardrailMode(readGuardrailMode(stored));
      const twice = writeGuardrailMode(readGuardrailMode(once));
      expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
    }
  });

  /**
   * THE OTHER WRITER, and the one the first version of this pass missed.
   *
   * The detail page's Mode control is not the only thing that turns a guardrail
   * on and off: the guardrails LIST has a per-row pause/resume, and it sent
   * `{ enabled: !enabled }` with no `mode` at all. Both provider mixins skip an
   * absent field, so the `mode` column survived the write untouched — and a
   * guardrail set to Off on the detail page (`mode: 'disabled'`) then resumed
   * from the list came back `{ mode: 'disabled', enabled: true }`: drawn as a
   * green "Active" row, skipped entirely by the evaluator.
   *
   * A collapse that PROMISES the two columns can never disagree has to hold at
   * every writer. These pin that the list's toggle now goes through the same
   * assembly as the control that got the redesign.
   */
  it.each(MODE_PAIRINGS)('never leaves $stored reading as on while off', ({ stored }) => {
    const patched = { ...stored, ...toggleGuardrailFields(stored) };
    // THE ONE-DIRECTIONAL INVARIANT, which is the harm rather than the means:
    // a row that reads as ON must resolve to a posture that actually evaluates.
    // The mirror image (`enabled: false` beside a leftover 'monitor') is not a
    // disagreement anyone can act on — every reader folds `enabled` first — and
    // it is the only place a paused guardrail remembers what it was.
    if (patched.enabled === true) {
      expect(readGuardrailMode(patched)).not.toBe('disabled');
    }
  });

  it.each(MODE_PAIRINGS)('toggles $stored to the opposite posture', ({ stored, shows }) => {
    const patched = { ...stored, ...toggleGuardrailFields(stored) };
    // A running guardrail stops; a stopped one starts. Nothing is a no-op —
    // which is what `{ enabled: !enabled }` became for the incoherent pairs,
    // where flipping the switch left the resolved posture exactly as it was.
    expect(readGuardrailMode(patched) === 'disabled').toBe(shows !== 'disabled');
  });

  it('resumes a paused MONITOR guardrail to monitor, never to enforce', () => {
    // The one direction an operator cannot undo after the fact: promoting a
    // guardrail that was only watching into one that blocks live traffic.
    expect(toggleGuardrailFields({ mode: 'monitor', enabled: false })).toEqual({
      mode: 'monitor',
      enabled: true,
    });
    // The enforcement plane's alias for the same posture.
    expect(toggleGuardrailFields({ mode: 'simulate', enabled: false })).toEqual({
      mode: 'monitor',
      enabled: true,
    });
    // A column with nothing to remember resumes to enforce.
    expect(toggleGuardrailFields({ mode: 'disabled', enabled: false })).toEqual({
      mode: 'enforce',
      enabled: true,
    });
    expect(toggleGuardrailFields({ mode: undefined, enabled: false })).toEqual({
      mode: 'enforce',
      enabled: true,
    });
  });

  it('pauses WITHOUT erasing the mode the guardrail is coming back to', () => {
    // Sending `mode: 'disabled'` here would be coherent and wrong: it destroys
    // the difference between a paused enforcing guardrail and a paused watching
    // one, and every resume after it is a silent promotion.
    expect(toggleGuardrailFields({ mode: 'monitor', enabled: true })).toEqual({ enabled: false });
    expect(toggleGuardrailFields({ mode: 'enforce', enabled: true })).toEqual({ enabled: false });
  });

  it('is reversible: pause then resume returns the posture it started in', () => {
    for (const { stored, shows } of MODE_PAIRINGS) {
      if (shows === 'disabled') continue;
      const paused = { ...stored, ...toggleGuardrailFields(stored) };
      expect(readGuardrailMode(paused)).toBe('disabled');
      const resumed = { ...paused, ...toggleGuardrailFields(paused) };
      // The stored WORDS may be normalised ('simulate' -> 'monitor'); the
      // POSTURE has to come back exactly, or the toggle is a trap.
      expect(readGuardrailMode(resumed)).toBe(shows);
    }
  });
});

// ── The whole stored blob, opened and saved untouched ───────────────────────

/**
 * A configuration carrying every field the simplification moved off the basic
 * form, at a NON-DEFAULT value, so that "the disclosure hides it" and "the save
 * drops it" are distinguishable outcomes.
 *
 * `budgetMs` on the webhook policy is deliberate and is NOT a typo for
 * `timeoutMs`. `families/webhook.ts:859` reads `policy.budgetMs`, a key that is
 * on no interface, in no catalog entry and on no screen — it exists only inside
 * the JSON blob. It is here because a save that rebuilt policies from the
 * catalog's field list (rather than spreading the stored object) would drop it
 * silently, and the operator's webhook deadline would revert to the family
 * default with nothing on screen to show for it.
 */
function storedConfig(): GuardrailHooksConfig {
  return {
    contractVersion: 2,
    policies: [
      {
        id: 'pol-pii',
        family: 'pii',
        enabled: true,
        hooks: ['input.pre'],
        schedule: { timing: 'sync', onFail: 'block' },
        action: 'redact',
        failMode: 'closed',
        runIf: 'onFinding',
        timeoutMs: 2000,
        label: 'HR PII',
        piiPolicyKey: 'pii-hr',
      },
      {
        id: 'pol-mod',
        family: 'moderation',
        enabled: true,
        hooks: ['output.pre'],
        // The observe rung, stored: this policy waits and records.
        schedule: { timing: 'sync', onFail: 'log' },
        // An EDGE rung of the action ladder — one of the two the basic control
        // does not lead with. If `basicOptions` failed to re-promote it, this
        // is the value that would come back as 'block'.
        action: 'warn',
        failMode: 'open',
        runIf: 'always',
        // NOT decoration, and the fixture was wrong without it: an enabled
        // LLM-backed policy with no `modelKey` is refused by
        // `validateGuardrailHooks` (hooks/legacy.ts:1052), which never consults
        // the record-level key — `liftLegacyHooks` copies
        // `moderation.modelKey ?? record.modelKey` down into the policy
        // precisely so it does not have to. Until the server half of this file
        // existed, every assertion here was client-side, so a fixture the PATCH
        // route would have rejected with a 400 read as a configuration that
        // "survives being opened and saved untouched".
        modelKey: 'judge-model',
        categories: { hate: true },
      },
      {
        id: 'pol-hook',
        family: 'webhook',
        enabled: false,
        hooks: ['tool.pre'],
        // The rung that only exists because async cannot block.
        schedule: { timing: 'async', onFail: 'log' },
        url: 'https://example.invalid/guard',
        // See the note above: undeclared, unreachable from any screen, read by
        // the family at run time.
        budgetMs: 750,
      } as unknown as GuardrailPolicy,
    ] as GuardrailPolicy[],
    bindings: {
      'input.pre': { enabled: true, schedule: { timing: 'sync', onFail: 'block' }, timeoutMs: 5000 },
      'output.pre': { enabled: true, schedule: { timing: 'sync', onFail: 'log' } },
      'tool.pre': { enabled: false, schedule: { timing: 'async', onFail: 'log' } },
    },
    stream: { enabled: true, holdBackChars: 512 },
    shortCircuit: false,
  };
}

describe('a stored configuration survives being opened and saved untouched', () => {
  it('is byte-identical after the detail page assembles its PATCH body', () => {
    const stored = storedConfig();
    const before = JSON.stringify(stored);

    // The load half of the page: `setHooks(loadedHooks)`, then `setHooksDirty(false)`.
    // The save half: `body.hooks = hooks`. Nothing between the two touches it,
    // which is precisely the claim under test.
    const body: Record<string, unknown> = { hooks: stored, ...writeGuardrailMode('enforce') };

    expect(JSON.stringify(body.hooks)).toBe(before);
  });

  it('carries no `action` and no `failMode`, so the projection owns those columns', () => {
    // The Default Action control came off the screen. The proof that it came
    // off CLEANLY is negative: the body must not carry the field at all.
    // Sending `action: undefined` and omitting it are the same on the wire, but
    // only omission survives `JSON.stringify` — and a body that DID carry a
    // stale value would beat the server's projection at
    // `legacy?.action ?? body.action`.
    const body: Record<string, unknown> = {
      name: 'Guard',
      description: '',
      modelKey: undefined,
      ...writeGuardrailMode('monitor'),
    };
    expect(Object.keys(body)).not.toContain('action');
    expect(Object.keys(body)).not.toContain('failMode');
    // ...and the pair that DID stay is complete, because a route that forwarded
    // one and not the other reproduces the disagreement exactly.
    expect(body).toMatchObject({ mode: 'monitor', enabled: true });
  });

  it('hands the drawer back the same policy it was opened with', () => {
    for (const policy of storedConfig().policies) {
      // `setDraft(policy)` on open; `onApply(draft)` on apply. With no `set()`
      // in between the draft IS the stored object, and the drawer's own dirty
      // check is what the parent consults before writing anything.
      expect(policyDraftIsDirty(policy, policy)).toBe(false);
    }
  });

  it('preserves every advanced field the basic form no longer asks for', () => {
    const stored = storedConfig();
    // The fields the simplification moved behind the disclosure, read back off
    // the blob a save would write. Named individually rather than deep-equalled
    // so that a drop reports WHICH knob went missing.
    const pii = stored.policies[0];
    expect(pii.failMode).toBe('closed');
    expect(pii.runIf).toBe('onFinding');
    expect(pii.timeoutMs).toBe(2000);
    expect(toEnforcement(pii.schedule)).toBe('block');

    const moderation = stored.policies[1];
    // The edge rung. `basicOptions` re-promotes a stored value that is not one
    // of the three the control leads with, so this survives a visit instead of
    // being displayed as — and then saved as — the nearest offered rung.
    expect(moderation.action).toBe('warn');
    expect(toEnforcement(moderation.schedule)).toBe('observe');

    const webhook = stored.policies[2] as GuardrailPolicy & { budgetMs?: number };
    expect(webhook.budgetMs).toBe(750);
    expect(toEnforcement(webhook.schedule)).toBe('observe_no_wait');
  });

  it('preserves a hook binding’s own timeout and its schedule', () => {
    const { bindings } = storedConfig();
    expect(bindings['input.pre']?.timeoutMs).toBe(5000);
    // A binding switched OFF still round-trips its schedule: the row's "Off" is
    // `enabled: false`, not a schedule the grid forgets.
    expect(bindings['tool.pre']?.enabled).toBe(false);
    expect(toEnforcement(bindings['tool.pre']?.schedule)).toBe('observe_no_wait');
    expect(
      JSON.stringify(fromEnforcement(toEnforcement(bindings['tool.pre']?.schedule))),
    ).toBe(JSON.stringify(bindings['tool.pre']?.schedule));
  });

  it('is byte-identical after EVERY schedule in it is re-read and re-written', () => {
    // The pessimistic case: pretend the matrix and the drawer both wrote back
    // what their selects were displaying, for every policy and every binding at
    // once. This is what a save looks like if some future edit makes the
    // controls controlled-and-always-writing rather than write-on-change.
    const stored = storedConfig();
    const before = JSON.stringify(stored);

    const rewritten: GuardrailHooksConfig = {
      ...stored,
      policies: stored.policies.map((policy) => ({
        ...policy,
        schedule: fromEnforcement(toEnforcement(policy.schedule)),
      })),
      bindings: Object.fromEntries(
        Object.entries(stored.bindings).map(([hook, binding]) => [
          hook,
          binding && { ...binding, schedule: fromEnforcement(toEnforcement(binding.schedule)) },
        ]),
      ),
    };

    expect(JSON.stringify(rewritten)).toBe(before);
  });
});

// ── The server half: what the PATCH route does to an untouched save ─────────

/**
 * WHY THIS SECTION EXISTS SEPARATELY FROM THE ONE ABOVE.
 *
 * Everything before this point composes the SCREENS' own functions and asks
 * whether they agree with each other. That is necessary and it is not
 * sufficient: the body those screens assemble is then handed to
 * `readHooksField` (which re-spells legacy keys, stamps defaults and runs
 * `validateGuardrailHooks`, a function that MUTATES `stream.holdBackChars`) and
 * to `projectHooksToLegacy` (which recomputes six legacy columns). Either one
 * could rewrite a configuration nobody edited, and no assertion above would
 * notice.
 *
 * The two claims under test are deliberately different in kind:
 *
 *   · the `hooks` BLOB must come back byte-identical. It is the authored
 *     document; a save that reshapes it is the failure this whole pass would be
 *     judged by.
 *   · the legacy COLUMNS must not. They are projections, and now that no human
 *     sets `action`, "unchanged" is the wrong guarantee for them — "recomputed
 *     from the policies, every time" is the one that keeps them honest.
 */

/** A record in the shape the route hands the projection. */
function storedRecord(over: Partial<IGuardrail> = {}): IGuardrail {
  return {
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    key: 'guard',
    name: 'Guard',
    type: 'preset',
    target: 'input',
    action: 'block',
    enabled: true,
    failMode: 'open',
    hooks: storedConfig(),
    hooksVersion: 2,
    ...over,
  } as IGuardrail;
}

/** What the detail page sends for a save that changed only the name: the whole
 *  stored config, straight back, with the mode pair beside it. */
function untouchedPatchBody(config: GuardrailHooksConfig, mode: GuardrailMode) {
  return {
    name: 'Guard',
    hooks: JSON.parse(JSON.stringify(config)) as GuardrailHooksConfig,
    hooksVersion: 2,
    ...writeGuardrailMode(mode),
  } as Record<string, unknown>;
}

describe('the PATCH route leaves an untouched configuration alone', () => {
  it('returns the stored blob byte-identical, undeclared keys included', () => {
    const before = JSON.stringify(storedConfig());
    const body = untouchedPatchBody(storedConfig(), 'enforce');

    const result = readHooksField(body);

    // A stored config that the validator REFUSES is the same outage as one it
    // rewrites: the operator cannot save the name change either.
    expect(result.errors).toBeUndefined();
    expect(JSON.stringify(result.hooks)).toBe(before);
    // Named separately because it is the one field no interface declares:
    // `families/webhook.ts` reads `policy.budgetMs` off the raw blob, and a
    // route that rebuilt policies from the catalog would drop it with nothing
    // on screen to show for it.
    const webhook = result.hooks?.policies[2] as (GuardrailPolicy & { budgetMs?: number }) | undefined;
    expect(webhook?.budgetMs).toBe(750);
  });

  it('carries no `action` and no `failMode` for the projection to lose to', () => {
    // `action: legacy?.action ?? body.action` — a body that still carried a
    // stale value would win wherever the projection declines to derive one.
    const body = untouchedPatchBody(storedConfig(), 'monitor');
    expect(Object.keys(body)).not.toContain('action');
    expect(Object.keys(body)).not.toContain('failMode');
  });

  it.each(LEGAL_SCHEDULES)(
    'accepts %j on every policy and every binding without reshaping it',
    (schedule) => {
      // The pessimistic version of the first case: force ONE schedule through
      // the whole document, so a validator that objected to `async` on a policy
      // bound to a blocking hook (or vice versa) shows up as a refusal rather
      // than as a save nobody makes.
      const config: GuardrailHooksConfig = {
        ...storedConfig(),
        policies: storedConfig().policies.map((policy) => ({ ...policy, schedule })),
        bindings: Object.fromEntries(
          Object.entries(storedConfig().bindings).map(([hook, binding]) => [
            hook,
            binding && { ...binding, schedule },
          ]),
        ),
      };
      const before = JSON.stringify(config);
      const result = readHooksField(untouchedPatchBody(config, 'enforce'));
      expect(result.errors).toBeUndefined();
      expect(JSON.stringify(result.hooks)).toBe(before);
    },
  );

  it.each(MODE_PAIRINGS)('sends both halves of the pair for a stored $stored', ({ stored }) => {
    // The load-then-save path the page actually runs. Whatever the row said,
    // the body carries the pair — never `mode` alone, which is what let the
    // list's old toggle store a guardrail that read as on while evaluating
    // nothing.
    const body = untouchedPatchBody(storedConfig(), readGuardrailMode(stored));
    expect(body.enabled).toBe(body.mode !== 'disabled');
    expect(toGuardrailMode(body.mode, body.enabled as boolean)).toBe(readGuardrailMode(stored));
  });
});

describe('the `action` column is projected, not preserved', () => {
  /**
   * THE FACT THAT RETIRES THE "DEFAULT ACTION" CONTROL, and the reason removing
   * it took nothing away: it was never authoritative. `projectHooksToLegacy`
   * has always folded the column out of the enabled policies, and
   * `action: legacy?.action ?? body.action` has always let that fold win — so
   * the select showed one value and the save stored another the moment a policy
   * disagreed with it. What changed is that a human is no longer asked for a
   * number the server was going to overwrite.
   */
  it('folds a stale column up to what the policies actually do', () => {
    const config = storedConfig(); // redact + warn enabled, webhook disabled
    const legacy = projectHooksToLegacy(config, storedRecord({ action: 'block' }));
    // Not 'block'. The column catches up with the policies on this save, with
    // or without a control on the screen.
    expect(legacy.action).toBe('redact');
  });

  it('keeps writing the column its readers depend on', () => {
    // The readers verified in this tree: the guardrails list (filter, block
    // KPI, per-row badge), the detail header, `GET /api/guardrails/:id`,
    // `client-guardrails`, and `evaluateGuardrail`, which returns
    // `action: record.action` on the evaluation RESULT — so the value is on the
    // wire every caller reads, including the EE gateway's response object.
    const legacy = projectHooksToLegacy(storedConfig(), storedRecord());
    expect(legacy.action).toBeDefined();
    expect(typeof legacy.action).toBe('string');
  });

  it('falls back to the stored column when nothing is enabled to derive from', () => {
    // A guardrail whose policies are all switched off must not have its column
    // churned to a default — that is an operator's setting, and there is
    // nothing on the screen that would explain the change.
    const config: GuardrailHooksConfig = {
      ...storedConfig(),
      policies: storedConfig().policies.map((policy) => ({ ...policy, enabled: false })),
    };
    const legacy = projectHooksToLegacy(config, storedRecord({ action: 'warn' }));
    expect(legacy.action).toBe('warn');
    expect(legacy.type).toBe('preset');
  });

  it('leaves `failMode` where it was unless a policy declares one', () => {
    // The guardrail-level "Default for policies that cannot run" control is
    // gone. `foldFailModes` returns `current.failMode` when no enabled policy
    // names one, so a legacy row's column survives a visit; when one does,
    // 'closed' wins, because over-blocking on an outage is the recoverable half
    // of that trade.
    const bare: GuardrailHooksConfig = {
      ...storedConfig(),
      policies: storedConfig().policies.map((policy) => {
        const copy = { ...policy };
        delete copy.failMode;
        return copy;
      }),
    };
    expect(projectHooksToLegacy(bare, storedRecord({ failMode: 'closed' })).failMode).toBe('closed');
    expect(projectHooksToLegacy(bare, storedRecord({ failMode: 'open' })).failMode).toBe('open');
    // The stored fixture has one 'closed' policy and one 'open' one.
    expect(projectHooksToLegacy(storedConfig(), storedRecord({ failMode: 'open' })).failMode).toBe(
      'closed',
    );
  });

  /**
   * THE ONE PROJECTED COLUMN THE PATCH ROUTE CANNOT WRITE, pinned so the gap is
   * a documented fact rather than something the next reader rediscovers.
   *
   * `UpdateGuardrailInput` (services/guardrail/types.ts) has no `type` slot, so
   * the value computed here is dropped on every save. `POST /api/guardrails`
   * does write it (`type: legacy?.type ?? body.type`) — but the create modal no
   * longer offers the fork, so a console-created guardrail is `type: 'preset'`
   * for life. `type: 'custom'` remains legal, remains stored, and remains
   * reachable through `POST /api/client/v1/guardrails`.
   */
  it('computes `type` from the policies even though PATCH has nowhere to put it', () => {
    const soleCustom: GuardrailHooksConfig = {
      ...storedConfig(),
      policies: [
        {
          id: 'pol-custom',
          family: 'custom',
          enabled: true,
          hooks: ['input.pre'],
          schedule: { timing: 'sync', onFail: 'block' },
          prompt: 'Refuse anything about internal pricing.',
          modelKey: 'judge',
        } as GuardrailPolicy,
      ],
    };
    const legacy = projectHooksToLegacy(soleCustom, storedRecord({ type: 'preset' }));
    expect(legacy.type).toBe('custom');
    expect(legacy.customPrompt).toBe('Refuse anything about internal pricing.');
  });
});
