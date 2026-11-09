/**
 * The built-in probe library added after the first ten probes. These are
 * opt-in: a campaign that selects no probes runs the default set only.
 */

import type { Probe } from '../types';
import { createRagPoisoningProbe } from './library/ragPoisoningIndirectInjection';
import { createMarkdownExfilProbe } from './library/markdownExfil';
import { createAnsiEscapeProbe } from './library/ansiEscapeOutput';
import { createDownstreamInjectionEchoProbe } from './library/downstreamInjectionEcho';
import { createAsciiSmugglingTagsProbe } from './library/asciiSmugglingTags';
import { createSystemPromptExtractionTemplatesProbe } from './library/systemPromptExtractionTemplates';
import { createSycophancyFalsePremiseProbe } from './library/sycophancyFalsePremise';
import { createOverRefusalControlProbe } from './library/overRefusalControl';
import { createManyShotRuleViolationProbe } from './library/manyShotRuleViolation';
import { createCrescendoScriptedCanaryProbe } from './library/crescendoScriptedCanary';
import { createSkeletonKeyProbe } from './library/skeletonKeyGuidelineAugment';
import { createContextComplianceProbe } from './library/contextComplianceForgedHistory';
import { createFormatObfuscationProbe } from './library/formatObfuscationBypass';
import { createPersonaRoleplayProbe } from './library/personaRoleplayCanary';
import { createUnboundedConsumptionProbe } from './library/unboundedConsumption';

/** Factory per library probe key, in catalog order. */
export const LIBRARY_PROBES: Record<string, () => Probe> = {
  'rag-poisoning-indirect-injection': createRagPoisoningProbe,
  'markdown-exfil': createMarkdownExfilProbe,
  'ansi-escape-output': createAnsiEscapeProbe,
  'downstream-injection-echo': createDownstreamInjectionEchoProbe,
  'ascii-smuggling-tags': createAsciiSmugglingTagsProbe,
  'system-prompt-extraction-templates': createSystemPromptExtractionTemplatesProbe,
  'sycophancy-false-premise': createSycophancyFalsePremiseProbe,
  'over-refusal-control': createOverRefusalControlProbe,
  'many-shot-rule-violation': createManyShotRuleViolationProbe,
  'crescendo-scripted-canary': createCrescendoScriptedCanaryProbe,
  'skeleton-key-guideline-augment': createSkeletonKeyProbe,
  'context-compliance-forged-history': createContextComplianceProbe,
  'format-obfuscation-bypass': createFormatObfuscationProbe,
  'persona-roleplay-canary': createPersonaRoleplayProbe,
  'unbounded-consumption': createUnboundedConsumptionProbe,
};
