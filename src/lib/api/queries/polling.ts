import { isClientError } from './errors';

/**
 * `refetchInterval` for a query whose data says whether it is still settling (a job running, a record
 * being processed): `ms` while `isPending(data)` holds, `false` (stop) once it does not, and also after a
 * client error. Use it with `refetchIntervalInBackground: false` (see `pollingOptions`).
 *
 *   useQuery({ queryKey, queryFn, refetchInterval: pollWhile((run) => run?.status === 'running', 2000) })
 */
export function pollWhile<T>(
  isPending: (data: T | undefined) => boolean,
  ms: number,
): (query: { state: { data: T | undefined; error: unknown } }) => number | false {
  return (query) => {
    if (isClientError(query.state.error)) return false;
    return isPending(query.state.data) ? ms : false;
  };
}

/** `pollWhile` plus the option that keeps a hidden tab from polling. Spread it into `useQuery` options. */
export function pollingOptions<T>(isPending: (data: T | undefined) => boolean, ms: number) {
  return { refetchInterval: pollWhile(isPending, ms), refetchIntervalInBackground: false } as const;
}
