/**
 * Which Configure section owns which config keys — used to tell a reviewer
 * which sections of the saved draft differ from the published version.
 *
 * Compared on the saved agent (not the unsaved form): "changed" here means
 * "publishing would change this", the question someone asks before pressing
 * Publish. Both sides come from redacted API responses, so masked secrets
 * compare equal to themselves and never leak a false "changed".
 */

/** The section headings as Build shows them. */
export const CONFIG_SECTION_TITLES: Record<string, string> = {
    basic: 'General',
    prompt: 'Prompt',
    subagents: 'Delegation',
    skills: 'Skills',
    memory: 'Memory',
    sandbox: 'Sandbox',
    callback: 'Callback & budget',
    files: 'Files',
    hitl: 'Approvals & questions',
    clienttools: 'Client tools',
    advanced: 'Runtime',
    variables: 'Variables',
    output: 'Structured output',
};

/**
 * Sections whose heading is translated: the message key under `agents`. The
 * rest of the headings are English until their sections are localized.
 */
export const CONFIG_SECTION_TITLE_KEYS: Record<string, string> = {
    callback: 'runSettings.sectionTitle',
    files: 'attachments.sectionTitle',
    hitl: 'hitl.sectionTitle',
    clienttools: 'clientTools.sectionTitle',
    variables: 'variables.sectionTitle',
};

/** A section's heading in the viewer's language — `translate` is `useTranslations('agents')`. */
export function configSectionTitle(id: string, translate: (key: string) => string): string {
    const key = CONFIG_SECTION_TITLE_KEYS[id];
    return key ? translate(key) : CONFIG_SECTION_TITLES[id] ?? id;
}

export const CONFIG_SECTION_KEYS: Record<string, string[]> = {
    basic: ['modelKey', 'reasoningEffort', 'reasoningBudgetTokens', 'showReasoning', 'additionalModels', 'knowledgeEngineKey', 'toolBindings', 'guardrails', 'inputGuardrailKey', 'outputGuardrailKey'],
    prompt: ['systemPrompt', 'promptKey', 'promptVariables'],
    subagents: ['subagents', 'subagentPolicy'],
    skills: ['skills', 'skillPolicy'],
    memory: ['memory'],
    sandbox: ['sandbox'],
    callback: ['callback', 'budget'],
    files: ['attachments'],
    hitl: ['humanInTheLoop'],
    clienttools: ['clientTools'],
    advanced: ['runtime', 'reminders'],
    variables: ['variables'],
    output: ['structuredOutput'],
};

/** JSON with sorted keys, and `undefined` / `null` / empty containers treated as absent. */
function canonical(value: unknown): string {
    const normalise = (input: unknown): unknown => {
        if (input === null || input === undefined) return undefined;
        if (Array.isArray(input)) {
            const items = input.map(normalise);
            return items.length === 0 ? undefined : items;
        }
        if (typeof input === 'object') {
            const entries = Object.keys(input as Record<string, unknown>)
                .sort()
                .map((key) => [key, normalise((input as Record<string, unknown>)[key])] as const)
                .filter(([, v]) => v !== undefined);
            return entries.length === 0 ? undefined : Object.fromEntries(entries);
        }
        return input;
    };
    return JSON.stringify(normalise(value) ?? null);
}

/**
 * Section ids whose keys differ between `draft` and `published`. With no
 * published version there is nothing to differ from, so nothing is flagged.
 */
export function changedConfigSections(
    draft: Record<string, unknown> | undefined,
    published: Record<string, unknown> | null | undefined,
): Set<string> {
    const changed = new Set<string>();
    if (!draft || !published) return changed;
    for (const [section, keys] of Object.entries(CONFIG_SECTION_KEYS)) {
        const a = Object.fromEntries(keys.map((key) => [key, draft[key]]));
        const b = Object.fromEntries(keys.map((key) => [key, published[key]]));
        if (canonical(a) !== canonical(b)) changed.add(section);
    }
    return changed;
}
