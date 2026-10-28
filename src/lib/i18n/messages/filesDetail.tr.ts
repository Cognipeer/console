/**
 * Document Store dosya çekmecesi: Önizleme, Markdown ve Ayrıntılar sekmeleri, eylemler, API kod parçaları.
 * `tr.ts` içinde `files.detail` olarak kayıtlıdır; ortak metinler (dosya türleri, sağlık,
 * API hataları, kopyalama) `filesCommon.tr.ts` içindedir. "Markdown" (sekmenin adı) anahtar
 * değildir: her dilde aynı yazılır, olduğu gibi çizilir.
 */
import type { filesDetailEn } from './filesDetail.en';

export const filesDetailTr: typeof filesDetailEn = {
  tabs: {
    preview: 'Önizleme',
    details: 'Ayrıntılar',
  },
  meta: {
    root: 'Bucket kökü',
    added: 'Eklendi: {when}',
  },
  actions: {
    close: 'Kapat',
    download: 'İndir',
    downloadMarkdown: 'Markdown’ı indir',
    copyKey: 'Anahtarı kopyala',
    keyCopied: 'Anahtar kopyalandı',
    delete: 'Sil…',
    dismiss: 'Gizle',
  },
  state: {
    loading: 'Dosya yükleniyor…',
    notFound: 'Bu dosya artık yok. Silinmiş olabilir.',
    retry: 'Yeniden dene',
  },
  locked: {
    disabled: 'Bu bucket devre dışı; dosyaları görüntülenebilir ve indirilebilir, ancak silinemez ya da dönüştürülemez. Değiştirmek için bucket’ı etkinleştirin.',
    deleting: 'Bu bucket siliniyor; içindeki hiçbir şey değiştirilemez.',
  },
  preview: {
    loading: 'Önizleme yükleniyor…',
    none: 'Bu tür için önizleme yok',
    noneHint: 'Açmak için dosyayı indirin.',
    tooLarge: 'Bu dosya {limit} sınırından büyük olduğu için önizlenmiyor. Açmak için indirin.',
    failed: 'Önizleme yüklenemedi.',
    frameTitle: '{name} önizlemesi',
    textLabel: '{name} dosyasının metni',
    empty: 'Bu dosya boş.',
    truncated: 'İlk {shown} karakter gösteriliyor (toplam {total}). Geri kalanını okumak için dosyayı indirin.',
  },
  markdown: {
    loading: 'Markdown yükleniyor…',
    size: 'Markdown kopyası · {size}',
    pendingHint: 'Dönüştürme arka planda çalışır. Bittiğinde bu sayfa kendiliğinden güncellenir.',
    // O kadar uzun süredir bekliyor ki arka plan işi büyük olasılıkla kayboldu (sunucu yeniden başladı): yenisi başlatılabilir.
    pendingStale:
      'Bu dönüştürme bir süredir tamamlanmadı. Bu sırada sunucu yeniden başlatıldıysa iş kaybolmuş olabilir. Yeniden başlatmak için tekrar dönüştürün.',
    keptCopy: 'Önceki Markdown kopyası hâlâ duruyor.',
    convertAgain: 'Yeniden dönüştür',
    ocrOptions: 'Metin tanıma seçenekleri',
    ocrAgain: 'Metin tanımayla yeniden dönüştür…',
    noneHint: 'Bu dosyanın Markdown kopyası yok.',
    retry: 'Dönüştürmeyi yeniden dene',
    convert: 'Markdown’a dönüştür',
    tooLarge: 'Markdown kopyası {limit} sınırından büyük olduğu için burada gösterilmiyor. Bunun yerine indirin.',
    empty: 'Markdown kopyası boş.',
    copy: 'Markdown’ı kopyala',
    textLabel: '{name} dosyasının Markdown metni',
  },
  details: {
    name: 'Ad',
    key: 'Anahtar',
    copyKey: '{name} dosyasının anahtarını kopyala',
    size: 'Boyut',
    sizeExact: '{size} ({bytes} bayt)',
    contentType: 'İçerik türü',
    checksum: 'Sağlama toplamı',
    checksumSha256: 'Sağlama toplamı (SHA-256)',
    copyChecksum: 'Sağlama toplamını kopyala',
    notRecorded: 'Kaydedilmemiş',
    origin: 'Kaynak',
    originUpload: 'Yükleme',
    originAgent: 'Agent çıktısı',
    originImport: 'Depolamadan içe aktarıldı',
    uploadedBy: 'Yükleyen',
    created: 'Oluşturulma',
    updated: 'Güncellenme',
  },
  api: {
    title: 'Bu dosyayı API ile kullanın',
    hint: 'Bu çağrıları Document Store’a erişimi olan bir API token’ı ile yapın. Dosya anahtarı adresin tek bir parçasıdır; bu yüzden içindeki eğik çizgiler kodlanır.',
    download: 'Dosyayı indir',
    downloadMarkdown: 'Markdown kopyasını indir',
    delete: 'Dosyayı sil',
    copy: 'Kod parçasını kopyala: {what}',
  },
  delete: {
    noun: 'dosya',
    withMarkdown: 'Markdown kopyası da birlikte silinir.',
    doneTitle: 'Dosya silindi',
    doneMessage: '{name} kaldırıldı',
  },
};
