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
    deleteFailed: 'Silme başarısız',
  },
  storage: {
    thisServerDisk: 'Bu sunucunun diski',
    thisServerDiskHint: 'Dosyalar bu sunucuda kalır ve replikalar arasında paylaşılmaz.',
    // Depolama sağlayıcısı dosyaları nerede tuttuğunu söylemiyor (ayarları bir bucket ya da container belirtmiyor).
    unknown: 'Bilinmiyor',
    unknownHint: 'Sağlayıcı dosyaları nerede tuttuğunu henüz söylemiyor. Ayarlarına bakın.',
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
    previewTooLarge: 'Bu dosya önizlemek için çok büyük. Bunun yerine indirin.',
    conversionUnsupported: 'Bu dosya türü Markdown’a dönüştürülemez.',
    markdownUnavailable: 'Bu dosyanın Markdown kopyası yok.',
    prefixLocked: 'Bucket’ta dosya varken prefix değiştirilemez.',
    bucketInactive: 'Bu bucket devre dışı. Değişiklik yapmak için etkinleştirin.',
    bucketDeleting: 'Bu bucket siliniyor; değiştirilemez.',
    bucketNotEmpty: 'Bu bucket’ta hâlâ dosya var.',
    duplicateKey: 'Bu anahtara sahip bir bucket zaten var.',
    providerInactive: 'Bu bucket’ın depolama sağlayıcısı devre dışı.',
    providerMissing: 'Bu bucket’ın depolama sağlayıcısı artık yok.',
    providerUnassigned: 'Bu bucket’ın depolama sağlayıcısı bu projeye atanmamış.',
    providerInvalid: 'Bu bucket’ın sağlayıcısı bir dosya depolama sağlayıcısı değil.',
    bucketNotFound: 'Bu bucket yok ya da silinmiş.',
    fileNotFound: 'Bu dosya artık yok.',
    readFailed: 'Dosya okunamadı. Hâlâ var olduğundan emin olup yeniden deneyin.',
    objectTooLarge: 'Dosya, sunucunun bir seferde okuyabileceğinden büyük; indirilemez ve önizlenemez.',
    invalidContentType: 'Bu yüklemenin dosya türü geçerli değil.',
    importInProgress: 'Bu bucket için bir içe aktarma zaten çalışıyor. Bitmesini bekleyin.',
    queueUnavailable: 'Arka plan kuyruğu şu anda kullanılamıyor. Biraz sonra yeniden deneyin.',
    storageUnavailable: 'Depolama sağlayıcısı geçici olarak kullanılamıyor. Biraz sonra yeniden deneyin.',
    storageTimeout: 'Depolama sağlayıcısı zamanında yanıt vermedi. Biraz sonra yeniden deneyin.',
    // Aşağıdaki iki cümle sunucunun kendi cümlesidir, okuyanın dilinde.
    storageLocationShared: 'Başka bir bucket bu depolama konumunu kullanıyor.',
    storageLocationSharedImport: 'Başka bir bucket bu depolama konumunu kullanıyor, bu yüzden konumdaki nesneler içe aktarılamaz.',
    storageLocationSharedDelete:
      'Başka bir bucket bu depolama konumunu kullanıyor. Bucket’ı dosyaları olmadan silin ya da önce diğer bucket’ı kaldırın.',
  },
};
