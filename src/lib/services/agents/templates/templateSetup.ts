/**
 * What is left to do once an agent exists: the checklist the create form shows
 * after the agent is made. Pure. The dashboard translates each item by its
 * `code`; `message` is the English text for clients that have no translation,
 * taken from the same message file (`agentTemplates.en.ts`) so the two cannot
 * drift apart.
 */

import { agentTemplatesEn } from '@/lib/i18n/messages/agentTemplates.en';
import type { AgentTemplate, AgentTemplateSetupCode, AgentTemplateSetupItem } from './types';

export interface TemplateSetupFacts {
  template: AgentTemplate;
  knowledgeKeys: string[];
  guardrailKeys: string[];
  /** An active web search provider is assigned to the project. */
  webSearchAvailable: boolean;
  published: boolean;
  /** The suggested triggers that were created. */
  triggers: Array<{ name: string; type: 'schedule' | 'webhook' | 'manual' | 'connector' }>;
}

/** The English text of a setup code, with its `{placeholders}` filled. */
function say(code: AgentTemplateSetupCode, values: Record<string, string> = {}): string {
  return agentTemplatesEn.setup[code].replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match);
}

export function buildSetupItems(facts: TemplateSetupFacts): AgentTemplateSetupItem[] {
  const { template } = facts;
  const items: AgentTemplateSetupItem[] = [];

  if (template.requires.knowledge && facts.knowledgeKeys.length === 0) {
    items.push({
      code: 'knowledge_not_bound',
      severity: template.requires.knowledge === 'required' ? 'warning' : 'info',
      message: say('knowledge_not_bound'),
    });
  }
  if (template.requires.webSearch && !facts.webSearchAvailable) {
    items.push({
      code: 'web_search_unavailable',
      severity: template.requires.webSearch === 'required' ? 'warning' : 'info',
      message: say('web_search_unavailable'),
    });
  }
  if (template.requires.guardrails === 'recommended' && facts.guardrailKeys.length === 0) {
    items.push({ code: 'guardrails_recommended', severity: 'info', message: say('guardrails_recommended') });
  }
  const clientTools = (template.spec.clientTools ?? []).map((tool) => tool.name).join(', ');
  if (clientTools) {
    items.push({ code: 'client_tools', severity: 'info', message: say('client_tools', { tools: clientTools }), detail: clientTools });
  }
  if (!facts.published && (template.surfaces.includes('api') || template.surfaces.includes('trigger'))) {
    items.push({ code: 'publish_needed', severity: 'info', message: say('publish_needed') });
  }
  if (facts.triggers.length > 0) {
    const names = facts.triggers.map((trigger) => trigger.name).join(', ');
    items.push({ code: 'triggers_disabled', severity: 'info', message: say('triggers_disabled', { names }), detail: names });
  }
  if (facts.triggers.some((trigger) => trigger.type === 'webhook')) {
    items.push({ code: 'webhook_secret', severity: 'warning', message: say('webhook_secret') });
  }
  return items;
}
