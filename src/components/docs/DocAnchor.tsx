'use client';

import type { ReactNode } from 'react';
import { Anchor, type AnchorProps } from '@mantine/core';
import type { DocTarget } from '@/lib/docs/docsLinks';
import { useDocLink } from './DocsDrawerContext';

/** A text link to a docs page: opens it in the docs panel, or in a new tab (see `useDocLink`). */
export default function DocAnchor({
  doc,
  newTab,
  children,
  ...props
}: AnchorProps & { doc: DocTarget; newTab?: boolean; children: ReactNode }) {
  const link = useDocLink(doc, { newTab });
  return (
    <Anchor {...props} {...link}>
      {children}
    </Anchor>
  );
}
