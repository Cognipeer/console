'use client';

import { createContext, useContext } from 'react';
import type { SdkDocId } from '@/lib/docs/sdkDocs';

export type DocsDrawerContextValue = {
  openDocs: (docId?: SdkDocId) => void;
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
