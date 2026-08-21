import { describe, it, expect, vi } from 'vitest';

import {
  chunkText,
  validateChunkConfig,
  chunkConfigRequiresReindex,
  resolveParentWindow,
  DEFAULT_SEPARATORS,
  type ChunkContext,
} from '@/lib/services/rag/chunking';
import type { IRagChunkConfig } from '@/lib/database';

const base = (over: Partial<IRagChunkConfig> = {}): IRagChunkConfig => ({
  strategy: 'recursive_character',
  chunkSize: 120,
  chunkOverlap: 20,
  ...over,
});

/** Every chunk's recorded span must quote the source exactly. */
function expectOffsetsQuoteSource(
  chunks: Array<{ content: string; charStart: number; charEnd: number; metadata: Record<string, unknown> }>,
  source: string,
) {
  for (const chunk of chunks) {
    const body = typeof chunk.metadata.contextualHeader === 'string'
      ? chunk.content.slice(String(chunk.metadata.contextualHeader).length + 2)
      : chunk.content;
    expect(source.slice(chunk.charStart, chunk.charEnd)).toBe(body);
  }
}

describe('chunkText — invariants that hold for every strategy', () => {
  const prose = [
    'Knowledge Engine modules split documents before embedding them.',
    'Each strategy decides where a boundary may fall.',
    '',
    'The packer fills a chunk up to its configured size and then carries an overlap forward.',
    'That overlap must never cut a word in half.',
  ].join('\n');

  it('does not glue words together across a boundary', async () => {
    const chunks = await chunkText(prose, base({ chunkSize: 60, chunkOverlap: 10 }));
    const joined = chunks.map((c) => c.content).join(' ');
    // The historic separator-loss bug produced "halfThe" style artefacts:
    // a lowercase letter immediately followed by an uppercase one.
    expect(joined).not.toMatch(/[a-zçğıöşü][A-ZÇĞİÖŞÜ]/);
    expect(chunks.length).toBeGreaterThan(1);
  });

  /**
   * A heading, then a whitespace-only line between two blank lines. The
   * sentence splitter emits that gap as its own whitespace-only atom, and the
   * semantic strategy used to filter those out of the atom stream — which broke
   * the contiguity `emit` relies on and left every chunk spanning the gap
   * quoting fewer characters than its recorded span.
   */
  const withBlankGap = ['# Ledger', '', '   ', '', prose].join('\n');

  /** Same vector for every sentence, so no topic break masks the gap. */
  const flatEmbed = async (texts: string[]) => texts.map(() => [1, 0]);

  const strategyCases: Array<[string, Partial<IRagChunkConfig>, ChunkContext?]> = [
    ['recursive_character', { strategy: 'recursive_character' }],
    ['token', { strategy: 'token', encoding: 'cl100k_base' }],
    ['markdown', { strategy: 'markdown' }],
    ['sentence', { strategy: 'sentence' }],
    ['semantic', { strategy: 'semantic' }, { embed: flatEmbed }],
  ];

  for (const [label, overrides, ctx] of strategyCases) {
    it(`records offsets that quote the source exactly — ${label}`, async () => {
      const config = base({ chunkSize: 120, chunkOverlap: 20, ...overrides });
      for (const source of [prose, withBlankGap]) {
        const chunks = await chunkText(source, config, ctx);
        expect(chunks.length).toBeGreaterThan(0);
        expectOffsetsQuoteSource(chunks, source);
      }
    });
  }

  it('carries only the configured overlap forward when chunkOverlap is missing', async () => {
    // Legacy stored configs and any API caller that omits the field both land
    // here. `undefined` loses every numeric comparison, so the overlap budget
    // never bound anything and each chunk carried its whole predecessor
    // forward — chunks grew without limit and blew past chunkSize.
    const text = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet. '.repeat(12);
    const config = { strategy: 'recursive_character', chunkSize: 100 } as unknown as IRagChunkConfig;

    const chunks = await chunkText(text, config);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.content.length).toBeLessThanOrEqual(100);
    expectOffsetsQuoteSource(chunks, text);
  });

  it('treats chunkSize as a hard cap even with no whitespace to split on', async () => {
    // CJK prose and base64 blobs have no spaces: the old splitter emitted them
    // as a single oversized chunk that could overflow the embedding model.
    const unbreakable = '請求書の支払期限を過ぎた場合には遅延損害金が発生します'.repeat(20);
    const chunks = await chunkText(unbreakable, base({ chunkSize: 100, chunkOverlap: 10 }));

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.content.length).toBeLessThanOrEqual(100);
    expectOffsetsQuoteSource(chunks, unbreakable);
  });

  it('returns no chunks for whitespace-only content', async () => {
    expect(await chunkText('   \n\n  \t ', base())).toEqual([]);
  });

  it('numbers chunks consecutively from zero', async () => {
    const chunks = await chunkText(prose, base({ chunkSize: 50, chunkOverlap: 5 }));
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
    expect(chunks.map((c) => c.metadata.chunkIndex)).toEqual(chunks.map((_, i) => i));
  });

  it('clamps rather than hangs when an existing module has overlap >= chunkSize', async () => {
    // Reachable today: the UI accepts chunkSize 50 and chunkOverlap 5000
    // independently, and the token splitter used to loop forever on it.
    const chunks = await chunkText(prose, {
      strategy: 'token', chunkSize: 20, chunkOverlap: 50, encoding: 'cl100k_base',
    });
    expect(chunks.length).toBeGreaterThan(0);
  });
});

describe('token strategy', () => {
  it('measures size in real tokens, not whitespace-separated words', async () => {
    // "internationalization" is one word but several tokens; a word-splitter
    // would happily pack 12 of these into a "12 token" chunk.
    const text = Array.from({ length: 40 }, () => 'internationalization').join(' ');
    const chunks = await chunkText(text, {
      strategy: 'token', chunkSize: 12, chunkOverlap: 2, encoding: 'cl100k_base',
    });

    const { encode } = await import('gpt-tokenizer/encoding/cl100k_base');
    for (const chunk of chunks) {
      expect(encode(chunk.content).length).toBeLessThanOrEqual(12);
    }
    expect(chunks.every((c) => typeof c.tokenCount === 'number')).toBe(true);
  });

  it('honours the configured encoding', async () => {
    const text = 'Sözleşmenin feshi hâlinde taraflar karşılıklı olarak yükümlülüklerinden kurtulur. '.repeat(8);
    const cl = await chunkText(text, { strategy: 'token', chunkSize: 32, chunkOverlap: 4, encoding: 'cl100k_base' });
    const o2 = await chunkText(text, { strategy: 'token', chunkSize: 32, chunkOverlap: 4, encoding: 'o200k_base' });

    // o200k tokenises Turkish more efficiently, so the same budget covers more
    // text and yields fewer chunks. If encoding were ignored these would match.
    expect(cl.length).not.toBe(o2.length);
  });

  it('falls back to cl100k_base when the encoding is unset', async () => {
    const chunks = await chunkText('hello world '.repeat(50), {
      strategy: 'token', chunkSize: 16, chunkOverlap: 2,
    });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].tokenCount).toBeLessThanOrEqual(16);
  });
});

describe('markdown strategy', () => {
  const doc = [
    '# Billing',
    '',
    'Invoices are issued monthly.',
    '',
    '## Refunds',
    '',
    'A refund is processed within ten business days.',
    '',
    '## Disputes',
    '',
    'Open a dispute from the billing page.',
  ].join('\n');

  it('never lets a chunk span two headings', async () => {
    const chunks = await chunkText(doc, base({ strategy: 'markdown', chunkSize: 4000, chunkOverlap: 0 }));

    expect(chunks.length).toBe(3);
    expect(chunks.some((c) => c.content.includes('Refunds') && c.content.includes('Disputes'))).toBe(false);
  });

  it('carries the heading breadcrumb on each chunk', async () => {
    const chunks = await chunkText(doc, base({ strategy: 'markdown', chunkSize: 4000, chunkOverlap: 0 }));
    expect(chunks.map((c) => c.headingPath)).toEqual([
      ['Billing'],
      ['Billing', 'Refunds'],
      ['Billing', 'Disputes'],
    ]);
    expect(chunks[1].metadata.headingPath).toEqual(['Billing', 'Refunds']);
  });

  it('ignores a # inside a fenced code block', async () => {
    const withCode = [
      '# Setup',
      '',
      '```bash',
      '# install the CLI first',
      'npm install -g cognipeer',
      '```',
      '',
      'Then authenticate.',
    ].join('\n');

    const chunks = await chunkText(withCode, base({ strategy: 'markdown', chunkSize: 4000, chunkOverlap: 0 }));
    expect(chunks).toHaveLength(1);
    expect(chunks[0].headingPath).toEqual(['Setup']);
  });

  it('still enforces chunkSize inside one long section', async () => {
    const long = `# Terms\n\n${'The parties agree to the following conditions. '.repeat(60)}`;
    const chunks = await chunkText(long, base({ strategy: 'markdown', chunkSize: 200, chunkOverlap: 20 }));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(200);
      expect(chunk.headingPath).toEqual(['Terms']);
    }
  });
});

describe('sentence strategy', () => {
  it('does not cut mid-sentence', async () => {
    const text = 'First sentence here. Second sentence follows! Third one ends things? And a fourth.';
    const chunks = await chunkText(text, base({ strategy: 'sentence', chunkSize: 46, chunkOverlap: 0 }));

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.content).toMatch(/[.!?]$/);
    }
  });
});

describe('semantic strategy', () => {
  const topicA = 'Invoices are issued monthly. Payment is due on receipt. Late fees apply after ten days.';
  const topicB = ' Our office is in Istanbul. The building has a rooftop terrace. Parking is available nearby.';

  /** Embeds every sentence as one of two orthogonal vectors, keyed by topic. */
  const fakeEmbed = vi.fn(async (texts: string[]) =>
    texts.map((t) => (/invoice|payment|fee/i.test(t) ? [1, 0] : [0, 1])));

  it('breaks where the topic shifts', async () => {
    const chunks = await chunkText(topicA + topicB, base({
      strategy: 'semantic', chunkSize: 4000, chunkOverlap: 0, semanticThreshold: 0.5,
    }), { embed: fakeEmbed });

    expect(chunks).toHaveLength(2);
    expect(chunks[0].content).toContain('Late fees');
    expect(chunks[1].content).toContain('Istanbul');
  });

  it('fails loudly when no embedder is available rather than silently downgrading', async () => {
    await expect(
      chunkText(topicA, base({ strategy: 'semantic' })),
    ).rejects.toThrow(/embedding model/i);
  });

  it('still respects chunkSize when the whole document is one topic', async () => {
    const oneTopic = 'Payment is due on receipt. '.repeat(40);
    const chunks = await chunkText(oneTopic, base({
      strategy: 'semantic', chunkSize: 120, chunkOverlap: 0, semanticThreshold: 0.5,
    }), { embed: fakeEmbed });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.content.length).toBeLessThanOrEqual(120);
  });
});

describe('contextual headers', () => {
  const text = 'Refunds are processed within ten business days. '.repeat(6);

  it('prefixes each chunk but leaves the recorded span pointing at the source', async () => {
    const describe_ = vi.fn(async () => 'From the Billing policy.');
    const chunks = await chunkText(text, base({
      chunkSize: 120, chunkOverlap: 0, contextualHeader: { enabled: true },
    }), { describe: describe_ });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.content.startsWith('From the Billing policy.\n\n')).toBe(true);
      expect(chunk.metadata.contextualHeader).toBe('From the Billing policy.');
    }
    // The header exists nowhere in the source, so the span must exclude it.
    expectOffsetsQuoteSource(chunks, text);
  });

  it('keeps the chunk when the model call fails', async () => {
    const describe_ = vi.fn(async () => { throw new Error('model unavailable'); });
    const chunks = await chunkText(text, base({
      chunkSize: 120, chunkOverlap: 0, contextualHeader: { enabled: true },
    }), { describe: describe_ });

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].metadata.contextualHeader).toBeUndefined();
    expect(chunks[0].content).toContain('Refunds are processed');
  });
});

describe('validateChunkConfig', () => {
  it('rejects an overlap at or above the chunk size', () => {
    expect(() => validateChunkConfig({ strategy: 'token', chunkSize: 100, chunkOverlap: 100 }))
      .toThrow(/must be smaller than chunkSize/);
  });

  it('rejects an unknown strategy and an unknown encoding', () => {
    expect(() => validateChunkConfig({ strategy: 'magic', chunkSize: 100, chunkOverlap: 0 }))
      .toThrow(/strategy must be one of/);
    expect(() => validateChunkConfig({ strategy: 'token', chunkSize: 100, chunkOverlap: 0, encoding: 'gpt2' }))
      .toThrow(/encoding must be one of/);
  });

  it('rejects a parent window smaller than the chunk it should widen', () => {
    expect(() => validateChunkConfig({
      strategy: 'recursive_character', chunkSize: 400, chunkOverlap: 40, parentWindowSize: 200,
    })).toThrow(/must be at least chunkSize/);
  });

  it('accepts a well-formed config', () => {
    const config = {
      strategy: 'markdown', chunkSize: 400, chunkOverlap: 40,
      separators: DEFAULT_SEPARATORS, parentWindowSize: 1600,
    };
    expect(validateChunkConfig(config)).toBe(config);
  });
});

describe('chunkConfigRequiresReindex', () => {
  it('is true when the boundaries would move', () => {
    expect(chunkConfigRequiresReindex(base(), base({ chunkSize: 500 }))).toBe(true);
    expect(chunkConfigRequiresReindex(base(), base({ strategy: 'markdown' }))).toBe(true);
  });

  it('is false for a parentWindowSize change, which is resolved at query time', () => {
    expect(chunkConfigRequiresReindex(base(), base({ parentWindowSize: 2000 }))).toBe(false);
  });

  it('is false when nothing that affects boundaries changed', () => {
    expect(chunkConfigRequiresReindex(base(), base())).toBe(false);
  });
});

describe('resolveParentWindow', () => {
  const source = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu';

  it('widens the chunk span and snaps outward to whitespace', () => {
    const chunk = { charStart: source.indexOf('delta'), charEnd: source.indexOf('delta') + 'delta'.length };
    const window = resolveParentWindow(source, chunk, 30)!;

    expect(window).toContain('delta');
    expect(window.length).toBeGreaterThan('delta'.length);
    expect(source).toContain(window);
    // Snapping outward means the window never starts or ends mid-word.
    expect(source.slice(source.indexOf(window) - 1, source.indexOf(window))).toMatch(/\s|^$/);
  });

  it('returns undefined when small-to-big is off or the source is missing', () => {
    const chunk = { charStart: 0, charEnd: 5 };
    expect(resolveParentWindow(source, chunk, 0)).toBeUndefined();
    expect(resolveParentWindow(undefined, chunk, 100)).toBeUndefined();
    expect(resolveParentWindow(source, {}, 100)).toBeUndefined();
  });

  it('returns undefined when the chunk already fills the window', () => {
    expect(resolveParentWindow(source, { charStart: 0, charEnd: 60 }, 30)).toBeUndefined();
  });
});
