'use client';

import { useCallback, useState } from 'react';
import { Button, Group, Text } from '@mantine/core';
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import { newPager, pagerCursor, pagerNext, pagerPage, pagerPrev, type PagerState } from './client';

/**
 * Cursor paging state for a list whose filters are described by `key`: changing
 * the key (a new search, another segment) starts again at page 1 and forgets the
 * old pages. The reset happens while rendering, so no request is made with a
 * cursor that belongs to the previous filters.
 */
export function useCursorPager(key: string) {
  const [state, setState] = useState<PagerState>(() => newPager(key));
  if (state.key !== key) setState(newPager(key));
  const next = useCallback((cursor: string) => setState((s) => pagerNext(s, key, cursor)), [key]);
  const prev = useCallback(() => setState((s) => pagerPrev(s, key)), [key]);
  return { page: pagerPage(state, key), cursor: pagerCursor(state, key), next, prev };
}

interface PagerControlsProps {
  page: number;
  hasNext: boolean;
  loading?: boolean;
  onPrev: () => void;
  onNext: () => void;
  previousLabel: string;
  nextLabel: string;
  pageLabel: string;
}

/** Previous / page / next buttons (the labels come from the owning tab's namespace). */
export function PagerControls({
  page,
  hasNext,
  loading,
  onPrev,
  onNext,
  previousLabel,
  nextLabel,
  pageLabel,
}: PagerControlsProps) {
  return (
    <Group gap="xs" wrap="nowrap">
      <Button
        size="xs"
        variant="default"
        leftSection={<IconChevronLeft size={12} />}
        disabled={Boolean(loading) || page <= 1}
        onClick={onPrev}
      >
        {previousLabel}
      </Button>
      <Text size="xs" ff="monospace" miw={52} ta="center">
        {pageLabel}
      </Text>
      <Button
        size="xs"
        variant="default"
        rightSection={<IconChevronRight size={12} />}
        disabled={Boolean(loading) || !hasNext}
        onClick={onNext}
      >
        {nextLabel}
      </Button>
    </Group>
  );
}
