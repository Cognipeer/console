/**
 * Regression — A PLUGIN DENIAL MUST STOP THE RUN, on both agent paths.
 *
 * agent-sdk 0.10.0 does not reject `invoke()` when a guardrail plugin denies.
 * It appends an assistant message carrying the reason and resolves normally.
 * Measured end-to-end against a real LLM: a guardrail bound to `prompt.pre`
 * decided `block`, the evaluation log recorded `decision: "block"`, and the
 * turn completed and was persisted as an ordinary answer — because nothing in
 * the console could see it.
 *
 * `guardrailDenial` is what sees it, and everything it depends on is an
 * UNDOCUMENTED PRIVATE DETAIL of a caret-ranged dependency:
 *
 *   · `state.ctx.__guardrailBlocked` — set by `createAgent` (dist/index.mjs:7609)
 *     and by the preModelCall/postModelCall gates (:4074, :4201), but NOT by
 *     `createSmartAgent`'s prompt-denial branch (:10316), which is the branch
 *     `createConsoleSdkAgent` actually takes;
 *   · the trailing `{ role: 'assistant', name: 'guardrail' }` message, which
 *     BOTH branches write (:7614, :10319);
 *   · the `${plugin}: ` prefix the host puts on every reason (:6744) with no
 *     way to opt out, which would otherwise show an internal guardrail key to
 *     whoever typed the message.
 *
 * A patch bump that renames any one of those brings the silent-pass back with
 * 4691 other tests still green. These four cases are the alarm.
 */

import { describe, it, expect } from 'vitest';

import { __testables } from '@/lib/services/agents/agentService';

const { guardrailDenial } = __testables;

const REASON = 'This didn’t go through, because it looks like it contains personal information.';
const PLUGIN = 'cognipeer-guardrail:corporate-policy';

describe('guardrailDenial: the ctx marker', () => {
  it('reads the reason and strips the plugin name the host prefixed', () => {
    const denial = guardrailDenial({
      state: {
        ctx: {
          __guardrailBlocked: {
            phase: 'request',
            incident: { reason: `${PLUGIN}: ${REASON}`, deniedBy: PLUGIN },
          },
        },
      },
    });

    expect(denial).toBe(REASON);
    expect(denial).not.toContain('cognipeer-guardrail:');
  });

  it('leaves a reason alone when the prefix is absent', () => {
    const denial = guardrailDenial({
      state: { ctx: { __guardrailBlocked: { incident: { reason: REASON } } } },
    });
    expect(denial).toBe(REASON);
  });

  it('never returns an empty string — a blocked run must carry a message', () => {
    const denial = guardrailDenial({
      state: { ctx: { __guardrailBlocked: { incident: { reason: '   ', deniedBy: PLUGIN } } } },
    });
    expect(denial).toBeTruthy();
    expect(denial).toBe('Blocked by a guardrail policy.');
  });
});

describe('guardrailDenial: the message marker — the createSmartAgent path', () => {
  it('detects a denial that carries NO ctx marker at all', () => {
    // This is the shape `createSmartAgent` actually returns for a
    // `userPromptSubmit` denial (dist/index.mjs:10316): the blocked state has
    // the assistant message and nothing else. Reading only `ctx` here is what
    // let a blocked prompt through as a normal answer.
    const denial = guardrailDenial({
      messages: [
        { role: 'user', content: 'my email is a@corp.com' },
        { role: 'assistant', name: 'guardrail', content: `${PLUGIN}: ${REASON}` },
      ],
    });

    expect(denial).toBe(REASON);
  });

  it('strips the prefix without a deniedBy to key on', () => {
    // The message path carries no `deniedBy`, so the strip falls back to the
    // shape the host always writes. Anchored at the front on purpose.
    const denial = guardrailDenial({
      messages: [{ role: 'assistant', name: 'guardrail', content: `${PLUGIN}: ${REASON}` }],
    });
    expect(denial).toBe(REASON);
  });

  it('does not strip the plugin name where it appears mid-sentence', () => {
    const body = `Blocked. See ${PLUGIN}: the rule that fired.`;
    const denial = guardrailDenial({
      messages: [{ role: 'assistant', name: 'guardrail', content: body }],
    });
    // Only a leading prefix is host noise; anything later is the operator's
    // own message text and must survive verbatim.
    expect(denial).toBe(body);
  });
});

describe('guardrailDenial: what must NOT read as a denial', () => {
  it('an ordinary assistant answer is not a denial', () => {
    expect(
      guardrailDenial({
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'Hello.' },
        ],
      }),
    ).toBeUndefined();
  });

  it('a guardrail message that is not LAST is not a denial', () => {
    // The SDK appends the marker as the final message. A `name: 'guardrail'`
    // message earlier in the transcript is history from a previous turn — the
    // conversation is replayed into `invoke`, so treating it as a denial would
    // block every subsequent turn forever.
    expect(
      guardrailDenial({
        messages: [
          { role: 'assistant', name: 'guardrail', content: REASON },
          { role: 'user', content: 'ok, different question' },
          { role: 'assistant', content: 'Sure.' },
        ],
      }),
    ).toBeUndefined();
  });

  it('a clean result with neither marker is not a denial', () => {
    expect(guardrailDenial({ state: { ctx: {} }, messages: [] })).toBeUndefined();
    expect(guardrailDenial({})).toBeUndefined();
  });
});
