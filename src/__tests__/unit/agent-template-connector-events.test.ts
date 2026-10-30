/**
 * The connector triggers of the agent templates against the events the
 * connector package really emits.
 *
 * A connector event's data is whatever the package's parse hook shapes (the
 * GitHub package: a flat `{ action, repository: "owner/name", number, draft,
 * headBranch ... }`, not GitHub's raw webhook body) and it is handed to the
 * trigger engine unchanged as `payload`. A filter path or a prompt tag the
 * event does not carry is absent, and an absent path matches nothing (except
 * `not_exists`): a template written on the wrong names would filter out every
 * delivery. So every template's connector trigger is held to the package's
 * declared event data (`githubConnectorFixture`, copied from its manifest):
 *
 * - every filter path and every prompt / variable tag resolves on the sample;
 * - the sample passes the template's own filter (and the events a template
 *   does not want do not);
 * - the turn built from it has no empty tag.
 */

import Mustache from 'mustache';
import { describe, expect, it } from 'vitest';

import type { IAgentTrigger } from '@/lib/database';
import { buildEventTurn, connectorPreface, eventView } from '@/lib/services/agents/agentTriggerEventDispatch';
import {
  WEBHOOK_CONTEXT_ROOTS,
  filterRuleMatches,
  firstFilterMiss,
  resolveFilterPath,
} from '@/lib/services/agents/agentTriggerWebhookView';
import { AGENT_TEMPLATES, findAgentTemplate } from '@/lib/services/agents/templates/catalog';
import type { AgentTemplate, AgentTemplateTrigger } from '@/lib/services/agents/templates/types';
import { GITHUB_PACKAGE_ID, GITHUB_TRIGGERS } from '../helpers/githubConnectorFixture';

type FixtureName = keyof typeof GITHUB_TRIGGERS;

const connectorTemplates = AGENT_TEMPLATES.flatMap((template) =>
  (template.triggers ?? []).filter((trigger) => trigger.type === 'connector').map((trigger) => ({ template, trigger })));

/** Every tag name in a Mustache text, sections included. */
function tagNames(text: string): string[] {
  const names: string[] = [];
  const walk = (tokens: ReturnType<typeof Mustache.parse>) => {
    for (const token of tokens) {
      if (['name', '&', '{', '#', '^'].includes(String(token[0]))) names.push(String(token[1]));
      const children = token[4];
      if (Array.isArray(children)) walk(children as ReturnType<typeof Mustache.parse>);
    }
  };
  walk(Mustache.parse(text));
  return names;
}

/** The tags of a trigger's prompt and of its variable mapping (`{{a.b}}` values). */
function templateTags(trigger: AgentTemplateTrigger): string[] {
  const texts = [trigger.prompt, ...Object.values(trigger.variables ?? {}).filter((value): value is string => typeof value === 'string')];
  return texts.flatMap((text) => tagNames(text));
}

const packageTrigger = (trigger: AgentTemplateTrigger) => GITHUB_TRIGGERS[trigger.connector!.trigger as FixtureName];

function fixtureOf(trigger: AgentTemplateTrigger) {
  const fixture = packageTrigger(trigger);
  if (!fixture) throw new Error(`githubConnectorFixture has no "${trigger.connector!.trigger}" trigger: copy it from the package manifest`);
  return fixture;
}

/** The view a delivery of this trigger is filtered and rendered over. */
function viewOf(trigger: AgentTemplateTrigger, data: unknown, event: string) {
  const stored = { _id: 't1', name: trigger.name, agentKey: 'agent' } as unknown as IAgentTrigger;
  return eventView({
    trigger: stored,
    preset: 'connector',
    payload: data,
    headers: {},
    identity: { event, deliveryId: 'delivery-1' },
    receivedAt: new Date('2026-10-28T10:00:00.000Z'),
    connector: { id: 'conn-1', key: 'github', name: 'GitHub', packageId: GITHUB_PACKAGE_ID, trigger: trigger.connector!.trigger },
  });
}

const present = (view: unknown, path: string) => {
  const resolved = resolveFilterPath(view, path);
  if (resolved.list) return (resolved.value as unknown[]).length > 0;
  return resolved.value !== undefined && resolved.value !== null;
};

describe('the fixture of the GitHub package', () => {
  it('describes samples that carry exactly the declared event data', () => {
    for (const [name, fixture] of Object.entries(GITHUB_TRIGGERS)) {
      expect(Object.keys(fixture.sample.data).sort(), name).toEqual([...fixture.properties].sort());
      expect(fixture.events, name).toContain(fixture.sample.type);
      expect(fixture.events.every((event) => event.startsWith(`${name}.`)), name).toBe(true);
    }
  });
});

describe('connector triggers in the agent templates', () => {
  it('exist for the pull request reviewer and the CI failure triage', () => {
    expect(connectorTemplates.map(({ template }) => template.key).sort()).toEqual(['ci-failure-triage', 'pr-reviewer']);
  });

  describe.each(connectorTemplates.map((entry) => [entry.template.key, entry] as const))('%s', (_key, { template, trigger }) => {
    const fixture = fixtureOf(trigger);
    const sample = fixture.sample.data;
    const view = viewOf(trigger, sample, fixture.sample.type);

    it('listens to a package and a trigger the package declares, on events it reports', () => {
      expect(trigger.connector!.package).toBe(GITHUB_PACKAGE_ID);
      expect(Object.keys(GITHUB_TRIGGERS)).toContain(trigger.connector!.trigger);
      for (const event of trigger.connector!.events ?? []) expect(fixture.events, event).toContain(event);
    });

    it('filters on properties the event data declares, and that the sample carries', () => {
      const rules = trigger.connector!.filter ?? [];
      expect(rules.length).toBeGreaterThan(0);
      for (const rule of rules) {
        const [root, property] = rule.path.split('.');
        expect(root, rule.path).toBe('payload');
        expect(fixture.properties, rule.path).toContain(property);
        // A rule on an absent path can only be met by not_exists.
        expect(present(view, rule.path), rule.path).toBe(true);
      }
    });

    it('reads only context roots and declared event properties in its prompt and variables, all present on the sample', () => {
      const tags = templateTags(trigger);
      expect(tags.length).toBeGreaterThan(0);
      for (const tag of tags) {
        const [root, property, ...rest] = tag.split('.');
        expect(WEBHOOK_CONTEXT_ROOTS as readonly string[], tag).toContain(root);
        if (root === 'payload') {
          // The data is flat: one level below payload, never GitHub's nested `pull_request.user.login`.
          expect(rest, tag).toEqual([]);
          expect(fixture.properties, tag).toContain(property);
        }
        expect(present(view, tag), tag).toBe(true);
      }
    });

    it('declares the variables its mapping fills', () => {
      const declared = (template.spec.variables ?? []).map((variable) => variable.name);
      for (const name of Object.keys(trigger.variables ?? {})) expect(declared, name).toContain(name);
    });

    it('does not mention what the event does not carry', () => {
      const text = JSON.stringify([trigger.prompt, trigger.variables, trigger.connector!.filter]);
      for (const raw of ['full_name', 'html_url', 'head_branch', 'changed_files', 'additions', 'deletions', 'head_commit', '.user.login', 'pull_request.', 'workflow_run.']) {
        expect(text, raw).not.toContain(raw);
      }
    });
  });
});

describe('the pull request reviewer on the package\'s pull request events', () => {
  const template = findAgentTemplate('pr-reviewer') as AgentTemplate;
  const trigger = template.triggers![0];
  const fixture = GITHUB_TRIGGERS.pull_request;
  const rules = trigger.connector!.filter!;
  const run = (data: Record<string, unknown>, event = `pull_request.${String(data.action)}`) => firstFilterMiss(viewOf(trigger, data, event), rules);

  it('accepts the package\'s own sample event', () => {
    expect(run(fixture.sample.data, fixture.sample.type)).toBeNull();
  });

  it.each(['opened', 'reopened', 'synchronize', 'ready_for_review'])('reviews a %s pull request', (action) => {
    expect(run({ ...fixture.sample.data, action })).toBeNull();
  });

  it.each(['edited', 'closed', 'labeled', 'assigned', 'converted_to_draft', 'review_requested'])('leaves a %s pull request alone', (action) => {
    expect(run({ ...fixture.sample.data, action })).toMatch(/^rule 1 \(payload\.action in\) did not match/);
  });

  it('leaves a draft pull request alone, and reviews it once it is ready', () => {
    expect(run({ ...fixture.sample.data, draft: true })).toMatch(/^rule 2 \(payload\.draft eq\) did not match/);
    expect(run({ ...fixture.sample.data, action: 'ready_for_review', draft: false })).toBeNull();
  });

  it('would filter out every event if it still read GitHub\'s own body', () => {
    const raw = { path: 'payload.pull_request.draft', op: 'eq' as const, value: false };
    expect(filterRuleMatches(viewOf(trigger, fixture.sample.data, fixture.sample.type), raw)).toBe(false);
    expect(firstFilterMiss(viewOf(trigger, fixture.sample.data, fixture.sample.type), [rules[0], raw])).toMatch(/^rule 2 \(payload\.pull_request\.draft eq\) did not match \(value: absent\)/);
  });

  it('turns the event into a prompt with every detail and the repository variable', () => {
    const data = fixture.sample.data;
    const stored = { _id: 't1', name: trigger.name, agentKey: 'pr-reviewer', prompt: trigger.prompt, variables: trigger.variables } as unknown as IAgentTrigger;
    const turn = buildEventTurn({
      trigger: stored,
      preface: connectorPreface({ packageName: 'GitHub', triggerTitle: 'Pull request' }, fixture.sample.type),
      payloadLabel: 'Connector',
      includePayload: trigger.connector!.includePayload,
      declared: template.spec.variables,
      view: viewOf(trigger, data, fixture.sample.type),
      payload: data,
    });
    expect(turn.ok).toBe(true);
    if (!turn.ok) return;
    expect(turn.variables).toEqual({ repository: 'octocat/Hello-World', focus: 'correctness, security, tests' });
    for (const text of ['1347', '"octocat/Hello-World"', '"Amazing new feature"', '"octocat"', '"new-topic"', '"master"', 'https://github.com/octocat/Hello-World/pull/1347', 'Please pull these awesome changes in!']) {
      expect(turn.message, text).toContain(text);
    }
    // No tag came out empty: a `Review pull request  in :` would show here.
    expect(turn.message).not.toMatch(/pull request\s+in\b/);
    expect(turn.message).not.toMatch(/Author:\s*\./);
    expect(turn.message).not.toMatch(/Merging\s+into/);
  });
});

describe('the CI failure triage on the package\'s workflow run events', () => {
  const template = findAgentTemplate('ci-failure-triage') as AgentTemplate;
  const trigger = template.triggers!.find((item) => item.type === 'connector')!;
  const fixture = GITHUB_TRIGGERS.workflow_run;
  const rules = trigger.connector!.filter!;
  const run = (data: Record<string, unknown>, event = `workflow_run.${String(data.action)}`) => firstFilterMiss(viewOf(trigger, data, event), rules);

  it('ignores a run that succeeded (the package\'s sample)', () => {
    expect(fixture.sample.data.conclusion).toBe('success');
    expect(run(fixture.sample.data, fixture.sample.type)).toMatch(/^rule 2 \(payload\.conclusion in\) did not match/);
  });

  it.each(['failure', 'timed_out'])('triages a run that ended in %s', (conclusion) => {
    expect(run({ ...fixture.sample.data, conclusion })).toBeNull();
  });

  it.each(['cancelled', 'skipped', 'neutral', 'action_required', null])('ignores a run that ended in %s', (conclusion) => {
    expect(run({ ...fixture.sample.data, conclusion })).not.toBeNull();
  });

  it.each(['requested', 'in_progress'])('ignores a %s run', (action) => {
    expect(run({ ...fixture.sample.data, action, conclusion: 'failure' })).toMatch(/^rule 1 \(payload\.action eq\) did not match/);
  });

  it('turns a failed run into a prompt with every detail', () => {
    const data = { ...fixture.sample.data, conclusion: 'failure', name: 'Test', branch: 'feature/invoice-export', runAttempt: 2 };
    const stored = { _id: 't1', name: trigger.name, agentKey: 'ci-failure-triage', prompt: trigger.prompt, variables: trigger.variables } as unknown as IAgentTrigger;
    const turn = buildEventTurn({
      trigger: stored,
      preface: connectorPreface({ packageName: 'GitHub', triggerTitle: 'Workflow run' }, fixture.sample.type),
      payloadLabel: 'Connector',
      includePayload: trigger.connector!.includePayload,
      declared: template.spec.variables,
      view: viewOf(trigger, data, fixture.sample.type),
      payload: data,
    });
    expect(turn.ok).toBe(true);
    if (!turn.ok) return;
    for (const text of ['"Test"', '"failure"', '"octocat/Hello-World"', '"feature/invoice-export"', '30433642', 'attempt 2', '"acb5820ced9479c074f688cc328bf03f341a511d"', 'https://github.com/octocat/Hello-World/actions/runs/30433642']) {
      expect(turn.message, text).toContain(text);
    }
    expect(turn.message).not.toMatch(/Workflow\s+ended/);
    expect(turn.message).not.toMatch(/branch\s+\(/);
  });
});
