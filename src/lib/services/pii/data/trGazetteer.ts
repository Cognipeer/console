/**
 * Turkish gazetteer — STARTER seed lists for the L2 dictionary pass
 * (`../dictionary.ts`).
 *
 * These are deliberately small, hand-compiled lists, not the ~10k/20k-entry
 * production lists the plan (`internal-notes/pii-v2-nlp-ve-asset-registry-plani.md`,
 * Faz 1) puts behind the GitHub asset registry. They exist so the dictionary
 * pass has something real to match against for local testing; a production
 * rollout replaces `TR_FIRST_NAMES`/`TR_SURNAMES`/`TR_DISTRICTS` with the
 * registry-downloaded lists without touching the matching logic below.
 *
 * `TR_PROVINCES` is the one complete list here: Turkey's 81 provinces are a
 * fixed, official, factual enumeration (also used by `tr_plaka`'s validator),
 * so there is no "seed vs. full" distinction for it.
 */

/** All 81 Turkish provinces (il), official names. */
export const TR_PROVINCES: string[] = [
  'Adana', 'Adıyaman', 'Afyonkarahisar', 'Ağrı', 'Amasya', 'Ankara', 'Antalya', 'Artvin',
  'Aydın', 'Balıkesir', 'Bilecik', 'Bingöl', 'Bitlis', 'Bolu', 'Burdur', 'Bursa',
  'Çanakkale', 'Çankırı', 'Çorum', 'Denizli', 'Diyarbakır', 'Edirne', 'Elazığ', 'Erzincan',
  'Erzurum', 'Eskişehir', 'Gaziantep', 'Giresun', 'Gümüşhane', 'Hakkari', 'Hatay', 'Isparta',
  'Mersin', 'İstanbul', 'İzmir', 'Kars', 'Kastamonu', 'Kayseri', 'Kırklareli', 'Kırşehir',
  'Kocaeli', 'Konya', 'Kütahya', 'Malatya', 'Manisa', 'Kahramanmaraş', 'Mardin', 'Muğla',
  'Muş', 'Nevşehir', 'Niğde', 'Ordu', 'Rize', 'Sakarya', 'Samsun', 'Siirt', 'Sinop', 'Sivas',
  'Tekirdağ', 'Tokat', 'Trabzon', 'Tunceli', 'Şanlıurfa', 'Uşak', 'Van', 'Yozgat', 'Zonguldak',
  'Aksaray', 'Bayburt', 'Karaman', 'Kırıkkale', 'Batman', 'Şırnak', 'Bartın', 'Ardahan',
  'Iğdır', 'Yalova', 'Karabük', 'Kilis', 'Osmaniye', 'Düzce',
];

/**
 * A STARTER subset of districts (ilçe) for a handful of large cities, used
 * only to boost `address_tr` confidence when one appears near a street/
 * neighbourhood keyword. Full 81-il × ~970-ilçe coverage is a registry asset
 * (Faz 1), not a hand-maintained list.
 */
export const TR_DISTRICTS_SEED: string[] = [
  // İstanbul
  'Kadıköy', 'Üsküdar', 'Beşiktaş', 'Şişli', 'Beyoğlu', 'Bakırköy', 'Maltepe', 'Ataşehir',
  'Kartal', 'Pendik', 'Fatih', 'Bahçelievler', 'Beylikdüzü', 'Esenyurt', 'Sarıyer', 'Sancaktepe',
  // Ankara
  'Çankaya', 'Keçiören', 'Yenimahalle', 'Mamak', 'Etimesgut', 'Sincan', 'Gölbaşı', 'Pursaklar',
  // İzmir
  'Konak', 'Bornova', 'Karşıyaka', 'Buca', 'Bayraklı', 'Çiğli', 'Gaziemir', 'Karabağlar',
  // Diğer büyük şehirler (starter)
  'Nilüfer', 'Osmangazi', 'Muratpaşa', 'Kepez', 'Selçuklu', 'Meram', 'Şahinbey', 'Talas',
];

/**
 * Very common Turkish given names — a STARTER seed (~90 entries), not an
 * exhaustive list. Deliberately mixes clearly-gendered and unisex names.
 * Ambiguous/common-word names (e.g. "Deniz", "Can") are still included: the
 * dictionary pass alone gives them a LOW base score (see `dictionary.ts`),
 * so a bare hit doesn't clear `minConfidence` without a title/surname
 * neighbour or an NER agreement.
 */
export const TR_FIRST_NAMES: string[] = [
  'Ahmet', 'Mehmet', 'Mustafa', 'Ali', 'Hüseyin', 'Hasan', 'İbrahim', 'Osman', 'Yusuf', 'Murat',
  'Ömer', 'Emre', 'Burak', 'Kemal', 'Serkan', 'Volkan', 'Erhan', 'Cem', 'Barış', 'Onur',
  'Tolga', 'Uğur', 'Kaan', 'Berk', 'Efe', 'Arda', 'Emir', 'Yiğit', 'Selim', 'Fatih',
  'Ayşe', 'Fatma', 'Emine', 'Hatice', 'Zeynep', 'Elif', 'Meryem', 'Sena', 'Büşra', 'Merve',
  'Esra', 'Gamze', 'Aylin', 'Pınar', 'Selin', 'Ebru', 'Derya', 'Gül', 'Nur', 'Yasemin',
  'Ceren', 'Duygu', 'İrem', 'Melis', 'Özge', 'Seda', 'Sevgi', 'Tuğba', 'Zehra', 'Nazlı',
  'Deniz', 'Can', 'Cem', 'Ege', 'Kaya', 'Barış', 'Umut', 'Gökhan', 'Serdar', 'Tarık',
  'İsmail', 'Halil', 'Recep', 'Bekir', 'Turgut', 'Nihat', 'Selçuk', 'Cengiz', 'Erdem', 'Koray',
  'Hakan', 'Tuncay', 'Şükrü', 'Necati', 'Adem', 'Bilal', 'Furkan', 'Enes', 'Metin', 'Levent',
];

/**
 * Common Turkish surnames — a STARTER seed (~70 entries).
 */
export const TR_SURNAMES: string[] = [
  'Yılmaz', 'Kaya', 'Demir', 'Şahin', 'Çelik', 'Yıldız', 'Yıldırım', 'Öztürk', 'Aydın', 'Özdemir',
  'Arslan', 'Doğan', 'Kılıç', 'Aslan', 'Çetin', 'Kara', 'Koç', 'Kurt', 'Özkan', 'Şimşek',
  'Erdoğan', 'Güneş', 'Aksoy', 'Bulut', 'Yalçın', 'Polat', 'Korkmaz', 'Çakır', 'Türk', 'Avcı',
  'Erdem', 'Aksu', 'Çiftçi', 'Turan', 'Karadeniz', 'Bozkurt', 'Uysal', 'Duman', 'Sarı', 'Aksoy',
  'Ateş', 'Ekinci', 'Güler', 'Tekin', 'Yavuz', 'Yücel', 'Yorulmaz', 'Aydemir', 'Aktaş', 'Aygün',
  'Bayram', 'Bilgin', 'Cengiz', 'Erol', 'Gündoğdu', 'Kaplan', 'Karaca', 'Keskin', 'Onur', 'Özcan',
  'Öztekin', 'Şen', 'Taş', 'Toprak', 'Uçar', 'Ünal', 'Yaman', 'Yeşil', 'Zengin', 'Özgür',
];

/** Honorifics/titles that precede a name — strong person-context signal. */
export const TR_TITLES: string[] = [
  'Sayın', 'Bay', 'Bayan', 'Sn.', 'Dr.', 'Doç.', 'Doç. Dr.', 'Prof.', 'Prof. Dr.', 'Av.',
  'Müh.', 'Mühendis', 'Öğr.', 'Hemşire', 'Yrd. Doç.',
];

/** Suffixes that follow a name and mark it as an honorific instead ("Bey"/"Hanım"). */
export const TR_NAME_SUFFIX_TITLES: string[] = ['Bey', 'Hanım', 'Hoca', 'Abi', 'Abla'];

/** Legal-entity suffixes — a dictionary hit here plus a capitalized run before it is `organization`, not `person`. */
export const TR_ORG_SUFFIXES: string[] = [
  'A.Ş.', 'AŞ', 'Ltd. Şti.', 'Ltd.Şti.', 'Ltd. Şirketi', 'Şirketi', 'Holding', 'Grup', 'Grubu',
  'Kooperatifi', 'Vakfı', 'Derneği', 'Üniversitesi', 'Belediyesi',
];

/** Turkish possessive/case suffixes stripped before a dictionary lookup (apostrophe optional: "Ahmet'in" and "Ahmetin" both fold to "Ahmet"). Longest first. */
export const TR_NAME_SUFFIXES: string[] = [
  "'nin", "'nın", "'nun", "'nün", "'in", "'ın", "'un", "'ün", "'e", "'a", "'i", "'ı", "'u", "'ü", "'de", "'da", "'te", "'ta", "'den", "'dan", "'ten", "'tan", "'yi", "'yı", "'yu", "'yü", "'ye", "'ya", "'nen", "'nan",
  'nin', 'nın', 'nun', 'nün', 'in', 'ın', 'un', 'ün', 'e', 'a', 'de', 'da', 'te', 'ta',
];
