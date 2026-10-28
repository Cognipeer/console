/**
 * Unit tests - the connector trigger pages say what the code does
 *
 * The triggers guide and the OpenAPI document teach a filter and a prompt over a connector event by example, and
 * list the names a filter path may start at and what a subscription's status means. A page that still shows
 * GitHub's own request body (`payload.pull_request.draft`) for a package that emits flat event data, or lists a root
 * the code does not accept (`event_id`), sends the reader to a filter that lets no event through or to a 400.
 *
 * So the examples are run the way the engine runs them (the filter rules through the save validator and the matcher,
 * the prompt tags through the view) over the event data the GitHub package declares (`githubConnectorFixture`), and
 * the roots a page names are compared with `WEBHOOK_CONTEXT_ROOTS`.
 *
 * The sentences that say what the API answers (the message of a cron a poll cannot take, a Retry that binds a lost
 * subscription, a parameter the package reads from the service, a schedule object on a PATCH), what a retired preset
 * leaves behind and what a cleared schedule field does are pinned here too, and no document may present a retired vendor
 * preset as one a person can create. The events the guide lists for GitHub, GitLab and Azure DevOps, and the examples of its cron table, are held
 * to the packages and to the Connectors module in the Enterprise overlay (`connector-trigger-guide-parity.test.ts`).
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentTriggerConnector, IAgentTrigger } from '@/lib/database';
import { __resetConnectorTriggerHostForTests, registerConnectorTriggerHost } from '@/enterprise/connector-triggers';
import { parseConnectorWrite } from '@/lib/services/agents/agentTriggerConnectorHost';
import { eventView } from '@/lib/services/agents/agentTriggerEventDispatch';
import {
  WEBHOOK_CONTEXT_ROOTS,
  firstFilterMiss,
  parseFilterRules,
  resolveFilterPath,
  templateProblem,
} from '@/lib/services/agents/agentTriggerWebhookView';
import { createFakeConnectorHost } from '../helpers/fakeConnectorHost';
import { GITHUB_PACKAGE_ID, GITHUB_TRIGGERS } from '../helpers/githubConnectorFixture';
import { shapeProblems } from '../helpers/openapiShape';

const ROOT = path.resolve(__dirname, '../../..');
const read = (file: string): string => readFileSync(path.join(ROOT, file), 'utf8');
const flat = (text: string): string => text.replace(/\s+/g, ' ');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const guide = read('docs/guide/agent-triggers.md');
const openapi = parse(read('openapi.yaml')) as Json;

/** The text under `## Connector triggers`, up to the next level-2 heading. */
function connectorSection(): string {
  const start = guide.indexOf('\n## Connector triggers');
  expect(start).toBeGreaterThan(0);
  const next = guide.indexOf('\n## ', start + 5);
  return guide.slice(start, next < 0 ? undefined : next);
}

/** The text under `### Vendor presets were retired`, up to the next heading of level 2 or 3. */
function retiredPresetsSection(): string {
  const start = guide.indexOf('\n### Vendor presets were retired');
  expect(start, 'the guide has a section on the retired vendor presets').toBeGreaterThan(0);
  const next = guide.slice(start + 5).search(/\n#{2,3} /);
  return guide.slice(start, next < 0 ? undefined : start + 5 + next);
}

/** The JSON body of the curl example that creates a connector trigger. */
function guideExample(): Json {
  const section = connectorSection();
  const body = /-d '(\{[\s\S]*?\n {2}\})'/.exec(section);
  expect(body, 'the guide shows a curl example with a JSON body').not.toBeNull();
  return JSON.parse(body![1]);
}

function viewFor(triggerName: keyof typeof GITHUB_TRIGGERS, data: unknown) {
  const fixture = GITHUB_TRIGGERS[triggerName];
  return eventView({
    trigger: { _id: 't1', name: 'Example', agentKey: 'agent' } as unknown as IAgentTrigger,
    preset: 'connector',
    payload: data,
    headers: {},
    identity: { event: fixture.sample.type, deliveryId: 'delivery-1' },
    receivedAt: new Date('2026-10-28T10:00:00.000Z'),
    connector: { id: 'conn-1', key: 'github', name: 'GitHub', packageId: GITHUB_PACKAGE_ID, trigger: triggerName },
  });
}

/** Every `{{tag}}` of a template. */
const tagsOf = (template: string): string[] => [...template.matchAll(/\{\{\s*([^{}\s]+)\s*\}\}/g)].map((match) => match[1]);

/** The package's sample, with the values an example's `eq` / `in` rules ask for (an example may name its own branch). */
function sampleThatMeets(data: Record<string, unknown>, filter: Json[]): Record<string, unknown> {
  const out = { ...data };
  for (const rule of filter) {
    const property = String(rule.path).split('.')[1];
    if (rule.op === 'eq') out[property] = rule.value;
    if (rule.op === 'in') out[property] = rule.value[0];
  }
  return out;
}

/**
 * An example a reader would copy: its filter passes the save validation and an event of the package that meets it
 * (the sample itself, unless the example names its own values), and every tag of its prompt names a field the event
 * carries.
 */
function expectWorksOnTheSample(example: { connector: Json; prompt: string }) {
  const name = example.connector.trigger as keyof typeof GITHUB_TRIGGERS;
  expect(Object.keys(GITHUB_TRIGGERS)).toContain(name);
  const fixture = GITHUB_TRIGGERS[name];
  const rules = parseFilterRules(example.connector.filter ?? []);
  expect(rules.ok, JSON.stringify(rules)).toBe(true);
  const sample = sampleThatMeets(fixture.sample.data, example.connector.filter ?? []);
  const view = viewFor(name, sample);
  expect(firstFilterMiss(view, rules.ok ? rules.rules : [])).toBeNull();
  for (const rule of example.connector.filter ?? []) {
    const [root, property] = String(rule.path).split('.');
    expect(root).toBe('payload');
    expect(fixture.properties, rule.path).toContain(property);
    // The path is on the package's own sample too (not only on the variant that meets the rule).
    expect(resolveFilterPath(viewFor(name, fixture.sample.data), rule.path).value, rule.path).not.toBeUndefined();
  }
  expect(templateProblem(example.prompt)).toBeNull();
  const tags = tagsOf(example.prompt);
  expect(tags.length).toBeGreaterThan(0);
  for (const tag of tags) {
    const resolved = resolveFilterPath(view, tag);
    expect(resolved.value, tag).not.toBeUndefined();
    expect(resolved.value, tag).not.toBeNull();
  }
  for (const event of example.connector.events ?? []) expect(fixture.events).toContain(event);
}

describe('the triggers guide, connector section', () => {
  it('shows a create example whose filter and prompt work on the package\'s own event data', () => {
    const example = guideExample();
    expect(example.type).toBe('connector');
    expectWorksOnTheSample(example);
  });

  it('does not teach the vendor\'s own request body for a connector event', () => {
    const section = connectorSection();
    // The one paragraph that says why those names do not exist may name them.
    const explanation = /\n\*\*The event's data is the package's, not the vendor's\.\*\*[^\n]*\n/.exec(section);
    expect(explanation, 'the section explains that the data is the package\'s').not.toBeNull();
    expect(flat(explanation![0])).toContain('not GitHub\'s own request body');
    const rest = flat(section.replace(explanation![0], '\n'));
    for (const raw of ['payload.pull_request.', 'full_name', 'payload.workflow_run.', 'head_commit', 'html_url']) {
      expect(rest, raw).not.toContain(raw);
    }
  });

  it('names every path root a connector filter takes, and no event_id', () => {
    const row = flat(connectorSection()).split('\n').join(' ');
    const filterRow = /\| `filter` \|([^|]*)\|/.exec(row)?.[1] ?? '';
    for (const root of ['payload', 'event', 'delivery_id', 'received_at', 'trigger', 'agent', 'connector']) expect(filterRow, root).toContain(`\`${root}`);
    expect(filterRow).not.toContain('event_id');
  });

  it('says a failed registration reads manual, a failing poll stays active, and failed follows a rotation', () => {
    const text = flat(connectorSection());
    expect(text).not.toContain('is stored and shows `failed`');
    expect(text).toContain('reads `manual` with the reason');
    expect(text).toContain('A poll that fails stays `active` with `last_error`');
    expect(text).toContain('`failed` (a rotation could not register the hook again');
  });

  it('tells a migrating retired preset that the payload is the package\'s flat data', () => {
    const text = flat(guide);
    expect(text).toContain('`payload.draft`, not the vendor\'s `payload.pull_request.draft`');
  });
});

describe('the OpenAPI document, connector triggers', () => {
  const createExamples = openapi.paths['/agents/{agentKey}/triggers'].post.requestBody.content['application/json'].examples;
  const runPost = openapi.paths['/agents/{agentKey}/triggers/{triggerId}/run'].post;
  const schemas = openapi.components.schemas as Record<string, Json>;

  it('shows a create example whose filter and prompt work on the package\'s own event data', () => {
    const example = createExamples.connector.value;
    expect(example.type).toBe('connector');
    expectWorksOnTheSample(example);
  });

  it('shows a Run now sample in the package\'s flat shape, with fields the trigger declares', () => {
    const sample = runPost.requestBody.content['application/json'].examples.connector_sample.value;
    expect(GITHUB_TRIGGERS.pull_request.events).toContain(sample.event);
    expect(typeof sample.payload.repository).toBe('string');
    for (const key of Object.keys(sample.payload)) expect(GITHUB_TRIGGERS.pull_request.properties, key).toContain(key);
  });

  it('shows a dry-run answer that renders that flat sample', () => {
    const request = runPost.requestBody.content['application/json'].examples.connector_sample.value;
    const answer = runPost.responses['200'].content['application/json'].examples.dry_run.value;
    expect(answer.event).toBe(request.event);
    const block = /```json\n([\s\S]*?)\n```/.exec(answer.prompt);
    expect(block).not.toBeNull();
    expect(JSON.parse(block![1])).toEqual(request.payload);
    expect(answer.prompt).toContain(`Review pull request #${request.payload.number} in "${request.payload.repository}"`);
  });

  it('lists the path roots the code accepts and never event_id', () => {
    const descriptions: Record<string, string> = {
      'AgentTriggerConnector.filter': schemas.AgentTriggerConnector.properties.filter.description,
      AgentTriggerConnectorRequest: schemas.AgentTriggerConnectorRequest.description,
      AgentTriggerWebhookFilterRule: schemas.AgentTriggerWebhookFilterRule.description,
    };
    for (const [where, description] of Object.entries(descriptions)) {
      const text = flat(description);
      expect(text, where).not.toContain('event_id');
      // Every root named between backticks as a path start is one the code takes.
      const named = [...text.matchAll(/`([a-z_]+)`/g)].map((match) => match[1]).filter((word) => ['payload', 'headers', 'event', 'delivery_id', 'preset', 'received_at', 'trigger', 'agent', 'connector'].includes(word));
      expect(named.length, where).toBeGreaterThan(0);
      for (const root of named) expect(WEBHOOK_CONTEXT_ROOTS as readonly string[], `${where}: ${root}`).toContain(root);
    }
    // The connector-only wording names all seven roots that carry data; the shared one names all nine.
    for (const root of ['payload', 'event', 'delivery_id', 'received_at', 'trigger', 'agent', 'connector']) {
      expect(flat(descriptions['AgentTriggerConnector.filter']), root).toContain(`\`${root}\``);
      expect(flat(descriptions.AgentTriggerConnectorRequest), root).toContain(`\`${root}\``);
    }
    for (const root of WEBHOOK_CONTEXT_ROOTS) expect(flat(descriptions.AgentTriggerWebhookFilterRule), root).toContain(`\`${root}\``);
  });

  it('accepts the documented roots when saving a rule, and refuses event_id', () => {
    for (const root of WEBHOOK_CONTEXT_ROOTS) {
      expect(parseFilterRules([{ path: `${root}.x`, op: 'exists' }]).ok, root).toBe(true);
    }
    expect(parseFilterRules([{ path: 'event_id', op: 'exists' }]).ok).toBe(false);
  });

  it('shows only examples that fit the schema they are shown for (request and answer bodies of the trigger operations)', () => {
    const checked: string[] = [];
    const problems: string[] = [];
    for (const [route, methods] of Object.entries(openapi.paths) as Array<[string, Json]>) {
      if (!route.includes('/triggers')) continue;
      for (const operation of Object.values(methods) as Json[]) {
        if (!operation || typeof operation !== 'object' || !operation.operationId) continue;
        const bodies: Array<[string, Json]> = [];
        const request = operation.requestBody?.content?.['application/json'];
        if (request) bodies.push(['request', request]);
        for (const [status, response] of Object.entries(operation.responses ?? {}) as Array<[string, Json]>) {
          const content = response?.content?.['application/json'];
          if (content) bodies.push([`response ${status}`, content]);
        }
        for (const [where, content] of bodies) {
          const name = typeof content.schema?.$ref === 'string' ? content.schema.$ref.split('/').pop() : undefined;
          if (!name) continue;
          const examples: Array<[string, unknown]> = [
            ...(content.example !== undefined ? [['example', content.example] as [string, unknown]] : []),
            ...Object.entries(content.examples ?? {}).map(([key, example]) => [key, (example as Json).value] as [string, unknown]),
          ];
          for (const [label, value] of examples) {
            checked.push(`${operation.operationId} ${where} ${label}`);
            for (const problem of shapeProblems(value, name)) problems.push(`${operation.operationId} ${where} ${label} (${name}): ${problem}`);
          }
        }
      }
    }
    // The connector examples are among them: the rotate answers and the create answer of a connector trigger.
    expect(checked).toEqual(expect.arrayContaining([
      'rotateAgentTriggerWebhookSecret response 200 webhook',
      'rotateAgentTriggerWebhookSecret response 200 connector',
    ]));
    expect(problems).toEqual([]);
  });

  it('documents the locale query parameter on every call that reaches the Connectors module in words', () => {
    const parameter = openapi.components.parameters.TriggerLocale;
    expect(parameter).toMatchObject({ name: 'locale', in: 'query', required: false, schema: { type: 'string', enum: ['tr', 'en'] } });
    const operations = ['createAgentTrigger', 'getAgentTrigger', 'updateAgentTrigger', 'rotateAgentTriggerWebhookSecret', 'retryAgentTriggerConnector'];
    const found = new Map<string, string[]>();
    for (const methods of Object.values(openapi.paths) as Json[]) {
      for (const operation of Object.values(methods) as Json[]) {
        if (operation && typeof operation === 'object' && operations.includes(operation.operationId)) {
          found.set(operation.operationId, (operation.parameters ?? []).map((item: Json) => item.$ref));
        }
      }
    }
    expect([...found.keys()].sort()).toEqual([...operations].sort());
    for (const [id, refs] of found) expect(refs, id).toContain('#/components/parameters/TriggerLocale');
    expect(flat(guide)).toContain('Add `?locale=tr` or `?locale=en` to a create, update, read, rotate or retry call');
  });

  it('says the same of the language in all three places: it covers the setup steps, and the reason is one English sentence', () => {
    const parameter = flat(openapi.components.parameters.TriggerLocale.description);
    const templates = flat(read('docs/guide/agent-templates.md'));
    expect(parameter).toContain('writes the `setup` steps');
    expect(parameter).toContain('The `reason` is not translated');
    expect(parameter).toContain('`reason_code` is the key');
    expect(flat(schemas.ConnectorSubscription.properties.reason.description)).toContain('one fixed English sentence for every reader');
    expect(flat(guide)).toContain('`reason` is not translated: it is one fixed English sentence for every reader');
    expect(templates).toContain('the `reason` of a subscription is one English sentence with a `reason_code`');
    // None of them promises a translated reason.
    for (const text of [parameter, flat(guide), templates]) {
      expect(text).not.toMatch(/its `reason` and its `setup` steps/);
      expect(text).not.toContain('write the `reason` and the setup steps');
      expect(text).not.toContain('(its reason and setup steps');
    }
  });

  it('documents the reason code and the previous secret\'s expiry of a subscription, with the codes the module sends', () => {
    const subscription = schemas.ConnectorSubscription.properties;
    expect(subscription.reason_code).toMatchObject({ type: 'string', nullable: true });
    expect(subscription.previous_secret_valid_until).toMatchObject({ type: 'integer', nullable: true });
    for (const code of ['no_subscribe', 'subscribe_failed', 'rotate_failed', 'account', 'connector_disabled', 'package_missing', 'unreachable', 'attach_failed']) {
      expect(flat(subscription.reason_code.description), code).toContain(`\`${code}\``);
      expect(flat(connectorSection()), code).toContain(`\`${code}\``);
    }
    expect(connectorSection()).toContain('"previous_secret_valid_until": null');
    expect(Object.keys(schemas.AgentTriggerWebhookSecret.properties)).toEqual(expect.arrayContaining(['connector_subscription', 'previous_valid_until']));
  });

  it('states what a hook set up by hand, a shared poll, an edit and a lost connection do, in the guide and in the schema', () => {
    const subscription = schemas.ConnectorSubscription.properties;
    const patch = flat(openapi.paths['/agents/{agentKey}/triggers/{triggerId}'].patch.description);
    const rotate = flat(openapi.paths['/agents/{agentKey}/triggers/{triggerId}/webhook/rotate-secret'].post.description);
    const retry = flat(openapi.paths['/agents/{agentKey}/triggers/{triggerId}/connector/retry'].post.description);
    const status = flat(subscription.status.description);
    const section = flat(connectorSection());

    // An account that is gone: a hook set up by hand goes on receiving; one that waited for the account reads `account`.
    for (const text of [section, status]) {
      expect(text).not.toContain('it stays `manual` with `reason_code: account` and goes on receiving');
      expect(text).toContain('`manual` with `reason_code: account`');
      expect(text).toContain('`no_subscribe`');
    }
    expect(section).toContain('goes on receiving when the connector\'s account is disconnected');
    expect(section).toContain('A hook the package cannot register at all keeps `no_subscribe`');
    expect(status).toContain('goes on receiving when the connector\'s account is disconnected');
    expect(status).toContain('keeps its reason');
    // Several triggers on one poll: the one over a limit misses events, and the last error names it.
    expect(section).toContain('does not hold the others back');
    expect(section).toContain('and how many events they missed');
    expect(flat(subscription.last_error.description)).toContain('"and N more"');
    // An edit of a poll's schedule: where it can fail, and the page that can run twice.
    expect(section).toContain('reaches another node, or comes after more than two minutes');
    for (const text of [section, patch]) expect(text).toContain('can run that page\'s events once more');
    // A save that keeps the binding while the module is off.
    expect(section).toContain('the answer\'s `connector_subscription` is the subscription as it is stored');
    expect(patch).toContain('is accepted even while the Connectors licence or switch');
    // A rotation that stopped half way, the earlier secret of a hook that gets registered, a trigger whose connection is gone.
    expect(section).toContain('rotating it answers with a new secret to paste');
    expect(rotate).toContain('the answer carries the new secret');
    expect(section).toContain('the earlier secret stops at once and `previous_secret_valid_until` reads `null`');
    expect(flat(subscription.previous_secret_valid_until.description)).toContain('the earlier secret stops at once');
    expect(section).toContain('reads `failed` with `reason_code: attach_failed`');
    expect(status).toContain('reads `failed` with `reason_code: attach_failed`');
    expect(retry).toContain('is bound to a new one');
  });

  it('describes the subscription statuses the way the service uses them', () => {
    const status = flat(schemas.ConnectorSubscription.properties.status.description);
    expect(status).not.toContain('registration or polling failed');
    expect(status).toContain('a poll that fails stays `active`');
    expect(status).toContain('`manual`: the vendor webhook has to be set up by hand');
    expect(status).toContain('`failed`: a rotation could not register the hook again');
    const create = flat(openapi.paths['/agents/{agentKey}/triggers'].post.description);
    expect(create).not.toContain('the subscription reads `failed` until');
    expect(create).toContain('A hook that could not be registered at the vendor reads `manual`');
  });
});

describe('the triggers guide, the schedule of a poll', () => {
  const section = () => flat(connectorSection());

  it('says what the API answers for a cron a poll cannot take: one sentence for each class, from the Connectors module first', () => {
    const text = section();
    // The sentences on `connector.schedule.cron`, in the order of the guide's table: not five fields, syntax of another dialect, a value, too often (a gap of N minutes, then of one), never due.
    for (const sentence of [
      'cron must be a five-field cron expression (minute hour day-of-month month day-of-week)',
      'cron uses syntax connector schedules do not support (L, W, # or ?); use numbers, ranges, lists, steps and month or weekday names',
      'cron has a value that is out of range or not a name: minute 0-59, hour 0-23, day 1-31, month 1-12 or jan-dec, weekday 0-7 or sun-sat',
      'cron runs every N minutes, below the M minutes this trigger allows',
      'cron runs every minute, below the M minutes this trigger allows',
      'cron cannot be evaluated in this timezone',
    ]) expect(text, sentence).toContain(`\`${sentence}\``);
    expect(text).toContain('A cron a connector schedule cannot take is `400` on `connector.schedule.cron`, and nothing is stored');
    expect(text).toContain('The Connectors module judges it first');
    // The console's own reader runs last: its words are only for an expression it still refuses after the module took it.
    expect(text).toContain('reads the cron once more after the module took it');
    expect(text).toContain('only an expression that reader still refuses is answered in its own words (`invalid cron expression: …`)');
    // Not the earlier claim that every cron a schedule cannot read gets the syntax sentence.
    expect(text).not.toContain('and the message says that it uses syntax connector schedules do not support');
  });

  it('gives examples for each class, and says the Studio field names the same problems', () => {
    const text = section();
    for (const example of ['`@daily`', '`0 0 9 * * *`', '`0 9 L * *`', '`0 9 15W * *`', '`0 9 * * 5#2`', '`0 9 ? * 1`', '`60 * * * *`', '`*/0 * * * *`', '`0 9 * * funday`', '`0 0 31 2 *`']) {
      expect(text, example).toContain(example);
    }
    expect(text).toContain('Studio\'s schedule field shows the same problems while you type');
    expect(text).not.toContain('Studio\'s schedule field checks the same rules');
  });

  it('says a PATCH without a schedule keeps it, and null returns a poll to the package\'s schedule, in UTC', () => {
    const text = section();
    expect(text).toContain('A PATCH that leaves `schedule` out keeps the stored schedule');
    expect(text).toContain('`schedule: null` returns the poll to the package\'s own schedule, in UTC');
    expect(text).toContain('Studio sends `null` when you clear the schedule field of a saved poll trigger, and shows the schedule that was stored after each save');
    expect(text).toContain('`schedule: null` on a PATCH returns a saved trigger to it, and leaving it out keeps the stored one');
  });

  it('says the timezone picker of Studio is off while the schedule field is empty, because the package\'s schedule runs in UTC', () => {
    const text = section();
    expect(text).toContain('While the schedule field is empty, the timezone picker beside it is off, because the package\'s schedule runs in UTC, and a hint says so; type a cron to pick a timezone');
    // It sits beside what an empty field sends, in the paragraph on editing.
    const editing = text.slice(text.indexOf('**Editing a poll\'s schedule.**'), text.indexOf('**Switching a poll off and on.**'));
    expect(editing).toContain('Studio sends `null` when you clear the schedule field of a saved poll trigger');
    expect(editing).toContain('the timezone picker beside it is off');
  });

  it('says a schedule object on a PATCH replaces the stored schedule as a whole, and a timezone it leaves out is UTC', () => {
    const text = section();
    expect(text).toContain('A `schedule` object replaces the stored schedule as a whole; it is not merged into it');
    expect(text).toContain('It must carry a `cron` (a `timezone` alone is `400` on `connector.schedule.cron`, *cron is required*)');
    expect(text).toContain('a `timezone` it leaves out, or sends as `null` or an empty string, is `UTC`, whatever timezone was stored');
    expect(text).toContain('to change only the cron of a poll that runs in `Europe/Istanbul`, send `"timezone": "Europe/Istanbul"` again');
    // The field table says it in one clause, beside the default and the null.
    const row = /\| `schedule` \|([^|]*)\|/.exec(text)?.[1] ?? '';
    expect(row).toContain('On a PATCH an object replaces the stored schedule as a whole: a `timezone` left out is `UTC`');
  });

  it('keeps the sentences of the edit, of a poll switched off and of a shared poll', () => {
    const text = section();
    // An edit of the schedule alone: the page that was being handed out moves with it.
    expect(text).toContain('moves with the edit and starts nothing twice');
    // A poll whose triggers are all off forgets its place at its next scheduled check; a trigger switched on starts from then.
    expect(text).toContain('the poll forgets its place');
    expect(text).toContain('taken at the next tick of the poller (a minute by default) and not at the next slot of the `schedule`');
    expect(text).toContain('keeps the place, and that check reports what happened meanwhile');
    expect(text).toContain('a `paused` poll keeps its place and catches up when it is back');
    // A shared poll: the trigger over its limit does not hold the others back, and a trigger that never matches lets the page go.
    expect(text).toContain('has nothing left on the page (each event ran');
    expect(text).toContain('has nothing left on the page either, so it lets the page go too');
  });
});

describe('the triggers guide, parameters, Retry and the retired presets', () => {
  it('says what the API checks of a parameter, and that a choice the package reads from the service is checked for its type only', () => {
    const row = /\| `params` \|([^|]*)\|/.exec(flat(connectorSection()))?.[1] ?? '';
    expect(row).not.toBe('');
    expect(row).toContain('a missing required value, a value of the wrong type or format, a parameter the trigger does not declare, or a value outside the package\'s fixed options is `400` on `connector.params.<key>`');
    expect(row).toContain('A field whose choices the package reads from the service (a repository, a table, a column, a board) is checked for its type only');
    expect(row).toContain('a choice that does not exist or cannot be used is stored, and the first poll or the registration of the hook fails, so read `last_error`');
    expect(row).not.toContain('a missing or wrong value is `400`');
  });

  it('says the list of a choice the package reads from the service is not read while the connector has no working account, and the field takes a typed value', () => {
    const row = /\| `params` \|([^|]*)\|/.exec(flat(connectorSection()))?.[1] ?? '';
    expect(row).toContain('While the connector has no working account (none connected, or one that needs a new sign-in or was revoked), the list is not read');
    expect(row).toContain('Studio\'s field says *Connect an account to pick from a list, or type the value.* and takes the value as typed, which is checked like any other');
    // It follows the sentence about the choices the package reads from the service, and does not replace what the save checks.
    expect(row.indexOf('While the connector has no working account')).toBeGreaterThan(row.indexOf('is checked for its type only'));
    expect(row).toContain('so read `last_error`');
  });

  it('says the same where a template asks for the repository of a connector trigger', () => {
    const templates = flat(read('docs/guide/agent-templates.md'));
    expect(templates).toContain('(`owner/name`, chosen from the connector\'s repositories)');
    expect(templates).toContain('While the connector has no working account the list is not read: the field says *Connect an account to pick from a list, or type the value.* and takes `owner/name` as typed.');
  });

  it('says a Retry that binds a lost subscription shows the secret of a hook set up by hand once, and a Retry of an existing one never does', () => {
    const text = flat(connectorSection());
    expect(text).toContain('and in the answer of a **Retry** that binds a trigger whose subscription was gone (`attach_failed`) to a new one, and nowhere else: a Retry of an existing subscription never carries it');
    expect(text).toContain('the answer carries its `secret` once, and a Retry of an existing subscription never does');
    // The rest of the Retry row and of the paragraph on failed registrations.
    expect(text).toContain('Retry changes nothing for those two');
    expect(text).toContain('Studio offers no Retry for those two');
    expect(text).toContain('the subscription itself stays as it was');
  });

  it('names the three packages that replace the presets and the events they do not cover, and what a generic webhook can still receive', () => {
    const text = flat(retiredPresetsSection());
    for (const id of ['cognipeer.github', 'cognipeer.gitlab', 'cognipeer.azure-devops']) expect(text, id).toContain(`\`${id}\``);
    expect(text).toContain('GitHub\'s `pull_request_review`, `check_run` or `release`');
    expect(text).toContain('has no connector trigger yet');
    // The generic modes do not read a vendor's own signature or token; a sender that can add a header of its own can still use them.
    expect(text).toContain('so a delivery that carries only those is not accepted');
    expect(text).toContain('A sender that can add a header of its own can use `bearer` or `header` mode');
    expect(text).toContain('the event is then named by the generic rules');
    expect(text).not.toContain('not a way to receive these vendors');
  });

  it('sends a reader to the Studio Test tab for the fields of an event, not to a page of the connector that lists them', () => {
    expect(flat(retiredPresetsSection())).toContain('the Studio **Test** tab of a saved connector trigger shows its sample event');
    expect(flat(connectorSection())).toContain('The Studio **Test** tab shows the sample event you can write the `filter` and the `prompt` against');
    expect(flat(guide)).not.toContain('connector page lists');
  });
});

describe('the OpenAPI document, the schedule of a poll and the answer of Retry', () => {
  const schemas = openapi.components.schemas as Record<string, Json>;
  const patch = () => flat(openapi.paths['/agents/{agentKey}/triggers/{triggerId}'].patch.description);
  const retry = () => flat(openapi.paths['/agents/{agentKey}/triggers/{triggerId}/connector/retry'].post.description);

  it('describes the schedule of a poll by what the API answers, and what null and a missing schedule do', () => {
    const schedule = flat(schemas.AgentTriggerConnectorRequest.properties.schedule.description);
    expect(schedule).toContain('`L`, `W`, `#` and `?`, macros such as `@daily` and a seconds field are not accepted');
    expect(schedule).toContain('is `400` on `connector.schedule.cron`, with a message that says what is wrong');
    expect(schedule).toContain('Left out on create, or `null`, the schedule is the package\'s own, in UTC');
    expect(schedule).toContain('`null` returns the trigger to the package\'s schedule');
    expect(patch()).toContain('when `connector.schedule` is left out; `connector.schedule: null` returns it to the package\'s own schedule, in UTC');
  });

  it('says a schedule object on a PATCH replaces the stored schedule as a whole, and a timezone it leaves out is UTC', () => {
    const schedule = flat(schemas.AgentTriggerConnectorRequest.properties.schedule.description);
    expect(schedule).toContain('An object on a PATCH replaces the stored schedule as a whole, it is not merged into it');
    expect(schedule).toContain('`cron` is required in it, and a `timezone` it leaves out, or sends as `null` or empty, is `UTC`, whatever timezone was stored');
    expect(patch()).toContain('A `connector.schedule` object replaces the stored schedule as a whole: it must carry a `cron`, and a `timezone` it leaves out, or sends as `null` or empty, is `UTC`, whatever timezone was stored');
  });

  it('says a Retry that binds a lost subscription returns the secret of a hook set up by hand once, and the secret field says so', () => {
    expect(retry()).toContain('returns the signing secret of a hook set up by hand once, in this answer (`connector_subscription.secret`)');
    expect(retry()).toContain('a retry of an existing subscription never does, so rotate the secret to get a new one');
    const secret = flat(schemas.ConnectorSubscription.properties.secret.description);
    expect(secret).toContain('or a Retry that binds a lost one');
    expect(secret).toContain('Shown once');
  });

  it('keeps the sentences of the edit and of the lost connection', () => {
    expect(patch()).toContain('stays as it was');
    expect(patch()).toContain('the poll calls nothing and forgets its place');
    expect(retry()).toContain('is bound to a new one');
  });

  it('does not send a reader to a connector page for the fields of a trigger', () => {
    const create = flat(openapi.paths['/agents/{agentKey}/triggers'].post.description);
    expect(create).not.toContain('the connector page lists');
    expect(create).toContain('the Studio Test tab of a saved connector trigger shows its sample event');
  });
});

describe('a schedule object on a PATCH of a connector poll trigger, as the guide and the OpenAPI document word it', () => {
  const scope = { tenantId: 't1', tenantDbName: 'tenant_t1', projectId: 'p1', actorId: 'user-1' };
  const stored: AgentTriggerConnector = {
    connectorId: 'conn-poll', trigger: 'issue_updated', params: {}, events: [], filter: [], includePayload: true,
    schedule: { cron: '*/10 * * * *', timezone: 'Europe/Istanbul' }, subscriptionId: 'sub_1',
  };
  /** What the PATCH route hands to the one write path: the request's `connector` object and the stored settings. */
  const patch = (connector: Record<string, unknown>) => parseConnectorWrite(scope, connector, stored);
  const scheduleOf = async (connector: Record<string, unknown>) => {
    const written = await patch(connector);
    expect(written.ok, JSON.stringify(written)).toBe(true);
    return written.ok ? written.connector.schedule : undefined;
  };

  beforeEach(() => registerConnectorTriggerHost(createFakeConnectorHost().host));
  afterEach(() => __resetConnectorTriggerHostForTests());

  it('keeps the stored schedule when the request leaves it out', async () => {
    expect(await scheduleOf({ events: ['issue.created'] })).toEqual({ cron: '*/10 * * * *', timezone: 'Europe/Istanbul' });
  });

  it('replaces the stored schedule as a whole: a timezone left out, null or empty is UTC, whatever was stored', async () => {
    expect(await scheduleOf({ schedule: { cron: '*/20 * * * *' } })).toEqual({ cron: '*/20 * * * *', timezone: 'UTC' });
    expect(await scheduleOf({ schedule: { cron: '*/20 * * * *', timezone: null } })).toEqual({ cron: '*/20 * * * *', timezone: 'UTC' });
    expect(await scheduleOf({ schedule: { cron: '*/20 * * * *', timezone: '' } })).toEqual({ cron: '*/20 * * * *', timezone: 'UTC' });
    // The same cron as the stored one does not keep the stored timezone either.
    expect(await scheduleOf({ schedule: { cron: '*/10 * * * *' } })).toEqual({ cron: '*/10 * * * *', timezone: 'UTC' });
  });

  it('keeps a timezone only when it is sent again with the cron', async () => {
    expect(await scheduleOf({ schedule: { cron: '*/20 * * * *', timezone: 'Europe/Istanbul' } })).toEqual({ cron: '*/20 * * * *', timezone: 'Europe/Istanbul' });
    expect(await scheduleOf({ schedule: { cron: '  */20   * * * *  ', timezone: 'America/New_York' } })).toEqual({ cron: '*/20 * * * *', timezone: 'America/New_York' });
  });

  it('does not take a timezone alone: the cron is required', async () => {
    const written = await patch({ schedule: { timezone: 'Europe/Istanbul' } });
    expect(written).toEqual({ ok: false, errors: [{ field: 'connector.schedule.cron', message: 'cron is required' }] });
  });
});

/** Paragraphs, list items, table rows and headings of a text, so that a sentence is judged on its own. */
function units(text: string): string[] {
  const out: string[] = [];
  let open = false;
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      open = false;
    } else if (!open || /^\s*(?:[-*]\s|\d+\.\s|\||#{1,6}\s)/.test(line)) {
      out.push(line);
      open = true;
    } else {
      out[out.length - 1] += `\n${line}`;
    }
  }
  return out;
}

/** What a text says that makes a retired preset read as one a person can create: "Presets for GitHub ...", "the GitLab preset", `preset: github`, `github_signature`. */
const PRESET_AS_AVAILABLE = [
  /\bpresets?\b[^.\n|]{0,60}\b(?:github|gitlab|azure[ _]?devops)\b/i,
  /\b(?:github|gitlab|azure[ _]?devops)\b[`'"*]*\s+(?:webhook\s+)?presets?\b/i,
  /\bpreset["'`]*\s*[:=]\s*["'`]*(?:github|gitlab|azure_devops)\b/i,
  /\b(?:github_signature|gitlab_token)\b/,
];
/** Words that make such a mention a statement about the past or about the read-only legacy. */
const RETIRED_WORDS = /\b(?:retire[ds]?|gone|legacy|read-only|earlier releases?|no longer|replac(?:e|es|ed)|refused|410)\b/i;

/** The sentences of a text that present a retired preset as available. A sentence is judged on its own (a long bullet may say "no longer" about something else), and a sentence that wraps is still one. */
const presentedAsAvailable = (text: string): string[] =>
  units(text)
    .flatMap((unit) => flat(unit).split(/(?<=[.!?])\s+(?=[A-Z`*(\[])/))
    .filter((sentence) => PRESET_AS_AVAILABLE.some((pattern) => pattern.test(sentence)) && !RETIRED_WORDS.test(sentence));

/** Every Markdown file under a folder of the repository (not the images in `public`). */
function markdownFiles(dir: string): string[] {
  return readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'public' || entry.name === 'node_modules' ? [] : markdownFiles(file);
    return entry.name.endsWith('.md') ? [file] : [];
  });
}

/** The prose of a parsed document: its descriptions, summaries and messages (not the values of an enum, which may list what a stored record can still hold). */
function proseIn(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const item of value) proseIn(item, out);
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'string' && ['description', 'summary', 'message', 'title'].includes(key)) out.push(item);
      else proseIn(item, out);
    }
  }
  return out;
}

describe('no document presents a retired vendor preset as one a person can create', () => {
  it('is not said by the changelog, the README or a documentation page', () => {
    const found = ['CHANGELOG.md', 'README.md', ...markdownFiles('docs')]
      .flatMap((file) => presentedAsAvailable(read(file)).map((sentence) => `${file}: ${sentence.slice(0, 160)}`));
    expect(found).toEqual([]);
  });

  it('is not said by a description of the OpenAPI document, and a webhook write names the generic preset and the four generic modes only', () => {
    expect(proseIn(openapi).flatMap((text) => presentedAsAvailable(text).map((sentence) => sentence.slice(0, 160)))).toEqual([]);
    const request = (openapi.components.schemas as Record<string, Json>).AgentTriggerWebhookRequest.properties;
    expect(request.preset.enum).toEqual(['generic']);
    expect(request.auth.enum).toEqual(['bearer', 'signature', 'header', 'standard_webhooks']);
    // No request example of a trigger operation names a retired preset or mode.
    const examples: Json[] = [];
    for (const [route, methods] of Object.entries(openapi.paths) as Array<[string, Json]>) {
      if (!route.includes('/triggers')) continue;
      for (const operation of Object.values(methods) as Json[]) {
        const content = operation?.requestBody?.content?.['application/json'];
        if (content?.example !== undefined) examples.push(content.example);
        for (const item of Object.values(content?.examples ?? {}) as Json[]) examples.push(item.value);
      }
    }
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) {
      if (example?.webhook?.preset !== undefined) expect(example.webhook.preset).toBe('generic');
      if (example?.webhook?.auth !== undefined) expect(['bearer', 'signature', 'header', 'standard_webhooks']).toContain(example.webhook.auth);
    }
  });

  it('notices the sentences it is there for, and lets the ones about the retirement through', () => {
    expect(presentedAsAvailable('- Presets for GitHub, GitLab, Azure DevOps and a generic sender, an event allow-list')).toHaveLength(1);
    // A sentence that wraps is still one sentence (the line of the changelog broke between "Presets for" and "GitHub").
    expect(presentedAsAvailable('- **Incoming webhooks**: a trigger starts when something posts. Presets for\n  GitHub, GitLab, Azure DevOps and a generic sender, an event allow-list\n  and payload filters.')).toHaveLength(1);
    expect(presentedAsAvailable('- The presets of GitHub and\n  GitLab are retired.')).toHaveLength(0);
    // Another sentence of the same bullet that says "no longer" does not excuse it.
    expect(presentedAsAvailable('- Webhooks have presets for GitHub and GitLab. The variable of a run is no longer empty.')).toHaveLength(1);
    expect(presentedAsAvailable('Create it with `"preset": "github"` and a secret.')).toHaveLength(1);
    expect(presentedAsAvailable('The `gitlab` preset checks the token.')).toHaveLength(1);
    expect(presentedAsAvailable('A webhook with preset: azure_devops and basic credentials.')).toHaveLength(1);
    expect(presentedAsAvailable('Set `auth` to `github_signature`.')).toHaveLength(1);
    expect(presentedAsAvailable('The old `github` preset is retired and read-only.')).toHaveLength(0);
    expect(presentedAsAvailable('They replace the GitHub webhook preset of earlier releases.')).toHaveLength(0);
    expect(presentedAsAvailable('A hook of a retired vendor preset (`github`, `gitlab`, `azure_devops`) answers 410.')).toHaveLength(0);
    expect(presentedAsAvailable('Use a connector for a service (GitHub, GitLab, Azure DevOps and others).')).toHaveLength(0);
  });
});

/** The id a heading gets as a link target (what the documentation site makes of it). */
const headingId = (heading: string): string => heading.replace(/`/g, '').trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-');

function headingIds(file: string): Set<string> {
  const ids = new Set<string>();
  let fenced = false;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.startsWith('```')) fenced = !fenced;
    const heading = fenced ? null : /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) ids.add(headingId(heading[1]));
  }
  return ids;
}

/** The links of a Markdown file to a page of the documentation (or a heading of it) that is not there. */
function brokenLinks(file: string): string[] {
  const from = path.join(ROOT, file);
  const broken: string[] = [];
  for (const match of readFileSync(from, 'utf8').matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = match[1];
    if (/^(?:https?:|mailto:)/.test(target)) continue;
    const [page, anchor] = target.split('#');
    const resolved = page === '' ? from : page.startsWith('/') ? path.join(ROOT, 'docs', page.endsWith('.md') ? page : `${page}.md`) : path.resolve(path.dirname(from), page);
    let ids: Set<string>;
    try {
      ids = headingIds(resolved);
    } catch {
      broken.push(`${target}: no such page`);
      continue;
    }
    if (anchor && !ids.has(anchor)) broken.push(`${target}: no such heading`);
  }
  return broken;
}

describe('links of the changelog and of the triggers guide', () => {
  it('point at pages and headings that exist', () => {
    expect(brokenLinks('CHANGELOG.md')).toEqual([]);
    expect(brokenLinks('docs/guide/agent-triggers.md')).toEqual([]);
  });
});
