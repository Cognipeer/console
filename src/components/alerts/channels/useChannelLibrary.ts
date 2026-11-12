'use client';

import { useChannelLibraryQuery } from '@/lib/api/queries/alerts';
import type { LibraryChannelDto } from '../alertTypes';
import { apiErrorMessage } from '../apiError';

export interface ChannelLibraryState {
  channels: LibraryChannelDto[];
  loading: boolean;
  error: string | null;
  reload: () => void;
}

const NO_CHANNELS: LibraryChannelDto[] = [];

/**
 * `GET /alerts/channels/library` (masked entries with the rules that use them), read through React Query;
 * `enabled: false` keeps a closed form from loading it.
 */
export function useChannelLibrary(options: { enabled?: boolean; fallbackError: string }): ChannelLibraryState {
  const { enabled = true, fallbackError } = options;
  const query = useChannelLibraryQuery(enabled);
  return {
    channels: query.data ?? NO_CHANNELS,
    loading: enabled && query.isFetching,
    error: query.isError ? apiErrorMessage(query.error, fallbackError) : null,
    reload: () => void query.refetch(),
  };
}
