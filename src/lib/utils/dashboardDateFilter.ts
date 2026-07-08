export type DashboardDatePeriod =
  | 'total'
  | 'last_day'
  | 'last_7_days'
  | 'last_30_days'
  | 'custom';

export interface DashboardDateFilterState {
  period: DashboardDatePeriod;
  dateRange: [Date | null, Date | null];
}

export interface DashboardResolvedDateFilter {
  period: DashboardDatePeriod;
  from?: Date;
  to?: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function isValidDate(value: Date): boolean {
  // Guard against non-Date values sneaking in from string-based date pickers.
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function parseDate(value: string | null): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return isValidDate(parsed) ? parsed : undefined;
}

export function defaultDashboardDateFilter(): DashboardDateFilterState {
  return {
    period: 'total',
    dateRange: [null, null],
  };
}

/**
 * Parses 'YYYY-MM-DD' (and Mantine 8 date-picker strings) as LOCAL midnight;
 * full ISO strings and Date instances pass through.
 */
export function parseLocalDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) return isValidDate(value) ? value : null;
  const shortMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (shortMatch) {
    const parsed = new Date(
      Number(shortMatch[1]),
      Number(shortMatch[2]) - 1,
      Number(shortMatch[3]),
    );
    return isValidDate(parsed) ? parsed : null;
  }
  const parsed = new Date(value);
  return isValidDate(parsed) ? parsed : null;
}

function toLocalDateString(date: Date): string {
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${mm}-${dd}`;
}

const DASHBOARD_PERIODS: DashboardDatePeriod[] = [
  'total',
  'last_day',
  'last_7_days',
  'last_30_days',
  'custom',
];

/**
 * Reads the client-side filter state back from URL search params
 * (?period=...&from=YYYY-MM-DD&to=YYYY-MM-DD). Inverse of
 * applyDashboardDateFilterToSearchParams.
 */
export function dashboardDateFilterFromSearchParams(
  searchParams: URLSearchParams,
): DashboardDateFilterState {
  const requested = searchParams.get('period') as DashboardDatePeriod | null;
  const period = requested && DASHBOARD_PERIODS.includes(requested) ? requested : 'total';
  if (period !== 'custom') {
    return { period, dateRange: [null, null] };
  }
  const from = parseLocalDate(searchParams.get('from'));
  const to = parseLocalDate(searchParams.get('to'));
  if (!from && !to) {
    return { period: 'total', dateRange: [null, null] };
  }
  return { period: 'custom', dateRange: [from, to] };
}

/**
 * Writes the filter into URL search params (short local dates, no time
 * component) so dashboard filters survive navigation and can be shared.
 */
export function applyDashboardDateFilterToSearchParams(
  filter: DashboardDateFilterState,
  params: URLSearchParams,
): void {
  params.delete('period');
  params.delete('from');
  params.delete('to');
  if (filter.period === 'total') return;
  params.set('period', filter.period);
  if (filter.period === 'custom') {
    const [from, to] = filter.dateRange;
    if (from && isValidDate(from)) params.set('from', toLocalDateString(from));
    if (to && isValidDate(to)) params.set('to', toLocalDateString(to));
  }
}

/** Stable string key for change detection between two filter states. */
export function dashboardDateFilterKey(filter: DashboardDateFilterState): string {
  const params = new URLSearchParams();
  applyDashboardDateFilterToSearchParams(filter, params);
  return params.toString();
}

export function resolveDashboardDateFilter(
  period: DashboardDatePeriod,
  options?: {
    now?: Date;
    from?: Date;
    to?: Date;
  },
): DashboardResolvedDateFilter {
  const now = options?.now ?? new Date();
  const from = options?.from;
  const to = options?.to;

  if (!isValidDate(now)) {
    return { period: 'total' };
  }

  switch (period) {
    case 'last_day':
      return { period, from: new Date(now.getTime() - DAY_MS), to: now };
    case 'last_7_days':
      return { period, from: new Date(now.getTime() - 7 * DAY_MS), to: now };
    case 'last_30_days':
      return { period, from: new Date(now.getTime() - 30 * DAY_MS), to: now };
    case 'custom': {
      const isFromValid = from ? isValidDate(from) : false;
      const isToValid = to ? isValidDate(to) : false;
      return {
        period,
        from: isFromValid ? from : undefined,
        to: isToValid ? to : undefined,
      };
    }
    case 'total':
    default:
      return { period: 'total' };
  }
}

export function parseDashboardDateFilterFromSearchParams(
  searchParams: URLSearchParams,
): DashboardResolvedDateFilter {
  const requestedPeriod = searchParams.get('period');
  const period: DashboardDatePeriod =
    requestedPeriod === 'last_day' ||
    requestedPeriod === 'last_7_days' ||
    requestedPeriod === 'last_30_days' ||
    requestedPeriod === 'custom' ||
    requestedPeriod === 'total'
      ? requestedPeriod
      : 'total';

  const from = parseDate(searchParams.get('from'));
  const to = parseDate(searchParams.get('to'));

  return resolveDashboardDateFilter(period, { from, to });
}

export function isDateInDashboardRange(
  value: Date | string | undefined,
  filter: Pick<DashboardResolvedDateFilter, 'from' | 'to'>,
): boolean {
  if (!filter.from && !filter.to) return true;
  if (!value) return false;

  const date = typeof value === 'string' ? new Date(value) : value;
  if (!isValidDate(date)) return false;

  if (filter.from && date < filter.from) return false;
  if (filter.to && date > filter.to) return false;

  return true;
}

function toStartOfDay(value: Date): Date {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function toEndOfDay(value: Date): Date {
  const date = new Date(value);
  date.setHours(23, 59, 59, 999);
  return date;
}

export function buildDashboardDateSearchParams(
  filter: DashboardDateFilterState,
): URLSearchParams {
  const params = new URLSearchParams();
  params.set('period', filter.period);

  if (filter.period === 'custom') {
    const [from, to] = filter.dateRange;
    if (from && isValidDate(from)) {
      params.set('from', toStartOfDay(from).toISOString());
    }
    if (to && isValidDate(to)) {
      params.set('to', toEndOfDay(to).toISOString());
    }
  }

  return params;
}