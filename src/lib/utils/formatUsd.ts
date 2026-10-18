/**
 * A dollar amount for a message a person reads (without the `$`): two decimals from a dollar up, four down to a tenth of a cent,
 * below that enough decimals to show two significant digits, so a limit of $0.00001 does not read as "0.0000".
 */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value === 0) return '0.00';
  const abs = Math.abs(value);
  if (abs >= 1) return value.toFixed(2);
  if (abs >= 0.001) return value.toFixed(4);
  const decimals = Math.min(10, Math.ceil(-Math.log10(abs)) + 1);
  return value.toFixed(decimals).replace(/0+$/, '');
}
