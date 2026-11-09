import type { platformStorageEn } from './platformStorage.en';

/** Turkish twin of `platformStorage.en.ts`; the type fails the build on a missing or extra key. */
export const platformStorageTr: typeof platformStorageEn = {
  badge: 'Platform',
  note: 'Platform tarafından sağlanır ve plan depolamanıza sayılır. Burada düzenlenemez, test edilemez veya silinemez.',
  vector: {
    storedSize: 'Saklanan boyut',
    storedSizeHint: 'Bu indeksin vektörlerinin kapladığı yerin tahminidir. Plan depolamanıza sayılır.',
    alwaysCreate: 'Bu sağlayıcıdaki indeks her zaman yeni oluşturulur. Mevcut bir indeksi bağlamak kullanılamaz.',
  },
  files: {
    providerHint: 'Dosyalar platform tarafından saklanır ve plan depolamanıza sayılır.',
  },
};
