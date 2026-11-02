import type { managedToolsEn } from './managedTools.en';

/** Bağlayıcının yönettiği araçlar. Anahtarlar `managedTools.en.ts` ile aynıdır. */
export const managedToolsTr: typeof managedToolsEn = {
  badge: 'Bağlayıcı',
  source: 'Kaynak',
  manual: 'Elle',
  noticeTitle: 'Bağlayıcılar tarafından yönetiliyor',
  noticeBody:
    'Bu aracın uç noktası, kimlik doğrulaması ve aksiyonları bağlayıcısından gelir; bu yüzden burada salt okunurdur. Değişiklikleri bağlayıcıdan yapın.',
  openConnector: 'Bağlayıcıyı aç',
  noActions: 'Henüz aksiyon yok. Araçları bağlayıcıdan eşitleyin.',
  native: 'Yerel',
  nativeCall: 'Yerel (bağlayıcı aksiyonu)',
};
