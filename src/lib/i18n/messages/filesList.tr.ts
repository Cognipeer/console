/**
 * Document Store bucket listesi sayfası: kutucuklar, filtreler, tablo, boş ve hata durumları.
 * `tr.ts` içinde `files.list` olarak kayıtlıdır; ortak metinler (dosya türleri, sağlık,
 * API hataları, kopyalama) `filesCommon.tr.ts` içindedir.
 */
import type { filesListEn } from './filesList.en';

export const filesListTr: typeof filesListEn = {
  eyebrow: 'Veri · Dosyalar',
  title: 'Doküman Deposu',
  subtitle: 'Ajanlar, bilgi kaynakları ve API için dosyaları tutan bucket’lar.',
  actions: {
    docs: 'Dokümantasyon',
    create: 'Bucket oluştur',
    menuFor: '{name} için işlemler',
    open: 'Bucket’ı aç',
    settings: 'Bucket ayarları',
    enable: 'Etkinleştir',
    disable: 'Devre dışı bırak',
    delete: 'Bucket’ı sil…',
  },
  tiles: {
    buckets: 'Bucket',
    active: 'Aktif',
    disabled: 'Devre dışı',
    files: 'Saklanan dosya',
    filesSize: 'tüm bucket’larda {size}',
  },
  filters: {
    search: 'Bucket’ları ad, anahtar veya açıklamaya göre ara…',
    providerLabel: 'Sağlayıcıya göre filtrele',
    allProviders: 'Tüm sağlayıcılar',
    statusLabel: 'Duruma göre filtrele',
    anyStatus: 'Tüm durumlar',
    clear: 'Filtreleri temizle',
  },
  columns: {
    bucket: 'Bucket adı',
    provider: 'Sağlayıcı',
    files: 'Dosya',
    size: 'Boyut',
    status: 'Durum',
    updated: 'Güncellendi',
    actions: 'İşlemler',
  },
  provider: {
    unavailable: 'Sağlayıcı kullanılamıyor',
  },
  footer: '{total} bucket’tan {shown} tanesi gösteriliyor',
  toggle: {
    enabledTitle: 'Bucket etkinleştirildi',
    enabledMessage: '{name} yeniden yükleme kabul ediyor.',
    disabledTitle: 'Bucket devre dışı bırakıldı',
    disabledMessage: '{name} dosyalarını okunabilir tutar, yeni bir şey kabul etmez.',
  },
  error: {
    title: 'Bucket’lar yüklenemedi',
    status: 'Sunucu {status} yanıtı verdi. Bucket’larınızda değişiklik yapılmadı.',
    retry: 'Yeniden dene',
    refreshTitle: 'Liste yenilenemedi',
    staleNote: 'Daha önce yüklenen bucket’lar gösteriliyor.',
  },
  empty: {
    title: 'Henüz bucket yok',
    description: 'Ajanlar, bilgi kaynakları ve API için dosya saklamaya başlamak üzere ilk bucket’ınızı oluşturun.',
    filteredTitle: 'Eşleşen bucket yok',
    filteredDescription: 'Belirlediğiniz arama ve filtrelere uyan bir şey yok. Bunları değiştirin ya da tüm bucket’ları görmek için temizleyin.',
  },
  noProvider: {
    title: 'Henüz dosya sağlayıcısı yok',
    description:
      'Bir bucket dosyalarını bir sağlayıcıda saklar: S3, S3 uyumlu bir depo, Azure Blob, MongoDB GridFS ya da bu sunucunun diski. Önce bir tane ekleyin.',
    add: 'Dosya sağlayıcısı ekle',
    askAdmin: 'Bir yöneticiden dosya sağlayıcısı eklemesini isteyin, sonra ilk bucket’ınızı oluşturun.',
  },
  noUsableProvider: {
    title: 'Hiçbir dosya sağlayıcısı bucket kabul edemiyor',
    description: 'Tüm dosya sağlayıcıları kapalı olduğu için bucket oluşturulamıyor. Birini açın ya da yenisini ekleyin.',
    manage: 'Dosya sağlayıcılarını yönet',
    askAdmin: 'Bir yöneticiden bir dosya sağlayıcısını açmasını isteyin, sonra ilk bucket’ınızı oluşturun.',
  },
};
