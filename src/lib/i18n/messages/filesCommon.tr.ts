/**
 * Document Store (Dosyalar): tüm Files ekranlarının ortak metinleri — dosya
 * türleri, Markdown dönüşüm durumları, sağlayıcı sağlığı, bucket durumu, dosyaların
 * nerede durduğu, kopyalama, salt okunur ipucu ve API hata mesajları. `tr.ts`
 * içinde `files.common` olarak kayıtlıdır; ekranlara özel metinler kardeş
 * modüllerde durur (`filesList`, `filesCreate`, `filesBucket`, `filesUpload`,
 * `filesDetail`).
 *
 * "PDF" anahtar değildir: her dilde aynı yazılır, olduğu gibi çizilir.
 */
import type { filesCommonEn } from './filesCommon.en';

export const filesCommonTr: typeof filesCommonEn = {
  kind: {
    all: 'Tüm türler',
    image: 'Görsel',
    text: 'Metin',
    office: 'Office belgesi',
    other: 'Diğer',
  },
  markdown: {
    ready: 'Hazır',
    pending: 'Dönüştürülüyor…',
    failed: 'Başarısız',
    skipped: 'Dönüştürülmedi',
    failureTitle: 'Markdown dönüşümü başarısız oldu',
    failureUnknown: 'Bir neden kaydedilmedi.',
  },
  health: {
    ok: 'Bağlı',
    failed: 'Test başarısız',
    untested: 'Henüz test edilmedi',
    builtin: 'Yerleşik',
    inactive: 'Devre dışı',
    builtinNote: 'Test gerekmiyor',
    testedAt: '{when} test edildi',
    openProvider: 'Sağlayıcıyı aç',
    failedReason: 'Son bağlantı testi başarısız oldu.',
    inactiveReason: 'Bu sağlayıcı devre dışı olduğu için bucket’ları kullanılamıyor.',
    untestedReason: 'Bağlantı henüz test edilmedi.',
  },
  bucketStatus: {
    active: 'Aktif',
    disabled: 'Devre dışı',
    deleting: 'Siliniyor…',
  },
  storage: {
    thisServerDisk: 'Bu sunucunun diski',
    thisServerDiskHint: 'Dosyalar bu sunucuda kalır ve replikalar arasında paylaşılmaz.',
    copy: 'Depolama konumunu kopyala',
  },
  copy: {
    copy: 'Kopyala',
    copied: 'Kopyalandı',
  },
  readOnly: {
    hint: 'Document Store’a salt okunur erişiminiz var; dosyaları değiştiren işlemler gizlendi.',
  },
  errors: {
    generic: 'Bir şeyler ters gitti. Yeniden deneyin.',
    network: 'Sunucuya ulaşılamadı. Bağlantınızı kontrol edip yeniden deneyin.',
    forbidden: 'Bu işlem için yetkiniz yok.',
    notFound: 'Bu öğe artık yok.',
    providerAccess: 'Bu bağlantıyı test etmek için sağlayıcı erişimine ihtiyacınız var.',
    fileTooLarge: 'Dosya yükleme sınırından büyük.',
    archiveTooLarge: 'Seçilen dosyalar birlikte indirilemeyecek kadar büyük. Daha az dosya seçin.',
    previewUnsupported: 'Bu dosya türü için önizleme yok.',
    conversionUnsupported: 'Bu dosya türü Markdown’a dönüştürülemez.',
    prefixLocked: 'Bucket’ta dosya varken prefix değiştirilemez.',
    bucketInactive: 'Bu bucket devre dışı. Değişiklik yapmak için etkinleştirin.',
    providerInactive: 'Bu bucket’ın depolama sağlayıcısı devre dışı.',
    bucketNotFound: 'Bu bucket yok ya da silinmiş.',
    readFailed: 'Dosya okunamadı. Hâlâ var olduğundan emin olup yeniden deneyin.',
    objectTooLarge: 'Dosya, sunucunun bir seferde okuyabileceğinden büyük; indirilemez ve önizlenemez.',
    storageLocationShared: 'Başka bir bucket bu depolama konumunu kullanıyor.',
    storageLocationSharedImport: 'Başka bir bucket bu depolama konumunu kullanıyor, bu yüzden konumdaki nesneler içe aktarılamaz.',
    storageLocationSharedDelete:
      'Başka bir bucket bu depolama konumunu kullanıyor, bu yüzden bu bucket dosyalarıyla birlikte silinemez. Önce diğer bucket’ı silin.',
  },
};
