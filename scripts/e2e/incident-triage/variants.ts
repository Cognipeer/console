/**
 * The three ways the finding can leave the agent — the question this test
 * exists to answer.
 *
 *  A. TOOL POST — the agent calls `post_incident_comment` itself.
 *  B. STRUCTURED — the agent returns a schema-checked object; the integration
 *     formats it and posts it (what the team does today).
 *  C. TEXT — the agent returns Markdown; the integration posts it verbatim.
 *
 * All three share the SAME investigation procedure, tools and knowledge base,
 * so any difference in the results comes from the delivery mechanism alone.
 */

export type VariantId = 'A-tool-post' | 'B-structured' | 'C-text';

const PROCEDURE = `You are the on-call incident investigator for our production platform.

For every problem you are given, follow this procedure:
1. FIRST search the knowledge base (knowledge_search) for the runbook matching the symptom. It tells you which services and components to check and which signals are red herrings.
2. Search the application logs (search_app_logs) for the affected service in the incident window.
3. Query the infrastructure logs (query_infra_logs, LogQL) for the component the runbook points at.
4. Decide the root cause ONLY from evidence you actually found. Separate the cause from its consequences and from background noise.

Unless the problem says otherwise, the incident window is today, 2026-09-22, between 09:00 and 10:00 UTC.`;

const COMMENT_FORMAT = `The comment is Markdown with these sections: **Root cause** (one sentence), **Evidence** (log lines with timestamps, from every source you used), **Affected services**, **Severity** (SEV1, SEV2 or SEV3) and **Recommended actions**.`;

export const STRUCTURED_SCHEMA = {
    type: 'object',
    required: ['incidentId', 'rootCause', 'evidence', 'affectedServices', 'severity', 'recommendedActions', 'confidence'],
    properties: {
        incidentId: { type: 'string', description: 'The incident id from the request, e.g. INC-4101.' },
        rootCause: { type: 'string', description: 'The root cause in one sentence.' },
        evidence: {
            type: 'array',
            description: 'Log lines that support the root cause.',
            items: {
                type: 'object',
                required: ['source', 'timestamp', 'line'],
                properties: {
                    source: { type: 'string', enum: ['app-logs', 'infra-logs', 'knowledge-base'] },
                    timestamp: { type: 'string' },
                    line: { type: 'string' },
                },
            },
        },
        affectedServices: { type: 'array', items: { type: 'string' } },
        severity: { type: 'string', enum: ['SEV1', 'SEV2', 'SEV3'] },
        recommendedActions: { type: 'array', items: { type: 'string' } },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    },
} as const;

export interface VariantDefinition {
    id: VariantId;
    name: string;
    systemPrompt: string;
    structuredOutput?: { enabled: true; schema: typeof STRUCTURED_SCHEMA };
    postsViaTool: boolean;
}

export const VARIANTS: VariantDefinition[] = [
    {
        id: 'A-tool-post',
        name: 'E2E Triage — tool post',
        postsViaTool: true,
        systemPrompt: `${PROCEDURE}
5. Post your finding exactly ONCE with post_incident_comment, on the incident id given in the request. ${COMMENT_FORMAT} Also fill rootCause and severity.
6. After posting, reply with a single line confirming the comment was posted. Do not post again.`,
    },
    {
        id: 'B-structured',
        name: 'E2E Triage — structured',
        postsViaTool: false,
        structuredOutput: { enabled: true, schema: STRUCTURED_SCHEMA },
        systemPrompt: `${PROCEDURE}
5. Return your finding in the required structured format. Do not post it anywhere — the incident system posts it for you.`,
    },
    {
        id: 'C-text',
        name: 'E2E Triage — text answer',
        postsViaTool: false,
        systemPrompt: `${PROCEDURE}
5. Your reply IS the incident comment and is posted verbatim — write nothing else. ${COMMENT_FORMAT}`,
    },
];

/** What the integration posts for variant B — structured fields rendered as the comment. */
export function formatStructuredComment(output: Record<string, unknown>): string {
    const list = (v: unknown) => (Array.isArray(v) ? v : []);
    const evidence = list(output.evidence)
        .map((e) => {
            const item = e as Record<string, unknown>;
            return `- \`${String(item.timestamp ?? '')}\` [${String(item.source ?? '')}] ${String(item.line ?? '')}`;
        })
        .join('\n');
    return [
        `**Root cause:** ${String(output.rootCause ?? '')}`,
        '',
        `**Evidence:**\n${evidence || '- (none given)'}`,
        '',
        `**Affected services:** ${list(output.affectedServices).join(', ')}`,
        `**Severity:** ${String(output.severity ?? '')}  ·  **Confidence:** ${String(output.confidence ?? '')}`,
        '',
        `**Recommended actions:**\n${list(output.recommendedActions).map((a) => `- ${String(a)}`).join('\n')}`,
    ].join('\n');
}
