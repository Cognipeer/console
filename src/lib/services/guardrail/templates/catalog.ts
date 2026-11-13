/**
 * GUARDRAIL TEMPLATES: READY-MADE HOOK CONFIGURATIONS.
 *
 * A guardrail is eleven policy families times six hooks, each policy with its
 * own action, detector and schedule. That is the right model for an operator who
 * knows what they want and the wrong first screen for one who does not. A
 * template is a finished `GuardrailHooksConfig` for one recognisable job
 * ("KVKK personal data", "MCP server protection"), created through the same
 * write path as a hand-authored guardrail and then edited like any other.
 *
 * WHAT A TEMPLATE IS NOT:
 *   · not a live link. Applying one copies its config into a new guardrail;
 *     editing the template later changes nothing that was already created. The
 *     record carries `metadata.template {key, version}` so a later catalog
 *     version can be offered as an update, and so the list can say "used by N".
 *   · not a model choice. Every template in this catalog runs without a model
 *     (deterministic families and the bundled CPU classifiers), so applying one
 *     spends no credits and asks no question. Templates that need an LLM judge
 *     belong in a later wave, with a model picker in the apply flow. The
 *     `moderation` lexicon and `prompt_shield` pattern detectors are left out
 *     on purpose: the evaluator still asks those families for a model, so
 *     without one they only report an evaluation error.
 *
 * HOOK CHOICE. The model gateway fires `input.pre`, `output.pre` and
 * `output.stream.delta`; agents fire those plus `prompt.pre` and the tool hooks.
 * Content templates therefore bind `input.pre`/`output.pre` so the same template
 * works on a model and on an agent. `prompt.pre` (once per agent turn) would be
 * cheaper in an agent loop but would do nothing on a model.
 *
 * MODE IS NOT PART OF A TEMPLATE. Every guardrail created from one starts in
 * `monitor` (see the apply route): findings are recorded, nothing is blocked,
 * and the operator flips one switch once the evaluation log looks right. The
 * policies themselves use the `block` schedule, which is what they will do once
 * the guardrail is enforcing.
 */

import type {
  GuardrailHookBinding,
  GuardrailHookId,
  GuardrailHooksConfig,
  GuardrailPolicy,
  GuardrailRegexRule,
  PiiLanguage,
} from '@/lib/database/provider/types.domain';
import { GUARDRAIL_CONTRACT_VERSION } from '../hooks/contract';
import { defaultToolGuardrailHooks } from '../hooks/engine';

/** Bumped whenever a template is added, removed or changes version. */
export const GUARDRAIL_TEMPLATE_CATALOG_VERSION = 1;

export type GuardrailTemplateCategory = 'baseline' | 'data' | 'security' | 'agents' | 'content';

/** Where a guardrail made from the template is meant to be attached. */
export type GuardrailTemplateTarget = 'model' | 'agent' | 'mcp';

export const GUARDRAIL_TEMPLATE_CATEGORIES: ReadonlyArray<{
  id: GuardrailTemplateCategory;
  label: string;
}> = [
  { id: 'baseline', label: 'Start here' },
  { id: 'data', label: 'Data protection' },
  { id: 'security', label: 'AI security' },
  { id: 'agents', label: 'Agents and tools' },
  { id: 'content', label: 'Content' },
];

// ── PII presets ─────────────────────────────────────────────────────────────

/**
 * A PII policy a template needs. The `pii` family scans THROUGH a tenant PII
 * policy (`piiPolicyKey`) and has no inline category list, so a template that
 * protects personal data has to bring one. The apply flow reuses a policy it
 * created earlier for the same preset in the same project, and creates it
 * otherwise; the operator can then edit it on the PII page like any other.
 *
 * Pattern mode only: names, organisations and places need the dictionary or
 * NER pass, which is a cost and accuracy decision for the operator, not for a
 * template.
 */
export interface GuardrailTemplatePiiPreset {
  id: string;
  name: string;
  description: string;
  /** PII catalog ids (`services/pii/categories.ts`) to switch ON; all others are off. */
  categories: readonly string[];
  languages: readonly PiiLanguage[];
}

export const GUARDRAIL_TEMPLATE_PII_PRESETS: Readonly<Record<string, GuardrailTemplatePiiPreset>> = {
  common: {
    id: 'common',
    name: 'Common personal data (template)',
    description:
      'Created by a guardrail template: e-mail, phone, payment card, IBAN and the Turkish national id, phone and IBAN.',
    categories: ['email', 'phone', 'creditCard', 'iban', 'tc_kimlik', 'tr_phone', 'tr_iban'],
    languages: [],
  },
  kvkk: {
    id: 'kvkk',
    name: 'KVKK personal data (template)',
    description:
      'Created by the KVKK guardrail template: Turkish national id, tax number, phone, IBAN, plate, passport and address, plus e-mail, payment card and date of birth.',
    categories: [
      'tc_kimlik',
      'tr_vkn',
      'tr_phone',
      'tr_iban',
      'tr_plaka',
      'tr_passport',
      'address_tr',
      'email',
      'phone',
      'iban',
      'creditCard',
      'birthDate',
    ],
    languages: [],
  },
  gdpr: {
    id: 'gdpr',
    name: 'GDPR personal data (template)',
    description:
      'Created by the GDPR guardrail template: e-mail, phone, IBAN and SWIFT, IP address, postal address, passport, payment card and date of birth.',
    categories: [
      'email',
      'phone',
      'de_phone',
      'iban',
      'swift',
      'ipAddress',
      'address_en',
      'passport_en',
      'creditCard',
      'birthDate',
    ],
    languages: [],
  },
  pci: {
    id: 'pci',
    name: 'Payment card data (template)',
    description: 'Created by the payment card guardrail template: card numbers that pass the Luhn check.',
    categories: ['creditCard'],
    languages: [],
  },
};

// ── Definitions ─────────────────────────────────────────────────────────────

export interface GuardrailTemplateBuildContext {
  /** The PII policy the apply flow resolved for `piiPreset`. Required when the template declares one. */
  piiPolicyKey?: string;
}

export interface GuardrailTemplateDefinition {
  /** Stable, kebab-case. Stored on every guardrail created from it. */
  key: string;
  /** Bumped when `build` changes what it produces. */
  version: number;
  category: GuardrailTemplateCategory;
  name: string;
  description: string;
  /** Shown first, and the set a new project is pointed at. */
  recommended?: boolean;
  attachTo: readonly GuardrailTemplateTarget[];
  /** The PII preset this template scans through, if any. */
  piiPreset?: keyof typeof GUARDRAIL_TEMPLATE_PII_PRESETS;
  build: (ctx: GuardrailTemplateBuildContext) => GuardrailHooksConfig;
}

const BLOCK = { timing: 'sync', onFail: 'block' } as const;
const STREAM: GuardrailHookId = 'output.stream.delta';

function bindings(hooks: readonly GuardrailHookId[]): Partial<Record<GuardrailHookId, GuardrailHookBinding>> {
  return Object.fromEntries(hooks.map((hook) => [hook, { enabled: true, schedule: BLOCK }]));
}

/** Every hook any enabled policy names, so a template can never leave a policy unbound. */
function hooksOf(policies: readonly GuardrailPolicy[]): GuardrailHookId[] {
  return [...new Set(policies.filter((p) => p.enabled).flatMap((p) => p.hooks))];
}

function config(
  policies: GuardrailPolicy[],
  options: { stream?: boolean; shortCircuit?: boolean } = {},
): GuardrailHooksConfig {
  return {
    contractVersion: GUARDRAIL_CONTRACT_VERSION,
    policies,
    bindings: bindings(hooksOf(policies)),
    stream: { enabled: options.stream === true },
    shortCircuit: options.shortCircuit ?? true,
  };
}

function requirePiiKey(ctx: GuardrailTemplateBuildContext, template: string): string {
  if (!ctx.piiPolicyKey) {
    throw new Error(`Template "${template}" needs a PII policy key to build`);
  }
  return ctx.piiPolicyKey;
}

// ── Building blocks ─────────────────────────────────────────────────────────

function secrets(id: string, label: string, hooks: GuardrailHookId[]): GuardrailPolicy {
  return {
    id,
    family: 'secrets',
    enabled: true,
    hooks,
    schedule: BLOCK,
    action: 'redact',
    label,
    known: true,
    // The generic 32-character heuristic fires on ordinary base64 and hashes;
    // a template has to be quiet enough that nobody switches it off.
    genericHighEntropy: false,
  };
}

function piiPolicy(
  id: string,
  label: string,
  piiPolicyKey: string,
  hooks: GuardrailHookId[],
  action: 'redact' | 'block' | 'flag',
): GuardrailPolicy {
  return {
    id,
    family: 'pii',
    enabled: true,
    hooks,
    schedule: BLOCK,
    action,
    label,
    piiPolicyKey,
    // Mask (keep the last digits) rather than a bare [REDACTED] tag, so a model
    // can still tell the user "the card ending 4242" without seeing the number.
    ...(action === 'redact' ? { actionOverride: 'mask' as const } : {}),
    detectObfuscated: true,
  };
}

function cognipeerShield(
  id: string,
  label: string,
  hooks: GuardrailHookId[],
  profile: 'strict' | 'balanced' | 'sensitive' = 'strict',
): GuardrailPolicy {
  return {
    id,
    family: 'cognipeer_guardrail_prompt_shield',
    enabled: true,
    hooks,
    schedule: BLOCK,
    action: 'block',
    label,
    categories: { prompt_injection: true, jailbreak: true, data_exfiltration: true },
    profile,
  };
}

function cognipeerModeration(
  id: string,
  label: string,
  hooks: GuardrailHookId[],
  options: {
    categories?: readonly string[];
    profile?: 'strict' | 'balanced' | 'sensitive';
    action?: 'block' | 'flag';
  } = {},
): GuardrailPolicy {
  const all = ['insult', 'hate', 'sexual', 'violence', 'self_harm', 'illegal'];
  const on = new Set(options.categories ?? all);
  return {
    id,
    family: 'cognipeer_guardrail_moderation',
    enabled: true,
    hooks,
    schedule: BLOCK,
    action: options.action ?? 'block',
    label,
    categories: Object.fromEntries(all.map((category) => [category, on.has(category)])),
    profile: options.profile ?? 'strict',
  };
}

function profanity(id: string, label: string, hooks: GuardrailHookId[], action: 'flag' | 'redact' | 'block'): GuardrailPolicy {
  return {
    id,
    family: 'word_filter',
    enabled: true,
    hooks,
    schedule: BLOCK,
    action,
    label,
    builtinLists: { 'profanity-tr': true, 'profanity-en': true },
    customListKeys: [],
    words: [],
    regexes: [],
  };
}

/** RFC 1918 IPv4 addresses and host names under the usual private suffixes. */
const INTERNAL_ADDRESS_RULES: GuardrailRegexRule[] = [
  {
    id: 'private-ipv4',
    label: 'Private IPv4 address',
    pattern:
      '\\b(?:10\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}|192\\.168\\.\\d{1,3}\\.\\d{1,3}|172\\.(?:1[6-9]|2\\d|3[01])\\.\\d{1,3}\\.\\d{1,3})\\b',
    category: 'internal_address',
    severity: 'medium',
    action: 'redact',
    maxMatchChars: 15,
  },
  {
    id: 'internal-host',
    label: 'Internal host name',
    pattern: '\\b[a-z0-9-]{1,63}(?:\\.[a-z0-9-]{1,63}){0,5}\\.(?:internal|intranet|corp|lan|local)\\b',
    flags: 'i',
    category: 'internal_address',
    severity: 'medium',
    action: 'redact',
    maxMatchChars: 400,
  },
];

/** A card security code or expiry date, only when its label is next to it. */
const CARD_CONTEXT_RULES: GuardrailRegexRule[] = [
  {
    id: 'card-security-code',
    label: 'Card security code',
    pattern: '\\b(?:cvv2?|cvc2?|cid|g\\u00fcvenlik kodu)\\s*[:=]?\\s*\\d{3,4}\\b',
    flags: 'iu',
    category: 'card_security_code',
    severity: 'high',
    action: 'redact',
    maxMatchChars: 40,
  },
  {
    id: 'card-expiry',
    label: 'Card expiry date',
    pattern:
      '\\b(?:exp(?:iry|iration)?(?: date)?|son kullanma(?: tarihi)?|skt)\\s*[:=]?\\s*(?:0[1-9]|1[0-2])\\s*/\\s*(?:\\d{4}|\\d{2})\\b',
    flags: 'i',
    category: 'card_expiry',
    severity: 'medium',
    action: 'redact',
    maxMatchChars: 60,
  },
];

// ── The catalog ─────────────────────────────────────────────────────────────

export const GUARDRAIL_TEMPLATES: readonly GuardrailTemplateDefinition[] = [
  // ── Start here ──
  {
    key: 'baseline',
    version: 1,
    category: 'baseline',
    name: 'Baseline protection',
    description:
      'The four things almost every assistant needs: credentials are masked both ways, prompt injection and harmful content are stopped, and personal data is masked in the answer. No model, no credits.',
    recommended: true,
    attachTo: ['model', 'agent'],
    piiPreset: 'common',
    build: (ctx) =>
      config([
        secrets('credentials', 'Credentials', ['input.pre', 'output.pre']),
        cognipeerShield('prompt-injection', 'Prompt injection', ['input.pre']),
        cognipeerModeration('harmful-content', 'Harmful content', ['input.pre', 'output.pre']),
        piiPolicy('personal-data', 'Personal data in the answer', requirePiiKey(ctx, 'baseline'), ['output.pre'], 'redact'),
      ]),
  },
  {
    key: 'credential-leak',
    version: 1,
    category: 'baseline',
    name: 'Credential leak prevention',
    description:
      'API keys, tokens and internal addresses never leave in either direction, and the answer is checked while it streams rather than after it reached the browser.',
    attachTo: ['model', 'agent'],
    build: () =>
      config(
        [
          secrets('credentials', 'Credentials', ['input.pre', 'output.pre', STREAM]),
          {
            id: 'internal-addresses',
            family: 'regex',
            enabled: true,
            hooks: ['output.pre', STREAM],
            schedule: BLOCK,
            action: 'redact',
            label: 'Internal addresses',
            rules: INTERNAL_ADDRESS_RULES,
          },
        ],
        { stream: true },
      ),
  },
  {
    key: 'profanity',
    version: 1,
    category: 'content',
    name: 'Profanity and insults (TR + EN)',
    description:
      'Turkish and English profanity lists that see through leetspeak and spacing, plus the offline classifier for insults and hate the lists miss. Flags what users write, masks what the assistant says.',
    attachTo: ['model', 'agent'],
    build: () =>
      config([
        profanity('profanity-in', 'Profanity from the user', ['input.pre'], 'flag'),
        profanity('profanity-out', 'Profanity in the answer', ['output.pre'], 'redact'),
        cognipeerModeration('insults', 'Insults and hate', ['input.pre', 'output.pre'], {
          categories: ['insult', 'hate'],
          action: 'flag',
        }),
      ]),
  },

  // ── Data protection ──
  {
    key: 'kvkk',
    version: 1,
    category: 'data',
    name: 'KVKK personal data (Türkiye)',
    description:
      'Turkish national id, tax number, phone, IBAN, plate, passport and address are masked before they reach the model and in the answer. A streamed answer is checked once it ends; personal data cannot be masked mid-stream, so use the non-streaming API where masking must hold.',
    attachTo: ['model', 'agent'],
    piiPreset: 'kvkk',
    build: (ctx) =>
      config([
        piiPolicy('kvkk-personal-data', 'KVKK personal data', requirePiiKey(ctx, 'kvkk'), ['input.pre', 'output.pre'], 'redact'),
      ]),
  },
  {
    key: 'gdpr',
    version: 1,
    category: 'data',
    name: 'GDPR personal data',
    description:
      'E-mail, phone, IBAN, IP address, postal address, passport and payment card are masked before they reach the model and in the answer. A streamed answer is checked once it ends; personal data cannot be masked mid-stream, so use the non-streaming API where masking must hold.',
    attachTo: ['model', 'agent'],
    piiPreset: 'gdpr',
    build: (ctx) =>
      config([
        piiPolicy('gdpr-personal-data', 'GDPR personal data', requirePiiKey(ctx, 'gdpr'), ['input.pre', 'output.pre'], 'redact'),
      ]),
  },
  {
    key: 'payment-card',
    version: 1,
    category: 'data',
    name: 'Payment card data (PCI DSS)',
    description:
      'A message that contains a card number is stopped before it reaches the model or its logs. Card numbers, security codes and expiry dates are masked in the answer; on a stream, security codes and expiry dates are masked as they arrive and card numbers are checked once it ends.',
    attachTo: ['model', 'agent'],
    piiPreset: 'pci',
    build: (ctx) => {
      const key = requirePiiKey(ctx, 'payment-card');
      return config(
        [
          piiPolicy('card-number-in', 'Card number from the user', key, ['input.pre'], 'block'),
          // PII has no bounded match length, so it cannot hold back a stream; the
          // labelled card details below can.
          piiPolicy('card-number-out', 'Card number in the answer', key, ['output.pre'], 'redact'),
          {
            id: 'card-details',
            family: 'regex',
            enabled: true,
            hooks: ['input.pre', 'output.pre', STREAM],
            schedule: BLOCK,
            action: 'redact',
            label: 'Security code and expiry',
            rules: CARD_CONTEXT_RULES,
          },
        ],
        { stream: true },
      );
    },
  },

  // ── AI security ──
  {
    key: 'prompt-injection',
    version: 1,
    category: 'security',
    name: 'Prompt injection shield',
    description:
      'Jailbreaks, instruction overrides and exfiltration attempts in what the user sends are stopped by the offline injection classifier. Milliseconds, no model.',
    attachTo: ['model', 'agent'],
    build: () =>
      config([cognipeerShield('injection-classifier', 'Injection classifier', ['input.pre'])]),
  },
  {
    key: 'indirect-injection',
    version: 1,
    category: 'security',
    name: 'Injection in tool results',
    description:
      'Instructions hidden in what a tool returns (a web page, a document, an e-mail, an MCP result) are stopped before the agent reads them, and credentials in results are masked.',
    attachTo: ['agent', 'mcp'],
    build: () =>
      config(
        [
          cognipeerShield('result-classifier', 'Injection in tool results', ['tool.post'], 'balanced'),
          secrets('result-credentials', 'Credentials in tool results', ['tool.post']),
        ],
        // Every finding on a tool result is evidence; keep them all.
        { shortCircuit: false },
      ),
  },

  // ── Agents and tools ──
  {
    key: 'agent-tool-safety',
    version: 1,
    category: 'agents',
    name: 'Agent tool safety',
    description:
      'The posture of the built-in tool guardrail, as your own editable copy: sandbox side effects classified, credentials and personal values masked in arguments and results, plus injection checks on what tools return.',
    recommended: true,
    attachTo: ['agent'],
    build: () => {
      const base = defaultToolGuardrailHooks();
      return {
        ...base,
        policies: [
          ...base.policies,
          cognipeerShield('tool-result-injection', 'Injection in tool results', ['tool.post'], 'balanced'),
        ],
      };
    },
  },
  {
    key: 'mcp-protection',
    version: 1,
    category: 'agents',
    name: 'MCP server protection',
    description:
      'For the tool calls of an MCP server: size limits and private-network URLs in both directions, credentials masked, and instructions hidden in tool results stopped. Personal data is left to the server’s PII protection.',
    recommended: true,
    attachTo: ['mcp'],
    // No PII family: personal data on an MCP server is handled by the server's
    // PII protection (a round trip), which a one-way redaction here would break.
    build: () =>
      config(
        [
          {
            id: 'mcp-limits',
            family: 'tool_access',
            enabled: true,
            hooks: ['tool.pre', 'tool.post'],
            schedule: BLOCK,
            action: 'block',
            label: 'Size limits and private-network URLs',
            denyPrivateNetworks: true,
            maxArgBytes: 512 * 1024,
            maxResultBytes: 4 * 1024 * 1024,
            maxArgDepth: 32,
          },
          secrets('mcp-secrets', 'Credential redaction', ['tool.pre', 'tool.post']),
          cognipeerShield('mcp-prompt-shield', 'Instructions hidden in tool results', ['tool.post'], 'balanced'),
        ],
        // Every finding on a tool call is evidence; keep them all.
        { shortCircuit: false },
      ),
  },
  {
    key: 'private-network',
    version: 1,
    category: 'agents',
    name: 'Private network (SSRF) guard',
    description:
      'A tool call whose URL points at a private, loopback or cloud metadata address is stopped. Add an allow list of domains later to restrict outbound access further.',
    attachTo: ['agent', 'mcp'],
    build: () =>
      config([
        {
          id: 'private-network',
          family: 'tool_access',
          enabled: true,
          hooks: ['tool.pre'],
          schedule: BLOCK,
          action: 'block',
          label: 'Private network URLs',
          denyPrivateNetworks: true,
        },
      ]),
  },

  // ── Content ──
  {
    key: 'strict-content',
    version: 1,
    category: 'content',
    name: 'Strict content (education, young users)',
    description:
      'The most sensitive content profile: the offline classifier at its highest recall plus the profanity lists, on both what users send and what the assistant answers.',
    attachTo: ['model', 'agent'],
    build: () =>
      config([
        cognipeerModeration('content-classifier', 'Harmful content (sensitive)', ['input.pre', 'output.pre'], {
          profile: 'sensitive',
        }),
        profanity('profanity', 'Profanity', ['input.pre', 'output.pre'], 'block'),
      ]),
  },
];

const BY_KEY = new Map(GUARDRAIL_TEMPLATES.map((template) => [template.key, template]));

export function findGuardrailTemplate(key: string): GuardrailTemplateDefinition | undefined {
  return BY_KEY.get(key);
}

/** The labels of the policies a template creates, for the gallery card. */
export function templateHighlights(template: GuardrailTemplateDefinition): string[] {
  const built = template.build({ piiPolicyKey: template.piiPreset ? 'preview' : undefined });
  return built.policies.filter((p) => p.enabled).map((p) => p.label ?? p.id);
}

/** Every hook a template binds, for the gallery card. */
export function templateHooks(template: GuardrailTemplateDefinition): GuardrailHookId[] {
  const built = template.build({ piiPolicyKey: template.piiPreset ? 'preview' : undefined });
  return Object.entries(built.bindings ?? {})
    .filter(([, binding]) => binding?.enabled)
    .map(([hook]) => hook as GuardrailHookId);
}
