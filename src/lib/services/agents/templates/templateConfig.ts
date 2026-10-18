/**
 * Pure helpers that turn a template and the user's picks into what is stored:
 * the agent config, the body of each suggested trigger and the agent key. No
 * database access, so they are cheap to test and safe to share.
 */

import type { IAgentConfig } from '@/lib/database';
import type { AgentTemplate, AgentTemplateTrigger } from './types';

/** What the user chooses when creating the agent: the parts of the config that belong to the project. */
export interface TemplateConfigPicks {
  modelKey: string;
  knowledgeKeys?: string[];
  guardrailKeys?: string[];
  /** For a template that needs the sandbox. */
  sandboxTemplateKey?: string;
  /** An embedded skill's template key → the key the project holds it under (a reused one keeps its key). */
  skillKeys?: Record<string, string>;
}

const unique = (values: string[] | undefined) => [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];

/**
 * The template's spec with the user's picks applied. Knowledge is bound the way
 * the Studio saves it: a `knowledgeBindings` list, the legacy single key left
 * out, and a tool mode only when there is more than one knowledge base.
 * `temperature` and `maxTokens` are not set: the model's own settings govern.
 */
export function buildTemplateConfig(template: AgentTemplate, picks: TemplateConfigPicks): IAgentConfig {
  const config = structuredClone(template.spec) as IAgentConfig;
  config.modelKey = picks.modelKey;

  const toolMode = template.spec.knowledgeToolMode;
  delete config.knowledgeEngineKey;
  delete config.knowledgeBindings;
  delete config.knowledgeToolMode;
  const knowledgeKeys = unique(picks.knowledgeKeys);
  if (knowledgeKeys.length > 0) {
    config.knowledgeBindings = knowledgeKeys.map((key) => ({ key }));
    if (knowledgeKeys.length > 1) config.knowledgeToolMode = toolMode ?? 'combined';
  }

  const guardrailKeys = unique(picks.guardrailKeys);
  if (guardrailKeys.length > 0) config.guardrails = guardrailKeys.map((key) => ({ key }));

  if (config.sandbox) {
    config.sandbox = {
      ...config.sandbox,
      enabled: true,
      ...(picks.sandboxTemplateKey ? { templateKey: picks.sandboxTemplateKey } : {}),
    };
  }

  if (config.skills) config.skills = [...new Set(config.skills.map((key) => picks.skillKeys?.[key] ?? key))];
  return config;
}

/**
 * The request body of a suggested trigger, in the shape `POST /agents/:id/triggers`
 * takes (so it goes through the same validation a hand-made trigger does):
 * always disabled and unpinned (it runs the published version).
 */
export function buildTriggerBody(trigger: AgentTemplateTrigger, timezone: string): Record<string, unknown> {
  return {
    name: trigger.name,
    type: trigger.type,
    ...(trigger.type === 'schedule' && trigger.schedule ? { schedule: { cron: trigger.schedule.cron, timezone } } : {}),
    ...(trigger.type === 'webhook' && trigger.webhook ? { webhook: structuredClone(trigger.webhook) } : {}),
    prompt: trigger.prompt,
    ...(trigger.variables ? { variables: structuredClone(trigger.variables) } : {}),
    enabled: false,
    version: null,
  };
}

/** The format of an agent key a user may type (lower case; the generated ones are too). */
export const AGENT_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** How many `-2`, `-3` ... candidates are tried before giving up. */
export const AGENT_KEY_MAX_ATTEMPTS = 50;

/** `base`, then `base-2`, `base-3` ... */
export function agentKeyCandidate(base: string, attempt: number): string {
  return attempt === 0 ? base : `${base}-${attempt + 1}`;
}
