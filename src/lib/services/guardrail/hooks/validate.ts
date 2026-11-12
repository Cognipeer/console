/**
 * Save-time validation of a guardrail `hooks` config. The one authority on
 * whether a config may be stored: the dashboard and the catalog carry hint-level
 * subsets of these rules, and this function is what refuses the save.
 *
 * Pure and database-free, so the client bundle's neighbours and unit tests can
 * import it without constructing providers.
 */

import {
  POLICY_VALID_HOOKS,
  BLOCK_MESSAGE_VARS,
  DEFAULT_STREAM_SETTINGS,
  GUARDRAIL_CONTRACT_VERSION,
  REGEX_MAX_MATCH_CHARS,
  STREAM_ELIGIBLE_FAMILIES,
  policyMaxMatchChars,
} from './contract';
import type { GuardrailHooksConfig } from './contract';

// ── Authoring-time validation ─────────────────────────────────────────────

/**
 * `GuardrailPolicy.message` — the per-policy block message.
 *
 * ONE rule: every `{{variable}}` must be in the CLOSED set. The interpolator
 * leaves an unrecognised one verbatim on purpose, so an operator who hoped for
 * `{{value}}` sees braces in the output rather than a hole; that is the right
 * runtime behaviour for a row already on disk, and the wrong thing to let
 * someone save on purpose. Rejecting it here costs nothing — the field is new,
 * so no stored row can carry one — and turns a message that renders as
 * `{{userName}}` in front of a customer into a 400 at save time.
 *
 * Blank is NOT an error: `selectBlockMessageTemplate` skips a whitespace layer,
 * so clearing the box means "go back to the inherited wording", which is the
 * behaviour the editor's Reset control depends on.
 *
 * The closed set exists because a template is tenant-editable and its output is
 * shown to end users: an interpolatable matched value would turn the guardrail
 * into an exfiltration channel for the data it exists to protect.
 */
function blockMessageErrors(message: unknown, label: string): string[] {
  if (message === undefined || message === null) return [];
  if (typeof message !== 'string') {
    return [`Policy "${label}" has a block message that is not text`];
  }
  const unknown = new Set<string>();
  // Constructed per call: a module-level /g regex carries `lastIndex` state.
  const pattern = /\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/g;
  for (const match of message.matchAll(pattern)) {
    const name = match[1];
    if (name && !(BLOCK_MESSAGE_VARS as readonly string[]).includes(name)) unknown.add(name);
  }
  if (unknown.size === 0) return [];
  return [
    `Policy "${label}" has a block message using ${[...unknown]
      .map((name) => `{{${name}}}`)
      .join(', ')}, which ${unknown.size === 1 ? 'is not a' : 'are not'} available variable${
      unknown.size === 1 ? '' : 's'
    }. Available: ${BLOCK_MESSAGE_VARS.map((name) => `{{${name}}}`).join(', ')}`,
  ];
}

/**
 * Returns every problem found; an empty list means the config may be stored.
 *
 * It also MUTATES `hooks.stream.holdBackChars` upward when a bound streaming
 * policy needs a bigger window. That is deliberate rather than a returned copy:
 * the hold-back is the entire streaming guarantee (no match can begin before
 * the write frontier and end after it if the withheld tail is at least as long
 * as the longest possible match), and a normalisation the caller has to
 * remember to apply is one a caller will eventually forget, leaving a stream
 * that reports enforcement it cannot deliver.
 */
export function validateGuardrailHooks(hooks: GuardrailHooksConfig): string[] {
  const errors: string[] = [];

  if (hooks.contractVersion !== GUARDRAIL_CONTRACT_VERSION) {
    errors.push(
      `hooks.contractVersion must be ${GUARDRAIL_CONTRACT_VERSION} (got ${String(hooks.contractVersion)})`,
    );
  }

  const policies = Array.isArray(hooks.policies) ? hooks.policies : [];
  const bindings = hooks.bindings ?? {};
  const seenIds = new Set<string>();
  let requiredHoldBack = 0;

  for (const policy of policies) {
    const label = policy.id || `<unnamed ${policy.family}>`;

    if (!policy.id) {
      errors.push(`Every policy needs an id (${policy.family})`);
    } else if (seenIds.has(policy.id)) {
      // Ids appear on every finding and in the evaluation log; two policies
      // sharing one makes a finding untraceable to the rule that raised it.
      errors.push(`Duplicate policy id "${policy.id}"`);
    }
    if (policy.id) seenIds.add(policy.id);

    const validHooks = POLICY_VALID_HOOKS[policy.family];
    if (!validHooks) {
      errors.push(`Policy "${label}" has unknown family "${String(policy.family)}"`);
      continue;
    }

    if (!policy.hooks?.length) {
      errors.push(`Policy "${label}" is bound to no hook, so it can never run`);
    }
    for (const hook of policy.hooks ?? []) {
      if (!validHooks.includes(hook)) {
        errors.push(`Policy "${label}" (${policy.family}) cannot run on hook "${hook}"`);
      } else if (policy.enabled && bindings[hook]?.enabled !== true) {
        // An enabled policy whose hook is not bound is the silent no-op this
        // whole design exists to prevent: the UI shows it on, nothing runs it.
        errors.push(
          `Policy "${label}" is bound to "${hook}", which has no enabled binding on this guardrail`,
        );
      }
    }

    // Checked for a DISABLED policy too, unlike everything below it. The rules
    // below are "this policy cannot do its job"; this one is "this string is
    // wrong", and a wrong string is wrong whether or not it runs today. It also
    // means an operator cannot park a broken message and be surprised by it the
    // day they switch the policy back on.
    for (const error of blockMessageErrors(policy.message, label)) errors.push(error);

    if (!policy.enabled) continue;

    switch (policy.family) {
      case 'pii':
        // OWNER RULE, enforced here and nowhere else: an enabled PII policy
        // references a policy. There is no inline category list on new
        // configs — the PII service owns categories, languages, custom
        // patterns, checksum validators and mask strategies, and duplicating
        // any of that is how the two engines drift apart.
        if (!policy.piiPolicyKey?.trim()) {
          errors.push(`Policy "${label}" is a PII policy and needs a piiPolicyKey`);
        }
        break;
      case 'moderation':
      case 'prompt_shield':
      case 'custom':
        // Mirrors plugins/guardrails.ts:97-116: an LLM-backed policy with no
        // model reads as "guardrail active" while nothing runs.
        if (!policy.modelKey?.trim()) {
          errors.push(
            `Policy "${label}" (${policy.family}) is enabled but has no model to evaluate it`,
          );
        }
        if (policy.family === 'custom' && !policy.prompt?.trim()) {
          errors.push(`Policy "${label}" is a custom policy and needs a prompt`);
        }
        break;
      case 'regex':
        if (!policy.rules?.length) {
          errors.push(`Policy "${label}" is a regex policy with no rules`);
        }
        for (const rule of policy.rules ?? []) {
          // An uncompilable pattern is the worst kind of dead rule: the
          // matcher swallows the error and the rule simply never fires
          // (wordFilter.ts:253-257 does exactly that today).
          try {
            new RegExp(rule.pattern, rule.flags ?? '');
          } catch {
            errors.push(`Regex rule "${rule.id || rule.label}" is not a valid pattern`);
          }
          const declared = Number(rule.maxMatchChars);
          if (!Number.isFinite(declared) || declared <= 0) {
            errors.push(
              `Regex rule "${rule.id || rule.label}" must declare a positive maxMatchChars`,
            );
          } else if (declared > REGEX_MAX_MATCH_CHARS) {
            errors.push(
              `Regex rule "${rule.id || rule.label}" declares maxMatchChars ${declared}, above the ${REGEX_MAX_MATCH_CHARS} limit`,
            );
          }
        }
        break;
      case 'webhook':
        // https only: the verdict decides whether a request is blocked, so a
        // plaintext hop is an enforcement bypass, not just a privacy leak.
        if (!/^https:\/\//i.test(policy.url ?? '')) {
          errors.push(`Policy "${label}" must use an https:// webhook url`);
        }
        break;
      case 'cognipeer_guardrail_moderation':
      case 'cognipeer_guardrail_prompt_shield':
        // No reference field to validate: the model ships inside the
        // `@cognipeer/guardrail` npm package, so there is no modelKey or
        // policyKey an enabled policy could be missing. An explicit no-op arm
        // rather than falling into `default` — this switch has NO compile
        // error for a family with a real required field that lands in
        // `default` by omission (see catalog/families.ts's own "ADDING A
        // TENTH FAMILY" checklist).
        break;
      default:
        break;
    }

    if (policy.hooks?.includes('output.stream.delta')) {
      if (!STREAM_ELIGIBLE_FAMILIES.has(policy.family)) {
        errors.push(
          `Policy "${label}" (${policy.family}) cannot run on a stream: its matches have no bounded length in raw characters`,
        );
      } else {
        const max = policyMaxMatchChars(policy);
        if (max <= 0) {
          errors.push(
            `Policy "${label}" declares no bounded match length, so no hold-back window can make it correct on a stream`,
          );
        } else {
          requiredHoldBack = Math.max(requiredHoldBack, max);
        }
      }
    }
  }

  if (requiredHoldBack > 0) {
    // A policy bound to the delta hook with no stream block at all is a config
    // that asked for streaming enforcement without saying so; the binding is
    // the stronger statement of intent, so the block is created enabled.
    if (!hooks.stream) hooks.stream = { enabled: true };
    const configured = hooks.stream.holdBackChars ?? DEFAULT_STREAM_SETTINGS.holdBackChars;
    if (configured < requiredHoldBack) hooks.stream.holdBackChars = requiredHoldBack;
  }

  return errors;
}
