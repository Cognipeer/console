/**
 * The world the incident-triage agent is dropped into.
 *
 * Three things, deliberately kept apart so each can be wrong on its own:
 *
 *  - CONFLUENCE: runbooks. They say where to look and what a known failure
 *    looks like, but never name today's incident — the agent has to learn the
 *    procedure here and apply it elsewhere.
 *  - APP LOGS (an Elasticsearch-shaped search API) and INFRA LOGS (a
 *    Loki-shaped query API): two sources with different shapes, as in real
 *    life. The root cause of every incident needs BOTH — the app log shows the
 *    symptom, the infra log shows why — so an agent that stops after one
 *    source gets a plausible, wrong answer.
 *  - SCENARIOS: the problems, each with a ground truth the scorer checks.
 *
 * Every log set carries noise (healthy traffic, unrelated warnings) and every
 * scenario has one tempting wrong answer, because a fixture where the first
 * ERROR line is the answer measures nothing.
 */

export interface ConfluencePage {
    id: string;
    title: string;
    space: string;
    /** Confluence "storage" format — XHTML, as the REST API returns it. */
    storage: string;
    version: number;
}

export interface AppLogEntry {
    '@timestamp': string;
    service: string;
    level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
    message: string;
    trace_id?: string;
}

export interface InfraLogLine {
    ts: string;
    labels: { namespace: string; app: string; pod?: string; node?: string };
    line: string;
}

export interface Scenario {
    id: string;
    incidentId: string;
    /** What the on-call engineer types. Symptom only — never the cause. */
    problem: string;
    /** All of these (case-insensitive, any one alternative per group) must appear. */
    rootCauseKeywords: string[][];
    /** The plausible wrong answer an app-log-only investigation reaches. */
    redHerring: string;
    /** Services the right answer names. */
    affectedServices: string[];
}

const T = (min: number, sec = 0) => `2026-09-22T09:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}Z`;

// ── Confluence ───────────────────────────────────────────────────────────

export const CONFLUENCE_SPACE = 'OPS';

export const CONFLUENCE_PAGES: ConfluencePage[] = [
    {
        id: '1001',
        title: 'Runbook: checkout returns 502 / 504',
        space: CONFLUENCE_SPACE,
        version: 7,
        storage: `
<h2>Symptoms</h2>
<p>Customers see 502 or 504 on <code>POST /checkout</code>. The checkout-api pods stay up.</p>
<h2>Where to look</h2>
<ol>
<li>App logs for <strong>checkout-api</strong>: look for connection-pool errors (<code>HikariPool</code>, "Connection is not available").</li>
<li>If the pool is exhausted, the cause is almost never the application. Check the <strong>postgres</strong> infra logs in namespace <code>prod</code> for <code>too many connections</code> / <code>max_connections</code>.</li>
<li>A deploy that scaled checkout-api replicas multiplies pool size by replica count — compare against postgres max_connections.</li>
</ol>
<h2>Known red herring</h2>
<p>payment-gateway timeouts appear in the same window but are a consequence, not the cause.</p>`,
    },
    {
        id: '1002',
        title: 'Runbook: slow logins',
        space: CONFLUENCE_SPACE,
        version: 3,
        storage: `
<h2>Symptoms</h2>
<p>Login takes more than 5s; auth-service p95 latency alert fires.</p>
<h2>Where to look</h2>
<ol>
<li>auth-service app logs: session reads from the session store.</li>
<li>Session store is <strong>redis-sessions</strong>. Check its infra logs (namespace <code>prod</code>, app <code>redis-sessions</code>) for memory pressure: <code>maxmemory</code>, evictions, OOM.</li>
</ol>
<p>Note: the user-db warnings about slow queries are background noise from the nightly report job.</p>`,
    },
    {
        id: '1003',
        title: 'Runbook: file uploads failing',
        space: CONFLUENCE_SPACE,
        version: 5,
        storage: `
<h2>Symptoms</h2>
<p>Uploads fail with 500 from <strong>media-api</strong>.</p>
<h2>Where to look</h2>
<ol>
<li>media-api app logs: storage errors. <code>AccessDenied</code> / <code>InvalidAccessKeyId</code> means credentials, not capacity.</li>
<li>Credentials are rotated by the <strong>secret-rotator</strong> job. Check infra logs (namespace <code>platform</code>, app <code>secret-rotator</code>) for the last rotation, and whether media-api was restarted afterwards to pick up the new key.</li>
</ol>`,
    },
    {
        id: '1004',
        title: 'Runbook: stale search results',
        space: CONFLUENCE_SPACE,
        version: 2,
        storage: `
<h2>Symptoms</h2>
<p>New products do not appear in search for hours.</p>
<h2>Where to look</h2>
<ol>
<li>search-api app logs show the index generation it is serving.</li>
<li>The index is rebuilt by the <strong>reindex-cron</strong> job (namespace <code>batch</code>). Check its infra logs for failures — the job is memory-hungry and is the usual suspect.</li>
</ol>`,
    },
    {
        id: '1005',
        title: 'On-call: how to write an incident comment',
        space: CONFLUENCE_SPACE,
        version: 9,
        storage: `
<p>Every incident comment states: the <strong>root cause</strong> in one sentence, the <strong>evidence</strong> (log lines with timestamps, from each source you used), the <strong>affected services</strong>, a <strong>severity</strong> (SEV1–SEV3) and the <strong>recommended actions</strong>.</p>
<p>Do not speculate beyond the evidence. If the logs do not support a cause, say so.</p>`,
    },
];

// ── App logs (Elasticsearch-shaped) ──────────────────────────────────────

export const APP_LOGS: AppLogEntry[] = [
    // healthy noise
    { '@timestamp': T(0), service: 'catalog-api', level: 'INFO', message: 'GET /products 200 38ms' },
    { '@timestamp': T(1), service: 'checkout-api', level: 'INFO', message: 'POST /checkout 200 212ms' },
    { '@timestamp': T(1, 30), service: 'user-db-reporter', level: 'WARN', message: 'slow query: SELECT * FROM orders_report (4120ms)' },
    // scenario: checkout 502
    { '@timestamp': T(12), service: 'checkout-api', level: 'INFO', message: 'deployment checkout-api v2.14.0 rolled out: replicas 6 -> 18' },
    { '@timestamp': T(14, 5), service: 'checkout-api', level: 'ERROR', message: 'HikariPool-1 - Connection is not available, request timed out after 30000ms', trace_id: 'a1' },
    { '@timestamp': T(14, 6), service: 'payment-gateway', level: 'WARN', message: 'upstream checkout-api timed out after 30s' },
    { '@timestamp': T(14, 9), service: 'checkout-api', level: 'ERROR', message: 'POST /checkout 502 30011ms', trace_id: 'a1' },
    { '@timestamp': T(15, 2), service: 'checkout-api', level: 'ERROR', message: 'HikariPool-1 - Connection is not available, request timed out after 30000ms', trace_id: 'a2' },
    // scenario: slow logins
    { '@timestamp': T(20), service: 'auth-service', level: 'WARN', message: 'session store read took 4870ms (key=sess:9f2)' },
    { '@timestamp': T(20, 4), service: 'auth-service', level: 'ERROR', message: 'redis command timeout: GET sess:77a after 5000ms' },
    { '@timestamp': T(20, 9), service: 'user-db-reporter', level: 'WARN', message: 'slow query: SELECT * FROM users_activity (5230ms)' },
    // scenario: uploads
    { '@timestamp': T(31), service: 'media-api', level: 'ERROR', message: 'PutObject failed: AccessDenied (InvalidAccessKeyId) bucket=media-prod' },
    { '@timestamp': T(31, 3), service: 'media-api', level: 'ERROR', message: 'POST /upload 500 91ms' },
    { '@timestamp': T(31, 20), service: 'media-api', level: 'WARN', message: 'disk usage 71% on /tmp/uploads' },
    // scenario: stale search
    { '@timestamp': T(40), service: 'search-api', level: 'INFO', message: 'serving index generation 2026-09-21T02:00 (age 31h)' },
    { '@timestamp': T(40, 2), service: 'search-api', level: 'WARN', message: 'index age exceeds 24h freshness budget' },
];

// ── Infra logs (Loki-shaped) ─────────────────────────────────────────────

export const INFRA_LOGS: InfraLogLine[] = [
    { ts: T(0), labels: { namespace: 'prod', app: 'postgres', pod: 'postgres-0' }, line: 'checkpoint complete: wrote 1822 buffers' },
    { ts: T(14), labels: { namespace: 'prod', app: 'postgres', pod: 'postgres-0' }, line: 'FATAL: sorry, too many clients already (max_connections=200, in use 200)' },
    { ts: T(14, 3), labels: { namespace: 'prod', app: 'postgres', pod: 'postgres-0' }, line: 'FATAL: remaining connection slots are reserved for non-replication superuser connections' },
    { ts: T(13), labels: { namespace: 'prod', app: 'payment-gateway', pod: 'pg-7c' }, line: 'readiness probe ok' },
    { ts: T(19, 58), labels: { namespace: 'prod', app: 'redis-sessions', pod: 'redis-sessions-0' }, line: 'WARNING: used_memory 3.98G reached maxmemory 4G, policy=noeviction' },
    { ts: T(20, 1), labels: { namespace: 'prod', app: 'redis-sessions', pod: 'redis-sessions-0' }, line: 'OOM command not allowed when used memory > maxmemory' },
    { ts: T(20, 5), labels: { namespace: 'prod', app: 'user-db', pod: 'user-db-0' }, line: 'autovacuum: VACUUM public.users_activity' },
    { ts: T(29, 55), labels: { namespace: 'platform', app: 'secret-rotator' }, line: 'rotated secret media-prod-storage-key (new version v42); consumers notified: none restarted' },
    { ts: T(30, 10), labels: { namespace: 'prod', app: 'media-api', pod: 'media-api-5d' }, line: 'container running since 2026-09-20T11:03Z (no restart)' },
    { ts: T(2), labels: { namespace: 'batch', app: 'reindex-cron' }, line: 'job reindex-cron-2894 started' },
    { ts: T(2, 44), labels: { namespace: 'batch', app: 'reindex-cron', node: 'batch-node-3' }, line: 'container reindex killed: OOMKilled (limit 2Gi)' },
    { ts: T(2, 45), labels: { namespace: 'batch', app: 'reindex-cron' }, line: 'job reindex-cron-2894 failed, backoffLimit reached' },
];

// ── Scenarios ────────────────────────────────────────────────────────────

export const SCENARIOS: Scenario[] = [
    {
        id: 'checkout-502',
        incidentId: 'INC-4101',
        problem: 'Customers are getting 502 errors when they try to check out, since about 09:14 UTC today.',
        rootCauseKeywords: [['connection', 'max_connections', 'too many clients'], ['postgres', 'database', 'db']],
        redHerring: 'payment-gateway',
        affectedServices: ['checkout-api', 'postgres'],
    },
    {
        id: 'slow-login',
        incidentId: 'INC-4102',
        problem: 'Logins are very slow right now, several seconds each. Started around 09:20 UTC.',
        rootCauseKeywords: [['redis', 'session store', 'redis-sessions'], ['maxmemory', 'memory', 'oom']],
        redHerring: 'user-db',
        affectedServices: ['auth-service', 'redis-sessions'],
    },
    {
        id: 'upload-failures',
        incidentId: 'INC-4103',
        problem: 'File uploads fail with a server error for everyone since 09:31 UTC.',
        rootCauseKeywords: [['rotat', 'credential', 'access key', 'secret'], ['restart', 'not restarted', 'none restarted', 'picked up', 'old key', 'stale']],
        redHerring: 'disk',
        affectedServices: ['media-api'],
    },
    {
        id: 'stale-search',
        incidentId: 'INC-4104',
        problem: 'New products are not showing up in search results; the index looks more than a day old.',
        rootCauseKeywords: [['reindex'], ['oom', 'memory', 'killed']],
        redHerring: 'search-api',
        affectedServices: ['search-api', 'reindex-cron'],
    },
];
