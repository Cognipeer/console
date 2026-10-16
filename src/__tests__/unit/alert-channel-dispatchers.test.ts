import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const h = vi.hoisted(() => ({
  safeFetch: vi.fn(),
  assertPublicUrl: vi.fn(),
  sendEmail: vi.fn(),
  db: { listUsers: vi.fn() },
  logLines: [] as string[],
}));

vi.mock('@/lib/security/outboundFetch', () => ({ safeFetch: h.safeFetch, assertPublicUrl: h.assertPublicUrl }));
vi.mock('@/lib/email/mailer', () => ({ sendEmail: h.sendEmail }));
vi.mock('@/lib/database', () => ({ getTenantDatabase: vi.fn(async () => h.db) }));
vi.mock('@/lib/core/logger', () => {
  const write = (...args: unknown[]) => { h.logLines.push(JSON.stringify(args)); };
  const logger = { debug: write, info: write, warn: write, error: write };
  return { createLogger: () => logger };
});

import {
  assertPublicChannelUrl,
  buildNotificationMessage,
  ChannelUrlError,
  dispatchNotification,
  getChannel,
  isValidPagerDutyRoutingKey,
  maskChannels,
  resolveAlertEmailRecipients,
  sealChannels,
  sendChannelMessage,
} from '@/lib/services/alerts/channels';
import { buildAlertEmailData, resetAlertEmailUserCache } from '@/lib/services/alerts/channels/emailChannel';
import { buildSlackPayload } from '@/lib/services/alerts/channels/slackChannel';
import { buildTeamsPayload, escapeTeamsMarkdown } from '@/lib/services/alerts/channels/teamsChannel';
import { pagerDutyDedupKey } from '@/lib/services/alerts/channels/pagerDutyChannel';
import { signWebhookBody } from '@/lib/services/webhooks/webhookDeliverer';
import type { AlertContext, AlertNotification } from '@/lib/services/alerts/channels/types';
import type { IAlertChannel } from '@/lib/database';

const SLACK_URL = 'https://hooks.slack.com/services/T000/B000/slackSECRETtoken';
const TEAMS_URL = 'https://example.webhook.office.com/webhookb2/teams-secret-guid/IncomingWebhook/cccc/dddd';
const HOOK_URL = 'https://hooks.example.com/alerts/receive?token=very-secret-token';
const HOOK_SECRET = 'whsec_topsecretvalue';
const ROUTING_KEY = 'R0123456789abcdefghijklmnopqrstu';
const ALL_SECRETS = ['slackSECRETtoken', 'teams-secret-guid', 'very-secret-token', HOOK_SECRET, ROUTING_KEY];

const ctx: AlertContext = {
  tenantDbName: 'tenant_acme', tenantId: 't1', tenantSlug: 'acme', companyName: 'Acme', projectName: 'Prod',
  dashboardUrl: 'https://console.test/dashboard/alerts/incidents', incidentUrl: 'https://console.test/dashboard/alerts/incidents/inc1', incidentId: 'inc1',
};

function notification(over: Partial<AlertNotification> = {}): AlertNotification {
  return {
    kind: 'fired',
    rule: {
      id: 'rule1', name: 'Pulse Main failing', module: 'agents', metric: 'agent_error_rate', metricLabel: 'Agent error rate',
      unit: '%', mode: 'threshold', windowMinutes: 15, operator: 'gt', threshold: 10,
    },
    entity: { type: 'agent', key: 'Pulse Main' },
    value: 27.5,
    severity: 'critical',
    firedAt: new Date('2026-10-15T12:30:00Z'),
    projectName: 'Prod', companyName: 'Acme',
    incidentUrl: ctx.incidentUrl, dashboardUrl: ctx.dashboardUrl,
    context: {
      mode: 'threshold', windowMinutes: 15,
      versionChange: { from: '1.4.0', to: '1.5.0' },
      errorSignatures: [{ message: 'Upstream timeout', count: 12 }],
    },
    ...over,
  };
}

async function channels(): Promise<Record<string, IAlertChannel>> {
  const [email, webhook, slack, teams, pagerduty] = await sealChannels([
    { type: 'email', recipients: ['ops@acme.test'] },
    { type: 'webhook', url: HOOK_URL, secret: HOOK_SECRET },
    { type: 'slack', url: SLACK_URL },
    { type: 'teams', url: TEAMS_URL },
    { type: 'pagerduty', routingKey: ROUTING_KEY },
  ]);
  return { email: email!, webhook: webhook!, slack: slack!, teams: teams!, pagerduty: pagerduty! };
}

function response(status: number, text = ''): Response {
  return new Response(text, { status });
}

function expectNoSecrets(value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of ALL_SECRETS) expect(text).not.toContain(secret);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAlertEmailUserCache();
  h.logLines.length = 0;
  h.safeFetch.mockResolvedValue(response(200, 'ok'));
  h.assertPublicUrl.mockResolvedValue(new URL('https://hooks.example.com'));
  h.sendEmail.mockResolvedValue(true);
  h.db.listUsers.mockResolvedValue([
    { role: 'owner', email: 'owner@acme.test' },
    { role: 'admin', email: 'gone@acme.test', status: 'disabled' },
  ]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('buildNotificationMessage', () => {
  it('renders a fired alert with entity, condition, version change and errors', () => {
    const message = buildNotificationMessage(notification());
    expect(message.title).toBe('[Critical] Pulse Main failing');
    expect(message.summary).toBe('Agent error rate for Pulse Main is 27.5% over the last 15 minutes (condition: > 10%).');
    expect(message.severity).toBe('critical');
    expect(message.url).toBe(ctx.incidentUrl);
    expect(message.urlLabel).toBe('View incident');
    const fields = Object.fromEntries(message.fields.map((f) => [f.label, f.value]));
    expect(fields).toMatchObject({
      Project: 'Prod', Metric: 'Agent error rate', Entity: 'agent: Pulse Main', Value: '27.5%', Condition: '> 10%',
      Window: '15 minutes', 'Fired at': '2026-10-15 12:30 UTC', 'Version change': '1.4.0 → 1.5.0',
    });
    expect(fields['Top error']).toBe('Upstream timeout (12x)');
  });

  it('says how long before the alert the new version was first seen, in every rendering', () => {
    const n = notification({
      context: { mode: 'threshold', windowMinutes: 15, versionChange: { from: '1.4.0', to: '1.5.0', firstSeenAt: '2026-10-15T12:12:00Z' } },
    });
    const expected = '1.4.0 → 1.5.0 (first seen 18 min before this fired)';
    const fields = Object.fromEntries(buildNotificationMessage(n).fields.map((f) => [f.label, f.value]));
    expect(fields['Version change']).toBe(expected);
    expect(buildAlertEmailData(n, ctx).versionChange).toBe(expected);
    // a timestamp after the alert (clock skew) or a missing one leaves the plain change
    const later = notification({
      context: { mode: 'threshold', windowMinutes: 15, versionChange: { from: '1.4.0', to: '1.5.0', firstSeenAt: '2026-10-15T12:45:00Z' } },
    });
    expect(buildAlertEmailData(later, ctx).versionChange).toBe('1.4.0 → 1.5.0');
  });

  it('uses the right operator symbol and wording for a "less than" rule', () => {
    const message = buildNotificationMessage(notification({
      rule: { ...notification().rule, metric: 'kb_queries', metricLabel: 'Knowledge base queries', unit: '', operator: 'lt', threshold: 100 },
      value: 12, entity: null,
    }));
    expect(message.summary).toContain('(condition: < 100)');
    expect(message.fields.find((f) => f.label === 'Condition')?.value).toBe('< 100');
  });

  it('describes baseline, absence and resolved notifications', () => {
    const base = notification();
    const baseline = buildNotificationMessage(notification({ rule: { ...base.rule, mode: 'baseline', operator: undefined, threshold: undefined }, baseline: 8 }));
    expect(baseline.summary).toContain('against a baseline of 8%');
    expect(baseline.fields.find((f) => f.label === 'Baseline')?.value).toBe('8%');
    const absence = buildNotificationMessage(notification({ rule: { ...base.rule, mode: 'absence' }, value: 0 }));
    expect(absence.summary).toContain('received no data');
    const resolved = buildNotificationMessage(notification({ kind: 'resolved', value: 2, resolvedAt: new Date('2026-10-15T13:45:00Z') }));
    expect(resolved.title).toBe('Resolved: Pulse Main failing');
    expect(resolved.severity).toBe('ok');
    expect(resolved.fields.find((f) => f.label === 'Duration')?.value).toBe('1 h 15 min');
  });
});

describe('email dispatcher', () => {
  it('passes the operator symbol, window, entity and baseline to the template', async () => {
    const lt = notification({
      rule: { ...notification().rule, operator: 'lt', threshold: 5 }, baseline: 9, value: 1.234,
    });
    const data = buildAlertEmailData(lt, ctx);
    expect(data).toMatchObject({
      operator: '<', windowMinutes: 15, windowText: '15 minutes', entityKey: 'Pulse Main', entityLabel: 'agent: Pulse Main',
      thresholdText: '5%', valueText: '1.23%', hasBaseline: true, baselineText: '9%', isThreshold: true,
    });
    const email = (await channels()).email!;
    const [result] = await dispatchNotification(lt, [email], ctx);
    expect(result).toMatchObject({ type: 'email', target: 'ops@acme.test', success: true });
    // dispatchNotification stamps the delivery-log fields on every result
    expect(result).toEqual(expect.objectContaining({ kind: expect.any(String), at: expect.any(Date) }));
    expect(h.sendEmail).toHaveBeenCalledWith('ops@acme.test', 'alert-fired', expect.objectContaining({ operator: '<', windowMinutes: 15 }));
  });

  it('uses the resolved template for recoveries', async () => {
    const email = (await channels()).email!;
    await dispatchNotification(notification({ kind: 'resolved', resolvedAt: new Date('2026-10-15T13:00:00Z') }), [email], ctx);
    expect(h.sendEmail).toHaveBeenCalledWith('ops@acme.test', 'alert-resolved', expect.objectContaining({ kind: 'resolved', duration: '30 min' }));
  });

  it('fills the error from the sendEmail return value', async () => {
    h.sendEmail.mockResolvedValue(false);
    const email = (await channels()).email!;
    const [result] = await dispatchNotification(notification(), [email], ctx);
    expect(result).toMatchObject({ type: 'email', target: 'ops@acme.test', success: false });
    expect(result!.error).toMatch(/mail server/);
  });

  it('falls back to enabled owners/admins and exports the recipient resolver', async () => {
    const recipients = await resolveAlertEmailRecipients('tenant_acme', []);
    expect(recipients).toEqual(['owner@acme.test']);
    expect(await resolveAlertEmailRecipients('tenant_acme', ['A@x.test', 'a@x.test', 'gone@acme.test'])).toEqual(['A@x.test']);
  });

  it('sends generic messages through alert-message', async () => {
    const email = (await channels()).email!;
    const results = await sendChannelMessage({ title: 'Weekly health', summary: 's', fields: [{ label: 'a', value: 'b' }] }, email, ctx);
    expect(results[0]).toMatchObject({ success: true });
    expect(h.sendEmail).toHaveBeenCalledWith('ops@acme.test', 'alert-message', expect.objectContaining({ title: 'Weekly health' }));
  });
});

describe('mail templates', () => {
  async function render(name: string, data: Record<string, unknown>) {
    const handlebars = (await import('handlebars/dist/cjs/handlebars')).default;
    const content = fs.readFileSync(path.join(process.cwd(), 'mail-templates', `${name}.html`), 'utf-8');
    const subjectRaw = content.match(/<!--\s*subject:\s*(.+?)\s*-->/i)![1]!;
    const runtime = { allowProtoPropertiesByDefault: false, allowProtoMethodsByDefault: false } as const;
    return {
      subject: handlebars.compile(subjectRaw)(data, runtime),
      html: handlebars.compile(content)({ currentYear: 2026, ...data }, runtime),
    };
  }

  it('alert-fired shows the real operator, window, entity and errors for a "less than" rule', async () => {
    const lt = notification({ rule: { ...notification().rule, operator: 'lt', threshold: 5 }, baseline: 9 });
    const { subject, html } = await render('alert-fired', buildAlertEmailData(lt, ctx));
    expect(subject).toBe('[Critical] Alert fired: Pulse Main failing (Pulse Main)');
    expect(html).toContain('&lt; 5%');
    expect(html).toContain('Last 15 minutes');
    expect(html).toContain('agent: Pulse Main');
    expect(html).toContain('Upstream timeout (12x)');
    expect(html).toContain('1.4.0 → 1.5.0');
    expect(html).toContain(ctx.incidentUrl!);
    expect(html).not.toContain('{{');
  });

  it('alert-fired marks a test notification', async () => {
    const { subject, html } = await render('alert-fired', buildAlertEmailData(notification({ kind: 'test' }), ctx));
    expect(subject).toContain('Test notification');
    expect(html).toContain('no incident was created');
  });

  it('alert-resolved and alert-message render', async () => {
    const resolved = await render('alert-resolved', buildAlertEmailData(notification({ kind: 'resolved', value: 2, resolvedAt: new Date('2026-10-15T13:45:00Z') }), ctx));
    expect(resolved.subject).toBe('[Resolved] Pulse Main failing (Pulse Main)');
    expect(resolved.html).toContain('Resolved at');
    expect(resolved.html).toContain('1 h 15 min');
    const message = await render('alert-message', { title: 'Digest', summary: 'All good', fields: [{ label: 'Agents', value: '3' }], url: 'https://x.test', urlLabel: 'Open' });
    expect(message.subject).toBe('Digest');
    expect(message.html).toContain('Agents');
  });
});

describe('webhook dispatcher', () => {
  it('posts a signed JSON body with the alert type and notification data', async () => {
    const webhook = (await channels()).webhook!;
    const [result] = await dispatchNotification(notification(), [webhook], ctx);
    expect(result).toMatchObject({ type: 'webhook', target: 'https://hooks.example.com/…/eive', success: true });

    const [url, init, options] = h.safeFetch.mock.calls[0]!;
    expect(url).toBe(HOOK_URL);
    expect(options).toMatchObject({ followRedirects: false });
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ type: 'alert.fired', data: { kind: 'fired', value: 27.5, rule: { id: 'rule1' }, entity: { key: 'Pulse Main' } } });
    expect(body.id).toMatch(/^alr_[0-9a-f]{24}$/);
    expect(Date.parse(body.occurredAt)).not.toBeNaN();
    expect(init.headers).toMatchObject({
      'content-type': 'application/json', 'user-agent': 'Cognipeer-Alerts/1', 'x-cognipeer-event': 'alert.fired',
    });
    const signature = init.headers['x-cognipeer-signature'] as string;
    const [, t, v1] = signature.match(/^t=(\d+),v1=([0-9a-f]{64})$/)!;
    expect(v1).toBe(crypto.createHmac('sha256', HOOK_SECRET).update(`${t}.${init.body}`).digest('hex'));
    expect(signature).toBe(signWebhookBody(HOOK_SECRET, init.body as string, Number(t)));
  });

  it('sends alert.resolved / alert.test types and omits the signature without a secret', async () => {
    const [unsigned] = await sealChannels([{ type: 'webhook', url: HOOK_URL }]);
    await dispatchNotification(notification({ kind: 'resolved' }), [unsigned!], ctx);
    await dispatchNotification(notification({ kind: 'test' }), [unsigned!], ctx);
    const types = h.safeFetch.mock.calls.map((c) => JSON.parse(c[1].body as string).type);
    expect(types).toEqual(['alert.resolved', 'alert.test']);
    expect(h.safeFetch.mock.calls[0]![1].headers['x-cognipeer-signature']).toBeUndefined();
  });

  it('reports HTTP failures and strips the url and secret from errors and logs', async () => {
    h.safeFetch.mockResolvedValue(response(500));
    const webhook = (await channels()).webhook!;
    const [http] = await dispatchNotification(notification(), [webhook], ctx);
    expect(http).toMatchObject({ success: false, error: 'Endpoint answered HTTP 500' });

    h.safeFetch.mockRejectedValue(new Error(`getaddrinfo failed for ${HOOK_URL} with ${HOOK_SECRET}`));
    const [network] = await dispatchNotification(notification(), [webhook], ctx);
    expect(network!.success).toBe(false);
    expectNoSecrets(network);
    expectNoSecrets(h.logLines.join('\n'));
  });
});

describe('slack dispatcher', () => {
  it('posts the Block Kit payload', async () => {
    const slack = (await channels()).slack!;
    const [result] = await dispatchNotification(notification(), [slack], ctx);
    expect(result).toMatchObject({ type: 'slack', target: 'https://hooks.slack.com/…/oken', success: true });
    const [url, init, options] = h.safeFetch.mock.calls[0]!;
    expect(url).toBe(SLACK_URL);
    expect(options).toMatchObject({ followRedirects: false });
    const payload = JSON.parse(init.body as string);
    expect(payload.text).toBe('[Critical] Pulse Main failing');
    expect(payload.attachments).toHaveLength(1);
    expect(payload.attachments[0].color).toBe('#d93025');
    const blocks = payload.attachments[0].blocks;
    expect(blocks.map((b: { type: string }) => b.type)).toEqual(['header', 'section', 'section', 'actions', 'context']);
    expect(blocks[0].text).toEqual({ type: 'plain_text', text: '[Critical] Pulse Main failing', emoji: false });
    expect(blocks[1].text.text).toBe('Agent error rate for Pulse Main is 27.5% over the last 15 minutes (condition: &gt; 10%).');
    expect(blocks[2].fields.map((f: { text: string }) => f.text)).toEqual([
      '*Project*\nProd', '*Metric*\nAgent error rate', '*Entity*\nagent: Pulse Main', '*Value*\n27.5%',
      '*Condition*\n&gt; 10%', '*Window*\n15 minutes', '*Fired at*\n2026-10-15 12:30 UTC',
      '*Version change*\n1.4.0 → 1.5.0', '*Top error*\nUpstream timeout (12x)',
    ]);
    expect(blocks[3].elements[0]).toMatchObject({ type: 'button', url: ctx.incidentUrl, text: { text: 'View incident' } });
    expect(blocks[4].elements[0].text).toBe('Acme · Cognipeer Console');
  });

  it('escapes mrkdwn control characters and chunks fields per section', () => {
    const payload = buildSlackPayload({
      title: 'T', summary: 'a <b> & c',
      fields: Array.from({ length: 12 }, (_, i) => ({ label: `L${i}`, value: i === 0 ? '<script>' : 'v' })),
    });
    const blocks = (payload.attachments as Array<{ blocks: Array<Record<string, unknown>> }>)[0]!.blocks;
    expect(JSON.stringify(blocks)).toContain('a &lt;b&gt; &amp; c');
    expect(JSON.stringify(blocks)).toContain('&lt;script&gt;');
    const sections = blocks.filter((b) => Array.isArray(b.fields));
    expect(sections.map((s) => (s.fields as unknown[]).length)).toEqual([10, 2]);
  });

  it('reports the status of a rejected payload but never reflects the body of a user-chosen url', async () => {
    h.safeFetch.mockResolvedValue(response(400, 'invalid_payload'));
    const slack = (await channels()).slack!;
    const [result] = await dispatchNotification(notification(), [slack], ctx);
    expect(result).toMatchObject({ success: false, error: 'Endpoint answered HTTP 400' });
    expect(JSON.stringify(result)).not.toContain('invalid_payload');
  });
});

describe('teams dispatcher', () => {
  it('posts an Adaptive Card 1.4 message', async () => {
    const teams = (await channels()).teams!;
    const [result] = await dispatchNotification(notification(), [teams], ctx);
    expect(result).toMatchObject({ type: 'teams', target: 'https://example.webhook.office.com/…/dddd', success: true });
    const [url, init] = h.safeFetch.mock.calls[0]!;
    expect(url).toBe(TEAMS_URL);
    const body = JSON.parse(init.body as string);
    expect(body.type).toBe('message');
    expect(body.attachments[0].contentType).toBe('application/vnd.microsoft.card.adaptive');
    expect(body.attachments[0].content.version).toBe('1.4');
    const card = body.attachments[0].content;
    expect(card.$schema).toBe('http://adaptivecards.io/schemas/adaptive-card.json');
    expect(card.type).toBe('AdaptiveCard');
    expect(card.body.map((b: { type: string }) => b.type)).toEqual(['TextBlock', 'TextBlock', 'FactSet', 'TextBlock']);
    expect(card.body[0]).toMatchObject({ text: '\\[Critical\\] Pulse Main failing', color: 'Attention', weight: 'Bolder' });
    expect(card.body[2].facts).toContainEqual({ title: 'Entity', value: 'agent: Pulse Main' });
    expect(card.body[2].facts).toContainEqual({ title: 'Condition', value: '\\> 10%' });
    expect(card.body[2].facts).toContainEqual({ title: 'Top error', value: 'Upstream timeout \\(12x\\)' });
    expect(card.actions).toEqual([{ type: 'Action.OpenUrl', title: 'View incident', url: ctx.incidentUrl }]);
  });

  it('escapes markdown in untrusted text so it never renders as a link', () => {
    const payload = buildTeamsPayload({
      title: 'Alert [t](https://evil.test/t)',
      summary: 'see [click](https://evil.test) now',
      fields: [
        { label: 'En*tity', value: 'agent: **[Pulse](https://evil.test)** _x_' },
        { label: 'Top error', value: '- [click](https://evil.test) (3x)' },
      ],
      footer: '[f](https://evil.test)',
      url: 'https://console.example.com/incidents/1',
    });
    const json = JSON.stringify(payload);
    expect(json).not.toContain('](');
    expect(json).toContain('\\\\[click\\\\]\\\\(https://evil.test\\\\)');
    expect(escapeTeamsMarkdown('2026-10-15 > 10%')).toBe('2026-10-15 \\> 10%');
    expect(escapeTeamsMarkdown('a\n1. b\n- c')).toBe('a\n1\\. b\n\\- c');
    // the action url is not markdown and stays untouched
    expect((payload.attachments as Array<{ content: { actions: Array<{ url: string }> } }>)[0]!.content.actions[0]!.url)
      .toBe('https://console.example.com/incidents/1');
  });

  it('colours a resolved card Good and omits the action without a url', () => {
    const payload = buildTeamsPayload({ title: 'Resolved', summary: '', severity: 'ok', fields: [] });
    const content = (payload.attachments as Array<{ content: { body: Array<{ color?: string }>; actions?: unknown } }>)[0]!.content;
    expect(content.body[0]!.color).toBe('Good');
    expect(content.actions).toBeUndefined();
  });
});

describe('pagerduty dispatcher', () => {
  const EVENTS = 'https://events.pagerduty.com/v2/enqueue';

  it('triggers with a stable dedup key, severity and links', async () => {
    h.safeFetch.mockResolvedValue(response(202, '{"status":"success"}'));
    const pagerduty = (await channels()).pagerduty!;
    const [result] = await dispatchNotification(notification(), [pagerduty], ctx);
    expect(result).toMatchObject({ type: 'pagerduty', target: `pagerduty …${ROUTING_KEY.slice(-4)}`, success: true });
    expect(h.safeFetch).toHaveBeenCalledTimes(1);
    expect(h.safeFetch.mock.calls[0]![0]).toBe(EVENTS);
    const body = JSON.parse(h.safeFetch.mock.calls[0]![1].body as string);
    expect(body).toMatchObject({
      routing_key: ROUTING_KEY, event_action: 'trigger', dedup_key: 'cognipeer:rule1:Pulse Main',
      payload: { severity: 'critical', group: 'agents', class: 'agent_error_rate', component: 'Pulse Main' },
      links: [{ href: ctx.incidentUrl }],
    });
    expect(body.payload.summary).toContain('Pulse Main failing');
    expect(body.payload.custom_details.Entity).toBe('agent: Pulse Main');
  });

  it('renotify triggers with the same key; resolved resolves it', async () => {
    const pagerduty = (await channels()).pagerduty!;
    await dispatchNotification(notification({ kind: 'renotify' }), [pagerduty], ctx);
    await dispatchNotification(notification({ kind: 'resolved' }), [pagerduty], ctx);
    const bodies = h.safeFetch.mock.calls.map((c) => JSON.parse(c[1].body as string));
    expect(bodies.map((b) => b.event_action)).toEqual(['trigger', 'resolve']);
    expect(bodies[0].dedup_key).toBe(bodies[1].dedup_key);
    expect(bodies[1]).toEqual({ routing_key: ROUTING_KEY, event_action: 'resolve', dedup_key: 'cognipeer:rule1:Pulse Main' });
  });

  it('a test triggers then resolves under its own key, never the rule key', async () => {
    const pagerduty = (await channels()).pagerduty!;
    const [result] = await dispatchNotification(notification({ kind: 'test' }), [pagerduty], ctx);
    expect(result!.success).toBe(true);
    const bodies = h.safeFetch.mock.calls.map((c) => JSON.parse(c[1].body as string));
    expect(bodies.map((b) => b.event_action)).toEqual(['trigger', 'resolve']);
    expect(bodies[0].dedup_key).toBe(bodies[1].dedup_key);
    expect(bodies[0].dedup_key).toMatch(/^cognipeer:test:[0-9a-f]{8}:rule1:Pulse Main$/);
  });

  it('a test reports success once the trigger is accepted, even if the clean-up resolve hangs or fails', async () => {
    h.safeFetch.mockResolvedValueOnce(response(202, '')).mockImplementationOnce(() => new Promise(() => undefined));
    const pagerduty = (await channels()).pagerduty!;
    const [hung] = await dispatchNotification(notification({ kind: 'test' }), [pagerduty], ctx);
    expect(hung!.success).toBe(true);
    expect(h.safeFetch).toHaveBeenCalledTimes(2);

    h.safeFetch.mockReset();
    h.safeFetch.mockResolvedValueOnce(response(202, '')).mockResolvedValueOnce(response(500, 'boom'));
    const [failed] = await dispatchNotification(notification({ kind: 'test' }), [pagerduty], ctx);
    expect(failed!.success).toBe(true);
  });

  it('stops after a rejected trigger and never leaks the routing key', async () => {
    h.safeFetch.mockResolvedValue(response(400, `{"message":"bad ${ROUTING_KEY}"}`));
    const pagerduty = (await channels()).pagerduty!;
    const [result] = await dispatchNotification(notification({ kind: 'test' }), [pagerduty], ctx);
    expect(result!.success).toBe(false);
    expect(h.safeFetch).toHaveBeenCalledTimes(1);
    expectNoSecrets(result);
    expectNoSecrets(h.logLines.join('\n'));
  });

  it('dedup keys: "_" without an entity and a digest for over-long entities', () => {
    expect(pagerDutyDedupKey('r1', null)).toBe('cognipeer:r1:_');
    const long = pagerDutyDedupKey('r1', 'x'.repeat(400));
    expect(long.length).toBeLessThanOrEqual(255);
    expect(long).not.toBe(pagerDutyDedupKey('r1', `${'x'.repeat(399)}y`));
  });
});

describe('dispatchNotification', () => {
  it('delivers on every channel in parallel and keeps going when one fails', async () => {
    const c = await channels();
    h.safeFetch.mockImplementation(async (url: string) => (url === SLACK_URL ? response(500) : response(200)));
    const results = await dispatchNotification(notification(), Object.values(c), ctx);
    expect(results.map((r) => [r.type, r.success])).toEqual([
      ['email', true], ['webhook', true], ['slack', false], ['teams', true], ['pagerduty', true],
    ]);
  });

  it('answers a channel that does not finish within the configured timeout', async () => {
    vi.useFakeTimers();
    h.safeFetch.mockImplementation(() => new Promise(() => undefined));
    const c = await channels();
    const pending = dispatchNotification(notification(), [c.slack!], ctx);
    await vi.advanceTimersByTimeAsync(10_001);
    const [result] = await pending;
    expect(result).toMatchObject({ type: 'slack', success: false, error: 'Timed out after 10000 ms' });
  });

  it('never throws: unknown types, undecryptable credentials and dispatcher crashes become failed results', async () => {
    const c = await channels();
    const broken = { ...c.slack!, sealed: 'not-decryptable' } as IAlertChannel;
    const unknown = { id: 'ch_000000000000', type: 'fax' } as unknown as IAlertChannel;
    const email = getChannel('email')!;
    const spy = vi.spyOn(email, 'dispatch').mockRejectedValue(new Error(`boom ${HOOK_SECRET}`));
    const results = await dispatchNotification(notification(), [broken, unknown, c.email!], ctx);
    spy.mockRestore();
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.success === false)).toBe(true);
    expect(results[0]!.error).toMatch(/could not be read/);
    expect(results[1]!.error).toMatch(/No dispatcher/);
    expectNoSecrets(results);
    expectNoSecrets(h.logLines.join('\n'));
  });

  it('returns nothing for no channels', async () => {
    expect(await dispatchNotification(notification(), [], ctx)).toEqual([]);
  });
});

describe('sendChannelMessage', () => {
  const message = { title: 'Weekly health', summary: 'All stable', severity: 'ok' as const, fields: [{ label: 'Agents', value: '3' }], url: 'https://console.test/x', urlLabel: 'Open', footer: 'Acme' };

  it('renders the message on slack, teams and webhook', async () => {
    const c = await channels();
    for (const channel of [c.slack!, c.teams!, c.webhook!]) {
      const [result] = await sendChannelMessage(message, channel, ctx);
      expect(result!.success).toBe(true);
    }
    const slack = JSON.parse(h.safeFetch.mock.calls[0]![1].body as string);
    expect(slack.text).toBe('Weekly health');
    const webhook = JSON.parse(h.safeFetch.mock.calls[2]![1].body as string);
    expect(webhook).toMatchObject({ type: 'notice', data: { title: 'Weekly health' } });
  });

  it('says so when a channel type cannot receive messages', async () => {
    const [result] = await sendChannelMessage(message, (await channels()).pagerduty!, ctx);
    expect(result).toMatchObject({ type: 'pagerduty', success: false, error: 'pagerduty channels do not receive messages' });
  });
});

describe('masking', () => {
  it('masked channels carry no credential and no sealed payload', async () => {
    const masked = maskChannels(Object.values(await channels()));
    expect(masked).toHaveLength(5);
    expectNoSecrets(masked);
    expect(JSON.stringify(masked)).not.toContain('sealed');
  });
});

describe('channel url validation', () => {
  it('accepts a public https url', async () => {
    expect(await assertPublicChannelUrl(`  ${SLACK_URL} `)).toBe(SLACK_URL);
    expect(h.assertPublicUrl).toHaveBeenCalledWith(SLACK_URL);
  });

  it.each([
    ['', 'url is required'],
    [undefined, 'url is required'],
    ['not a url', 'url is not a valid URL'],
    ['http://hooks.example.com/x', 'url must use https'],
    ['ftp://hooks.example.com/x', 'url must use https'],
    ['https://user:pass@hooks.example.com/x', 'url must not contain credentials'],
    [`https://hooks.example.com/${'a'.repeat(2100)}`, 'url must be at most 2048 characters'],
  ])('rejects %#', async (input, message) => {
    await expect(assertPublicChannelUrl(input)).rejects.toMatchObject({ name: 'ChannelUrlError', message });
  });

  it('rejects non-public hosts without echoing the url', async () => {
    h.assertPublicUrl.mockRejectedValue(new Error('Refusing outbound request to private/loopback host'));
    const error = await assertPublicChannelUrl('https://10.0.0.5/secret-path').catch((e) => e);
    expect(error).toBeInstanceOf(ChannelUrlError);
    expect(error.message).toBe('url must resolve to a public address');
  });

  it('validates PagerDuty routing keys', () => {
    expect(isValidPagerDutyRoutingKey(ROUTING_KEY)).toBe(true);
    expect(isValidPagerDutyRoutingKey('short')).toBe(false);
    expect(isValidPagerDutyRoutingKey(`${ROUTING_KEY.slice(0, 31)}-`)).toBe(false);
    expect(isValidPagerDutyRoutingKey(undefined)).toBe(false);
  });
});
