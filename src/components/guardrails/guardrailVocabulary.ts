/**
 * THE WORDS. One home for the two collapsed controls' copy, so the same choice
 * is not offered in three different phrasings on three screens of one feature.
 *
 * WHY THIS FILE EXISTS. The pass that collapsed `timing` x `onFail` into one
 * Enforcement control and `mode` x `enabled` into one Mode control landed the
 * copy separately in each screen that draws it, which reproduced in prose the
 * exact problem the collapse was meant to fix:
 *
 *   · the drawer offered  "Block — wait for it, and stop the request on a finding"
 *   · the hooks matrix offered "Block — wait, and stop on a finding"
 *   · and both exported a const named `ENFORCEMENT_OPTIONS` whose `label` meant
 *     the SHORT form in one file and the LONG form in the other, so importing
 *     the wrong one rendered a full sentence inside a badge.
 *
 * The mode labels had three copies (`MODE_DATA` and `MODE_DATA_COMPACT` in the
 * matrix, `MODE_OPTIONS` + `MODE_HINT` on the detail page) and the list screen
 * was about to become the fourth.
 *
 * NOTHING HERE IS PERSISTED OR TRANSMITTED. This file holds presentation copy
 * only. The conversions and the stored shapes live in
 * `@/lib/services/guardrail/hooks/contract`:
 *
 *   Enforcement            STORED `schedule`                      via
 *   'block'                { timing: 'sync',  onFail: 'block' }   fromEnforcement / toEnforcement
 *   'observe'              { timing: 'sync',  onFail: 'log'   }
 *   'observe_no_wait'      { timing: 'async', onFail: 'log'   }
 *
 *   Mode                   STORED COLUMNS                         via
 *   'enforce'              { mode: 'enforce',  enabled: true  }   writeGuardrailMode / readGuardrailMode
 *   'monitor'              { mode: 'monitor',  enabled: true  }
 *   'disabled'             { mode: 'disabled', enabled: false }
 *
 * The contract deliberately carries the FUNCTIONS and not the prose — it is the
 * leaf the engine imports, and the engine has no use for a label — so the prose
 * lives here, one level up, where only screens can reach it.
 *
 * THE OTHER COPY. `lib/i18n/messages/en.ts` carries the same three enforcement
 * values and the same three modes under `guardrails.schedule.enforcement*`,
 * `guardrails.mode.*` and `guardrails.action.*`. That namespace has ZERO
 * consumers today — no component under `components/guardrails/**` calls
 * `useTranslations`, and `tr.ts` has no `guardrails` block — so THIS file is
 * what every screen actually renders and that one is the reference an i18n
 * adoption pass will substitute in. The two have already drifted in wording;
 * change one and change the other, and when the folder is wired to
 * `useTranslations`, these literals should be deleted rather than kept in sync
 * by hand.
 */

import type {
  GuardrailEnforcement,
  GuardrailMode,
} from '@/lib/services/guardrail/hooks/contract';
import {
  GUARDRAIL_ENFORCEMENTS,
} from '@/lib/services/guardrail/hooks/contract';

/**
 * Three registers for one option, named for the ROOM they need rather than for
 * the screen that happens to use them — a grid cell, a full-width select, and a
 * help line — so a caller picks by fit instead of importing whichever `label`
 * its neighbour exported.
 */
export interface EnforcementCopy {
  /** Badge- and cell-width. Never a sentence. */
  short: string;
  /** A select with room to say what it does. */
  long: string;
  /** The help line under the control. Names the stored shape last, because an
   *  operator reading it should meet the behaviour before the storage. */
  description: string;
}

/**
 * The words are the guardrail-level vocabulary at a smaller scope, on purpose:
 * OBSERVE at one hook is what MONITOR is for the whole guardrail — everything
 * runs, everything is recorded, no decision is acted on. `timing` and `onFail`
 * are not words an operator needs any more, and they appear below only as the
 * closing clause that lets a reader map the screen back to a stored row.
 */
export const ENFORCEMENT_COPY: Readonly<Record<GuardrailEnforcement, EnforcementCopy>> = {
  block: {
    short: 'Block',
    long: 'Block — wait, and stop on a finding',
    description:
      'The request waits for this check, and what it finds can stop the request. Stored as sync + block.',
  },
  observe: {
    short: 'Observe',
    long: 'Observe — wait, record, continue',
    description:
      'The request waits for this check and records what it finds, then continues either way. Stored as sync + log.',
  },
  observe_no_wait: {
    short: 'Observe, no wait',
    long: 'Observe, without waiting',
    description:
      'The request does not wait at all. This runs beside it and records what it finds — by the time it answers the response has gone, so it can only ever record. Stored as async + log.',
  },
};

/**
 * The three, strongest first, built by mapping the CONTRACT's own ordered list
 * so a fourth enforcement value added to the union is a compile error here
 * rather than an option every screen silently stops offering.
 */
export const ENFORCEMENT_VOCABULARY: ReadonlyArray<{ value: GuardrailEnforcement } & EnforcementCopy> =
  GUARDRAIL_ENFORCEMENTS.map((value) => ({ value, ...ENFORCEMENT_COPY[value] }));

/** The one-line answer to "what is this set to", for summary badges. */
export function enforcementSummaryLabel(value: GuardrailEnforcement): string {
  return ENFORCEMENT_COPY[value].short;
}

/** Mode's registers, matching Enforcement's. */
export interface ModeCopy {
  /** Segmented-control and badge width. */
  short: string;
  /** A select with room for the consequence. */
  long: string;
  /** What the posture actually does. */
  hint: string;
}

/**
 * MONITOR is stated as OBSERVE applied to the whole guardrail, deliberately —
 * an operator who has learned one of the two controls has learned both, which
 * is the entire reason the collapse was worth doing.
 */
export const MODE_COPY: Readonly<Record<GuardrailMode, ModeCopy>> = {
  enforce: {
    short: 'Enforce',
    long: 'Enforce — act on the verdict',
    hint: 'Verdicts are acted on: a policy that says block, blocks.',
  },
  monitor: {
    short: 'Monitor',
    long: 'Monitor — record, act on nothing',
    hint:
      'Everything still runs and everything is still recorded, but every decision is neutralised before anyone acts on it — Observe, applied to the whole guardrail. Use it to size a policy against real traffic before turning it on.',
  },
  disabled: {
    short: 'Off',
    long: 'Off — nothing runs',
    hint:
      'Nothing runs and nothing is recorded. An allow verdict from a guardrail that is off means “nothing was checked”, not “this is safe”.',
  },
};

/** The three postures in the order a control should offer them. Hand-ordered
 *  rather than derived: `GuardrailMode` is a persisted union whose declaration
 *  order is not a presentation decision. */
export const GUARDRAIL_MODES = ['enforce', 'monitor', 'disabled'] as const satisfies
  readonly GuardrailMode[];

export const MODE_VOCABULARY: ReadonlyArray<{ value: GuardrailMode } & ModeCopy> =
  GUARDRAIL_MODES.map((value) => ({ value, ...MODE_COPY[value] }));
