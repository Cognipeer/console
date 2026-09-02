/**
 * What an end user is told when a guardrail stops something.
 *
 * These defaults matter more than they look: a tenant-editable template is a
 * feature almost nobody uses, so for most workspaces the strings below ARE the
 * product's voice at its worst moment. Four rules shaped every one of them:
 *
 *  1. DO NOT BLAME THE USER. Most blocks are accidents — a support agent
 *     pasting a customer record, a developer pasting a config file. "This
 *     didn't go through" is true; "you violated policy" is an accusation the
 *     guardrail is not in a position to make.
 *  2. SAY WHAT TO DO NEXT. A message with no next step turns into a support
 *     ticket, and the person who could unblock it (the workspace admin) is
 *     named where they exist.
 *  3. NEVER LEAK WHICH RULE FIRED. Naming the category is useful; naming the
 *     rule, the pattern or the matched value is a free oracle for anyone
 *     probing the guardrail. `prompt_shield` goes further and says NOTHING
 *     about why — telling an attacker "prompt injection detected" is the single
 *     most useful piece of feedback we could give them. The one exception is
 *     `tool_denied`, where the tool name is information the user needs to ask
 *     for access and cannot use to evade anything.
 *  4. ALWAYS LEAVE A REFERENCE. Without a trace id, "the assistant refused"
 *     is unsupportable; `resolveBlockMessage` appends one to every rendered
 *     body that does not already carry it.
 *
 * `secrets` is the one family that deliberately WARNS rather than merely
 * instructing: if a real key reached this point it has been typed into a chat
 * box, and telling the user to rotate it is worth far more than the block.
 *
 * ── WHO CAN OVERRIDE WHAT ───────────────────────────────────────────────────
 * Three layers, narrowest first: the blocking policy's own `message`, then the
 * workspace's template for that REASON CLASS, then the built-in above. The
 * reason-class layer is the one an operator normally wants — it is how you set
 * one message for every personal-data block at once — and the per-policy layer
 * exists because the reason classes are deliberately coarser than the families
 * that feed them (`regex`, `custom` and `webhook` all land on 'custom'), so
 * without it two unrelated policies are stuck sharing one string.
 * `describePolicyBlockMessage` reports which layer won, so a screen can say
 * "inherited" instead of leaving an operator to guess.
 */

import type {
  GuardrailBlockedMessageSettings as BlockedMessageSettings,
  GuardrailBlockReasonClass as BlockReasonClass,
  GuardrailPolicyFamily as PolicyFamily,
} from '@/lib/database/provider/types.domain';
import { BLOCK_MESSAGE_VARS, DEFAULT_BLOCK_STATUS, VERDICT_STATUS } from './contract';
import type { BlockMessageVar, RenderedBlockMessage } from './contract';

/** Mirrors the console's own supported UI locales. Kept as a local union rather
 *  than imported from the i18n bundle, which would drag two large message
 *  objects into a module the evaluation path loads on every request. */
export type BlockMessageLocale = 'en' | 'tr';
export const BLOCK_MESSAGE_LOCALES: readonly BlockMessageLocale[] = ['en', 'tr'];
export const DEFAULT_BLOCK_MESSAGE_LOCALE: BlockMessageLocale = 'en';

/**
 * Policy family -> the coarse reason a user is shown. Several families collapse
 * into `custom` on purpose: an authored regex rule or a webhook verdict could
 * be about anything, and guessing a specific reason for it would produce a
 * message that is confidently wrong.
 */
/*
 * That collapse has a cost, and `GuardrailPolicy.message` is what pays it:
 * three families share the `custom` string, so editing "the regex policy's
 * message" here would rewrite the webhook policy's as well. A policy that needs
 * its own wording carries it on the policy, above this table; everything else
 * keeps inheriting, which is what lets an operator set one message for every
 * personal-data block at once.
 */
export const BLOCK_REASON_FOR_FAMILY: Readonly<Record<PolicyFamily, BlockReasonClass>> = {
  pii: 'pii',
  secrets: 'secrets',
  word_filter: 'profanity',
  regex: 'custom',
  moderation: 'moderation',
  prompt_shield: 'injection',
  custom: 'custom',
  tool_access: 'tool_denied',
  webhook: 'custom',
};

const EN: Readonly<Record<BlockReasonClass, string>> = {
  pii: 'This didn’t go through, because it looks like it contains personal information — a name, contact details or an ID number. Take those out, or replace them with placeholders, and send it again.',
  secrets:
    'This didn’t go through, because it looks like it contains a credential such as an API key, an access token or a private key. Remove it and send the message again. If that credential is real, treat it as exposed and rotate it now.',
  profanity:
    'This didn’t go through, because some of the wording isn’t allowed in this workspace. Rephrase it and send it again.',
  moderation:
    'This didn’t go through, because it falls outside what this workspace allows. Try rephrasing it, or ask your workspace admin if you think it should be allowed.',
  // Deliberately says nothing about why. See rule 3 above.
  injection:
    'This didn’t go through. Try rephrasing your request, or contact your workspace admin if you think this is a mistake.',
  tool_denied:
    'The assistant tried to use {{toolName}}, which isn’t available here, so the action was stopped. Ask your workspace admin if you need it enabled.',
  custom:
    'This didn’t go through, because of a policy set by this workspace. Try rephrasing it, or ask your workspace admin what’s allowed.',
  unavailable:
    'A safety policy couldn’t run just now, and this workspace is set to stop requests when that happens. There’s nothing wrong with what you sent — please try again in a moment.',
};

const TR: Readonly<Record<BlockReasonClass, string>> = {
  pii: 'Bu işlem tamamlanmadı, çünkü içinde kişisel bilgi (ad, iletişim bilgisi veya kimlik numarası gibi) görünüyor. Bu bilgileri çıkarın ya da yerlerine örnek değerler koyup yeniden gönderin.',
  secrets:
    'Bu işlem tamamlanmadı, çünkü içinde bir kimlik bilgisi (API anahtarı, erişim jetonu veya özel anahtar) görünüyor. Bu değeri çıkarıp yeniden gönderin. Anahtar gerçekse sızmış kabul edin ve hemen yenileyin.',
  profanity:
    'Bu işlem tamamlanmadı, çünkü kullanılan ifadelerin bir kısmına bu çalışma alanında izin verilmiyor. Metni yeniden yazıp gönderin.',
  moderation:
    'Bu işlem tamamlanmadı, çünkü bu çalışma alanının içerik kurallarının dışında kalıyor. İfadeyi değiştirmeyi deneyebilir ya da izin verilmesi gerektiğini düşünüyorsanız çalışma alanı yöneticinize başvurabilirsiniz.',
  injection:
    'Bu işlem tamamlanmadı. İsteğinizi farklı bir biçimde yazmayı deneyin; bunun bir hata olduğunu düşünüyorsanız çalışma alanı yöneticinize başvurun.',
  tool_denied:
    'Asistan {{toolName}} aracını kullanmak istedi; bu araç burada kullanılamıyor, bu yüzden işlem durduruldu. İhtiyacınız varsa çalışma alanı yöneticinizden açmasını isteyin.',
  custom:
    'Bu işlem, bu çalışma alanının bir kuralı nedeniyle tamamlanmadı. İfadeyi değiştirmeyi deneyebilir ya da yöneticinize neye izin verildiğini sorabilirsiniz.',
  unavailable:
    'Gerekli bir güvenlik denetimi şu anda çalıştırılamadı ve bu çalışma alanı, böyle durumlarda isteği durduracak şekilde ayarlanmış. Gönderdiğiniz içerikte bir sorun yok — kısa bir süre sonra tekrar deneyin.',
};

export const BUILTIN_BLOCK_MESSAGES: Readonly<
  Record<BlockMessageLocale, Readonly<Record<BlockReasonClass, string>>>
> = { en: EN, tr: TR };

/** The English defaults, which is what the contract names. Other locales come
 *  from BUILTIN_BLOCK_MESSAGES. */
export const DEFAULT_BLOCK_MESSAGES = EN;

/** Label of the appended reference line, per locale. */
const REFERENCE_LABEL: Readonly<Record<BlockMessageLocale, string>> = {
  en: 'Reference',
  tr: 'Referans',
};

/**
 * Neutral stand-ins for the two variables whose absence would leave a built-in
 * sentence ungrammatical. This is NOT a general default mechanism: every other
 * variable renders empty when it is missing, because a message that invents a
 * guardrail name is worse than one that omits it.
 */
const VAR_FALLBACKS: Partial<Record<BlockMessageVar, string>> = {
  toolName: 'a tool',
};

/**
 * The interpolator. About ten lines, and deliberately NOT a template engine:
 *
 *  · Mustache would be the obvious reach, and it is wrong here — `{{ }}`
 *    HTML-escapes, so every apostrophe in a guardrail name and every quote in
 *    an LLM-produced finding message would come out as an entity, and these
 *    strings are rendered as plain text into chat transcripts and API error
 *    bodies, not into HTML.
 *  · The variable set is CLOSED (BLOCK_MESSAGE_VARS). An unrecognised
 *    `{{something}}` is left VERBATIM rather than blanked, so an operator who
 *    hoped for `{{value}}` sees braces in the output and learns the set is
 *    closed, instead of silently shipping a message with a hole in it.
 *  · A function replacer is used specifically so `$&` / `$1` in a substituted
 *    value are NOT re-interpreted, and so substituted text is never re-scanned
 *    — otherwise a guardrail named `{{traceId}}` would become a template.
 */
export function renderBlockMessage(
  template: string,
  vars: Partial<Record<BlockMessageVar, string>>,
): string {
  // Constructed per call: a module-level /g regex carries `lastIndex` state,
  // and that has bitten every codebase that has ever cached one.
  return template.replace(/\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/g, (match, name: string) => {
    if (!(BLOCK_MESSAGE_VARS as readonly string[]).includes(name)) return match;
    const key = name as BlockMessageVar;
    const value = vars[key];
    if (value !== undefined && value !== '') return value;
    return VAR_FALLBACKS[key] ?? '';
  });
}

/**
 * The layers an operator can override, in the order they are consulted.
 *
 * Only `byCategory` is persisted today — it is exactly
 * `BlockedMessageSettings.templates`, keyed by reason class. `byPolicy` and
 * `byLocale` exist because the resolution order is part of the contract and a
 * caller assembling templates in process (a preset, a red-team preview) can
 * supply them; they are not yet reachable from a stored guardrail.
 */
export interface BlockMessageTemplateSet {
  default?: string;
  byCategory?: Partial<Record<BlockReasonClass, string>>;
  /**
   * Keyed by `GuardrailPolicy.id`.
   *
   * NOT the same layer as `GuardrailPolicy.message`, and the difference is why
   * they sit on opposite sides of `byCategory`. This map is assembled in
   * process by a caller that is describing SOMEBODY ELSE'S policies — a preset,
   * a red-team preview — so it must not outrank a workspace's own wording.
   * `policy.message` is authored on the policy itself by the same operator who
   * wrote the category template, and is the narrower statement of their intent,
   * so it does.
   */
  byPolicy?: Record<string, string>;
}

export interface BlockMessageTemplates extends BlockMessageTemplateSet {
  byLocale?: Partial<Record<BlockMessageLocale, BlockMessageTemplateSet>>;
}

export function isBlockMessageLocale(value: unknown): value is BlockMessageLocale {
  return value === 'en' || value === 'tr';
}

/**
 * Which layer a rendered message came from. The drawer needs this to say "this
 * is inherited from the personal-data default" rather than showing an operator
 * a box of text with no clue whether editing it affects one policy or nine.
 */
export type BlockMessageSource =
  /** `GuardrailPolicy.message` — this policy overrides its reason class. */
  | 'policy'
  | 'locale_category'
  | 'locale_policy'
  | 'locale_default'
  /** `BlockedMessageSettings.templates[reasonClass]` — the workspace's answer
   *  for every block of this reason. */
  | 'category'
  | 'policy_template'
  | 'default'
  /** Nothing was overridden anywhere. The common case. */
  | 'builtin';

export interface ResolvedBlockMessageTemplate {
  template: string;
  source: BlockMessageSource;
  reasonClass: BlockReasonClass;
}

/**
 * Resolution order, normative:
 *   policy.message
 *   -> locale.byCategory -> locale.byPolicy -> locale.default
 *   -> byCategory -> byPolicy -> default
 *   -> the built-in default for that locale.
 *
 * `policy.message` is FIRST, and it is the only layer above the category one.
 * It exists because the reason classes are coarser than the policies that feed
 * them — `regex`, `custom` and `webhook` all land on 'custom' — so without it
 * an operator editing "the regex policy's message" silently rewrites the
 * webhook policy's too. It outranks the category layer because it is the
 * narrower statement of the same operator's intent, authored on the policy
 * itself.
 *
 * Category still beats the `byPolicy` MAP, which is a different thing despite
 * the similar name: that map is assembled in process by a caller describing
 * somebody else's policies (a preset, a red-team preview), and letting a
 * preset's wording override a workspace's own voice is exactly the inversion
 * this order was written to prevent.
 *
 * A layer whose string is blank is SKIPPED rather than honoured, which is what
 * makes "clear the box to go back to the inherited wording" work at every
 * level, instead of shipping an end user an empty block message.
 *
 * The built-in is reached only when nothing above it exists, which is the
 * common case — which is why the built-ins are written as finished messages
 * rather than placeholders.
 */
export function resolveBlockMessageTemplate(
  templates: BlockMessageTemplates | undefined,
  reasonClass: BlockReasonClass,
  policyId: string | undefined,
  locale: BlockMessageLocale,
  policyMessage?: string,
): ResolvedBlockMessageTemplate {
  const localized = templates?.byLocale?.[locale];
  const layers: Array<[BlockMessageSource, string | undefined]> = [
    ['policy', policyMessage],
    ['locale_category', localized?.byCategory?.[reasonClass]],
    ['locale_policy', policyId ? localized?.byPolicy?.[policyId] : undefined],
    ['locale_default', localized?.default],
    ['category', templates?.byCategory?.[reasonClass]],
    ['policy_template', policyId ? templates?.byPolicy?.[policyId] : undefined],
    ['default', templates?.default],
  ];
  for (const [source, layer] of layers) {
    if (typeof layer === 'string' && layer.trim().length > 0) {
      return { template: layer, source, reasonClass };
    }
  }
  return { template: BUILTIN_BLOCK_MESSAGES[locale][reasonClass], source: 'builtin', reasonClass };
}

/** The template alone. Kept because most callers want only the string, and
 *  because it was the shape before the per-policy layer existed. */
export function selectBlockMessageTemplate(
  templates: BlockMessageTemplates | undefined,
  reasonClass: BlockReasonClass,
  policyId: string | undefined,
  locale: BlockMessageLocale,
  policyMessage?: string,
): string {
  return resolveBlockMessageTemplate(templates, reasonClass, policyId, locale, policyMessage)
    .template;
}

export interface PolicyBlockMessageOrigin {
  /** The reason class this policy's blocks fall into. Several families share
   *  one, which is the whole reason the per-policy override exists. */
  reasonClass: BlockReasonClass;
  /** True when the policy's own `message` is what a block would show. */
  overridden: boolean;
  source: BlockMessageSource;
  /** What is in force right now. */
  effective: string;
  /**
   * What would be shown if the policy's own message were removed — the drawer's
   * placeholder, and what "Reset to inherited" restores. Equal to `effective`
   * when nothing is overridden.
   */
  inherited: string;
  /** The layer `inherited` came from, for the "inherited from …" line. */
  inheritedFrom: BlockMessageSource;
}

/**
 * Everything the per-policy message drawer needs, in one call.
 *
 * It answers the two questions an operator actually has in front of that box —
 * "what do people see when this policy blocks something?" and "is this string
 * mine or is it coming from somewhere else?" — and it answers the second by
 * resolving TWICE: once as configured, once with the policy's own message taken
 * away. Computing the inherited value any other way would mean re-implementing
 * the layer order, which is how the drawer ends up describing a different
 * resolution from the one the engine performs.
 */
export function describePolicyBlockMessage(input: {
  family: PolicyFamily;
  /** `GuardrailPolicy.message`. */
  message?: string;
  policyId?: string;
  settings?: BlockedMessageSettings;
  templates?: BlockMessageTemplates;
  locale?: string;
}): PolicyBlockMessageOrigin {
  const locale = isBlockMessageLocale(input.locale) ? input.locale : DEFAULT_BLOCK_MESSAGE_LOCALE;
  const reasonClass = BLOCK_REASON_FOR_FAMILY[input.family] ?? 'custom';
  const templates = mergeTemplateLayers(input.settings, input.templates);

  const effective = resolveBlockMessageTemplate(
    templates,
    reasonClass,
    input.policyId,
    locale,
    input.message,
  );
  const inherited =
    effective.source === 'policy'
      ? resolveBlockMessageTemplate(templates, reasonClass, input.policyId, locale, undefined)
      : effective;

  return {
    reasonClass,
    overridden: effective.source === 'policy',
    source: effective.source,
    effective: effective.template,
    inherited: inherited.template,
    inheritedFrom: inherited.source,
  };
}

/** The persisted map is the LOWEST operator layer; anything a caller passes in
 *  process sits above it. One implementation, because `resolveBlockMessage` and
 *  the drawer must stack them identically or the preview lies. */
function mergeTemplateLayers(
  settings: BlockedMessageSettings | undefined,
  templates: BlockMessageTemplates | undefined,
): BlockMessageTemplates {
  return {
    ...templates,
    byCategory: { ...settings?.templates, ...templates?.byCategory },
  };
}

export interface ResolveBlockMessageInput {
  reasonClass: BlockReasonClass;
  /** The persisted per-guardrail settings; its `templates` map is the
   *  `byCategory` layer. */
  settings?: BlockedMessageSettings;
  /** In-process overrides layered ABOVE the persisted ones. */
  templates?: BlockMessageTemplates;
  /** The policy whose finding caused the block, for the `byPolicy` layer. */
  policyId?: string;
  /**
   * `GuardrailPolicy.message` of that same policy — the TOP layer.
   *
   * Passed in rather than looked up because this module holds no configuration:
   * the caller already has the blocking finding and the policy list in hand
   * (`renderBlock`, hooks/engine.ts), and a lookup here would need the whole
   * `GuardrailHooksConfig` for one string.
   */
  policyMessage?: string;
  vars?: Partial<Record<BlockMessageVar, string>>;
  /** Anything; narrowed to a supported locale, defaulting to English. */
  locale?: string;
  traceId: string;
  /** Off by default, so a block stays HTTP 400 with the error body every
   *  deployed OpenAI-compatible client already parses. */
  useVerdictStatusCodes?: boolean;
}

export function resolveBlockMessage(input: ResolveBlockMessageInput): RenderedBlockMessage {
  const locale = isBlockMessageLocale(input.locale) ? input.locale : DEFAULT_BLOCK_MESSAGE_LOCALE;
  const templates = mergeTemplateLayers(input.settings, input.templates);
  const template = selectBlockMessageTemplate(
    templates,
    input.reasonClass,
    input.policyId,
    locale,
    input.policyMessage,
  );

  const vars = { ...input.vars };
  if (input.traceId && vars.traceId === undefined) vars.traceId = input.traceId;
  let body = renderBlockMessage(template, vars);

  // Rule 4: every body carries a reference. A template that places the id
  // inline keeps control of where it goes; one that doesn't gets it appended.
  // `includeTraceId` defaults to true — support cannot debug a block without it.
  //
  // The "already there?" test looks at the TEMPLATE, not at the rendered body.
  // Searching the body for the id is the obvious version and it is wrong: trace
  // ids are opaque strings, and a short one is a substring of ordinary prose
  // ('t' appears in almost every message), so the reference would silently
  // vanish from exactly the blocks a human has to chase down.
  const reference = vars.requestId ?? vars.traceId;
  const inlined = /\{\{\s*(?:requestId|traceId)\s*\}\}/.test(template);
  if ((input.settings?.includeTraceId ?? true) && reference && !inlined) {
    body = `${body}\n\n${REFERENCE_LABEL[locale]}: ${reference}`;
  }

  return {
    reasonClass: input.reasonClass,
    body,
    mode: input.settings?.mode ?? 'error',
    status: input.useVerdictStatusCodes ? VERDICT_STATUS.blocked : DEFAULT_BLOCK_STATUS,
    traceId: input.traceId,
  };
}
