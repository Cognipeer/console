'use client';

import type { CSSProperties, ReactNode } from 'react';
import Link from 'next/link';
import { UnstyledButton } from '@mantine/core';
import {
  useIntentPrefetch,
  useIsNavigationPending,
} from '@/components/common/navigation/useNavigationFeedback';

/**
 * Card-style internal link: intent prefetch (hover, focus, pointer down) and
 * an instant pending state while its navigation is in flight.
 */
export function CardLink({
  href,
  className,
  style,
  children,
}: {
  href: string;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const pending = useIsNavigationPending(href);
  const { getIntentProps } = useIntentPrefetch({ kind: 'full' });
  return (
    <UnstyledButton
      component={Link}
      href={href}
      prefetch={false}
      className={className}
      style={style}
      data-pending={pending || undefined}
      {...getIntentProps(href)}
    >
      {children}
    </UnstyledButton>
  );
}
