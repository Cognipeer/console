/**
 * IP address and CIDR validation for the IAM center (policy conditions, access
 * check context, token allow-lists). Pure and dependency free so it runs in the
 * browser and in node tests.
 *
 * Strict on purpose: the same strings end up in Cedar (`ip("10.0.0.0/8")`), and
 * a value the server would reject is better caught while typing.
 */

/** Decimal IPv4 octets 0-255 without leading zeros (`01` is ambiguous: octal in some parsers). */
export function isValidIPv4(value: string): boolean {
  const parts = value.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => /^(0|[1-9]\d{0,2})$/.test(p) && Number(p) <= 255);
}

/** IPv6 with optional `::` compression and an optional trailing embedded IPv4. No zone id. */
export function isValidIPv6(value: string): boolean {
  if (value.length < 2 || value.includes('%') || !/^[0-9a-fA-F:.]+$/.test(value)) return false;
  const doubleColon = value.indexOf('::');
  if (doubleColon !== -1 && value.indexOf('::', doubleColon + 1) !== -1) return false;
  if (value.includes(':::')) return false;

  let groupsBudget = 8;
  let text = value;
  // An embedded IPv4 occupies the last two groups.
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (!isValidIPv4(tail)) return false;
    groupsBudget -= 2;
    text = text.slice(0, lastColon + 1);
    // `1:2:3:4:5:6:` -> drop the trailing colon unless it is part of `::`.
    if (text.endsWith('::')) {
      /* keep as is */
    } else if (text.endsWith(':')) {
      text = text.slice(0, -1);
    }
    if (text === '') return false;
  }

  const hasCompression = text.includes('::');
  const [head, rest] = hasCompression ? text.split('::') : [text, ''];
  const headGroups = head === '' ? [] : head.split(':');
  const restGroups = !hasCompression || rest === '' ? [] : rest.split(':');
  const all = [...headGroups, ...restGroups];
  if (!all.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g))) return false;

  if (hasCompression) {
    // `::` stands for at least one zero group.
    return all.length < groupsBudget;
  }
  return all.length === groupsBudget;
}

export function isValidIp(value: string): boolean {
  const v = value.trim();
  return isValidIPv4(v) || isValidIPv6(v);
}

export type CidrParse =
  | { ok: true; normalized: string; family: 4 | 6 }
  | { ok: false; reason: 'empty' | 'address' | 'prefix' };

/**
 * Parses `a.b.c.d/n` or an IPv6 equivalent. A bare address is accepted and
 * normalized to a single-host range (`/32`, `/128`) so the stored value is
 * always a real CIDR.
 */
export function parseCidr(input: string): CidrParse {
  const value = input.trim();
  if (value === '') return { ok: false, reason: 'empty' };

  const slash = value.indexOf('/');
  const address = slash === -1 ? value : value.slice(0, slash);
  const prefixText = slash === -1 ? null : value.slice(slash + 1);

  const v4 = isValidIPv4(address);
  // Cedar's ip() takes no IPv4 embedded in IPv6 (`::ffff:10.0.0.1`), so a range cannot either.
  const v6 = !v4 && !address.includes('.') && isValidIPv6(address);
  if (!v4 && !v6) return { ok: false, reason: 'address' };

  const max = v4 ? 32 : 128;
  if (prefixText === null) return { ok: true, normalized: `${address}/${max}`, family: v4 ? 4 : 6 };
  if (!/^\d{1,3}$/.test(prefixText)) return { ok: false, reason: 'prefix' };
  const prefix = Number(prefixText);
  if (prefix > max) return { ok: false, reason: 'prefix' };
  return { ok: true, normalized: `${address}/${prefix}`, family: v4 ? 4 : 6 };
}
