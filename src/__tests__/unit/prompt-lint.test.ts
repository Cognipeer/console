/**
 * Deterministic system-prompt checks (promptLint). Every verdict must be
 * mechanical and reproducible — these tests pin the rules.
 */

import { describe, expect, it } from 'vitest';
import { lintSystemPrompt } from '@/lib/services/promptLint';

function statusOf(report: ReturnType<typeof lintSystemPrompt>, id: string) {
  const check = report.checks.find((c) => c.id === id);
  expect(check, `check ${id} must exist`).toBeDefined();
  return check!.status;
}

describe('lintSystemPrompt', () => {
  it('passes a clean, reasonable prompt on every check', () => {
    const prompt = [
      'You are a precise research assistant for the Pulse product.',
      '',
      'Always cite the tool output you used. Prefer short structured answers.',
      '',
      'When a task cannot be completed, say so explicitly and list what is missing.',
    ].join('\n');
    const report = lintSystemPrompt(prompt);
    expect(report.failed).toBe(0);
    expect(report.warned).toBe(0);
    expect(report.passed).toBe(report.checks.length);
    expect(report.chars).toBe(prompt.length);
    expect(report.estTokens).toBe(Math.ceil(prompt.length / 4));
  });

  it('fails on duplicated paragraphs', () => {
    const block = 'Always verify the file exists before you claim the deliverable is complete.';
    const report = lintSystemPrompt(`${block}\n\nSome other instruction here to separate.\n\n${block}`);
    expect(statusOf(report, 'dup-paragraph')).toBe('fail');
    expect(report.checks.find((c) => c.id === 'dup-paragraph')!.detail).toContain('2×');
  });

  it('warns on duplicated long sentences inside one paragraph', () => {
    const sentence = 'You must always answer in the same language as the user question was asked.';
    const report = lintSystemPrompt(`${sentence} Something else. ${sentence}`);
    expect(statusOf(report, 'dup-sentence')).toBe('warn');
  });

  it('fails when the cache-critical prefix carries dynamic content', () => {
    const withDate = `Today is 2026-08-15 10:30. You are an assistant.\nRest of prompt.`;
    expect(statusOf(lintSystemPrompt(withDate), 'dynamic-prefix')).toBe('fail');

    const withUuid = `Session 550e8400-e29b-41d4-a716-446655440000 context.\nRest.`;
    expect(statusOf(lintSystemPrompt(withUuid), 'dynamic-prefix')).toBe('fail');

    // Same dynamic content BEYOND the prefix window is fine.
    const tail = `${'A stable instruction line.\n'.repeat(40)}Generated at 2026-08-15.`;
    expect(statusOf(lintSystemPrompt(tail), 'dynamic-prefix')).toBe('pass');
  });

  it('warns on placeholder markers and unrendered templates', () => {
    expect(statusOf(lintSystemPrompt('You are helpful. TODO: tighten this.'), 'placeholder')).toBe('warn');
    expect(statusOf(lintSystemPrompt('Hello {{customer_name}}, you are an agent.'), 'placeholder')).toBe('warn');
  });

  it('grades the size budget by estimated tokens', () => {
    expect(statusOf(lintSystemPrompt('short prompt'), 'size')).toBe('pass');
    expect(statusOf(lintSystemPrompt('x'.repeat(8_001 * 4)), 'size')).toBe('warn');
    expect(statusOf(lintSystemPrompt('x'.repeat(32_001 * 4)), 'size')).toBe('fail');
  });

  it('warns on highly repetitive prompts (low unique-trigram ratio)', () => {
    const repetitive = 'do the task carefully '.repeat(60);
    expect(statusOf(lintSystemPrompt(repetitive), 'repetition')).toBe('warn');
  });

  it('flags whitespace and control-character hygiene', () => {
    expect(statusOf(lintSystemPrompt('line with trailing space   \nclean line'), 'whitespace')).toBe('warn');
    expect(statusOf(lintSystemPrompt('has a bell  character'), 'control-chars')).toBe('warn');
    // Tabs and newlines are NOT control-char violations.
    expect(statusOf(lintSystemPrompt('col1\tcol2\nrow2'), 'control-chars')).toBe('pass');
  });

  it('handles an empty prompt with a stable, all-pass checklist', () => {
    const report = lintSystemPrompt('');
    expect(report.chars).toBe(0);
    expect(report.failed).toBe(0);
    expect(report.checks.length).toBeGreaterThanOrEqual(8);
  });
});
