/**
 * The pure half of Configure → Experience: how an edit lands in the stored
 * `config.experience` object. Absent stays absent — an agent nobody touched
 * must serialize exactly the config it had before the section existed — so
 * every edit that leaves nothing behind returns `undefined`.
 */

import type { IAgentExperienceConfig, IAgentStarter } from '@/lib/database/provider/types.domain';
import {
    AGENT_STARTERS_MAX,
    AGENT_STARTER_LABEL_MAX,
    AGENT_STARTER_TEXT_MAX,
    AGENT_WELCOME_MAX,
} from '@/lib/services/agents/agentExperience';

export { AGENT_STARTERS_MAX, AGENT_STARTER_LABEL_MAX, AGENT_STARTER_TEXT_MAX, AGENT_WELCOME_MAX };

/** The variables a welcome text may use, as the editor lists them. */
export const WELCOME_VARIABLES = ['{{user.name}}', '{{user.firstName}}', '{{agent.name}}', '{{portal.name}}'] as const;

function isEmpty(value: IAgentExperienceConfig): boolean {
    return !value.welcome && (value.starters ?? []).length === 0;
}

/** Applies a partial edit; an empty result is `undefined` (the key is dropped on save). */
export function patchExperience(
    value: IAgentExperienceConfig | undefined,
    patch: Partial<IAgentExperienceConfig>,
): IAgentExperienceConfig | undefined {
    const next: IAgentExperienceConfig = { ...(value ?? {}), ...patch };
    if (next.welcome !== undefined && next.welcome.trim() === '') delete next.welcome;
    if (next.starters !== undefined && next.starters.length === 0) delete next.starters;
    return isEmpty(next) ? undefined : next;
}

export function addStarter(value: IAgentExperienceConfig | undefined): IAgentExperienceConfig | undefined {
    const starters = value?.starters ?? [];
    if (starters.length >= AGENT_STARTERS_MAX) return value;
    // A blank row is kept while it is being typed; `patchExperience` would drop an empty list, not a blank starter.
    return { ...(value ?? {}), starters: [...starters, { text: '' }] };
}

export function updateStarter(
    value: IAgentExperienceConfig | undefined,
    index: number,
    patch: Partial<IAgentStarter>,
): IAgentExperienceConfig | undefined {
    const starters = [...(value?.starters ?? [])];
    if (!starters[index]) return value;
    const next: IAgentStarter = { ...starters[index], ...patch };
    if (next.label !== undefined && next.label.trim() === '') delete next.label;
    if (next.autoSend !== true) delete next.autoSend;
    starters[index] = next;
    return { ...(value ?? {}), starters };
}

export function removeStarter(value: IAgentExperienceConfig | undefined, index: number): IAgentExperienceConfig | undefined {
    const starters = (value?.starters ?? []).filter((_, i) => i !== index);
    return patchExperience(value, { starters });
}

export function moveStarter(value: IAgentExperienceConfig | undefined, from: number, to: number): IAgentExperienceConfig | undefined {
    const starters = [...(value?.starters ?? [])];
    if (from < 0 || from >= starters.length || to < 0 || to >= starters.length || from === to) return value;
    const [moved] = starters.splice(from, 1);
    starters.splice(to, 0, moved);
    return { ...(value ?? {}), starters };
}

export type ExperienceIssueCode = 'starter_text_required' | 'starter_text_too_long' | 'starter_label_too_long' | 'welcome_too_long';

export interface ExperienceIssue {
    field: string;
    code: ExperienceIssueCode;
}

/** What would stop a save, found without a round trip (the server checks the same). */
export function experienceSaveErrors(value: IAgentExperienceConfig | undefined): ExperienceIssue[] {
    const issues: ExperienceIssue[] = [];
    if (!value) return issues;
    if ((value.welcome ?? '').length > AGENT_WELCOME_MAX) issues.push({ field: 'experience.welcome', code: 'welcome_too_long' });
    (value.starters ?? []).forEach((starter, index) => {
        const field = `experience.starters.${index}`;
        if (starter.text.trim() === '') issues.push({ field: `${field}.text`, code: 'starter_text_required' });
        else if (starter.text.length > AGENT_STARTER_TEXT_MAX) issues.push({ field: `${field}.text`, code: 'starter_text_too_long' });
        if ((starter.label ?? '').length > AGENT_STARTER_LABEL_MAX) issues.push({ field: `${field}.label`, code: 'starter_label_too_long' });
    });
    return issues;
}

/** The stored object to save: blank starters (still being typed) left out, an empty result dropped. */
export function experienceForSave(value: IAgentExperienceConfig | undefined): IAgentExperienceConfig | undefined {
    if (!value) return undefined;
    const starters = (value.starters ?? [])
        .map((starter) => ({ ...starter, text: starter.text.trim() }))
        .filter((starter) => starter.text !== '');
    return patchExperience(undefined, {
        ...(value.welcome ? { welcome: value.welcome.trim() } : {}),
        starters,
    });
}
