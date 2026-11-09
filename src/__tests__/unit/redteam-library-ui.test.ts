import { describe, expect, it } from 'vitest';
import {
  NEW_PROBE_DAYS,
  agentFit,
  defaultSetNote,
  detectionKind,
  detectorInfo,
  exportFileName,
  filterAttemptsByKind,
  filterBuiltinProbes,
  groupPickerProbes,
  isHardProofDetector,
  isNewProbe,
  keysInCategory,
  maskText,
  outcomeLabel,
  overRefusalDetail,
  previewCell,
  probeOriginOf,
  probeSourceLabel,
  shouldMaskPreview,
  toNativeProbe,
  worksWithLabels,
} from '@/components/redteam/helpers';
import type { BuiltinProbeDefinitionView, CustomProbeView, ProbeCatalogView } from '@/components/redteam/types';

const probe = (patch: Partial<ProbeCatalogView> = {}): ProbeCatalogView => ({
  key: 'p',
  name: 'p',
  family: 'f',
  category: 'LLM01-prompt-injection',
  severity: 'medium',
  description: 'd',
  ...patch,
});

describe('isNewProbe', () => {
  const now = new Date('2026-11-09T12:00:00Z');
  it('is new within the window and not after it', () => {
    expect(isNewProbe('2026-11-09', now)).toBe(true);
    expect(isNewProbe('2026-08-20', now)).toBe(true);
    expect(isNewProbe('2026-08-01', now)).toBe(false);
    expect(NEW_PROBE_DAYS).toBe(90);
  });
  it('is not new without a readable date or with a future one', () => {
    expect(isNewProbe(undefined, now)).toBe(false);
    expect(isNewProbe('not a date', now)).toBe(false);
    expect(isNewProbe('2027-01-01', now)).toBe(false);
  });
});

describe('worksWithLabels', () => {
  it('defaults to model and agent', () => {
    expect(worksWithLabels({})).toEqual(['Model', 'Agent']);
  });
  it('says Model only and lists requirements', () => {
    expect(worksWithLabels({ targets: ['model'], requires: ['long-context'] })).toEqual(['Model only', 'Long context']);
    expect(worksWithLabels({ targets: ['model'], requires: ['caller-history'] })).toEqual(['Model only', 'Caller history']);
  });
  it('shows Caller history when every attempt has history even without the requirement', () => {
    expect(worksWithLabels({ requiresHistory: true })).toEqual(['Model', 'Agent', 'Caller history']);
  });
  it('says Model only when no attempt can run on an agent, whatever the probe declares', () => {
    expect(worksWithLabels({ targets: ['model', 'agent'], agentAttemptCount: 0 })).toEqual(['Model only']);
    expect(worksWithLabels({ targets: ['model', 'agent'], agentAttemptCount: 2 })).toEqual(['Model', 'Agent']);
  });
});

describe('detection', () => {
  it('classifies detector lists', () => {
    expect(detectionKind(['refusal', 'pattern'])).toBe('deterministic');
    expect(detectionKind(['refusal', 'llm-judge:crescendo'])).toBe('judge');
    expect(detectionKind(['refusal', 'pattern', 'llm-judge:x'])).toBe('both');
    expect(detectionKind(undefined)).toBe('unknown');
    expect(detectionKind([])).toBe('unknown');
  });
  it('names detectors and tells hard proof from soft signals', () => {
    expect(detectorInfo('markdown-exfil').label).toBe('Markdown exfiltration');
    expect(detectorInfo('llm-judge:crescendo').label).toBe('Judge · crescendo');
    expect(detectorInfo('something-new').label).toBe('something-new');
    expect(isHardProofDetector('pattern')).toBe(true);
    expect(isHardProofDetector('refusal')).toBe(false);
    expect(isHardProofDetector('non-refusal')).toBe(false);
    expect(isHardProofDetector('llm-judge:x')).toBe(false);
  });
});

describe('filterBuiltinProbes', () => {
  const list = [
    probe({ key: 'a', category: 'LLM01-prompt-injection', severity: 'high', targets: ['model', 'agent'], detectors: ['refusal', 'pattern'] }),
    probe({ key: 'b', category: 'LLM05-improper-output-handling', severity: 'medium', targets: ['model'], detectors: ['refusal', 'llm-judge:x'] }),
    probe({ key: 'c', category: 'LLM01-prompt-injection', severity: 'medium' }),
  ];
  it('filters by category, severity and target', () => {
    expect(filterBuiltinProbes(list, { category: 'LLM01-prompt-injection' }).map((p) => p.key)).toEqual(['a', 'c']);
    expect(filterBuiltinProbes(list, { severity: 'medium' }).map((p) => p.key)).toEqual(['b', 'c']);
    expect(filterBuiltinProbes(list, { target: 'agent' }).map((p) => p.key)).toEqual(['a', 'c']);
  });
  it('leaves a probe with no agent-runnable attempt out of the agent filter', () => {
    const withCounts = [probe({ key: 'x', targets: ['model', 'agent'], agentAttemptCount: 0 }), probe({ key: 'y', agentAttemptCount: 3 })];
    expect(filterBuiltinProbes(withCounts, { target: 'agent' }).map((p) => p.key)).toEqual(['y']);
    expect(filterBuiltinProbes(withCounts, { target: 'model' }).map((p) => p.key)).toEqual(['x', 'y']);
  });
  it('filters by detection and keeps probes with unknown detectors', () => {
    expect(filterBuiltinProbes(list, { detection: 'judge' }).map((p) => p.key)).toEqual(['b', 'c']);
    expect(filterBuiltinProbes(list, { detection: 'deterministic' }).map((p) => p.key)).toEqual(['a', 'c']);
  });
  it('applies no filter when none is set', () => {
    expect(filterBuiltinProbes(list, {})).toHaveLength(3);
  });
});

describe('picker grouping', () => {
  const list = [
    probe({ key: 'd1', isDefault: true }),
    probe({ key: 'm1', isDefault: false, addedAt: '2026-11-09' }),
    probe({ key: 'old' }),
    probe({ key: 'c1', custom: true, origin: 'manual' }),
    probe({ key: 'c2', custom: true }),
    probe({ key: 'i1', custom: true, origin: 'import' }),
  ];
  it('groups default, more, custom and imported in order', () => {
    const groups = groupPickerProbes(list);
    expect(groups.map((g) => g.label)).toEqual(['Built-in (default set)', 'Built-in (more)', 'Custom', 'Imported']);
    expect(groups[0]!.probes.map((p) => p.key)).toEqual(['d1', 'old']);
    expect(groups[1]!.probes.map((p) => p.key)).toEqual(['m1']);
    expect(groups[2]!.probes.map((p) => p.key)).toEqual(['c1', 'c2']);
    expect(groups[3]!.probes.map((p) => p.key)).toEqual(['i1']);
  });
  it('leaves out empty groups', () => {
    expect(groupPickerProbes([probe({ key: 'x' })]).map((g) => g.id)).toEqual(['default']);
    expect(groupPickerProbes([])).toEqual([]);
  });
  it('names the default set size', () => {
    expect(defaultSetNote([probe({ key: 'a', isDefault: true }), probe({ key: 'b', isDefault: true }), probe({ key: 'c', isDefault: false })])).toBe(
      'Runs the default set: 2 probes',
    );
    expect(defaultSetNote([probe({ key: 'a', isDefault: true })])).toBe('Runs the default set: 1 probe');
    // An older server sends no flags: every built-in is in the default set.
    expect(defaultSetNote([probe({ key: 'a' }), probe({ key: 'b' }), probe({ key: 'u', custom: true })])).toBe('Runs the default set: 2 probes');
  });
  it('lists the keys of one category', () => {
    expect(keysInCategory([probe({ key: 'a' }), probe({ key: 'b', category: 'LLM09-misinformation' })], 'LLM09-misinformation')).toEqual(['b']);
  });
});

describe('agentFit', () => {
  it('is full when nothing is known', () => {
    expect(agentFit({})).toEqual({ kind: 'full' });
  });
  it('dims a probe with no attempt that runs on agents', () => {
    expect(agentFit({ agentAttemptCount: 0, attemptCount: 5 })).toEqual({ kind: 'none', text: 'Not run against agents' });
    expect(agentFit({ targets: ['model'] })).toEqual({ kind: 'none', text: 'Not run against agents' });
  });
  it('counts partial fits', () => {
    expect(agentFit({ agentAttemptCount: 2, attemptCount: 6 })).toEqual({ kind: 'partial', text: '2 of 6 attempts run on agents' });
    expect(agentFit({ agentAttemptCount: 6, attemptCount: 6 })).toEqual({ kind: 'full' });
  });
});

describe('custom probe source', () => {
  it('labels manual, clone and import', () => {
    expect(probeSourceLabel({})).toBe('Manual');
    expect(probeSourceLabel({ origin: 'clone', clonedFrom: { probeKey: 'markdown-exfil', version: 1 } })).toBe('Clone of markdown-exfil v1');
    expect(probeSourceLabel({ origin: 'import', source: { name: 'HarmBench' } })).toBe('Imported · HarmBench');
    expect(probeSourceLabel({ origin: 'import' })).toBe('Imported');
  });
  it('treats a probe without origin as manual', () => {
    expect(probeOriginOf({})).toBe('manual');
    expect(probeOriginOf({ origin: 'import' })).toBe('import');
  });
});

describe('over-refusal wording', () => {
  it('says Refused and Answered for over-refusal attempts only', () => {
    expect(outcomeLabel({ polarity: 'over-refusal' }, 'vulnerable')).toBe('Refused');
    expect(outcomeLabel({ polarity: 'over-refusal' }, 'safe')).toBe('Answered');
    expect(outcomeLabel({ polarity: 'over-refusal' }, 'needs_review')).toBe('needs review');
    expect(outcomeLabel({}, 'vulnerable')).toBe('vulnerable');
    expect(outcomeLabel({ polarity: undefined }, 'safe')).toBe('safe');
  });
  it('filters attempts by kind', () => {
    const rows = [{ polarity: 'over-refusal' as const }, {}, { polarity: undefined }];
    expect(filterAttemptsByKind(rows, 'all')).toHaveLength(3);
    expect(filterAttemptsByKind(rows, 'over-refusal')).toHaveLength(1);
    expect(filterAttemptsByKind(rows, 'attack')).toHaveLength(2);
  });
  it('words the tile detail', () => {
    expect(overRefusalDetail({ refused: 3, completed: 8 })).toBe('3 of 8 harmless prompts refused');
    expect(overRefusalDetail({ refused: 3, completed: 8, failed: 0 })).toBe('3 of 8 harmless prompts refused');
    expect(overRefusalDetail({ refused: 0, completed: 0, failed: 8 })).toBe('0 of 0 refused · 8 unanswered');
  });
});

describe('import preview masking', () => {
  it('masks with the length', () => {
    expect(maskText('x'.repeat(142))).toBe('•••• (142 characters)');
  });
  it('masks for sensitive formats and harmful polarities', () => {
    expect(shouldMaskPreview(true, 'over-refusal')).toBe(true);
    expect(shouldMaskPreview(false, 'harmful-request')).toBe(true);
    expect(shouldMaskPreview(false, 'forbidden-strings')).toBe(true);
    expect(shouldMaskPreview(false, 'over-refusal')).toBe(false);
    expect(shouldMaskPreview(undefined, 'prompt-injection')).toBe(false);
  });
  it('shows or hides the cell text', () => {
    expect(previewCell('hello', true)).toBe('•••• (5 characters)');
    expect(previewCell('hello', false)).toBe('hello');
    expect(previewCell('abcdef', false, 3)).toBe('abc…');
  });
});

describe('export', () => {
  it('keeps a file name to safe characters', () => {
    expect(exportFileName('markdown-exfil')).toBe('markdown-exfil.redteam.yaml');
    expect(exportFileName('a b/c')).toBe('a-b-c.redteam.yaml');
    expect(exportFileName('///')).toBe('probe.redteam.yaml');
  });
  it('turns a custom probe into the export shape without the import date', () => {
    const custom: CustomProbeView = {
      id: '1',
      key: 'k',
      name: 'My probe',
      description: 'd',
      family: 'custom',
      category: 'LLM01-prompt-injection',
      severity: 'high',
      attempts: [{ id: 'a1', turns: ['hi'] }],
      detectors: { refusal: true, pattern: true, named: ['pii'] },
      polarity: 'attack',
      origin: 'import',
      source: { name: 'Set', license: 'MIT', importedAt: '2026-11-09T00:00:00Z' },
    };
    const native = toNativeProbe(custom);
    expect(native.name).toBe('My probe');
    expect(native.detectors).toEqual({ refusal: true, pattern: true, named: ['pii'] });
    expect(native.source).toMatchObject({ name: 'Set', license: 'MIT' });
    expect(native.source?.importedAt).toBeUndefined();
  });
  it('turns a built-in definition into a copy that records its lineage', () => {
    const builtin: BuiltinProbeDefinitionView = {
      ...probe({ key: 'markdown-exfil', version: 2, polarity: 'attack' }),
      attempts: [{ id: 'a1', turns: ['hi'], system: 'secret {{canary}}', canary: 'RT-ABCD-1234' }],
      detectorSpec: { refusal: true, pattern: true, named: ['markdown-exfil'] },
    };
    const native = toNativeProbe(builtin);
    expect(native.name).toBe('markdown-exfil-copy');
    expect(native.clonedFrom).toEqual({ probeKey: 'markdown-exfil', version: 2 });
    expect(native.detectors).toEqual({ refusal: true, pattern: true, named: ['markdown-exfil'] });
    expect(native.attempts[0]!.system).toContain('{{canary}}');
  });
});
