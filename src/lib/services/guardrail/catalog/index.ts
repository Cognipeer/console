/**
 * The guardrail policy CATALOG — one description of every policy family, in a
 * form the console can render without knowing what any of them are.
 *
 * ── WHAT THIS IS FOR ────────────────────────────────────────────────────────
 * Two screens read it. The catalog (the "add a policy" picker) shows a card per
 * family: `label`, `description`, `icon`, `color`, its group and its keywords.
 * The editor renders a form for the chosen family by walking `spec.fields` and
 * switching on `kind` — never on `family`.
 *
 * That is the whole contract: adding a tenth family is ONE entry in
 * `./families`, and no UI file changes. `guardrail-catalog.test.ts` fails if a
 * family reaches `POLICY_FAMILIES` without one.
 *
 * ── THE TWO HALVES ──────────────────────────────────────────────────────────
 * `./fields`   the schema LANGUAGE: fourteen control kinds, each with a label,
 *              help text, a required flag and a validator, plus the
 *              `validatePolicyField(s)` pass a form runs.
 * `./families` the DATA: one `PolicyFamilySpec` per family. `validHooks`,
 *              `streamSafe` and `blockReason` are read from the contract rather
 *              than restated there, so the catalog cannot disagree with the
 *              engine about where a family may run.
 *
 * ── WHERE IT MAY BE IMPORTED ────────────────────────────────────────────────
 * Anywhere. It reaches `hooks/contract`, `hooks/messages` and
 * `services/guardrail/constants` and nothing else — no `@/lib/database`, no
 * `hooks/legacy`, no `hooks/engine`, no React. Server, client bundle and a
 * plain unit test all import the same module, which is the only way the picker
 * and the save-time validator can be talking about the same thing.
 *
 * ── WHAT IT IS NOT ──────────────────────────────────────────────────────────
 * Not the save-time authority. `validateGuardrailHooks` (hooks/legacy.ts) is,
 * and it runs behind the database barrel where a client cannot reach it. Every
 * rule here is one the server also applies: a client validator that is stricter
 * blocks a save the server would accept, and a looser one promises a save the
 * server will refuse.
 */

export * from './fields';
export * from './families';
