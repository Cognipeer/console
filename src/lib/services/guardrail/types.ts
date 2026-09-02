import type { IGuardrail, GuardrailAction, GuardrailFailMode, GuardrailType } from '@/lib/database';
// TYPE-ONLY, and it has to stay that way. `hooks/contract.ts` imports
// `GuardrailFinding` back from this file, so a value import in either
// direction would be a genuine module cycle over two files that both hold
// module-level const tables. Both sides are erased at compile time, so the
// emitted JS has no edge at all and TypeScript resolves the circular reference
// without complaint.
import type { HookVerdict } from './hooks/contract';

// ── PII Category definitions ─────────────────────────────────────────────

export interface PiiCategoryDefinition {
  id: string;
  label: string;
  description: string;
  defaultEnabled: boolean;
}

export const PII_CATEGORIES: PiiCategoryDefinition[] = [
  {
    id: 'email',
    label: 'Email addresses',
    description: 'Detects RFC-style email addresses.',
    defaultEnabled: true,
  },
  {
    id: 'phone',
    label: 'Phone numbers',
    description: 'Validates international phone number patterns.',
    defaultEnabled: true,
  },
  {
    id: 'creditCard',
    label: 'Credit card numbers',
    description: 'Detects potential credit card number patterns.',
    defaultEnabled: true,
  },
  {
    id: 'iban',
    label: 'IBAN numbers',
    description: 'Detects IBAN formatted bank accounts.',
    defaultEnabled: false,
  },
  {
    id: 'swift',
    label: 'SWIFT/BIC codes',
    description: 'Detects international bank identifier codes.',
    defaultEnabled: false,
  },
  {
    id: 'nationalId',
    label: 'National ID numbers',
    description: 'Detects national ID formats such as SSN-style patterns.',
    defaultEnabled: false,
  },
  {
    id: 'tckn',
    label: 'Turkish National ID (TCKN)',
    description: 'Detects 11-digit Turkish national identity numbers (checksum-validated).',
    defaultEnabled: true,
  },
  {
    id: 'passport',
    label: 'Passport numbers',
    description: 'Detects common passport number formats.',
    defaultEnabled: false,
  },
  {
    id: 'birthDate',
    label: 'Birth dates',
    description: 'Detects common birth date formats.',
    defaultEnabled: false,
  },
  {
    id: 'address',
    label: 'Street addresses',
    description: 'Detects physical address patterns.',
    defaultEnabled: false,
  },
  {
    id: 'ipAddress',
    label: 'IP addresses',
    description: 'Detects IPv4 and IPv6 addresses.',
    defaultEnabled: false,
  },
  {
    id: 'url',
    label: 'URLs',
    description: 'Detects HTTP/HTTPS and www URLs.',
    defaultEnabled: false,
  },
  {
    id: 'socialHandle',
    label: 'Social media handles',
    description: 'Detects @username style social handles.',
    defaultEnabled: false,
  },
  {
    id: 'apiKey',
    label: 'API tokens & secrets',
    description: 'Detects long random tokens that resemble API keys or secrets.',
    defaultEnabled: true,
  },
  {
    id: 'cryptoWallet',
    label: 'Crypto wallet addresses',
    description: 'Detects Bitcoin/Ethereum wallet style addresses.',
    defaultEnabled: false,
  },
];

// ── Moderation Category definitions ──────────────────────────────────────

export interface ModerationCategoryDefinition {
  id: string;
  label: string;
  defaultEnabled: boolean;
}

export const MODERATION_CATEGORIES: ModerationCategoryDefinition[] = [
  { id: 'harassment', label: 'Harassment', defaultEnabled: true },
  { id: 'harassment/threatening', label: 'Harassment (Threatening)', defaultEnabled: true },
  { id: 'hate', label: 'Hate speech', defaultEnabled: true },
  { id: 'hate/threatening', label: 'Hate (Threatening)', defaultEnabled: true },
  { id: 'illicit', label: 'Illicit Activity', defaultEnabled: true },
  { id: 'illicit/violent', label: 'Illicit (Violent)', defaultEnabled: true },
  { id: 'self-harm', label: 'Self Harm', defaultEnabled: true },
  { id: 'self-harm/intent', label: 'Self Harm (Intent)', defaultEnabled: true },
  { id: 'self-harm/instructions', label: 'Self Harm (Instructions)', defaultEnabled: true },
  { id: 'sexual', label: 'Sexual Content', defaultEnabled: true },
  { id: 'sexual/minors', label: 'Sexual Content (Minors)', defaultEnabled: true },
  { id: 'violence', label: 'Violence', defaultEnabled: true },
  { id: 'violence/graphic', label: 'Graphic Violence', defaultEnabled: true },
  { id: 'terrorism', label: 'Terrorism & Extremism', defaultEnabled: true },
  { id: 'weapons', label: 'Weapons & Weapon Crafting', defaultEnabled: true },
  { id: 'fraud', label: 'Fraud & Scams', defaultEnabled: true },
  { id: 'drugs', label: 'Illegal Drugs', defaultEnabled: true },
  { id: 'cybercrime', label: 'Cybercrime & Malware', defaultEnabled: true },
  { id: 'child_safety', label: 'Child Safety & Grooming', defaultEnabled: true },
  { id: 'misinformation', label: 'Medical/Health Misinformation', defaultEnabled: true },
  { id: 'privacy_violation', label: 'Privacy Violations & Doxxing', defaultEnabled: true },
  { id: 'impersonation', label: 'Identity Impersonation', defaultEnabled: true },
  { id: 'manipulation', label: 'Psychological Manipulation', defaultEnabled: true },
  { id: 'radicalization', label: 'Radicalization Content', defaultEnabled: true },
  { id: 'financial_advice', label: 'Unauthorized Financial Advice', defaultEnabled: false },
  { id: 'animal_cruelty', label: 'Animal Abuse & Cruelty', defaultEnabled: true },
];

// ── Prompt Shield issue definitions ──────────────────────────────────────

export interface PromptShieldIssueDefinition {
  id: string;
  label: string;
}

export const PROMPT_SHIELD_ISSUES: PromptShieldIssueDefinition[] = [
  { id: 'prompt_injection', label: 'Prompt injection attempt' },
  { id: 'system_override', label: 'Attempt to override instructions' },
  { id: 'role_play', label: 'Role-playing to bypass policies' },
  { id: 'social_engineering', label: 'Social engineering' },
  { id: 'data_exfiltration', label: 'Attempt to exfiltrate secrets' },
  { id: 'jailbreak_persona', label: 'DAN or jailbreak persona' },
  { id: 'hypothetical_scenario', label: 'Hypothetical scenario attack' },
  { id: 'payload_splitting', label: 'Payload splitting/smuggling' },
  { id: 'context_poisoning', label: 'Context poisoning attempt' },
  { id: 'privilege_escalation', label: 'Privilege escalation attempt' },
  { id: 'policy_circumvention', label: 'Policy circumvention technique' },
  { id: 'recursive_prompting', label: 'Recursive or meta-prompting' },
  { id: 'encoding_obfuscation', label: 'Encoding/obfuscation attack' },
  { id: 'multi_language_evasion', label: 'Multi-language evasion' },
  { id: 'other', label: 'Other jailbreak technique' },
];

// ── Word filter list definitions ──────────────────────────────────────────

export interface WordFilterListDefinition {
  id: string;
  label: string;
  description: string;
  defaultEnabled: boolean;
}

export const WORD_FILTER_BUILTIN_LISTS: WordFilterListDefinition[] = [
  {
    id: 'profanity-en',
    label: 'Profanity (English)',
    description: 'Common English profanity and slurs, with leetspeak/obfuscation folding.',
    defaultEnabled: true,
  },
  {
    id: 'profanity-tr',
    label: 'Profanity (Turkish)',
    description: 'Common Turkish profanity and slurs, with diacritic and obfuscation folding.',
    defaultEnabled: true,
  },
];

// ── Evaluation result types ───────────────────────────────────────────────

export interface GuardrailFinding {
  type: 'pii' | 'word_filter' | 'moderation' | 'prompt_shield' | 'custom';
  category: string;
  severity: 'low' | 'medium' | 'high';
  message: string;
  action: GuardrailAction;
  block: boolean;
  value?: string;
}

/**
 * Coerces an arbitrary LLM-supplied severity to a valid one, defaulting to
 * 'high' (fail safe) when the value is missing or unrecognized.
 */
export function normalizeSeverity(value: unknown): GuardrailFinding['severity'] {
  return value === 'low' || value === 'medium' || value === 'high' ? value : 'high';
}

/**
 * Single source of truth for the "a policy could not run" finding. Fail-closed
 * turns the failure into a real (potentially blocking) violation; fail-open
 * surfaces it as a non-blocking flag so the outage is visible without changing
 * the verdict. Used by both the LLM evaluators and the missing-model guard.
 */
export function buildEvaluationErrorFinding(params: {
  type: GuardrailFinding['type'];
  failMode: GuardrailFailMode | undefined;
  action: GuardrailAction;
  message: string;
}): GuardrailFinding {
  const closed = params.failMode === 'closed';
  return {
    type: params.type,
    category: 'evaluation_error',
    severity: closed ? 'high' : 'low',
    message: params.message,
    action: closed ? params.action : 'flag',
    block: closed && params.action === 'block',
  };
}

export interface GuardrailEvaluationResult {
  passed: boolean;
  guardrailKey: string;
  guardrailName: string;
  action: GuardrailAction;
  findings: GuardrailFinding[];
  /**
   * True when the guardrail is disabled: no policies ran and `passed` is a
   * vacuous true. Runtime enforcement correctly skips disabled guardrails,
   * but the test panel must surface this so a disabled guardrail doesn't read
   * as "content is safe".
   */
  disabled?: boolean;
  /**
   * THE ENFORCEMENT ANSWER: "should this caller stop the request", already
   * neutralised by the guardrail's Mode. A guardrail in Monitor reports
   * `blocked: false` while its findings still carry `block: true` — that is the
   * whole point of Monitor, and it is why `passed` cannot be used here.
   *
   * `passed` answers a DIFFERENT question ("was there a blocking finding") and
   * keeps its legacy meaning for every reader that wants the counterfactual.
   * Anything that throws, denies, or refuses reads THIS field.
   */
  blocked: boolean;
  /**
   * Present when any finding carries the `redact` action: the evaluated text
   * with those findings' values masked. Callers should substitute this for the
   * original content and continue.
   */
  redactedText?: string;
  /**
   * The full hook verdict behind this result — spans, mutations, risk score,
   * response-header codes, the rendered block message and `wouldBeDecision`.
   *
   * ADDITIVE and always optional: every field above keeps its exact meaning, so
   * a caller that has never heard of hooks reads the same six fields it reads
   * today. This exists so a caller that DOES want the richer answer (the test
   * panel, the red-team runner, the gateway's response headers) does not have
   * to bypass the facade and call `runHook` itself — which is how the two
   * paths would start disagreeing about what a guardrail decided.
   */
  verdict?: HookVerdict;
}

// ── Service input/output types ────────────────────────────────────────────
//
// The three hook-plane fields below are declared with indexed access into
// `IGuardrail` rather than by naming `GuardrailHooksConfig` / `GuardrailMode`
// directly. That is the idiom this file already uses for `target`, `failMode`
// and `policy`, and it matters more here than there: `hooks` is a large
// structural blob that is written through these inputs and read back through
// the view, so a second description of it would be free to drift and would
// break assignment in exactly one direction — the direction nobody tests.
//
// All three are OPTIONAL everywhere. A legacy record carries none of them, and
// a create/update that omits them must keep behaving exactly as it does today.

export interface CreateGuardrailInput {
  name: string;
  description?: string;
  type: GuardrailType;
  target?: IGuardrail['target'];
  action: GuardrailAction;
  enabled?: boolean;
  failMode?: IGuardrail['failMode'];
  modelKey?: string;
  policy?: IGuardrail['policy'];
  customPrompt?: string;
  projectId?: string;
  /** The hook-plane config. Absent = the record is created legacy-shaped and
   *  is lifted on first read. */
  hooks?: IGuardrail['hooks'];
  hooksVersion?: IGuardrail['hooksVersion'];
  /** enforce | monitor | disabled. Absent behaves as 'enforce'. */
  mode?: IGuardrail['mode'];
}

export interface UpdateGuardrailInput {
  name?: string;
  description?: string;
  action?: GuardrailAction;
  enabled?: boolean;
  failMode?: IGuardrail['failMode'];
  modelKey?: string;
  policy?: IGuardrail['policy'];
  customPrompt?: string;
  hooks?: IGuardrail['hooks'];
  hooksVersion?: IGuardrail['hooksVersion'];
  mode?: IGuardrail['mode'];
}

export interface GuardrailView {
  id: string;
  tenantId: string;
  projectId?: string;
  key: string;
  name: string;
  description?: string;
  type: GuardrailType;
  target: IGuardrail['target'];
  action: GuardrailAction;
  enabled: boolean;
  failMode?: IGuardrail['failMode'];
  modelKey?: string;
  policy?: IGuardrail['policy'];
  customPrompt?: string;
  hooks?: IGuardrail['hooks'];
  hooksVersion?: IGuardrail['hooksVersion'];
  mode?: IGuardrail['mode'];
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

export interface EvaluateGuardrailInput {
  guardrailKey: string;
  text: string;
  tenantDbName: string;
  tenantId: string;
  projectId?: string;
}
