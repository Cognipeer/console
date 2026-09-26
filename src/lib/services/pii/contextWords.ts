/**
 * Per-category context keyword lists used by the confidence pass
 * (`confidence.ts`'s `findContextWord`) to boost a candidate's score when a
 * relevant word appears within ±60 characters.
 *
 * Deliberately flat (not split per language): the risk of a context word
 * from language A accidentally boosting a candidate detected under language
 * B is negligible (they're topically related — "vergi"/"tax" both only ever
 * show up near tax-id-shaped numbers) and a single flat list per category is
 * far simpler to maintain than a `Record<PiiLanguage, string[]>` per entry.
 * A production rollout that finds cross-language noise here can split a
 * specific category's list without touching this module's shape.
 */
export const CONTEXT_WORDS: Record<string, string[]> = {
  email: ['e-posta', 'eposta', 'mail', 'e-mail'],
  tc_kimlik: ['tckn', 't.c.', 'tc kimlik', 'kimlik no', 'kimlik numarası', 'nüfus cüzdanı'],
  tr_vkn: ['vkn', 'vergi no', 'vergi numarası', 'vergi kimlik'],
  tr_plaka: ['plaka', 'plaka no', 'araç plakası'],
  tr_passport: ['pasaport', 'pasaport no', 'passport'],
  tr_sgk: ['sgk', 'sigorta no', 'sigorta sicil'],
  tr_iban: ['iban', 'hesap no', 'banka hesabı'],
  iban: ['iban', 'account number', 'bank account'],
  tr_phone: ['telefon', 'tel', 'gsm', 'cep', 'cep telefonu'],
  phone: ['phone', 'tel', 'mobile', 'call'],
  address_tr: ['adres', 'ikamet', 'oturduğu', 'yaşadığı', 'teslimat adresi'],
  address_en: ['address', 'resides at', 'lives at', 'shipping address'],
  person: ['sayın', 'müşteri', 'ilgili kişi', 'çalışan', 'personel', 'başvuran', 'adına'],
  organization: ['şirket', 'firma', 'işveren', 'kurum', 'şirketi', 'company', 'employer'],
  location: ['adres', 'şehir', 'konum', 'city', 'location', 'ikamet'],
  birthDate: ['date of birth', 'born on', 'dob', 'doğum tarihi', 'd.tarihi', 'doğum günü'],
};
