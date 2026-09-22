/**
 * Scores one run on what the agent DID, not on what it said it did.
 *
 * Tool usage and ordering come from the run's steps (as the console recorded
 * them) cross-checked against the mock servers' own request logs; the root
 * cause is judged on the text that was actually delivered to the incident —
 * the posted comment for A, the formatted structured output for B, the reply
 * for C. A run "passes" only when every part of the procedure held: runbook
 * first, both log sources queried, correct root cause, delivered exactly once.
 */

import type { RecordedRequest } from './mockServers';
import type { Scenario } from './fixtures';

export interface RunStep {
    name: string;
    args?: unknown;
    error?: string;
    status?: string;
}

export interface RunObservation {
    scenario: Scenario;
    variant: string;
    httpStatus: number;
    error?: string;
    steps: RunStep[];
    requests: RecordedRequest[];
    /** The text delivered to the incident (post body), or undefined if nothing was delivered. */
    deliveredText?: string;
    /** The root-cause sentence when the variant has one as a field (A's rootCause, B's rootCause). */
    rootCauseField?: string;
    deliveries: number;
    deliveredToIncident?: string;
    schemaValid?: boolean;
    tokens: { input: number; output: number };
    latencyMs: number;
}

export interface RunScore {
    completed: boolean;
    kbFirst: boolean;
    usedAppLogs: boolean;
    usedInfraLogs: boolean;
    infraQueryErrors: number;
    toolCalls: number;
    toolErrors: number;
    rootCauseCorrect: boolean;
    blamedRedHerring: boolean;
    deliveredOnce: boolean;
    duplicateDelivery: boolean;
    rightIncident: boolean;
    schemaValid?: boolean;
    pass: boolean;
    failureReasons: string[];
}

const LOG_TOOLS = ['search_app_logs', 'query_infra_logs'];

export function rootCauseMatches(text: string, groups: string[][]): boolean {
    const haystack = text.toLowerCase();
    return groups.every((group) => group.some((needle) => haystack.includes(needle.toLowerCase())));
}

export function scoreRun(obs: RunObservation): RunScore {
    const reasons: string[] = [];
    const names = obs.steps.map((s) => s.name);
    const firstKb = names.indexOf('knowledge_search');
    const firstLog = names.findIndex((n) => LOG_TOOLS.includes(n));
    const kbFirst = firstKb !== -1 && (firstLog === -1 || firstKb < firstLog);

    // Cross-check against the servers: a step the console recorded but the
    // upstream never received (e.g. a guardrail block) does not count.
    const appHits = obs.requests.filter((r) => r.server === 'app-logs' && r.status === 200).length;
    const infraOk = obs.requests.filter((r) => r.server === 'infra-logs' && r.status === 200).length;
    const infraErrors = obs.requests.filter((r) => r.server === 'infra-logs' && r.status !== 200).length;
    const usedAppLogs = names.includes('search_app_logs') && appHits > 0;
    const usedInfraLogs = names.includes('query_infra_logs') && infraOk > 0;

    const completed = obs.httpStatus === 200 && !obs.error;
    const judged = obs.deliveredText ?? '';
    const rootCauseCorrect = completed && rootCauseMatches(judged, obs.scenario.rootCauseKeywords);
    const rootCauseSentence = (obs.rootCauseField ?? '').toLowerCase();
    const blamedRedHerring = rootCauseSentence.length > 0
        && rootCauseSentence.includes(obs.scenario.redHerring.toLowerCase())
        && !rootCauseMatches(rootCauseSentence, obs.scenario.rootCauseKeywords);

    const deliveredOnce = obs.deliveries === 1;
    const duplicateDelivery = obs.deliveries > 1;
    const rightIncident = obs.deliveredToIncident === obs.scenario.incidentId;

    if (!completed) reasons.push(`run failed: ${obs.error ?? `HTTP ${obs.httpStatus}`}`);
    if (!kbFirst) reasons.push(firstKb === -1 ? 'never searched the knowledge base' : 'searched logs before the knowledge base');
    if (!usedAppLogs) reasons.push('did not query app logs');
    if (!usedInfraLogs) reasons.push(infraErrors > 0 ? 'infra log queries all failed (bad LogQL)' : 'did not query infra logs');
    if (completed && !rootCauseCorrect) reasons.push('wrong or incomplete root cause');
    if (blamedRedHerring) reasons.push(`blamed the red herring (${obs.scenario.redHerring})`);
    if (obs.deliveries === 0) reasons.push('nothing delivered');
    if (duplicateDelivery) reasons.push(`delivered ${obs.deliveries} times`);
    if (obs.deliveries > 0 && !rightIncident) reasons.push(`posted to ${obs.deliveredToIncident ?? '?'}`);
    if (obs.schemaValid === false) reasons.push('structured output failed its schema');

    const pass = completed && kbFirst && usedAppLogs && usedInfraLogs && rootCauseCorrect
        && deliveredOnce && rightIncident && obs.schemaValid !== false;

    return {
        completed,
        kbFirst,
        usedAppLogs,
        usedInfraLogs,
        infraQueryErrors: infraErrors,
        toolCalls: obs.steps.length,
        toolErrors: obs.steps.filter((s) => s.error || s.status === 'error').length,
        rootCauseCorrect,
        blamedRedHerring,
        deliveredOnce,
        duplicateDelivery,
        rightIncident,
        ...(obs.schemaValid !== undefined ? { schemaValid: obs.schemaValid } : {}),
        pass,
        failureReasons: reasons,
    };
}
