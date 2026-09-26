/**
 * Prompt variables for agents.
 *
 * The agent runtime used to call `Mustache.render(prompt.template, {})` with a
 * literally empty context, so every `{{variable}}` in a shared prompt rendered
 * to an empty string. The prompt looked fine in the Prompts module, ran hollow
 * under an agent, and nothing anywhere said so.
 *
 * Values come from three places, lowest precedence first:
 *
 *   1. `config.promptVariables` — static defaults set on the agent
 *   2. `runtimeContext.metadata` — per-call values from the caller
 *   3. built-ins (`agent`, `now`, `user`) — written last, so a caller cannot
 *      forge the agent's own identity into the prompt
 *
 * A caller can only fill placeholders the prompt author wrote: Mustache renders
 * declared tags and ignores everything else, so extra metadata keys are inert.
 * That is the boundary that keeps this from being an open prompt-injection
 * surface — it is still caller text entering the system prompt, which is why
 * every resolved variable is reported back for tracing.
 */

import Mustache from 'mustache';

import type { IAgentConfig } from '@/lib/database/provider/types.domain';
import type { AgentRuntimeContext } from '@/lib/services/runtimeContext';

/** Reserved top-level names the caller cannot override. */
export const BUILT_IN_PROMPT_VARIABLES = ['agent', 'now', 'user'] as const;
const BUILT_INS: ReadonlySet<string> = new Set(BUILT_IN_PROMPT_VARIABLES);

export interface PromptVariableInput {
    config: IAgentConfig;
    agentKey: string;
    agentName: string;
    /** Resolved version, when the run is pinned to one. */
    version?: number | null;
    runtimeContext?: AgentRuntimeContext;
    userId?: string;
}

export interface ResolvedPromptVariables {
    /** The render context handed to Mustache. */
    values: Record<string, unknown>;
    /** Names that were filled from caller-supplied runtime metadata. */
    fromCaller: string[];
}

/**
 * Names a Mustache template references at the top level.
 *
 * `Mustache.parse` is used rather than a regex so that sections, inverted
 * sections and comments are classified correctly — `{{#items}}` is a section,
 * not a missing variable, and reporting it as unresolved would train operators
 * to ignore the warning.
 */
export function collectTemplateVariables(template: string): string[] {
    const names = new Set<string>();
    try {
        for (const token of Mustache.parse(template)) {
            const [type, name] = token as unknown as [string, string];
            // 'name' = {{x}}, '&' = {{&x}}, '#'/'^' = sections (still a lookup).
            if (type === 'name' || type === '&' || type === '#' || type === '^') {
                names.add(String(name).split('.')[0]);
            }
        }
    } catch {
        // An unparseable template is the Prompts module's problem, not ours;
        // rendering below will surface it the same way it always did.
        return [];
    }
    return [...names];
}

export function buildPromptVariables(input: PromptVariableInput): ResolvedPromptVariables {
    const defaults = input.config.promptVariables ?? {};
    const metadata = input.runtimeContext?.metadata ?? {};

    const fromCaller: string[] = [];
    const values: Record<string, unknown> = { ...defaults };

    for (const [key, value] of Object.entries(metadata)) {
        if (BUILT_INS.has(key)) continue;
        values[key] = value;
        fromCaller.push(key);
    }

    const now = new Date();
    values.agent = {
        key: input.agentKey,
        name: input.agentName,
        version: input.version ?? null,
    };
    values.now = {
        iso: now.toISOString(),
        date: now.toISOString().slice(0, 10),
        // Deliberately UTC: a server-local time in a prompt makes the same agent
        // answer differently depending on which replica served the request.
        time: now.toISOString().slice(11, 19),
    };
    values.user = { id: input.userId ?? input.runtimeContext?.userId ?? null };

    return { values, fromCaller };
}

export interface RenderedPrompt {
    text: string;
    unresolved: string[];
    fromCaller: string[];
}

/**
 * Renders a prompt template with the resolved variables.
 *
 * Unresolved placeholders still render empty — that is Mustache's behaviour and
 * changing it would break prompts that rely on an optional variable — but they
 * are returned so the caller can log them. Silently hollow is the bug this
 * module exists to fix; empty-and-reported is a decision.
 */
export function renderPromptTemplate(
    template: string,
    resolved: ResolvedPromptVariables,
): RenderedPrompt {
    const referenced = collectTemplateVariables(template);
    const unresolved = referenced.filter((name) => {
        const value = resolved.values[name];
        return value === undefined || value === null || value === '';
    });

    return {
        text: Mustache.render(template, resolved.values),
        unresolved,
        fromCaller: resolved.fromCaller.filter((name) => referenced.includes(name)),
    };
}

/**
 * True when an inline system prompt should go through Mustache at all.
 *
 * Inline prompts were never rendered, so turning rendering on unconditionally
 * would silently eat a literal `{{` in someone's existing prompt. It is
 * triggered by either of two explicit signals:
 *
 *  - the agent declares prompt variables, or
 *  - the template references a BUILT-IN (`{{now}}`, `{{agent}}`, `{{user}}`).
 *
 * The second is not optional. Declaring variables was a settings-screen act,
 * and that screen was removed in favour of managing the prompt directly — so
 * with only the first trigger, `Şu anda saat {{now}}` reached the model
 * literally, braces and all. Nobody writes `{{now}}` into a prompt meaning
 * the two braces.
 */
export function shouldRenderInlinePrompt(config: IAgentConfig, template?: string): boolean {
    if (Object.keys(config.promptVariables ?? {}).length > 0) return true;
    if (!template) return false;
    const referenced = collectTemplateVariables(template);
    return referenced.some((name) => BUILT_INS.has(name));
}
