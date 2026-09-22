/**
 * OpenAPI specs for the three tools, as an operator would import them.
 *
 * The descriptions are the only documentation the model gets about these
 * APIs, so they are written the way a real team would write them — including
 * the LogQL hint on the infra source, which is where a model without it
 * would otherwise guess a query language.
 */

export function appLogsSpec(baseUrl: string) {
    return {
        openapi: '3.0.3',
        info: { title: 'App Logs', version: '1.0.0' },
        servers: [{ url: baseUrl }],
        paths: {
            '/logs/_search': {
                get: {
                    operationId: 'search_app_logs',
                    summary: 'Search application logs (per-service logs emitted by the apps themselves). Filter by service, level, free-text and time window.',
                    parameters: [
                        { name: 'service', in: 'query', schema: { type: 'string' }, description: 'Exact service name, e.g. checkout-api, auth-service, media-api, search-api.' },
                        { name: 'level', in: 'query', schema: { type: 'string', enum: ['DEBUG', 'INFO', 'WARN', 'ERROR'] }, description: 'Minimum-severity filter (exact level).' },
                        { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Case-insensitive substring to find in the message.' },
                        { name: 'from', in: 'query', schema: { type: 'string' }, description: 'ISO-8601 start of the window (inclusive).' },
                        { name: 'to', in: 'query', schema: { type: 'string' }, description: 'ISO-8601 end of the window (inclusive).' },
                        { name: 'size', in: 'query', schema: { type: 'integer' }, description: 'Max hits to return (default 50, max 200).' },
                    ],
                    responses: { 200: { description: 'Matching log entries' } },
                },
            },
        },
    };
}

export function infraLogsSpec(baseUrl: string) {
    return {
        openapi: '3.0.3',
        info: { title: 'Infra Logs', version: '1.0.0' },
        servers: [{ url: baseUrl }],
        paths: {
            '/loki/api/v1/query_range': {
                post: {
                    operationId: 'query_infra_logs',
                    summary: 'Query infrastructure logs (databases, caches, batch jobs, platform components) with LogQL. The body.query is a LogQL stream selector with optional line filters, e.g. {namespace="prod", app="postgres"} |= "connection". Label names: namespace, app, pod, node.',
                    requestBody: {
                        required: true,
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    required: ['query'],
                                    properties: {
                                        query: { type: 'string', description: 'LogQL, e.g. {namespace="prod", app="redis-sessions"} |= "memory"' },
                                        start: { type: 'string', description: 'ISO-8601 start of the window.' },
                                        end: { type: 'string', description: 'ISO-8601 end of the window.' },
                                        limit: { type: 'integer', description: 'Max lines (default 100).' },
                                    },
                                },
                            },
                        },
                    },
                    responses: { 200: { description: 'Log streams' } },
                },
            },
        },
    };
}

export function incidentCommentsSpec(baseUrl: string) {
    return {
        openapi: '3.0.3',
        info: { title: 'Incidents', version: '1.0.0' },
        servers: [{ url: baseUrl }],
        paths: {
            '/incidents/{incidentId}/comments': {
                post: {
                    operationId: 'post_incident_comment',
                    summary: 'Post the investigation result as a comment on the incident. Call exactly once, after the investigation is complete.',
                    parameters: [
                        { name: 'incidentId', in: 'path', required: true, schema: { type: 'string' }, description: 'Incident id, e.g. INC-4101.' },
                    ],
                    requestBody: {
                        required: true,
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    required: ['body'],
                                    properties: {
                                        body: { type: 'string', description: 'The full comment in Markdown.' },
                                        rootCause: { type: 'string', description: 'The root cause in one sentence.' },
                                        severity: { type: 'string', enum: ['SEV1', 'SEV2', 'SEV3'] },
                                    },
                                },
                            },
                        },
                    },
                    responses: { 201: { description: 'Comment created' } },
                },
            },
        },
    };
}
