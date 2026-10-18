/**
 * Whether a template can be turned into a working agent in a project, from
 * facts the server read about that project. Pure: the facts are gathered by the
 * service, the verdict is decided here.
 */

import type {
  AgentTemplate,
  AgentTemplateAvailability,
  AgentTemplateAvailabilityItem,
} from './types';

/** What the project (and this deployment) has. */
export interface TemplateFacts {
  /** The project has a chat model. */
  hasLlmModel: boolean;
  /** An active web search provider is assigned to the project. */
  hasWebSearchProvider: boolean;
  /** The project has an active knowledge engine. */
  hasKnowledgeEngine: boolean;
  sandbox:
    | { available: false; reason: 'edition' | 'license' }
    /** `templateKeys` is absent when the list could not be read. */
    | { available: true; templateKeys?: string[] };
}

/**
 * - A missing chat model, and a required knowledge base or web search provider,
 *   are blockers the user can fix in the project: `needs_setup`.
 * - The sandbox module missing from the edition or the license is not
 *   something the project can fix: `unavailable`.
 * - Something an optional part would use is only a warning: the template is
 *   still `ready`.
 */
export function computeTemplateAvailability(template: AgentTemplate, facts: TemplateFacts): AgentTemplateAvailability {
  const items: AgentTemplateAvailabilityItem[] = [];
  const { requires } = template;

  if (!facts.hasLlmModel) items.push({ code: 'no_llm_model', severity: 'blocker' });

  if (requires.sandbox) {
    if (!facts.sandbox.available) {
      items.push({ code: 'sandbox_unavailable', severity: 'blocker', detail: facts.sandbox.reason });
    } else if (facts.sandbox.templateKeys && facts.sandbox.templateKeys.length === 0) {
      items.push({ code: 'sandbox_template_missing', severity: 'blocker' });
    }
  }

  if (requires.webSearch && !facts.hasWebSearchProvider) {
    items.push({ code: 'web_search_unavailable', severity: requires.webSearch === 'required' ? 'blocker' : 'warning' });
  }
  if (requires.knowledge && !facts.hasKnowledgeEngine) {
    items.push({ code: 'knowledge_missing', severity: requires.knowledge === 'required' ? 'blocker' : 'warning' });
  }

  const status = items.some((item) => item.code === 'sandbox_unavailable')
    ? 'unavailable'
    : items.some((item) => item.severity === 'blocker')
      ? 'needs_setup'
      : 'ready';
  return { status, items };
}
