/** `piiProtection.en.ts` in Turkish (same keys, same placeholders). */
export const piiProtectionTr = {
  title: 'PII koruması',
  model: {
    description:
      'Kişisel veri sağlayıcıya hiç ulaşmaz: PII politikasının bulduğu her değer bir token olarak gider, cevap gerçek değerle döner. Bu modele yapılan her çağrıda geçerlidir.',
  },
  agent: {
    description: 'Model token’ları görür; tool’lar, konuşma ve kullanıcı gerçek değerleri görür.',
    inherited: '{model} modeli her çağrıyı zaten {policy} politikasıyla koruyor. Burada seçilen politika bu agent için onun yerine geçer.',
    replaces: 'Bu agent için {model} modelinin {policy} politikasının yerine geçer.',
  },
  policy: {
    label: 'PII politikası',
    hint: 'Neyin aranacağı politikada, PII altında ayarlanır. Kapalıyken metin olduğu gibi gider.',
    placeholder: 'Kapalı',
    loading: 'Politikalar yükleniyor…',
    failed: 'PII politikaları yüklenemedi.',
    none: 'Bu projede henüz PII politikası yok.',
    create: 'PII politikası oluştur',
    new: 'Yeni PII politikası',
    noneReadOnly: 'PII’yi düzenleyebilen biri oluşturmalı.',
    open: 'Politikayı aç',
    missing: '“{key}” politikası artık bu projede yok. Başka bir politika seçilene ya da koruma kapatılana kadar çağrılar hata verir.',
    disabled: 'Bu politika kapalı; yeniden açılana kadar çağrılar korumasız gider.',
    disabledSuffix: 'kapalı',
  },
  limits: {
    media: 'Koruma açıkken görsel, dosya ve ses reddedilir.',
    logs: 'Kullanım loglarında değerler değil token’lar kalır.',
    session: 'Bir değer oturum boyunca hep aynı token’a dönüşür.',
  },
};
