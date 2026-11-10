import type { usageLimitsEn } from './usageLimits.en';

/**
 * `usageLimits` ad alanı: bir plan limiti bir işlemi reddettiğinde veya geciktirdiğinde görülen
 * metinler. İngilizce karşılığı usageLimits.en.ts dosyasındadır; anahtarlar ve {yer tutucular}
 * aynı kalmalıdır.
 */
export const usageLimitsTr: typeof usageLimitsEn = {
  codes: {
    tenant_rate_limited: {
      title: 'İstek sınırına ulaşıldı',
      message: 'Çalışma alanınız istek sınırına ulaştı. {seconds} saniye sonra tekrar deneyin.',
      messageNoWait: 'Çalışma alanınız istek sınırına ulaştı. Kısa süre sonra tekrar deneyin.',
    },
    tenant_concurrency_limited: {
      title: 'Boş yer yok',
      message: 'Çalışma alanınızda planın izin verdiği kadar {dimension} zaten çalışıyor ({limit}). {seconds} saniye sonra tekrar deneyin.',
      messageNoWait: 'Çalışma alanınızda planın izin verdiği kadar {dimension} zaten çalışıyor ({limit}). Kısa süre sonra tekrar deneyin.',
    },
    monthly_allowance_exhausted: {
      title: 'Aylık hak kullanıldı',
      message: 'Çalışma alanınız {dimension} için aylık hakkını kullandı ({limit} içinden {used}). Hak {date} tarihinde yenilenir.',
      messageNoDate: 'Çalışma alanınız {dimension} için aylık hakkını kullandı ({limit} içinden {used}). Hak gelecek ay yenilenir.',
    },
    storage_quota_exceeded: {
      title: 'Depolama dolu',
      message: 'Bu işlem çalışma alanınızı depolama hakkının üzerine çıkarır. Bazı dosyaları veya vektörleri silin ve tekrar deneyin.',
    },
    seat_limit_reached: {
      title: 'Koltuk sınırına ulaşıldı',
      message: 'Çalışma alanınız tüm koltuklarını kullandı ({limit}). Yeni bir kişi eklemeden önce bir koltuğu boşaltın.',
    },
    insufficient_credits: {
      title: 'Yeterli kredi yok',
      message: 'Çalışma alanınızda bu istek için yeterli kredi bulunmuyor.',
    },
    credits_unavailable: {
      title: 'Krediler okunamıyor',
      message: 'Kredi bakiyesi şu anda okunamıyor, bu nedenle yönetilen hizmetler duraklatıldı. {seconds} saniye sonra tekrar deneyin.',
      messageNoWait: 'Kredi bakiyesi şu anda okunamıyor, bu nedenle yönetilen hizmetler duraklatıldı. Kısa süre sonra tekrar deneyin.',
    },
    context_over_credit_cap: {
      title: 'İstek çok büyük',
      message: 'Bu istek, yönetilen bir model çağrısının alabileceğinden büyük. İsteği kısaltıp tekrar deneyin.',
    },
    plan_feature_unavailable: {
      title: 'Kullanılamıyor',
      message: 'Bu özellik çalışma alanınızın planına dahil değil.',
    },
  },
  dimensions: {
    apiRpm: 'API istekleri',
    agent: 'ajan oturumu',
    flow: 'akış',
    job: 'iş',
    crawler: 'crawler işi',
    browser: 'tarayıcı oturumu',
    realtime: 'gerçek zamanlı oturum',
    sandbox: 'sandbox',
    searches: 'arama',
    flowRuns: 'akış çalıştırması',
    crawlerPages: 'tarayıcı sayfası',
    sandboxHours: 'sandbox saati',
    sandboxSeconds: 'sandbox saati',
    unknown: 'öğe',
  },
  queued: 'Boş bir ajan yeri bekleniyor (en fazla {seconds} sn).',
  adminLink: 'Planı ve kullanımı görüntüleyin',
  nonAdminHint: 'Bir çalışma alanı yöneticisine danışın',
};
