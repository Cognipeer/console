// @vitest-environment jsdom
/**
 * The docs links of the console: the docs-links registry and the docsPath of every service (their shape;
 * the docs repo checks that each page exists), the URLs built from them on the deployment's base, and a
 * docs link that opens the docs panel on a plain click and a new tab otherwise.
 *
 * (createElement, not JSX: the suite only collects `.test.ts`.)
 */

import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { installDomStubs } from '@/__tests__/helpers/iamCenterUi';
import docsLinksJson from '@/config/docs-links.json';
import platformServicesJson from '@/config/platform-services.json';
import platformServicesSchema from '@/config/platform-services.schema.json';
import DocAnchor from '@/components/docs/DocAnchor';
import { DocsDrawerProvider, type OpenDocs } from '@/components/docs/DocsDrawerContext';
import {
  buildDocsUrl,
  DEFAULT_DOC,
  DEFAULT_DOCS_BASE_URL,
  isDocId,
  normalizeDocsBaseUrl,
  resolveDoc,
} from '@/lib/docs/docsLinks';

/** A page of the docs site: no `.html` (the site serves clean URLs), an index ends in `/`. */
const DOC_PATH = /^\/(console|console-sdk)\/[a-z0-9/-]*(#[a-z0-9-]+)?$/;

describe('docs-links registry', () => {
  it('names every page by its clean path on the docs site, once', () => {
    const pages = Object.entries(docsLinksJson.pages);
    expect(pages.length).toBeGreaterThan(0);
    for (const [id, page] of pages) {
      expect(page.path, id).toMatch(DOC_PATH);
      expect(page.title, id).not.toBe('');
    }
    expect(new Set(pages.map(([, page]) => page.path)).size).toBe(pages.length);
    expect(isDocId(DEFAULT_DOC)).toBe(true);
  });

  it('gives every service a page, in the shape the schema requires', () => {
    const schemaService = platformServicesSchema.definitions.service;
    expect(schemaService.required).toContain('docsPath');
    expect(new RegExp(schemaService.properties.docsPath.pattern).source).toBe(DOC_PATH.source);
    for (const service of platformServicesJson.services) {
      expect((service as { docsPath?: string }).docsPath, service.id).toMatch(DOC_PATH);
    }
  });
});

describe('resolveDoc / buildDocsUrl', () => {
  it('resolves an id to its page and title, and a path to itself', () => {
    expect(resolveDoc('models-inference')).toEqual({
      path: '/console/guide/models/inference',
      title: 'Inference (LLM & Embeddings)',
    });
    expect(resolveDoc('/console/guide/knowledge/rag', 'RAG')).toEqual({ path: '/console/guide/knowledge/rag', title: 'RAG' });
  });

  it('falls back to the start of the guide for nothing, an unknown id or what is not a rooted path', () => {
    const start = { path: '/console/guide/start/', title: 'What is Console' };
    for (const target of [undefined, null, '', 'api-tracing', 'getting-started', '//evil.example/x', 'https://evil.example']) {
      expect(resolveDoc(target), String(target)).toEqual(start);
    }
  });

  it('builds the URL on the base, with the query before the anchor', () => {
    expect(buildDocsUrl(DEFAULT_DOCS_BASE_URL, 'agents-runs-api')).toBe(
      'https://docs.cognipeer.com/console/developer/api/agents#runs-api',
    );
    expect(buildDocsUrl('https://intranet.example/docs', 'agents-runs-api', { embed: '1', theme: 'dark' })).toBe(
      'https://intranet.example/docs/console/developer/api/agents?embed=1&theme=dark#runs-api',
    );
    expect(buildDocsUrl(DEFAULT_DOCS_BASE_URL, '/console/guide/start/', { embed: '1' })).toBe(
      'https://docs.cognipeer.com/console/guide/start/?embed=1',
    );
  });

  it('reads DOCS_BASE_URL as an http(s) root without trailing slash, else the public site', () => {
    expect(normalizeDocsBaseUrl(undefined)).toBe(DEFAULT_DOCS_BASE_URL);
    expect(normalizeDocsBaseUrl('  ')).toBe(DEFAULT_DOCS_BASE_URL);
    expect(normalizeDocsBaseUrl('https://docs.example.internal/')).toBe('https://docs.example.internal');
    expect(normalizeDocsBaseUrl('http://10.0.0.5:8080/cognipeer/docs/?x=1#y')).toBe('http://10.0.0.5:8080/cognipeer/docs');
    expect(normalizeDocsBaseUrl('javascript:alert(1)')).toBe(DEFAULT_DOCS_BASE_URL);
    expect(normalizeDocsBaseUrl('docs.example.internal')).toBe(DEFAULT_DOCS_BASE_URL);
  });
});

describe('DocAnchor', () => {
  beforeAll(() => installDomStubs());
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  function mount(node: ReturnType<typeof h>): HTMLAnchorElement {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(h(MantineProvider, null, node)));
    return container.querySelector('a')!;
  }

  function inPanel(openDocs: OpenDocs, props: { newTab?: boolean } = {}) {
    return h(DocsDrawerProvider, {
      value: { openDocs, docsBaseUrl: 'https://docs.example.internal' },
      children: h(DocAnchor, { doc: 'knowledge-files', ...props, children: 'Files guide' }),
    });
  }

  function clickWith(link: HTMLAnchorElement, init: MouseEventInit = {}): MouseEvent {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });
    act(() => {
      link.dispatchEvent(event);
    });
    return event;
  }

  it('opens the page in the docs panel on a plain click, with the deployment base on the link', () => {
    const openDocs = vi.fn<OpenDocs>();
    const link = mount(inPanel(openDocs));
    expect(link.getAttribute('href')).toBe('https://docs.example.internal/console/guide/knowledge/files');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    const event = clickWith(link);
    expect(event.defaultPrevented).toBe(true);
    expect(openDocs).toHaveBeenCalledWith('knowledge-files', { title: undefined });
  });

  it('leaves a modifier click and a new-tab link to the browser', () => {
    const openDocs = vi.fn<OpenDocs>();
    const link = mount(inPanel(openDocs));
    for (const init of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }]) {
      expect(clickWith(link, init).defaultPrevented).toBe(false);
    }
    act(() => root!.unmount());
    container!.remove();
    const newTab = mount(inPanel(openDocs, { newTab: true }));
    expect(clickWith(newTab).defaultPrevented).toBe(false);
    expect(openDocs).not.toHaveBeenCalled();
  });

  it('is a plain link to the public site outside the dashboard', () => {
    const link = mount(h(DocAnchor, { doc: 'knowledge-files', children: 'Files guide' }));
    expect(link.getAttribute('href')).toBe('https://docs.cognipeer.com/console/guide/knowledge/files');
    expect(clickWith(link).defaultPrevented).toBe(false);
  });
});
