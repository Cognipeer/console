import { describe, it, expect } from 'vitest';
import { scanDictionary, scanCustomPhrases } from '@/lib/services/pii/dictionary';

describe('scanDictionary — person sequences', () => {
  it('gives a title + first name + surname the highest base score', () => {
    const text = 'Sayın Ahmet Yılmaz bugün ofise geldi.';
    const [c] = scanDictionary(text, ['tr']);
    expect(c.category).toBe('person');
    expect(c.value).toBe('Sayın Ahmet Yılmaz');
    expect(c.baseScore).toBeGreaterThanOrEqual(0.9);
  });

  it('scores a bare first+surname pair lower than the title form, but still meaningfully', () => {
    const text = 'Mehmet Öztürk ile birlikte geldi.';
    const [c] = scanDictionary(text, ['tr']);
    expect(c.category).toBe('person');
    expect(c.value).toBe('Mehmet Öztürk');
    expect(c.baseScore).toBeGreaterThan(0.5);
    expect(c.baseScore).toBeLessThan(0.9);
  });

  it('gives a bare, ambiguous first name a low score and no capitalization means none at all', () => {
    const text = 'Bugün deniz çok dalgalıydı ama Deniz de geldi.';
    const candidates = scanDictionary(text, ['tr']);
    // lowercase "deniz" (the sea) must not be flagged
    const lowerHit = candidates.find((c) => c.value === 'deniz');
    expect(lowerHit).toBeUndefined();
    // capitalized "Deniz" (the name) is flagged, but weakly
    const nameHit = candidates.find((c) => c.value === 'Deniz');
    expect(nameHit).toBeDefined();
    expect(nameHit!.baseScore).toBeLessThan(0.5);
  });

  it('does not merge two people separated by a comma into one entity', () => {
    const text = 'Katılımcılar: Ahmet Yılmaz, Ayşe Kaya.';
    const candidates = scanDictionary(text, ['tr']);
    const people = candidates.filter((c) => c.category === 'person');
    expect(people.map((p) => p.value)).toEqual(['Ahmet Yılmaz', 'Ayşe Kaya']);
  });
});

describe('scanDictionary — organizations', () => {
  it('flags a capitalized run followed by a legal-entity suffix', () => {
    const text = 'Cognipeer Teknoloji A.Ş. ile görüştük.';
    const orgs = scanDictionary(text, ['tr']).filter((c) => c.category === 'organization');
    expect(orgs).toHaveLength(1);
    expect(orgs[0].value).toBe('Cognipeer Teknoloji A.Ş.');
  });
});

describe('scanDictionary — locations', () => {
  it('flags a known province', () => {
    const locs = scanDictionary('Ankara güzel bir şehir.', ['tr']).filter((c) => c.category === 'location');
    expect(locs.map((l) => l.value)).toContain('Ankara');
  });

  it('combines a district/province pair into one span with a higher score than either alone', () => {
    const locs = scanDictionary('Çankaya/Ankara adresine gönderildi.', ['tr']).filter((c) => c.category === 'location');
    expect(locs).toHaveLength(1);
    expect(locs[0].value).toBe('Çankaya/Ankara');
    expect(locs[0].baseScore).toBeGreaterThan(0.55);
  });

  it('does not flag a lowercase common word that happens to match a province name', () => {
    // no Turkish province is a common lowercase word, but this guards the capitalization gate generally
    const locs = scanDictionary('bu bir ankara testi değil, van gölü de değil ama Van öyle.', ['tr'])
      .filter((c) => c.category === 'location');
    expect(locs.map((l) => l.value)).toEqual(['Van']);
  });
});

describe('scanDictionary — language gating', () => {
  it('is a no-op when tr/global are not requested', () => {
    expect(scanDictionary('Sayın Ahmet Yılmaz geldi.', ['en'])).toEqual([]);
  });

  it('defaults to tr when no languages are given', () => {
    expect(scanDictionary('Sayın Ahmet Yılmaz geldi.', undefined).length).toBeGreaterThan(0);
  });
});

describe('scanCustomPhrases', () => {
  it('matches a tenant phrase at a word boundary and reports its category', () => {
    const found = scanCustomPhrases('Proje adı: Falcon Nine, gizli.', [
      { value: 'Falcon Nine', categoryId: 'project_codename', severity: 'high' },
    ]);
    expect(found).toHaveLength(1);
    expect(found[0].category).toBe('project_codename');
    expect(found[0].value).toBe('Falcon Nine');
  });

  it('does not match a phrase glued inside a longer word', () => {
    const found = scanCustomPhrases('Canadaian visitors arrived.', [
      { value: 'can', categoryId: 'x' },
    ]);
    expect(found).toEqual([]);
  });

  it('is case-insensitive', () => {
    const found = scanCustomPhrases('the FALCON NINE project', [
      { value: 'falcon nine', categoryId: 'project_codename' },
    ]);
    expect(found).toHaveLength(1);
  });
});
