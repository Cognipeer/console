import { describe, it, expect } from 'vitest';
import { detect } from '@/lib/services/pii/detector';

function allEnabled(ids: string[]): Record<string, boolean> {
  return Object.fromEntries(ids.map((id) => [id, true]));
}

describe('tr_vkn', () => {
  // Self-consistency round-trip: the checksum algorithm generates its own
  // check digit for a given 9-digit prefix, so this proves the validator
  // accepts what it itself computes as valid and rejects a mutated digit —
  // WITHOUT relying on an external ground-truth VKN (see categories.ts's
  // doc comment on `validateVkn`: not verified against an official test
  // vector in this session).
  function computeVknCheckDigit(prefix9: string): number {
    const digits = prefix9.split('').map(Number);
    let total = 0;
    for (let i = 0; i < 9; i++) {
      const tmp = (digits[i] + (9 - i)) % 10;
      total += tmp === 0 ? 9 : (() => {
        const v = (tmp * 2 ** (9 - i)) % 9;
        return v === 0 ? 9 : v;
      })();
    }
    return (10 - (total % 10)) % 10;
  }

  it('accepts a number whose check digit the algorithm itself computed, with the "vergi" context word present', () => {
    const prefix = '123456789';
    const vkn = prefix + computeVknCheckDigit(prefix);
    const findings = detect(`Vergi No: ${vkn}`, { categories: allEnabled(['tr_vkn']), languages: ['tr'] });
    const hit = findings.find((f) => f.category === 'tr_vkn' && f.value === vkn);
    expect(hit).toBeDefined();
    expect(hit!.confidence).toBeGreaterThan(0.5); // low base score alone would not clear this — context boost did
  });

  it('rejects a 10-digit run whose last digit does not match the checksum', () => {
    const prefix = '123456789';
    const correct = computeVknCheckDigit(prefix);
    const wrong = (correct + 1) % 10;
    const findings = detect(`Vergi No: ${prefix}${wrong}`, { categories: allEnabled(['tr_vkn']), languages: ['tr'] });
    expect(findings.filter((f) => f.category === 'tr_vkn')).toHaveLength(0);
  });

  it('has a low confidence with no context word nearby (still detected, not filtered by default)', () => {
    const prefix = '123456789';
    const vkn = prefix + computeVknCheckDigit(prefix);
    const findings = detect(`sipariş numarası ${vkn} işlendi`, { categories: allEnabled(['tr_vkn']), languages: ['tr'] });
    const hit = findings.find((f) => f.category === 'tr_vkn');
    expect(hit).toBeDefined();
    expect(hit!.confidence).toBeLessThan(0.5);
  });
});

describe('tr_plaka', () => {
  it('detects a standard Turkish plate', () => {
    const findings = detect('Aracın plakası 34 ABC 123.', { categories: allEnabled(['tr_plaka']), languages: ['tr'] });
    expect(findings.map((f) => f.value)).toContain('34 ABC 123');
  });

  it('does not match an out-of-range province code (82+)', () => {
    const findings = detect('Kod 99 ABC 1234 geçersiz.', { categories: allEnabled(['tr_plaka']), languages: ['tr'] });
    expect(findings).toHaveLength(0);
  });
});

describe('tr_passport', () => {
  it('detects the current-format U + 8 digit passport number', () => {
    const findings = detect('Pasaport no: U12345678', { categories: allEnabled(['tr_passport']), languages: ['tr'] });
    expect(findings.map((f) => f.value)).toContain('U12345678');
    expect(findings[0].confidence).toBeGreaterThan(0.5); // "pasaport" context boosted it
  });
});

describe('tr_phone — broadened BTK numbering plan', () => {
  it('still detects mobile numbers (pre-existing behaviour)', () => {
    const findings = detect('Cep: 0532 123 45 67', { categories: allEnabled(['tr_phone']), languages: ['tr'] });
    expect(findings).toHaveLength(1);
  });

  it('detects a landline number with a 3-digit area code (0312 = Ankara)', () => {
    const findings = detect('Sabit hat: 0312 123 45 67', { categories: allEnabled(['tr_phone']), languages: ['tr'] });
    expect(findings).toHaveLength(1);
  });

  it('detects a 444 short code', () => {
    const findings = detect('Bizi 444 1 444 numaralı hattan arayın.', { categories: allEnabled(['tr_phone']), languages: ['tr'] });
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings.some((f) => f.value.replace(/\s/g, '').includes('4441444'))).toBe(true);
  });

  it('detects a non-geographic 0850 number', () => {
    const findings = detect('Çağrı merkezi: 0850 123 45 67', { categories: allEnabled(['tr_phone']), languages: ['tr'] });
    expect(findings).toHaveLength(1);
  });
});

describe('address_tr', () => {
  it('detects a neighbourhood + building number', () => {
    const findings = detect(
      'Kızılay Mahallesi Atatürk Caddesi No:12 Daire:4 adresine gönderin.',
      { categories: allEnabled(['address_tr']), languages: ['tr'] },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].value).toContain('Kızılay Mahallesi');
    expect(findings[0].value).toContain('No:12');
  });

  it('does not fire on a sentence that merely mentions a neighbourhood with no building number', () => {
    const findings = detect(
      'Kızılay Mahallesi çok kalabalıktı bugün, hiç sakin değildi.',
      { categories: allEnabled(['address_tr']), languages: ['tr'] },
    );
    expect(findings).toHaveLength(0);
  });
});

describe('birthDate — now calendar-validated', () => {
  it('accepts a real date with dot separators (the Turkish convention)', () => {
    const findings = detect('Doğum tarihi: 15.06.1990', { categories: allEnabled(['birthDate']) });
    expect(findings.map((f) => f.value)).toContain('15.06.1990');
  });

  it('rejects a calendar-impossible date (31st of February)', () => {
    const findings = detect('Tarih: 31.02.2024 olarak girildi.', { categories: allEnabled(['birthDate']) });
    expect(findings).toHaveLength(0);
  });

  it('rejects Feb 29 on a non-leap year but accepts it on a leap year', () => {
    expect(detect('29.02.2023', { categories: allEnabled(['birthDate']) })).toHaveLength(0);
    expect(detect('29.02.2024', { categories: allEnabled(['birthDate']) })).toHaveLength(1);
  });
});

describe('finding.confidence is additive — legacy categories still get a value but findings are unfiltered by default', () => {
  it('email keeps its exact pre-v2 behaviour (found, with a new confidence field attached)', () => {
    const findings = detect('contact me at a@b.com', { categories: allEnabled(['email']) });
    expect(findings).toHaveLength(1);
    expect(findings[0].value).toBe('a@b.com');
    expect(typeof findings[0].confidence).toBe('number');
    expect(findings[0].detector).toBe('pattern');
  });
});
