/**
 * EU AI Act / GPAI Code of Practice risk taxonomy for red-team reporting.
 *
 * The engine natively tags every probe with an OWASP "Top 10 for LLM
 * Applications" category (stable, tool-facing). Regulators, however, reason in
 * the EU AI Act's own vocabulary: the Article 55 / GPAI Code-of-Practice
 * *systemic-risk* families (CBRN, cyber-offence, loss-of-control, harmful
 * manipulation) plus the Article 15 accuracy/robustness/cybersecurity duties for
 * high-risk systems. This module is the single, deterministic bridge between the
 * two so a compliance report can speak the auditor's language without changing
 * how probes are authored.
 *
 * The mapping keys on the OWASP category (not the probe key) because the OWASP
 * prefix is guaranteed stable and every probe — built-in or custom — already
 * carries one.
 */

import type { OwaspLlmCategory } from './types';

/**
 * EU-facing risk families a red-team finding can map to. The first four mirror
 * the GPAI Code-of-Practice "selected types of systemic risk"; the remainder
 * capture the Article 15 (robustness / cybersecurity) and data-protection duties
 * that high-risk deployments must also evidence.
 */
export type EuRiskCategory =
  | 'harmful-manipulation'
  | 'cyber-offence'
  | 'loss-of-control'
  | 'sensitive-data-disclosure'
  | 'misinformation'
  | 'availability-robustness';

/** A pointer into the regulation, used to make a report self-documenting. */
export interface EuArticleRef {
  /** Human label, e.g. "AI Act Art. 15" or "GPAI CoP — Commitment 2". */
  source: string;
  /** Why this finding is relevant to that provision. */
  note: string;
}

export interface EuRiskCategoryMeta {
  key: EuRiskCategory;
  label: string;
  description: string;
  /** Regulatory hooks this risk family discharges evidence for. */
  articleRefs: EuArticleRef[];
}

const ART55: EuArticleRef = {
  source: 'AI Act Art. 55 + GPAI CoP Commitment 3',
  note: 'Adversarial testing / model evaluation of systemic risk for GPAI models.',
};
const ART15_ROBUST: EuArticleRef = {
  source: 'AI Act Art. 15',
  note: 'Accuracy, robustness and resilience against adversarial inputs for high-risk systems.',
};
const ART15_CYBER: EuArticleRef = {
  source: 'AI Act Art. 15(5)',
  note: 'Cybersecurity: resilience against attempts to alter use, outputs or performance.',
};

/** Canonical metadata for every EU risk family (drives report labelling). */
export const EU_RISK_CATEGORIES: Record<EuRiskCategory, EuRiskCategoryMeta> = {
  'harmful-manipulation': {
    key: 'harmful-manipulation',
    label: 'Harmful manipulation',
    description:
      'The system can be coerced into producing disallowed, deceptive, or operationally harmful content (jailbreaks, prompt injection steering behaviour).',
    articleRefs: [
      ART55,
      ART15_ROBUST,
      { source: 'AI Act Art. 5', note: 'Prohibited manipulative / harmful practices the output must not enable.' },
    ],
  },
  'cyber-offence': {
    key: 'cyber-offence',
    label: 'Cyber offence',
    description:
      'Outputs or tool use that enable offensive cyber capability — insecure/executable output, tool abuse, or exfiltration paths.',
    articleRefs: [
      ART55,
      ART15_CYBER,
      { source: 'GPAI CoP — cyber-offence risk', note: 'Offensive cyber capability is a selected systemic risk.' },
    ],
  },
  'loss-of-control': {
    key: 'loss-of-control',
    label: 'Loss of control',
    description:
      'The system takes consequential actions with excessive autonomy or insufficient human oversight (excessive agency, unsafe tool invocation).',
    articleRefs: [
      ART55,
      { source: 'AI Act Art. 14', note: 'Human oversight: ability to intervene, override, and constrain autonomy.' },
      { source: 'GPAI CoP — loss-of-control risk', note: 'Inability to constrain model behaviour is a selected systemic risk.' },
    ],
  },
  'sensitive-data-disclosure': {
    key: 'sensitive-data-disclosure',
    label: 'Sensitive-data disclosure',
    description:
      'The system leaks personal data, secrets, or its confidential system instructions (PII exposure, system-prompt leakage).',
    articleRefs: [
      ART15_CYBER,
      { source: 'AI Act Art. 10', note: 'Data governance and protection of personal data used or exposed by the system.' },
      { source: 'GDPR Art. 5 / 32', note: 'Confidentiality and integrity of personal data.' },
    ],
  },
  misinformation: {
    key: 'misinformation',
    label: 'Misinformation & overreliance',
    description:
      'The system emits confident falsehoods or fabricated content that a user may over-trust, without appropriate hedging or transparency.',
    articleRefs: [
      ART15_ROBUST,
      { source: 'AI Act Art. 50', note: 'Transparency obligations so users are not misled by AI-generated content.' },
    ],
  },
  'availability-robustness': {
    key: 'availability-robustness',
    label: 'Availability & robustness',
    description:
      'The system degrades, denies service, or behaves inconsistently under adversarial or out-of-distribution load (resource exhaustion, supply-chain).',
    articleRefs: [
      ART15_ROBUST,
      { source: 'GPAI CoP — cyber-offence risk', note: 'Disruption of availability / critical function.' },
    ],
  },
};

/**
 * Map an OWASP LLM category to the EU risk families it evidences. A single
 * OWASP category can speak to more than one EU duty (e.g. prompt injection is
 * both a manipulation and a robustness concern), so the mapping is one-to-many.
 * Unknown / custom-only categories fall back to a robustness signal so nothing
 * silently drops out of a compliance rollup.
 */
export function mapOwaspToEu(owasp: string): EuRiskCategory[] {
  switch (owasp as OwaspLlmCategory) {
    case 'LLM01-prompt-injection':
      return ['harmful-manipulation', 'cyber-offence'];
    case 'LLM02-insecure-output-handling':
      return ['cyber-offence'];
    case 'LLM04-model-dos':
      return ['availability-robustness'];
    case 'LLM05-supply-chain':
      return ['cyber-offence', 'availability-robustness'];
    case 'LLM06-sensitive-information-disclosure':
      return ['sensitive-data-disclosure'];
    case 'LLM07-system-prompt-leakage':
      return ['sensitive-data-disclosure'];
    case 'LLM08-excessive-agency':
      return ['loss-of-control', 'cyber-offence'];
    case 'LLM09-overreliance':
      return ['misinformation'];
    default:
      return ['availability-robustness'];
  }
}

export const EU_RISK_CATEGORY_KEYS = Object.keys(EU_RISK_CATEGORIES) as EuRiskCategory[];
