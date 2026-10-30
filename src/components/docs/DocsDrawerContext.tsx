'use client';

import { createContext, useContext, type MouseEvent } from 'react';
import { buildDocsUrl, DEFAULT_DOCS_BASE_URL, type DocTarget } from '@/lib/docs/docsLinks';

export type OpenDocs = (target?: DocTarget, options?: { title?: string }) => void;

export type DocsDrawerContextValue = {
  /** Opens a docs page in the panel beside the page: a docs-links id or a docs path. */
  openDocs: OpenDocs;
  /** Root of the docs site for this deployment (DOCS_BASE_URL); the public site when absent. */
  docsBaseUrl?: string;
};

const DocsDrawerContext = createContext<DocsDrawerContextValue | null>(null);

export function DocsDrawerProvider({
  value,
  children,
}: {
  value: DocsDrawerContextValue;
  children: React.ReactNode;
}) {
  return (
    <DocsDrawerContext.Provider value={value}>{children}</DocsDrawerContext.Provider>
  );
}

export function useDocsDrawer() {
  const ctx = useContext(DocsDrawerContext);
  if (!ctx) {
    throw new Error('useDocsDrawer must be used within DocsDrawerProvider');
  }
  return ctx;
}

/**
 * The props of a link to a docs page: the page's URL in a new tab (so middle-click, a modifier
 * click and a copied link keep working) and a plain click that opens it in the docs panel instead.
 * Outside the dashboard (no panel) it stays a plain link; so does `newTab`, for a link inside a
 * modal, where the panel would open behind the overlay.
 */
export function useDocLink(target: DocTarget, options: { newTab?: boolean; title?: string } = {}) {
  const ctx = useContext(DocsDrawerContext);
  const href = buildDocsUrl(ctx?.docsBaseUrl ?? DEFAULT_DOCS_BASE_URL, target);
  const onClick = (event: MouseEvent<HTMLElement>) => {
    if (!ctx || options.newTab || event.defaultPrevented) return;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    ctx.openDocs(target, { title: options.title });
  };
  return { href, target: '_blank', rel: 'noopener noreferrer', onClick } as const;
}
