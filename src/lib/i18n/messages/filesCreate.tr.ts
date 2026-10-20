/**
 * Document Store "Bucket oluştur" ekranı: sağlayıcı kartları, ad ve anahtar, prefix, depolama konumu, durum.
 * `tr.ts` içinde `files.create` olarak kayıtlıdır; ortak metinler (dosya türleri, sağlık,
 * API hataları, kopyalama) `filesCommon.tr.ts` içindedir.
 */
import type { filesCreateEn } from './filesCreate.en';

export const filesCreateTr: typeof filesCreateEn = {
  title: 'Bucket oluştur',
  subtitle: 'Doküman Deposu',
  optional: 'isteğe bağlı',
  provider: {
    title: 'Depolama sağlayıcısı',
    description: 'Bu bucket’ın dosyalarının nerede tutulacağını seçin. Yalnızca açık olan sağlayıcılar seçilebilir.',
    groupLabel: 'Depolama sağlayıcısı seçimi',
    localDisk: 'Dosyalar bu sunucunun diskinde kalır, replikalar arasında paylaşılmaz.',
    notActive: 'Bu sağlayıcı aktif olmadığı için üzerinde bucket oluşturulamaz.',
    add: 'Dosya sağlayıcısı ekle',
    refresh: 'Sağlayıcıları yenile',
    retry: 'Yeniden dene',
    askAdmin: 'Bir yöneticiden dosya sağlayıcısı eklemesini isteyin.',
    noneTitle: 'Henüz dosya sağlayıcısı yok',
    noneDescription:
      'Bir bucket dosyalarını bir sağlayıcıda saklar: S3, S3 uyumlu bir depo, Azure Blob, MongoDB GridFS ya da bu sunucunun diski.',
    noneUsable: 'Bu sağlayıcıların hiçbiri şu anda bucket kabul edemiyor. Sağlayıcılar bölümünden birini açın ya da yenisini ekleyin.',
    noneUsableAskAdmin: 'Bu sağlayıcıların hiçbiri şu anda bucket kabul edemiyor. Bir yöneticiden birini açmasını isteyin.',
    loadFailedTitle: 'Sağlayıcılar yüklenemedi',
    localWarningTitle: 'Dosyalar bu sunucunun diskinde kalır',
    localWarning:
      'Replikalar arasında paylaşılmazlar; birden fazla replikalı bir kurulum hepsini göremez. Birden çok sunucunun ulaşması gereken dosyalar için bir nesne deposu seçin.',
  },
  bucket: {
    title: 'Bucket bilgileri',
    description: 'Bucket’ın konsolda, API’de ve SDK’da nasıl adlandırılacağı.',
    nameLabel: 'Ad',
    namePlaceholder: 'Pazarlama görselleri',
    keyLabel: 'Anahtar',
    keyPlaceholder: 'pazarlama-gorselleri',
    keyHint: 'Addan üretilir, dilerseniz düzenleyebilirsiniz. Küçük harf, rakam, tire ve alt çizgi kullanılır. Sonradan değiştirilemez.',
    descriptionLabel: 'Açıklama',
    descriptionPlaceholder: 'Burada ne tutuluyor, kimler için',
  },
  location: {
    title: 'Konum',
    description: 'Bu bucket’ın dosyalarının sağlayıcı içinde nerede tutulacağı.',
    prefixLabel: 'Sağlayıcı içindeki prefix',
    prefixHint: 'Boş bırakırsanız anahtar kullanılır. Bucket’ta dosya varken değiştirilemez.',
    previewTitle: 'Dosyalar şurada saklanacak',
    fileKey: '<dosya anahtarı>',
    choose: 'Dosyaların nerede saklanacağını görmek için bir sağlayıcı seçin.',
    unknown: 'Bu sağlayıcı dosyaları nerede tuttuğunu bildirmiyor.',
  },
  status: {
    title: 'Durum',
    description: 'Devre dışı bir bucket dosyalarını okunabilir tutar, yeni bir şey kabul etmez.',
    activeLabel: 'Aktif',
    activeDescription: 'Bu bucket’ın yükleme kabul etmesine izin verin. Bucket’ı devre dışı oluşturmak için kapatın.',
  },
  summary: {
    bucketTitle: 'Bu bucket',
    provider: 'Sağlayıcı',
    key: 'Anahtar',
    prefix: 'Prefix yolu',
    status: 'Durum',
    readyTitle: 'Oluşturmaya hazır',
    providerChosen: 'Depolama sağlayıcısı seçildi',
    nameAndKey: 'Ad ve anahtar',
    prefixValid: 'Prefix geçerli',
    ready: '{total} adımdan {done} tanesi hazır',
  },
  actions: {
    create: 'Bucket oluştur',
  },
  errors: {
    title: 'Bucket oluşturulamadı',
    generic: 'Bucket oluşturulamadı. Yeniden deneyin.',
    nameRequired: 'Bucket’a bir ad verin.',
    nameTooLong: 'Ad en fazla {max} karakter olabilir.',
    descriptionTooLong: 'Açıklama en fazla {max} karakter olabilir.',
    keyRequired: 'Bucket’ın bir anahtarı olmalı.',
    keyInvalid: 'Yalnızca küçük harf, rakam, tire ve alt çizgi kullanın.',
    keyTooLong: 'Anahtar en fazla {max} karakter olabilir.',
    keyTaken: '“{key}” anahtarlı bir bucket zaten var. Başka bir anahtar seçin.',
    prefixInvalid: 'Prefix “..”, ters eğik çizgi veya denetim karakteri içeremez.',
    prefixTooLong: 'Prefix en fazla {max} karakter olabilir.',
    providerRequired: 'Bir depolama sağlayıcısı seçin.',
    providerUnusable: 'Bu sağlayıcı artık bucket kabul edemiyor. Başka birini seçin.',
  },
  success: {
    title: 'Bucket oluşturuldu',
    message: '{name} dosyalar için hazır.',
  },
};
