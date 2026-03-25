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
  return !Number.isNaN(value.getTime());
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