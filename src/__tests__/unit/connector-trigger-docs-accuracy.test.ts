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
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import type { IAgentTrigger } from '@/lib/database';
import { eventView } from '@/lib/services/agents/agentTriggerEventDispatch';
import {
  WEBHOOK_CONTEXT_ROOTS,
  firstFilterMiss,
  parseFilterRules,
  resolveFilterPath,
  templateProblem,
} from '@/lib/services/agents/agentTriggerWebhookView';
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
