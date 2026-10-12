/**
 * What a chat surface shows around an agent: the welcome text and the suggested
 * first messages. A portal, a widget or any other host reads this from the
 * agent's config (`config.experience`) and may override it per portal.
 *
 * Everything here is pure: the checks run when a config is saved, the
 * normaliser when a surface reads it, and the template renderer when a surface
 * greets a person.
 */

import type { IAgentConfig, IAgentExperienceConfig, IAgentStarter } from '@/lib/database';

/** How many starters an agent may offer. */
export const AGENT_STARTERS_MAX = 6;
export const AGENT_STARTER_TEXT_MAX = 500;
export const AGENT_STARTER_LABEL_MAX = 60;
export const AGENT_WELCOME_MAX = 2000;

export interface AgentExperienceIssue {
    field: string;
    message: string;
}

/** The checks of a saved `config.experience`; errors block the save. */
export function validateExperienceConfig(config: Pick<IAgentConfig, 'experience'>): { errors: AgentExperienceIssue[] } {
    const errors: AgentExperienceIssue[] = [];
    const experience = config.experience;
    if (experience === undefined || experience === null) return { errors };
    if (typeof experience !== 'object' || Array.isArray(experience)) {
        errors.push({ field: 'experience', message: 'must be an object' });
        return { errors };
    }
    if (experience.welcome !== undefined && experience.welcome !== null) {
        if (typeof experience.welcome !== 'string') {
            errors.push({ field: 'experience.welcome', message: 'must be text' });
        } else if (experience.welcome.length > AGENT_WELCOME_MAX) {
            errors.push({ field: 'experience.welcome', message: `must be at most ${AGENT_WELCOME_MAX} characters` });
        }
    }
    if (experience.starters !== undefined && experience.starters !== null) {
        if (!Array.isArray(experience.starters)) {
            errors.push({ field: 'experience.starters', message: 'must be a list' });
        } else {
            if (experience.starters.length > AGENT_STARTERS_MAX) {
                errors.push({ field: 'experience.starters', message: `at most ${AGENT_STARTERS_MAX} starters` });
            }
            experience.starters.forEach((starter, index) => {
                const field = `experience.starters.${index}`;
                if (!starter || typeof starter !== 'object') {
                    errors.push({ field, message: 'must be an object with a text' });
                    return;
                }
                if (typeof starter.text !== 'string' || starter.text.trim() === '') {
                    errors.push({ field: `${field}.text`, message: 'Write the message the starter sends' });
                } else if (starter.text.length > AGENT_STARTER_TEXT_MAX) {
                    errors.push({ field: `${field}.text`, message: `must be at most ${AGENT_STARTER_TEXT_MAX} characters` });
                }
                if (starter.label !== undefined && starter.label !== null) {
                    if (typeof starter.label !== 'string') errors.push({ field: `${field}.label`, message: 'must be text' });
                    else if (starter.label.length > AGENT_STARTER_LABEL_MAX) {
                        errors.push({ field: `${field}.label`, message: `must be at most ${AGENT_STARTER_LABEL_MAX} characters` });
                    }
                }
                if (starter.autoSend !== undefined && typeof starter.autoSend !== 'boolean') {
                    errors.push({ field: `${field}.autoSend`, message: 'must be true or false' });
                }
            });
        }
    }
    if (experience.clientTools !== undefined && experience.clientTools !== null) {
        const clientTools = experience.clientTools as unknown;
        if (typeof clientTools !== 'object' || Array.isArray(clientTools)) {
            errors.push({ field: 'experience.clientTools', message: 'must be an object' });
        } else {
            const enabled = (clientTools as { enabled?: unknown }).enabled;
            if (enabled !== undefined && typeof enabled !== 'boolean') {
                errors.push({ field: 'experience.clientTools.enabled', message: 'must be true or false' });
            }
        }
    }
    return { errors };
}

/**
 * Has the agent's author agreed to take tools from the page that embeds the chat?
 * What such a tool returns is typed in the end user's browser, so an agent only
 * gets them when this is explicitly on; the runtime offers a host's declared tools
 * to no other agent.
 */
export function agentAcceptsClientTools(config: Pick<IAgentConfig, 'experience'> | undefined | null): boolean {
    const experience = config?.experience;
    if (!experience || typeof experience !== 'object') return false;
    const clientTools = experience.clientTools;
    return Boolean(clientTools) && typeof clientTools === 'object' && clientTools?.enabled === true;
}

export interface ResolvedAgentExperience {
    starters: IAgentStarter[];
    /** Markdown, as stored (variables are not yet filled in). */
    welcome?: string;
}

/**
 * The experience as a surface reads it: starters trimmed, empty ones dropped,
 * the list capped, `autoSend` always present. An agent that never set any gets
 * no starters and no welcome.
 */
export function resolveAgentExperience(config: Pick<IAgentConfig, 'experience'> | undefined | null): ResolvedAgentExperience {
    const experience: IAgentExperienceConfig = config?.experience && typeof config.experience === 'object' ? config.experience : {};
    const starters: IAgentStarter[] = [];
    for (const starter of Array.isArray(experience.starters) ? experience.starters : []) {
        const text = typeof starter?.text === 'string' ? starter.text.trim().slice(0, AGENT_STARTER_TEXT_MAX) : '';
        if (!text) continue;
        const label = typeof starter.label === 'string' ? starter.label.trim().slice(0, AGENT_STARTER_LABEL_MAX) : '';
        starters.push({ text, ...(label ? { label } : {}), autoSend: starter.autoSend === true });
        if (starters.length >= AGENT_STARTERS_MAX) break;
    }
    const welcome = typeof experience.welcome === 'string' ? experience.welcome.trim().slice(0, AGENT_WELCOME_MAX) : '';
    return { starters, ...(welcome ? { welcome } : {}) };
}

/** What a welcome template may name. */
export interface WelcomeVariables {
    user?: { name?: string | null; email?: string | null };
    portal?: { name?: string | null };
    agent?: { name?: string | null };
}

const MARKDOWN_SPECIALS = /[\\`*_{}[\]()#+\-.!|~<>&"']/g;
const MAX_VARIABLE_CHARS = 80;

/**
 * A value that may appear inside Markdown without being read as Markdown: control
 * characters and line breaks become spaces, the text is cut, and every character
 * with a Markdown or HTML meaning is backslash-escaped. A person's display name is
 * their own to choose, so it must not be able to add a link, an image or a tag
 * to a greeting.
 */
export function escapeForMarkdown(value: string): string {
    const flat = value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_VARIABLE_CHARS);
    return flat.replace(MARKDOWN_SPECIALS, (character) => `\\${character}`);
}

function firstNameOf(user: WelcomeVariables['user']): string {
    const name = user?.name?.trim();
    if (name) return name.split(/\s+/)[0] ?? '';
    const local = user?.email?.split('@')[0]?.trim();
    return local ?? '';
}

/**
 * Fills `{{user.name}}`, `{{user.firstName}}`, `{{portal.name}}` and
 * `{{agent.name}}` in a welcome template on the server, escaping each value (see
 * {@link escapeForMarkdown}). A name nobody gave is an empty string; any other
 * `{{…}}` is left as it is.
 */
export function renderWelcomeTemplate(template: string, variables: WelcomeVariables): string {
    const values: Record<string, string> = {
        'user.name': variables.user?.name?.trim() || variables.user?.email?.split('@')[0]?.trim() || '',
        'user.firstName': firstNameOf(variables.user),
        'portal.name': variables.portal?.name?.trim() ?? '',
        'agent.name': variables.agent?.name?.trim() ?? '',
    };
    return template.replace(/\{\{\s*([a-zA-Z.]+)\s*\}\}/g, (whole, key: string) => (
        Object.prototype.hasOwnProperty.call(values, key) ? escapeForMarkdown(values[key]) : whole
    )).trim();
}

/** A client-API view of the experience (snake_case), or undefined when the agent set none. */
export function toClientExperience(config: Pick<IAgentConfig, 'experience'> | undefined | null) {
    const resolved = resolveAgentExperience(config);
    if (resolved.starters.length === 0 && !resolved.welcome) return undefined;
    return {
        ...(resolved.welcome ? { welcome: resolved.welcome } : {}),
        starters: resolved.starters.map((starter) => ({
            text: starter.text,
            ...(starter.label ? { label: starter.label } : {}),
            auto_send: starter.autoSend === true,
        })),
    };
}
