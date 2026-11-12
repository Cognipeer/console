import { MutationCache, QueryCache, QueryClient, type QueryClientConfig } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import { errorMessage, isApiError } from '@/lib/api/client';

/**
 * Per-query / per-mutation switches read by the client's cache handlers.
 *
 * `notifyOnError: true` shows the error's message in a notification when the query or mutation fails; a string
 * does the same with that string as the notification title. It is off by default: a screen that already shows its
 * own error does not get a second message.
 */
export interface ApiCallMeta extends Record<string, unknown> {
  notifyOnError?: boolean | string;
}

declare module '@tanstack/react-query' {
  interface Register {
    queryMeta: ApiCallMeta;
    mutationMeta: ApiCallMeta;
  }
}

export const defaultQueryOptions = {
  queries: {
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
  },
};

function notifyFailure(error: unknown, meta: ApiCallMeta | undefined): void {
  const flag = meta?.notifyOnError;
  if (!flag) return;
  // A 401 is being answered by the redirect to the login page (see `apiRequest`); a message would flash over it.
  if (isApiError(error) && error.status === 401) return;
  notifications.show({
    color: 'red',
    title: typeof flag === 'string' ? flag : undefined,
    message: errorMessage(error),
  });
}

/** The app's query client. `config` replaces nothing but the options it names (tests pass `defaultOptions`). */
export function createQueryClient(config: QueryClientConfig = {}): QueryClient {
  return new QueryClient({
    ...config,
    queryCache: new QueryCache({ onError: (error, query) => notifyFailure(error, query.meta) }),
    mutationCache: new MutationCache({ onError: (error, _vars, _ctx, mutation) => notifyFailure(error, mutation.meta) }),
    defaultOptions: config.defaultOptions ?? defaultQueryOptions,
  });
}
