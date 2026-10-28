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
