/**
 * Token IP allowlists: CIDR parsing and matching (IPv4 + IPv6), normalization,
 * and the fail-closed rules. Pure functions, no I/O.
 */
import { isIP } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  MAX_ALLOWED_IP_RANGES,
  checkCidr,
  hasIpRestriction,
  isIpAllowed,
  isRangeWithin,
  parseClientIp,
  parseIpv4,
  parseIpv6,
  resolveChildAllowlist,
  splitIpRangeText,
  validateAllowedIpRanges,
  type ParsedCidr,
} from '@/lib/services/apiTokens/ipAllowlist';

describe('address parsing agrees with node:net', () => {
  const v4Valid = ['0.0.0.0', '1.2.3.4', '10.0.0.1', '127.0.0.1', '192.168.255.254', '255.255.255.255', '203.0.113.7'];
  const v4Invalid = [
    '', '1.2.3', '1.2.3.4.5', '256.0.0.1', '1.2.3.256', '01.2.3.4', '1.02.3.4', '1.2.3.04', ' 1.2.3.4', '1.2.3.4 ',
    '1..3.4', '.1.2.3', '1.2.3.', 'a.b.c.d', '1.2.3.-4', '0x7f.0.0.1', '1e1.0.0.1', '1.2.3.4/24',
  ];
  const v6Valid = [
    '::', '::1', '1::', '2001:db8::1', '2001:db8:0:0:0:0:0:1', 'fe80::1', 'FE80::ABCD', '::ffff:10.0.0.1', '::ffff:a00:1',
    '64:ff9b::1.2.3.4', '1:2:3:4:5:6:7:8', '1:2:3:4:5:6:1.2.3.4', '1::8', '1:2:3:4:5:6:7::', '::2:3:4:5:6:7:8', '0:0:0:0:0:0:0:0',
  ];
  const v6Invalid = [
    '', ':', ':::', '1:::2', '1::2::3', '12345::1', 'g::1', '1:2:3:4:5:6:7', '1:2:3:4:5:6:7:8:9', '1:2:3:4:5:6:7:8::',
    '::1.2.3', '::1.2.3.4.5', '::256.0.0.1', ':1::2', '1::2:', ':1:2:3:4:5:6:7', '1:2:3:4:5:6:7:1.2.3.4', 'fe80::1%eth0',
  ];

  it.each(v4Valid)('accepts IPv4 %s', (text) => {
    expect(isIP(text)).toBe(4);
    expect(parseIpv4(text)).not.toBeNull();
  });
  it.each(v4Invalid)('rejects IPv4 %j', (text) => {
    expect(parseIpv4(text)).toBeNull();
  });
  it.each(v6Valid)('accepts IPv6 %s', (text) => {
    expect(isIP(text)).toBe(6);
    expect(parseIpv6(text)).not.toBeNull();
  });
  it.each(v6Invalid)('rejects IPv6 %j', (text) => {
    expect(parseIpv6(text)).toBeNull();
  });

  it('parses IPv6 into the right groups', () => {
    expect(parseIpv6('2001:db8::1')).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6('::')).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(parseIpv6('::ffff:10.1.2.3')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0a01, 0x0203]);
    expect(parseIpv6('1:2:3:4:5:6:7::')).toEqual([1, 2, 3, 4, 5, 6, 7, 0]);
  });

  it('agrees with node:net on 30k generated near-valid strings (seeded)', () => {
    let seed = 987654321;
    const rnd = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const pick = <T,>(items: T[]): T => items[Math.floor(rnd() * items.length)];
    const hexGroup = () => {
      let out = '';
      for (let i = Math.floor(rnd() * 6); i > 0; i--) out += '0123456789abcdefABCDEFg'[Math.floor(rnd() * 23)];
      return out;
    };
    const decimal = () => {
      const r = rnd();
      if (r < 0.05) return '';
      if (r < 0.1) return `0${Math.floor(rnd() * 100)}`;
      return String(Math.floor(rnd() * 300));
    };
    const generate = () => {
      const kind = Math.floor(rnd() * 4);
      if (kind === 0) return Array.from({ length: pick([3, 4, 4, 4, 5]) }, decimal).join('.');
      const groups = Array.from({ length: Math.floor(rnd() * 10) }, hexGroup);
      let text = groups.join(':');
      if (rnd() < 0.6) {
        const at = Math.floor(rnd() * (groups.length + 1));
        text = `${groups.slice(0, at).join(':')}::${groups.slice(at).join(':')}`;
      }
      if (kind === 3) text += `${text.endsWith(':') ? '' : ':'}${Array.from({ length: pick([3, 4, 4]) }, decimal).join('.')}`;
      return text;
    };

    const mismatches: string[] = [];
    let valid4 = 0;
    let valid6 = 0;
    for (let i = 0; i < 30_000; i++) {
      const text = generate();
      const family = isIP(text);
      if (family === 4) valid4++;
      if (family === 6) valid6++;
      if ((parseIpv4(text) !== null) !== (family === 4) || (parseIpv6(text) !== null) !== (family === 6)) {
        mismatches.push(`${JSON.stringify(text)} node=${family}`);
      }
    }
    expect(mismatches.slice(0, 10)).toEqual([]);
    // The generator really exercised both families.
    expect(valid4).toBeGreaterThan(500);
    expect(valid6).toBeGreaterThan(500);
  });
});

describe('client address normalization', () => {
  it('reads plain, bracketed, zoned and mapped addresses', () => {
    expect(parseClientIp('203.0.113.7')).toEqual({ family: 4, parts: [203, 0, 113, 7] });
    expect(parseClientIp(' 203.0.113.7 ')).toEqual({ family: 4, parts: [203, 0, 113, 7] });
    expect(parseClientIp('[2001:db8::1]')?.family).toBe(6);
    expect(parseClientIp('fe80::1%eth0')?.family).toBe(6);
    // What a dual-stack listener reports for an IPv4 client:
    expect(parseClientIp('::ffff:203.0.113.7')).toEqual({ family: 4, parts: [203, 0, 113, 7] });
    expect(parseClientIp('::ffff:cb00:7107')).toEqual({ family: 4, parts: [203, 0, 113, 7] });
  });

  it('refuses things that are not an address', () => {
    for (const bad of [undefined, null, '', 'unknown', 'localhost', '1.2.3', '1.2.3.4:8080', '203.0.113.7, 10.0.0.1', 'x'.repeat(200)]) {
      expect(parseClientIp(bad as string | null | undefined)).toBeNull();
    }
  });
});

describe('checkCidr', () => {
  it('normalizes bare addresses to host ranges', () => {
    expect(checkCidr('203.0.113.7')).toMatchObject({ ok: true, normalized: '203.0.113.7/32' });
    expect(checkCidr('2001:DB8::1')).toMatchObject({ ok: true, normalized: '2001:db8::1/128' });
  });

  it('keeps a canonical decimal prefix and allows host bits', () => {
    expect(checkCidr('10.0.0.0/08')).toMatchObject({ ok: true, normalized: '10.0.0.0/8' });
    expect(checkCidr('10.0.0.5/24')).toMatchObject({ ok: true, normalized: '10.0.0.5/24' });
    expect(checkCidr('  192.168.0.0/16  ')).toMatchObject({ ok: true, normalized: '192.168.0.0/16' });
    expect(checkCidr('0.0.0.0/0')).toMatchObject({ ok: true });
    expect(checkCidr('::/0')).toMatchObject({ ok: true });
  });

  it('reports why a range is wrong', () => {
    expect(checkCidr('')).toEqual({ ok: false, reason: 'empty' });
    expect(checkCidr('   ')).toEqual({ ok: false, reason: 'empty' });
    expect(checkCidr('10.0.0.0/33')).toEqual({ ok: false, reason: 'prefix' });
    expect(checkCidr('2001:db8::/129')).toEqual({ ok: false, reason: 'prefix' });
    expect(checkCidr('10.0.0.0/')).toEqual({ ok: false, reason: 'prefix' });
    expect(checkCidr('10.0.0.0/-1')).toEqual({ ok: false, reason: 'prefix' });
    expect(checkCidr('10.0.0.0/8/8')).toEqual({ ok: false, reason: 'prefix' });
    expect(checkCidr('10.0.0.0/abc')).toEqual({ ok: false, reason: 'prefix' });
    expect(checkCidr('10.0.0/8')).toEqual({ ok: false, reason: 'address' });
    expect(checkCidr('example.com')).toEqual({ ok: false, reason: 'address' });
    expect(checkCidr('[::1]/128')).toEqual({ ok: false, reason: 'address' });
    expect(checkCidr('fe80::1%eth0/64')).toEqual({ ok: false, reason: 'address' });
    expect(checkCidr(`10.0.0.0/8${' '.repeat(10)}${'1'.repeat(80)}`)).toEqual({ ok: false, reason: 'tooLong' });
  });
});

describe('isIpAllowed: unrestricted tokens', () => {
  it('allows any address (even an unknown one) when no list is set', () => {
    for (const value of [undefined, null, [], '', '   ']) {
      expect(hasIpRestriction(value)).toBe(false);
      expect(isIpAllowed('203.0.113.7', value)).toBe(true);
      expect(isIpAllowed('unknown', value)).toBe(true);
      expect(isIpAllowed(undefined, value)).toBe(true);
    }
  });
});

describe('isIpAllowed: IPv4 ranges', () => {
  const ranges = ['10.0.0.0/8', '203.0.113.7', '192.168.1.128/25'];

  it('matches inside a range and rejects outside it', () => {
    expect(isIpAllowed('10.1.2.3', ranges)).toBe(true);
    expect(isIpAllowed('10.255.255.255', ranges)).toBe(true);
    expect(isIpAllowed('11.0.0.1', ranges)).toBe(false);
    expect(isIpAllowed('9.255.255.255', ranges)).toBe(false);
  });

  it('treats a bare address as /32', () => {
    expect(isIpAllowed('203.0.113.7', ranges)).toBe(true);
    expect(isIpAllowed('203.0.113.8', ranges)).toBe(false);
    expect(isIpAllowed('203.0.113.6', ranges)).toBe(false);
  });

  it('respects non-octet-aligned prefixes at the boundary', () => {
    expect(isIpAllowed('192.168.1.128', ranges)).toBe(true);
    expect(isIpAllowed('192.168.1.255', ranges)).toBe(true);
    expect(isIpAllowed('192.168.1.127', ranges)).toBe(false);
    expect(isIpAllowed('192.168.2.128', ranges)).toBe(false);
    expect(isIpAllowed('172.16.5.9', ['172.16.0.0/12'])).toBe(true);
    expect(isIpAllowed('172.32.0.1', ['172.16.0.0/12'])).toBe(false);
    expect(isIpAllowed('172.15.255.255', ['172.16.0.0/12'])).toBe(false);
  });

  it('honours /0 and /32 and host bits in the range', () => {
    expect(isIpAllowed('8.8.8.8', ['0.0.0.0/0'])).toBe(true);
    expect(isIpAllowed('8.8.8.8', ['8.8.8.8/32'])).toBe(true);
    expect(isIpAllowed('8.8.8.9', ['8.8.8.8/32'])).toBe(false);
    expect(isIpAllowed('10.0.0.200', ['10.0.0.5/24'])).toBe(true);
    expect(isIpAllowed('10.0.1.5', ['10.0.0.5/24'])).toBe(false);
  });

  it('does not cross address families', () => {
    expect(isIpAllowed('2001:db8::1', ['10.0.0.0/8'])).toBe(false);
    expect(isIpAllowed('10.0.0.1', ['2001:db8::/32'])).toBe(false);
    // 0.0.0.0/0 is "all IPv4", not "everything".
    expect(isIpAllowed('2001:db8::1', ['0.0.0.0/0'])).toBe(false);
    expect(isIpAllowed('10.0.0.1', ['::/0'])).toBe(false);
  });
});

describe('isIpAllowed: IPv6 ranges', () => {
  const ranges = ['2001:db8::/32', 'fd00:1234:5678::/48', '2a00:1450:4001:81b::200e'];

  it('matches inside a range and rejects outside it', () => {
    expect(isIpAllowed('2001:db8::1', ranges)).toBe(true);
    expect(isIpAllowed('2001:db8:ffff:ffff:ffff:ffff:ffff:ffff', ranges)).toBe(true);
    expect(isIpAllowed('2001:db9::1', ranges)).toBe(false);
    expect(isIpAllowed('2001:db7:ffff::1', ranges)).toBe(false);
    expect(isIpAllowed('fd00:1234:5678:abcd::1', ranges)).toBe(true);
    expect(isIpAllowed('fd00:1234:5679::1', ranges)).toBe(false);
  });

  it('treats a bare IPv6 address as /128', () => {
    expect(isIpAllowed('2a00:1450:4001:81b::200e', ranges)).toBe(true);
    expect(isIpAllowed('2A00:1450:4001:081B:0:0:0:200E', ranges)).toBe(true);
    expect(isIpAllowed('2a00:1450:4001:81b::200f', ranges)).toBe(false);
  });

  it('handles prefixes that are not a multiple of 16', () => {
    expect(isIpAllowed('2001:db8:0:7fff::1', ['2001:db8::/49'])).toBe(true);
    expect(isIpAllowed('2001:db8:0:8000::1', ['2001:db8::/49'])).toBe(false);
    expect(isIpAllowed('::1', ['::1/128'])).toBe(true);
    expect(isIpAllowed('::2', ['::1/128'])).toBe(false);
    expect(isIpAllowed('fe80::1%eth0', ['fe80::/10'])).toBe(true);
    expect(isIpAllowed('[2001:db8::5]', ['2001:db8::/32'])).toBe(true);
  });
});

describe('isIpAllowed: IPv4-mapped IPv6 (dual-stack sockets)', () => {
  it('matches a mapped client against IPv4 ranges', () => {
    expect(isIpAllowed('::ffff:10.1.2.3', ['10.0.0.0/8'])).toBe(true);
    expect(isIpAllowed('::ffff:a01:203', ['10.0.0.0/8'])).toBe(true);
    expect(isIpAllowed('::ffff:11.1.2.3', ['10.0.0.0/8'])).toBe(false);
    expect(isIpAllowed('::ffff:203.0.113.7', ['203.0.113.7'])).toBe(true);
  });

  it('reads a mapped range as the IPv4 range it embeds', () => {
    expect(isIpAllowed('10.1.2.3', ['::ffff:10.0.0.0/104'])).toBe(true);
    expect(isIpAllowed('11.1.2.3', ['::ffff:10.0.0.0/104'])).toBe(false);
    expect(isIpAllowed('::ffff:10.1.2.3', ['::ffff:10.0.0.0/104'])).toBe(true);
    expect(checkCidr('::ffff:10.0.0.0/104')).toMatchObject({ ok: true, normalized: '::ffff:10.0.0.0/104' });
  });
});

describe('isIpAllowed: failure direction', () => {
  it('denies a restricted token when the client address is unknown or unparseable', () => {
    for (const ip of [undefined, null, '', 'unknown', 'not-an-ip', '10.0.0.1:443', '10.0.0.1, 10.0.0.2']) {
      expect(isIpAllowed(ip as string | null | undefined, ['0.0.0.0/0', '::/0'])).toBe(false);
    }
  });

  it('a stored list with no usable entry denies everything instead of unlocking the token', () => {
    expect(hasIpRestriction(['not-a-range'])).toBe(true);
    expect(isIpAllowed('10.0.0.1', ['not-a-range'])).toBe(false);
    expect(isIpAllowed('10.0.0.1', [''])).toBe(false);
    expect(isIpAllowed('10.0.0.1', [42, null])).toBe(false);
    expect(isIpAllowed('10.0.0.1', 'garbage')).toBe(false);
    expect(isIpAllowed('10.0.0.1', { 0: '10.0.0.0/8' })).toBe(false);
    expect(isIpAllowed('10.0.0.1', 42)).toBe(false);
  });

  it('ignores a bad entry next to a good one (the good one still works)', () => {
    expect(isIpAllowed('10.0.0.1', ['oops', '10.0.0.0/8'])).toBe(true);
    expect(isIpAllowed('11.0.0.1', ['oops', '10.0.0.0/8'])).toBe(false);
  });

  it('accepts a single-string stored value', () => {
    expect(isIpAllowed('10.0.0.1', '10.0.0.0/8')).toBe(true);
    expect(isIpAllowed('11.0.0.1', '10.0.0.0/8')).toBe(false);
  });
});

describe('validateAllowedIpRanges', () => {
  it('treats null, undefined and [] as "no restriction"', () => {
    expect(validateAllowedIpRanges(undefined)).toEqual({ ok: true, ranges: null });
    expect(validateAllowedIpRanges(null)).toEqual({ ok: true, ranges: null });
    expect(validateAllowedIpRanges([])).toEqual({ ok: true, ranges: null });
  });

  it('normalizes, trims and de-duplicates', () => {
    expect(validateAllowedIpRanges([' 10.0.0.0/8 ', '203.0.113.7', '203.0.113.7/32', '10.0.0.0/08', '2001:DB8::/32'])).toEqual({
      ok: true,
      ranges: ['10.0.0.0/8', '203.0.113.7/32', '2001:db8::/32'],
    });
  });

  it('reports each bad entry with its position', () => {
    const result = validateAllowedIpRanges(['10.0.0.0/8', '10.0.0.0/33', 7, '', 'nope']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => [i.index, i.reason])).toEqual([
      [1, 'prefix'],
      [2, 'type'],
      [3, 'empty'],
      [4, 'address'],
    ]);
    expect(result.issues[0].message).toContain('10.0.0.0/33');
  });

  it('rejects a non-array and an oversized list', () => {
    expect(validateAllowedIpRanges('10.0.0.0/8').ok).toBe(false);
    expect(validateAllowedIpRanges({ a: 1 }).ok).toBe(false);
    const tooMany = Array.from({ length: MAX_ALLOWED_IP_RANGES + 1 }, (_, i) => `10.${i >> 8}.${i & 255}.0/24`);
    const result = validateAllowedIpRanges(tooMany);
    expect(result.ok).toBe(false);
    expect(validateAllowedIpRanges(tooMany.slice(0, MAX_ALLOWED_IP_RANGES)).ok).toBe(true);
  });
});

describe('splitIpRangeText', () => {
  it('splits on newlines, commas, semicolons and spaces', () => {
    expect(splitIpRangeText('10.0.0.0/8\n192.168.0.0/16, 203.0.113.7;  2001:db8::/32\r\n\n')).toEqual([
      '10.0.0.0/8',
      '192.168.0.0/16',
      '203.0.113.7',
      '2001:db8::/32',
    ]);
    expect(splitIpRangeText('   ')).toEqual([]);
  });
});

describe('isRangeWithin', () => {
  const cidr = (text: string): ParsedCidr => {
    const check = checkCidr(text);
    if (!check.ok) throw new Error(`bad test range ${text}`);
    return check.cidr;
  };

  it('a range is within an equal or wider one of the same family', () => {
    expect(isRangeWithin(cidr('10.0.0.0/16'), cidr('10.0.0.0/8'))).toBe(true);
    expect(isRangeWithin(cidr('10.0.0.0/8'), cidr('10.0.0.0/8'))).toBe(true);
    expect(isRangeWithin(cidr('10.1.2.3'), cidr('10.0.0.0/8'))).toBe(true);
    expect(isRangeWithin(cidr('2001:db8:1::/48'), cidr('2001:db8::/32'))).toBe(true);
  });

  it('wider, disjoint and cross-family ranges are not within', () => {
    expect(isRangeWithin(cidr('10.0.0.0/8'), cidr('10.0.0.0/16'))).toBe(false);
    expect(isRangeWithin(cidr('0.0.0.0/0'), cidr('10.0.0.0/8'))).toBe(false);
    expect(isRangeWithin(cidr('11.0.0.0/16'), cidr('10.0.0.0/8'))).toBe(false);
    expect(isRangeWithin(cidr('10.0.0.0/8'), cidr('::/0'))).toBe(false);
    expect(isRangeWithin(cidr('2001:db9::/32'), cidr('2001:db8::/32'))).toBe(false);
    expect(isRangeWithin(cidr('192.168.1.128/25'), cidr('192.168.1.0/25'))).toBe(false);
    expect(isRangeWithin(cidr('192.168.1.128/25'), cidr('192.168.1.0/24'))).toBe(true);
  });
});

describe('resolveChildAllowlist (a token minting a token never widens network scope)', () => {
  it('an unrestricted minter passes the request through', () => {
    for (const parent of [undefined, null, []]) {
      expect(resolveChildAllowlist(parent, null)).toEqual({ ok: true, ranges: null });
      expect(resolveChildAllowlist(parent, ['0.0.0.0/0'])).toEqual({ ok: true, ranges: ['0.0.0.0/0'] });
    }
  });

  it('a restricted minter\'s child inherits its ranges when none are asked for', () => {
    expect(resolveChildAllowlist(['10.0.0.0/16', '2001:db8::/32'], null)).toEqual({
      ok: true,
      ranges: ['10.0.0.0/16', '2001:db8::/32'],
    });
  });

  it('may narrow, never widen', () => {
    const parent = ['10.0.0.0/16', '2001:db8::/32'];
    expect(resolveChildAllowlist(parent, ['10.0.5.0/24', '2001:db8:1::/48'])).toEqual({
      ok: true,
      ranges: ['10.0.5.0/24', '2001:db8:1::/48'],
    });
    expect(resolveChildAllowlist(parent, ['10.0.0.0/8'])).toEqual({ ok: false, offending: ['10.0.0.0/8'] });
    expect(resolveChildAllowlist(parent, ['0.0.0.0/0', '10.0.1.0/24'])).toEqual({ ok: false, offending: ['0.0.0.0/0'] });
    expect(resolveChildAllowlist(parent, ['192.0.2.1/32'])).toEqual({ ok: false, offending: ['192.0.2.1/32'] });
  });

  it('a damaged parent list still confines the child (it matches nothing, so nothing can be inside it)', () => {
    expect(resolveChildAllowlist(['garbage'], ['10.0.0.0/8'])).toEqual({ ok: false, offending: ['10.0.0.0/8'] });
    expect(resolveChildAllowlist(['garbage'], null)).toEqual({ ok: true, ranges: ['garbage'] });
  });
});
