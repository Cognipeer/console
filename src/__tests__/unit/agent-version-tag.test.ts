// @vitest-environment jsdom
/**
 * The version tag beside an agent's name on the Evaluations and Red-team screens: what it says for a
 * configuration's default and for a run (the version that answered, the draft, what was asked before the run
 * started), its colour, and the draft that changed under a run. Plus the tag in a DOM.
 * (createElement, not JSX: the suite only collects `.test.ts`.)
 */

import { createElement as h } from 'react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import AgentWithVersion from '@/components/agents/AgentWithVersion';
import { DRAFT_CHANGED_NOTE, configVersionTag, runVersionTag } from '@/components/agents/agentVersionTag';
import { storedVersionFromPicker, type IAgentRunRevision } from '@/lib/shared/agentRevision';
import { installDomStubs, mount, type Mounted } from '../helpers/iamCenterUi';

describe('configVersionTag', () => {
  it('follows the published version when nothing is pinned, or the default predates pinning', () => {
    for (const stored of [undefined, null, 'published']) {
      expect(configVersionTag(stored)).toEqual({
        label: 'published',
        color: 'teal',
        tooltip: 'Follows the published version',
        changed: false,
      });
    }
  });

  it('shows a pinned version as v3, in the neutral colour', () => {
    expect(configVersionTag(3)).toEqual({
      label: 'v3',
      color: 'teal',
      tooltip: 'Pinned to version 3',
      changed: false,
    });
  });

  it('marks the draft in orange', () => {
    expect(configVersionTag('draft')).toEqual({
      label: 'draft',
      color: 'orange',
      tooltip: 'Tests the saved draft, not a published version',
      changed: false,
    });
  });

  it('reads anything else as the published version instead of showing it', () => {
    for (const stored of [0, -1, 1.5, '3', 'v3', {}, [], true]) {
      expect(configVersionTag(stored).label).toBe('published');
    }
  });
});

describe('runVersionTag', () => {
  it('has no tag for a run that carries no revision (made before it was recorded, or not an agent run)', () => {
    expect(runVersionTag(undefined)).toBeNull();
    expect(runVersionTag(null)).toBeNull();
  });

  it('shows the version that answered, with how it was asked for in the tooltip', () => {
    expect(runVersionTag({ requested: 'published', version: 4 })).toEqual({
      label: 'v4',
      color: 'teal',
      tooltip: 'v4 (published)',
      changed: false,
    });
    expect(runVersionTag({ requested: 3, version: 3 })).toEqual({
      label: 'v3',
      color: 'teal',
      tooltip: 'v3',
      changed: false,
    });
  });

  it('shows the draft in orange when the draft answered, with its fingerprint', () => {
    expect(runVersionTag({ requested: 'draft', version: null, draftFingerprint: '3f2a…' })).toEqual({
      label: 'draft',
      color: 'orange',
      tooltip: 'draft · 3f2a…',
      changed: false,
    });
  });

  it('shows the draft when nothing was published to follow', () => {
    expect(runVersionTag({ requested: 'published', version: null })).toEqual({
      label: 'draft',
      color: 'orange',
      tooltip: 'draft (nothing published)',
      changed: false,
    });
  });

  it('shows what was asked for until the run has started', () => {
    expect(runVersionTag({ requested: 'published' })?.label).toBe('published');
    expect(runVersionTag({ requested: 4 })?.label).toBe('v4');
    expect(runVersionTag({ requested: 'draft' })).toMatchObject({ label: 'draft', color: 'orange', tooltip: 'draft' });
  });

  it('warns when the draft was saved while the run was in progress', () => {
    const run: IAgentRunRevision = { requested: 'draft', version: null, draftFingerprint: '3f2a…', draftChanged: true };
    expect(runVersionTag(run)).toEqual({
      label: 'draft',
      color: 'yellow',
      tooltip: `draft · 3f2a…\n${DRAFT_CHANGED_NOTE}`,
      changed: true,
    });
    expect(DRAFT_CHANGED_NOTE).toBe('The draft was saved while this run was in progress');
  });

  it('does not warn on a run whose draft did not change', () => {
    expect(runVersionTag({ requested: 'draft', version: null, draftChanged: false })).toMatchObject({ color: 'orange', changed: false });
  });

  it('survives a revision that is missing its fields', () => {
    expect(runVersionTag({} as IAgentRunRevision)).toMatchObject({ label: 'published', color: 'teal' });
  });
});

describe('storedVersionFromPicker', () => {
  it('turns a version picker value into a stored default', () => {
    expect(storedVersionFromPicker('')).toBeNull();
    expect(storedVersionFromPicker('published')).toBeNull();
    expect(storedVersionFromPicker(null)).toBeNull();
    expect(storedVersionFromPicker(undefined)).toBeNull();
    expect(storedVersionFromPicker('draft')).toBe('draft');
    expect(storedVersionFromPicker('3')).toBe(3);
    expect(storedVersionFromPicker('12')).toBe(12);
  });

  it('follows the published version for a value that is not a version', () => {
    for (const value of ['0', '-1', '1.5', 'abc', 'v3', ' 3']) expect(storedVersionFromPicker(value)).toBeNull();
  });
});

describe('AgentWithVersion', () => {
  beforeAll(() => {
    installDomStubs();
  });

  const mounted: Mounted[] = [];
  afterEach(async () => {
    for (const item of mounted.splice(0)) await item.unmount();
  });

  async function show(element: Parameters<typeof mount>[0]) {
    const item = await mount(h('p', { 'data-subject': '' }, element));
    mounted.push(item);
    return item.host.querySelector<HTMLElement>('[data-subject]')!;
  }

  it('draws the name with the version beside it, in spans only so it fits a paragraph', async () => {
    const subject = await show(h(AgentWithVersion, { name: 'support-bot', tag: configVersionTag(3) }));
    expect(subject.textContent).toBe('support-botv3');
    const badge = subject.querySelector('.mantine-Badge-root');
    expect(badge?.tagName).toBe('SPAN');
    expect(badge?.textContent).toBe('v3');
    expect(subject.querySelectorAll('div')).toHaveLength(0);
  });

  it('draws the name alone when there is no tag', async () => {
    const subject = await show(h(AgentWithVersion, { name: 'support-bot', tag: null }));
    expect(subject.textContent).toBe('support-bot');
    expect(subject.querySelector('.mantine-Badge-root')).toBeNull();
  });

  it('draws the tag alone when there is no name, and nothing when there is neither', async () => {
    const tagOnly = await show(h(AgentWithVersion, { tag: runVersionTag({ requested: 'published', version: 4 }) }));
    expect(tagOnly.textContent).toBe('v4');
    const nothing = await show(h(AgentWithVersion, { tag: null }));
    expect(nothing.textContent).toBe('');
  });

  it('keeps a lower-case label and carries the colour of the tag', async () => {
    const subject = await show(h(AgentWithVersion, { name: 'bot', tag: configVersionTag('draft') }));
    const badge = subject.querySelector<HTMLElement>('.mantine-Badge-root')!;
    expect(badge.textContent).toBe('draft');
    expect(badge.style.textTransform).toBe('none');
    expect(badge.style.getPropertyValue('--badge-bg')).toContain('orange');
  });

  it('adds a warning icon to a run whose draft changed, so it is not colour alone', async () => {
    const changed = await show(h(AgentWithVersion, {
      name: 'bot',
      tag: runVersionTag({ requested: 'draft', version: null, draftChanged: true }),
    }));
    expect(changed.querySelector('.mantine-Badge-root svg')).not.toBeNull();
    const plain = await show(h(AgentWithVersion, { name: 'bot', tag: runVersionTag({ requested: 'draft', version: null }) }));
    expect(plain.querySelector('.mantine-Badge-root svg')).toBeNull();
  });
});
