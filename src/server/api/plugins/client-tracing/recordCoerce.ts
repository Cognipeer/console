import type { TracingSummaryPayload } from './payloadTypes';

export function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

export function toNumber(value: unknown): number | undefined {
  return typeof value === 'number' && !Number.isNaN(value) ? value : undefined;
}

export function toErrorRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string' && value.length > 0) {
    return { message: value };
  }

  return toRecord(value);
}

export function toErrorList(values: unknown[] | undefined): Array<Record<string, unknown>> {
  return (values || []).flatMap((value) => {
    const normalized = toErrorRecord(value);
    return normalized ? [normalized] : [];
  });
}

export function getSummaryRecord(summary: unknown): Record<string, unknown> {
  return toRecord(summary) ?? {};
}

export function getSummaryEventCounts(summary: unknown): Record<string, number> {
  const record = toRecord(getSummaryRecord(summary).eventCounts);
  if (!record) {
    return {};
  }

  const counts: Record<string, number> = {};
  for (const [key, value] of Object.entries(record)) {
    const count = toNumber(value);
    if (count !== undefined) {
      counts[key] = count;
    }
  }

  return counts;
}

export function getSummaryNumber(
  summary: unknown,
  key: keyof TracingSummaryPayload,
): number | undefined {
  return toNumber(getSummaryRecord(summary)[key]);
}
