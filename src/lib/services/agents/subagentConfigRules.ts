/**
 * What a stored delegation setup may say, as plain data checks. A leaf module
 * (types only) so the config validator and the manifest check share one rule
 * set: a value the SDK would quietly clamp or ignore is refused here instead,
 * where the owner can fix it.
 */

import type { IAgentConfig } from '@/lib/database';

type NumberRule = { min?: number; max?: number; integer?: boolean; exclusiveMin?: boolean };

export const SUBAGENT_MODES = ['off', 'registry_only', 'registry_and_adhoc'] as const;
export const CHILD_CONTEXT_POLICIES = ['minimal', 'scoped', 'full'] as const;

export const SUBAGENT_POLICY_LIMITS = {
    maxDepth: { min: 1, max: 5 },
    maxChildCalls: { min: 1, max: 50 },
    maxParallel: { min: 1, max: 16 },
} as const;

/** The limits a sub-agent's own run may carry (the same knobs and bounds as the agent's `runtime.limits`). */
export const SUBAGENT_RUN_LIMITS: Record<string, NumberRule> = {
    maxToolCalls: { min: 1, max: 500, integer: true },
    maxParallelTools: { min: 1, max: 50, integer: true },
    maxContextTokens: { min: 1_000, integer: true },
    maxTotalOutputTokens: { min: 1, integer: true },
    maxCostUsd: { min: 0, exclusiveMin: true },
    maxWallClockMs: { min: 1_000, integer: true },
};

export interface SubagentRuleIssue {
    field: string;
    message: string;
}

function numberIssue(field: string, value: unknown, rule: NumberRule): SubagentRuleIssue | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value)) return { field, message: 'must be a number' };
    if (rule.integer && !Number.isInteger(value)) return { field, message: 'must be a whole number' };
    if (rule.min !== undefined && (rule.exclusiveMin ? value <= rule.min : value < rule.min)) {
        return { field, message: `must be ${rule.exclusiveMin ? 'greater than' : 'at least'} ${rule.min}` };
    }
    if (rule.max !== undefined && value > rule.max) return { field, message: `must be at most ${rule.max}` };
    return undefined;
}

function enumIssue(field: string, value: unknown, allowed: readonly string[]): SubagentRuleIssue | undefined {
    if (value === undefined || value === null) return undefined;
    return typeof value === 'string' && allowed.includes(value) ? undefined : { field, message: `must be one of: ${allowed.join(', ')}` };
}

/** Problems in `subagentPolicy` and in each entry's `childContextPolicy` / `limits`. Field paths are relative to the config. */
export function subagentConfigIssues(config: Pick<IAgentConfig, 'subagents' | 'subagentPolicy'>): SubagentRuleIssue[] {
    const issues: SubagentRuleIssue[] = [];
    const push = (issue: SubagentRuleIssue | undefined) => { if (issue) issues.push(issue); };

    const policy = config.subagentPolicy;
    if (policy !== undefined && policy !== null) {
        if (typeof policy !== 'object' || Array.isArray(policy)) {
            issues.push({ field: 'subagentPolicy', message: 'must be an object' });
        } else {
            push(enumIssue('subagentPolicy.mode', policy.mode, SUBAGENT_MODES));
            push(enumIssue('subagentPolicy.childContextPolicy', policy.childContextPolicy, CHILD_CONTEXT_POLICIES));
            for (const [name, bounds] of Object.entries(SUBAGENT_POLICY_LIMITS)) {
                push(numberIssue(`subagentPolicy.${name}`, (policy as Record<string, unknown>)[name], { ...bounds, integer: true }));
            }
            if (policy.allowAdhocTools !== undefined && typeof policy.allowAdhocTools !== 'boolean') {
                issues.push({ field: 'subagentPolicy.allowAdhocTools', message: 'must be true or false' });
            }
        }
    }

    (config.subagents ?? []).forEach((entry, index) => {
        const field = `subagents[${index}]`;
        push(enumIssue(`${field}.childContextPolicy`, entry?.childContextPolicy, CHILD_CONTEXT_POLICIES));
        const limits = entry?.limits as Record<string, unknown> | undefined;
        if (limits === undefined || limits === null) return;
        if (typeof limits !== 'object' || Array.isArray(limits)) {
            issues.push({ field: `${field}.limits`, message: 'must be an object' });
            return;
        }
        for (const [name, rule] of Object.entries(SUBAGENT_RUN_LIMITS)) {
            push(numberIssue(`${field}.limits.${name}`, limits[name], rule));
        }
    });
    return issues;
}
