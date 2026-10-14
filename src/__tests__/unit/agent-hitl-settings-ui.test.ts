/**
 * Configure → Approvals & questions: which tools the table lists, what each
 * row resolves to, and how an edit lands in the stored `humanInTheLoop`.
 */

import { describe, expect, it } from 'vitest';
import { hitlToolRows, patchHitl, setToolChoice } from '@/components/agents/studio/hitlSettings';
import { CONFIG_SECTION_KEYS, CONFIG_SECTION_TITLES, changedConfigSections } from '@/components/agents/studio/configSections';
import { en } from '@/lib/i18n/messages/en';
import { tr } from '@/lib/i18n/messages/tr';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const toolConfig = {
  toolBindings: [
    { source: 'mcp', sourceKey: 'jira', toolNames: ['create_issue'] },
    { source: 'system', sourceKey: 'web_search', toolNames: ['web_search'] },
  ],
  knowledgeEngineKey: 'kb',
  memory: { enabled: true, memoryStoreKey: 'm', tools: 'readwrite' as const },
  sandbox: { enabled: true },
};

describe('hitlToolRows', () => {
  const on = { toolApproval: { enabled: true, defaultPolicy: 'always' as const } };

  it('lists every tool the agent can call once, with what the runtime will do', () => {
    const rows = hitlToolRows(toolConfig, on);
    const byName = Object.fromEntries(rows.map((row) => [row.name, row]));
    expect(byName.create_issue).toMatchObject({ readOnly: false, choice: 'default', effective: 'always' });
    expect(byName.web_search).toMatchObject({ readOnly: true, effective: 'never' });
    expect(byName.knowledge_search).toMatchObject({ readOnly: true, effective: 'never' });
    expect(byName.memory_search).toMatchObject({ readOnly: true, effective: 'never' });
    expect(byName.memory_write).toMatchObject({ readOnly: false, effective: 'always' });
    expect(byName.sandbox_exec).toMatchObject({ readOnly: false, effective: 'always' });
    expect(byName.sandbox_read_file).toMatchObject({ readOnly: true, effective: 'never' });
    expect(new Set(rows.map((row) => row.name)).size).toBe(rows.length);
  });

  it('follows the default policy for tools without a setting', () => {
    const rows = hitlToolRows(toolConfig, { toolApproval: { enabled: true, defaultPolicy: 'never' } });
    expect(rows.find((row) => row.name === 'create_issue')?.effective).toBe('never');
  });

  it('lets a per-tool setting win over the read-only exemption and the default', () => {
    const rows = hitlToolRows(toolConfig, {
      toolApproval: { enabled: true, defaultPolicy: 'always', tools: { web_search: 'always', create_issue: 'never' } },
    });
    expect(rows.find((row) => row.name === 'web_search')).toMatchObject({ choice: 'always', effective: 'always' });
    expect(rows.find((row) => row.name === 'create_issue')).toMatchObject({ choice: 'never', effective: 'never' });
  });

  it('keeps a leftover per-tool entry visible, marked stale', () => {
    const rows = hitlToolRows({ toolBindings: [] }, { toolApproval: { enabled: true, tools: { gone: 'never' } } });
    expect(rows).toEqual([expect.objectContaining({ name: 'gone', stale: true, choice: 'never' })]);
  });

  it('lists nothing for an agent without tools', () => {
    expect(hitlToolRows({}, undefined)).toEqual([]);
  });
});

describe('editing the stored object', () => {
  it('sets and clears a per-tool entry, dropping the map once empty', () => {
    const one = setToolChoice({ toolApproval: { enabled: true } }, 'sandbox_exec', 'never');
    expect(one.toolApproval?.tools).toEqual({ sandbox_exec: 'never' });
    const cleared = setToolChoice(one, 'sandbox_exec', 'default');
    expect(cleared.toolApproval).toEqual({ enabled: true });
    expect('tools' in cleared.toolApproval!).toBe(false);
  });

  it('creates the approval block, switched off, when a tool is set on an agent that had none', () => {
    expect(setToolChoice(undefined, 'a', 'always')).toEqual({ toolApproval: { enabled: false, tools: { a: 'always' } } });
  });

  it('merges a change and drops keys set to undefined so the runtime default applies again', () => {
    const base = { timeoutMinutes: 30, onTimeout: 'cancel' as const, askUser: { enabled: true } };
    expect(patchHitl(base, { timeoutMinutes: undefined })).toEqual({ onTimeout: 'cancel', askUser: { enabled: true } });
    expect(patchHitl(undefined, { approvers: 'owner' })).toEqual({ approvers: 'owner' });
  });

  it('stores the unattended policy, and clearing it lets the runtime default (deny) apply again', () => {
    const paused = patchHitl({ toolApproval: { enabled: true } }, { unattended: 'pause' });
    expect(paused).toEqual({ toolApproval: { enabled: true }, unattended: 'pause' });
    expect(patchHitl(paused, { unattended: undefined })).toEqual({ toolApproval: { enabled: true } });
  });
});

describe('the Approvals & questions section', () => {
  it('is registered under hitl and owns config.humanInTheLoop', () => {
    expect(CONFIG_SECTION_KEYS.hitl).toEqual(['humanInTheLoop']);
    expect(CONFIG_SECTION_TITLES.hitl).toBe('Approvals & questions');
  });

  it('is flagged as changed when the draft differs from the published version', () => {
    const published = { modelKey: 'm', humanInTheLoop: { toolApproval: { enabled: true } } };
    const draft = { modelKey: 'm', humanInTheLoop: { toolApproval: { enabled: true, defaultPolicy: 'never' } } };
    expect([...changedConfigSections(draft, published)]).toEqual(['hitl']);
  });
});

describe('the unattended policy select', () => {
  it('is worded for the owner in both languages', () => {
    const english = en.agents.hitl as Record<string, string>;
    const turkish = tr.agents.hitl as Record<string, string>;
    expect(english.unattended).toBe('When nobody can answer (schedules, API bridges, evaluations)');
    expect(english.unattendedDeny).toBe('Deny the tool call');
    expect(english.unattendedPause).toBe('Pause and wait for approval in Studio');
    expect(english.unattendedAllow).toBe('Run without approval');
    for (const key of ['unattended', 'unattendedDeny', 'unattendedPause', 'unattendedAllow',
      'unattendedDenyDescription', 'unattendedPauseDescription', 'unattendedAllowDescription']) {
      expect(turkish[key], key).toBeTruthy();
      expect(turkish[key], key).not.toBe(english[key]);
    }
  });
});

describe('agents.hitl messages', () => {
  const english = en.agents.hitl as Record<string, string>;
  const turkish = tr.agents.hitl as Record<string, string>;
  const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

  it('has the same keys in English and Turkish, with the same placeholders', () => {
    expect(Object.keys(turkish).sort()).toEqual(Object.keys(english).sort());
    for (const key of Object.keys(english)) {
      expect(placeholders(turkish[key]), key).toEqual(placeholders(english[key]));
      expect(turkish[key].trim(), key).not.toBe('');
    }
  });

  it('defines every key the components ask for', () => {
    const root = join(__dirname, '../../components/agents');
    const files = [
      'session/PendingActionCards.tsx',
      'session/AgentSessionView.tsx',
      'studio/AgentHumanInTheLoopPanel.tsx',
      'studio/SessionList.tsx',
    ];
    const used = new Set<string>();
    for (const file of files) {
      const source = readFileSync(join(root, file), 'utf8');
      for (const match of source.matchAll(/\bt\('([A-Za-z]+)'/g)) used.add(match[1]);
    }
    const detail = readFileSync(join(root, 'AgentDetailPage.tsx'), 'utf8');
    for (const match of detail.matchAll(/\bt\('hitl\.([A-Za-z]+)'/g)) used.add(match[1]);
    expect(used.size).toBeGreaterThan(30);
    const missing = [...used].filter((key) => !(key in english));
    expect(missing).toEqual([]);
  });
});
