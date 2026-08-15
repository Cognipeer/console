/**
 * Anonymization pipeline on top of the existing PII detector.
 *
 * The detector (`detector.ts`) owns ALL pattern knowledge — this module never
 * defines its own regexes. It adds two irreversible output strategies used by
 * the Traffic Snapshots feature (and any other consumer that needs to strip
 * PII from text before it is persisted into an evaluation dataset):
 *
 *   - 'mask'      — each finding is replaced with its category's existing mask
 *                   strategy (keep-last-4, keep-domain, …), exactly as the
 *                   detector computes it for action='mask'.
 *   - 'pseudonym' — each finding is replaced with a deterministic token
 *                   `<CATEGORY_HHHHHH>` where HHHHHH is the first 6 hex chars
 *                   of HMAC-SHA256(salt, matchedValue). The same value under
 *                   the same salt ALWAYS yields the same token, so entity
 *                   co-reference survives anonymization ("<EMAIL_a1b2c3> asked
 *                   … reply to <EMAIL_a1b2c3>") while the value itself cannot
 *                   be recovered without the salt. The salt must never be
 *                   persisted next to the output.
 *
 * `anonymizeMessages` walks chat-message arrays ({role, content}) where
 * content may be a plain string or an array of parts carrying `.text`
 * (OpenAI-style multi-part content). Non-text parts are passed through
 * untouched — callers that need them gone should flatten first.
 */

import { createHmac } from 'node:crypto';
import type { IPiiCustomPattern } from '@/lib/database';
import { applyReplacements, detect } from './detector';
import type { PiiFinding } from './types';

export interface AnonymizeOptions {
  /** Built-in category ids to detect (e.g. 'email', 'tc_kimlik'). */
  categories: string[];
  /** Output strategy — see module header. */
  strategy: 'mask' | 'pseudonym';
  /** HMAC key for 'pseudonym' tokens. Required; never persist it. */
  salt: string;
  /** Extra one-off patterns, same shape as IPiiPolicy.customPatterns. */
  customPatterns?: IPiiCustomPattern[];
}

export interface AnonymizeTextResult {
  text: string;
  /** Number of findings that were replaced. */
  findings: number;
}

/** 'tr_phone' → 'TR_PHONE'; anything non-alphanumeric collapses to '_'. */
function pseudonymPrefix(categoryId: string): string {
  const cleaned = categoryId
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || 'PII';
}

/** Deterministic pseudonym token for one matched value. */
export function pseudonymToken(salt: string, categoryId: string, value: string): string {
  const digest = createHmac('sha256', salt).update(value).digest('hex').slice(0, 6);
  return `<${pseudonymPrefix(categoryId)}_${digest}>`;
}

function detectorConfig(opts: AnonymizeOptions) {
  return {
    categories: Object.fromEntries(opts.categories.map((id) => [id, true])),
    customPatterns: opts.customPatterns,
  };
}

/**
 * Detect and replace PII in `text` per the configured strategy. Deterministic:
 * identical input + options always produce identical output.
 */
export function anonymizeText(text: string, opts: AnonymizeOptions): AnonymizeTextResult {
  if (!text) return { text, findings: 0 };

  if (opts.strategy === 'mask') {
    const findings = detect(text, detectorConfig(opts), 'mask');
    return { text: applyReplacements(text, findings), findings: findings.length };
  }

  const findings = detect(text, detectorConfig(opts), 'detect');
  const pseudonymized: PiiFinding[] = findings.map((f) => ({
    ...f,
    replacement: pseudonymToken(opts.salt, f.category, f.value),
  }));
  return { text: applyReplacements(text, pseudonymized), findings: pseudonymized.length };
}

/** One part of a multi-part message content (OpenAI-style). */
export interface AnonymizableContentPart {
  text?: unknown;
  [key: string]: unknown;
}

/** A chat message whose content is a string or an array of text-bearing parts. */
export interface AnonymizableMessage {
  role: string;
  content: unknown;
  [key: string]: unknown;
}

export interface AnonymizeMessagesResult<T extends AnonymizableMessage> {
  messages: T[];
  /** Total findings replaced across every message. */
  findings: number;
}

/**
 * Anonymize every text payload in a chat-message array. Returns new objects —
 * the input is never mutated. Content that is neither a string nor an array of
 * parts is passed through untouched.
 */
export function anonymizeMessages<T extends AnonymizableMessage>(
  messages: T[],
  opts: AnonymizeOptions,
): AnonymizeMessagesResult<T> {
  let findings = 0;

  const out = messages.map((message) => {
    const content = message.content;

    if (typeof content === 'string') {
      const result = anonymizeText(content, opts);
      findings += result.findings;
      return { ...message, content: result.text };
    }

    if (Array.isArray(content)) {
      const parts = content.map((part) => {
        if (part && typeof part === 'object' && typeof (part as AnonymizableContentPart).text === 'string') {
          const result = anonymizeText((part as AnonymizableContentPart).text as string, opts);
          findings += result.findings;
          return { ...(part as AnonymizableContentPart), text: result.text };
        }
        return part;
      });
      return { ...message, content: parts };
    }

    return message;
  });

  return { messages: out, findings };
}
