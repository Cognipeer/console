/**
 * The PII protection picker of the model edit page and the agent Build tab: its pure rules, the field in English and
 * Turkish, the "uses / used by" edges a chosen policy creates, and the Build tab's changed-section flag.
 * (createElement, not JSX: the suite only collects `.test.ts`.)
 */
import React, { createElement as h, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { I18nProvider } from '@/lib/i18n';
import PiiProtectionField from '@/components/pii/PiiProtectionField';
import {
  NO_PII_POLICIES,
  piiPolicyKeyOf,
  piiPolicyState,
  piiProtectionPayload,
  type PiiPolicyOptions,
} from '@/components/pii/piiProtectionForm';
import { changedConfigSections } from '@/components/agents/studio/configSections';
import { extractAgentEdges, extractModelEdges } from '@/lib/resources/providers/core';
import { EDGE_KINDS } from '@/lib/resources/references';
import { piiProtectionEn } from '@/lib/i18n/messages/piiProtection.en';
import { piiProtectionTr } from '@/lib/i18n/messages/piiProtection.tr';
import { en } from '@/lib/i18n/messages/en';
import { tr } from '@/lib/i18n/messages/tr';

(globalThis as { React?: typeof React }).React = React;

const render = (node: ReactNode, locale: 'en' | 'tr' = 'en') =>
  renderToStaticMarkup(h(MantineProvider, null, h(I18nProvider, { locale, children: node })));
const noop = () => undefined;

const policies: PiiPolicyOptions = {
  policies: [
    { id: 'p1', key: 'tc-only', name: 'TC only', enabled: true, engine: 'regex' },
    { id: 'p2', key: 'banking', name: 'Banking PII', enabled: false, engine: 'cognipeer' },
  ],
  loading: false,
  failed: false,
};

describe('the protection value', () => {
  it('judges a chosen key against the loaded policies', () => {
    expect(piiPolicyState(null, policies)).toBe('off');
    expect(piiPolicyState('tc-only', policies)).toBe('ok');
    expect(piiPolicyState('banking', policies)).toBe('disabled');
    expect(piiPolicyState('deleted', policies)).toBe('missing');
    // Nothing to judge by while the list loads or when it failed: never "missing".
    expect(piiPolicyState('deleted', { ...policies, loading: true })).toBe('pending');
    expect(piiPolicyState('deleted', { ...NO_PII_POLICIES, failed: true })).toBe('pending');
  });

  it('goes to the API as { policyKey } or null, and comes back as a key', () => {
    expect(piiProtectionPayload('tc-only')).toEqual({ policyKey: 'tc-only' });
    expect(piiProtectionPayload(' ')).toBeNull();
    expect(piiProtectionPayload(null)).toBeNull();
    expect(piiPolicyKeyOf({ policyKey: 'tc-only' })).toBe('tc-only');
    expect(piiPolicyKeyOf(null)).toBeNull();
    expect(piiPolicyKeyOf(undefined)).toBeNull();
    expect(piiPolicyKeyOf({ policyKey: '' })).toBeNull();
  });
});

describe('the field', () => {
  it('off: the picker only, no limits', () => {
    const html = render(h(PiiProtectionField, { surface: 'model', value: null, onChange: noop, policies }));
    expect(html).toContain(piiProtectionEn.policy.label);
    expect(html).not.toContain(piiProtectionEn.limits.media);
  });

  it('a model with a policy: a link to the policy and the model notes', () => {
    const html = render(h(PiiProtectionField, { surface: 'model', value: 'tc-only', onChange: noop, policies }));
    expect(html).toContain('href="/dashboard/pii/p1"');
    expect(html).toContain(piiProtectionEn.limits.media);
    expect(html).toContain(piiProtectionEn.limits.logs);
    expect(html).not.toContain(piiProtectionEn.limits.session);
  });

  it('flags a policy that is gone (calls fail) and one that is off (calls go out unprotected)', () => {
    const missing = render(h(PiiProtectionField, { surface: 'model', value: 'deleted', onChange: noop, policies }));
    expect(missing).toContain('The policy “deleted” is not in this project any more');
    const disabled = render(h(PiiProtectionField, { surface: 'model', value: 'banking', onChange: noop, policies }));
    expect(disabled).toContain(piiProtectionEn.policy.disabled);
  });

  it('offers to create a policy in place when the project has none (no link away from the unsaved form)', () => {
    const html = render(h(PiiProtectionField, { surface: 'model', value: null, onChange: noop, policies: NO_PII_POLICIES }));
    expect(html).toContain(piiProtectionEn.policy.none);
    expect(html).toContain('data-testid="pii-policy-create-inline"');
    expect(html).toContain(piiProtectionEn.policy.create);
    expect(html).not.toContain('href="/dashboard/pii"');
  });

  it('a project with policies still offers a new one; a disabled field offers none', () => {
    const html = render(h(PiiProtectionField, { surface: 'model', value: null, onChange: noop, policies }));
    expect(html).toContain(piiProtectionEn.policy.new);
    const off = render(h(PiiProtectionField, { surface: 'model', value: null, onChange: noop, policies, disabled: true }));
    expect(off).not.toContain('data-testid="pii-policy-create-inline"');
  });

  it('an agent shows the main model’s policy: inherited when it picks none, replaced when it picks one', () => {
    const inherited = render(h(PiiProtectionField, {
      surface: 'agent', value: null, onChange: noop, policies, modelPolicyKey: 'tc-only', modelName: 'gpt-4o-prod',
    }));
    expect(inherited).toContain('The model gpt-4o-prod already protects every call with the policy TC only');
    const replaced = render(h(PiiProtectionField, {
      surface: 'agent', value: 'banking', onChange: noop, policies, modelPolicyKey: 'tc-only', modelName: 'gpt-4o-prod',
    }));
    expect(replaced).toContain('Replaces the policy TC only of the model gpt-4o-prod for this agent.');
    expect(replaced).toContain(piiProtectionEn.limits.session);
  });

  it('speaks Turkish', () => {
    const html = render(h(PiiProtectionField, { surface: 'agent', value: 'tc-only', onChange: noop, policies }), 'tr');
    expect(html).toContain(piiProtectionTr.policy.label);
    expect(html).toContain(piiProtectionTr.limits.session);
  });
});

describe('the strings', () => {
  const keys = (node: unknown, prefix = ''): string[] =>
    node && typeof node === 'object'
      ? Object.entries(node as Record<string, unknown>).flatMap(([k, v]) => keys(v, `${prefix}${k}.`))
      : [prefix.slice(0, -1)];
  const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  const at = (root: unknown, key: string) => key.split('.').reduce<unknown>((n, k) => (n as Record<string, unknown>)[k], root) as string;

  it('English and Turkish have the same keys and placeholders, and both are registered', () => {
    expect(keys(piiProtectionTr).sort()).toEqual(keys(piiProtectionEn).sort());
    for (const key of keys(piiProtectionEn)) {
      expect(placeholders(at(piiProtectionTr, key))).toEqual(placeholders(at(piiProtectionEn, key)));
    }
    expect(en.piiProtection).toBe(piiProtectionEn);
    expect(tr.piiProtection).toBe(piiProtectionTr);
  });
});

describe('references', () => {
  const pick = (edges: { kind: string; target: string; field: string }[] | undefined) =>
    (edges ?? []).filter((e) => e.kind.endsWith('.piiPolicy')).map((e) => `${e.kind}:${e.target}@${e.field}`);

  it('a model and an agent with a policy use it; without one they use none', () => {
    expect(pick(extractModelEdges({ category: 'llm', providerKey: 'p', piiProtection: { policyKey: 'tc-only' } })))
      .toEqual(['model.piiPolicy:tc-only@piiProtection.policyKey']);
    expect(pick(extractModelEdges({ category: 'llm', providerKey: 'p', piiProtection: null }))).toEqual([]);
    expect(pick(extractAgentEdges({ config: { modelKey: 'm', piiProtection: { policyKey: 'tc-only' } } })))
      .toEqual(['agent.piiPolicy:tc-only@config.piiProtection.policyKey']);
    expect(pick(extractAgentEdges({ config: { modelKey: 'm' } }))).toEqual([]);
  });

  it('a missing or disabled policy is an error on both, looked up in the referrer’s own project', () => {
    for (const kind of ['model.piiPolicy', 'agent.piiPolicy']) {
      expect(EDGE_KINDS[kind]).toMatchObject({ toType: 'pii-policy', scope: 'strict-project', severity: 'error', inactiveBreaks: true });
    }
    expect((en.resources as unknown as { edgeKinds: Record<string, string> }).edgeKinds['model.piiPolicy']).toBeTruthy();
  });
});

describe('the Build tab', () => {
  it('flags General as changed when only the PII policy differs from the published version', () => {
    const published = { modelKey: 'm', piiProtection: { policyKey: 'tc-only' } };
    expect(changedConfigSections({ modelKey: 'm', piiProtection: { policyKey: 'banking' } }, published)).toEqual(new Set(['basic']));
    expect(changedConfigSections({ modelKey: 'm', piiProtection: { policyKey: 'tc-only' } }, published)).toEqual(new Set());
  });
});
