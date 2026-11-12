/**
 * Summary of an alert event's channel deliveries (`sent` of `total` attempted).
 * `failed-one` / `failed-all` mean nothing was delivered, which reads very
 * differently from "0/1 sent" in a table cell; `none-attempted` means the event
 * had no channel to deliver to.
 */
export type DeliveryKind = 'none-attempted' | 'all' | 'partial' | 'failed-one' | 'failed-all';

export function summarizeDeliveries(
  channels: Array<{ success: boolean }> | undefined,
): { kind: DeliveryKind; sent: number; total: number } {
  const total = channels?.length ?? 0;
  const sent = channels?.filter((channel) => channel.success).length ?? 0;
  if (total === 0) return { kind: 'none-attempted', sent, total };
  if (sent === total) return { kind: 'all', sent, total };
  if (sent > 0) return { kind: 'partial', sent, total };
  return { kind: total === 1 ? 'failed-one' : 'failed-all', sent, total };
}
