/**
 * The system prompt an agent runs with: the inline text or the Prompts-module template,
 * rendered with the run's prompt variables.
 */

import { type RenderedPrompt, type ResolvedPromptVariables, renderPromptTemplate, shouldRenderInlinePrompt } from './promptVariables';
import { getDatabase, type IAgentConfig } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('agents');

/**
 * Logs which prompt placeholders came from the caller and which nobody filled.
 *
 * An unfilled placeholder renders empty, which is exactly the failure this
 * whole module exists to make visible: the prompt still "works", it just quietly
 * says less than its author wrote. A warn line is the cheapest way for an
 * operator to find that from a trace.
 */
export function reportPromptVariables(
    rendered: RenderedPrompt,
    context: { agentKey: string; promptKey?: string },
): void {
    if (rendered.unresolved.length > 0) {
        logger.warn('Prompt has unresolved variables; they rendered empty', {
            ...context,
            unresolved: rendered.unresolved,
        });
    }
    if (rendered.fromCaller.length > 0) {
        logger.debug('Prompt variables filled from caller runtime context', {
            ...context,
            variables: rendered.fromCaller,
        });
    }
}

/**
 * The system prompt an agent runs with: its own text (or the one the caller
 * hands in), else the Prompts-module template its `promptKey` names, rendered
 * with the run's prompt variables. An inline prompt is rendered only when the
 * agent opted in or the text references a built-in (`shouldRenderInlinePrompt`),
 * so a literal `{{` in an existing prompt is left alone. Used for the agent's own
 * run and, with the referenced agent's own config, for a sub-agent that is
 * another agent: the same text it would run with on its own.
 */
export async function resolveAgentPrompt(input: {
    db: Pick<Awaited<ReturnType<typeof getDatabase>>, 'findPromptByKey'>;
    projectId: string;
    agentKey: string;
    config: IAgentConfig;
    systemPrompt: string | undefined;
    variables: ResolvedPromptVariables;
}): Promise<string | undefined> {
    const { config, agentKey } = input;
    let systemPrompt = input.systemPrompt;
    if (!systemPrompt && config.promptKey) {
        const prompt = await input.db.findPromptByKey(config.promptKey, input.projectId);
        if (prompt) {
            const rendered = renderPromptTemplate(prompt.template, input.variables);
            systemPrompt = rendered.text;
            reportPromptVariables(rendered, { agentKey, promptKey: config.promptKey });
        }
    } else if (systemPrompt && shouldRenderInlinePrompt(config, systemPrompt)) {
        const rendered = renderPromptTemplate(systemPrompt, input.variables);
        systemPrompt = rendered.text;
        reportPromptVariables(rendered, { agentKey });
    }
    return systemPrompt;
}
