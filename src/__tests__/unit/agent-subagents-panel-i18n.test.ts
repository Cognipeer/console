/**
 * The Delegation (sub-agents) panel: every string it shows is a message in both
 * languages (same keys, same placeholders), and the copy says what the runtime does.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { messages } from '@/lib/i18n/messages';

type Bag = Record<string, string>;
const bag = (lang: 'en' | 'tr'): Bag =>
  ((messages[lang] as unknown as { agents: { subagents: Bag } }).agents.subagents);
const en = bag('en');
const tr = bag('tr');
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

const source = readFileSync(path.join(process.cwd(), 'src/components/agents/studio/AgentSubagentsPanel.tsx'), 'utf8');
const used = [...source.matchAll(/\bt\('(\w+)'/g)].map((m) => m[1]!);

describe('agents.subagents messages', () => {
  it('has the same keys and placeholders in English and Turkish', () => {
    expect(Object.keys(tr).sort()).toEqual(Object.keys(en).sort());
    for (const [key, text] of Object.entries(en)) {
      expect(placeholders(tr[key] ?? ''), key).toEqual(placeholders(text));
    }
  });

  it('defines every key the panel asks for, and the panel keeps no English of its own', () => {
    expect(used.length).toBeGreaterThan(30);
    for (const key of used) {
      expect(en[key], `en.${key}`).toBeTruthy();
      expect(tr[key], `tr.${key}`).toBeTruthy();
    }
    expect(source).not.toMatch(/>\s*(Sub-agents|Add sub-agent|Delegation guards|Remove|Cancel)\s*</);
  });

  it('describes what the runtime does with a referenced agent and with approvals', () => {
    const text = `${en.refNote} ${en.promptRefDescription} ${en.modelRefDescription}`;
    expect(text).toMatch(/name, header, system prompt and model/);
    expect(en.refNote).toMatch(/guardrails are not applied/);
    expect(en.approvalsNote).toMatch(/pauses the run and names the sub-agent/);
    expect(en.approvalsNote).toMatch(/unattended/);
    // The runtime falls back to "You are <name>. <header>" and warns: the header alone is not a prompt to rely on.
    expect(JSON.stringify(en)).not.toMatch(/header alone/i);
    expect(en.childContextDescription + en.contextScoped).toMatch(/latest message/);
  });
});
