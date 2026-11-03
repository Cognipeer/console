/**
 * Links in chat messages open in a new tab, in the agent's Markdown answers and
 * in the person's own plain-text words alike; an in-page `#…` jump stays put.
 * (createElement, not JSX: the suite only collects `.test.ts`.)
 */

import { createElement as h } from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import AgentMarkdown from '@/components/agents/session/AgentMarkdown';
import { LinkifiedText, linkifyText } from '@/components/common/ui/ExternalLinks';

const NEW_TAB = 'target="_blank" rel="noopener noreferrer"';

function markdown(text: string): string {
  return renderToStaticMarkup(h(MantineProvider, null, h(AgentMarkdown, { text })));
}

describe('agent Markdown links', () => {
  it('opens a Markdown link and a bare address in a new tab', () => {
    const html = markdown('See [the docs](https://docs.example.com/a) or https://example.com/b.');
    expect(html).toContain(`<a href="https://docs.example.com/a" ${NEW_TAB}>the docs</a>`);
    expect(html).toContain(`<a href="https://example.com/b" ${NEW_TAB}>https://example.com/b</a>`);
  });

  it('keeps an in-page jump in the page', () => {
    const html = markdown('Note[^1]\n\n[^1]: the footnote');
    const jump = html.match(/<a [^>]*href="#user-content-fn-1"[^>]*>/)?.[0];
    expect(jump).toBeDefined();
    expect(jump).not.toContain('target=');
  });
});

describe('plain message text', () => {
  it('splits out the addresses and leaves sentence punctuation outside', () => {
    expect(linkifyText('Go to https://example.com/x, then (https://en.wikipedia.org/wiki/Foo_(bar)).')).toEqual([
      { kind: 'text', text: 'Go to ' },
      { kind: 'link', text: 'https://example.com/x', href: 'https://example.com/x' },
      { kind: 'text', text: ', then (' },
      { kind: 'link', text: 'https://en.wikipedia.org/wiki/Foo_(bar)', href: 'https://en.wikipedia.org/wiki/Foo_(bar)' },
      { kind: 'text', text: ').' },
    ]);
  });

  it('reads a www. address as https and ignores what names no host', () => {
    expect(linkifyText('www.example.com')).toEqual([
      { kind: 'link', text: 'www.example.com', href: 'https://www.example.com' },
    ]);
    expect(linkifyText('https:// and www. and www.local')).toEqual([{ kind: 'text', text: 'https:// and www. and www.local' }]);
    expect(linkifyText('no links here')).toEqual([{ kind: 'text', text: 'no links here' }]);
  });

  it('does not link other schemes', () => {
    expect(linkifyText('javascript:alert(1) file:///etc/passwd')).toEqual([
      { kind: 'text', text: 'javascript:alert(1) file:///etc/passwd' },
    ]);
  });

  it('draws each address as a new-tab link and keeps the rest as text', () => {
    const html = renderToStaticMarkup(h(LinkifiedText, { text: 'line one\nhttps://example.com/<b>' }));
    expect(html).toBe(`line one\n<a href="https://example.com/" ${NEW_TAB} style="word-break:break-all">https://example.com/</a>&lt;b&gt;`);
  });

  it('stays fast on a long run with no address in it', () => {
    const started = Date.now();
    linkifyText(`https://${'a'.repeat(50_000)}${')'.repeat(50_000)}`);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
