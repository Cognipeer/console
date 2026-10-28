import type { ocrSettingsEn } from './ocrSettings.en';

/** Turkish twin of `ocrSettings.en.ts`; the type fails the build on a missing or extra key. */
export const ocrSettingsTr: typeof ocrSettingsEn = {
  mode: {
    label: 'Taranmış sayfaları oku (OCR)',
    hint: 'Taranmış PDF ve resimler için metin tanıma. Kapalıyken bugünkü davranış sürer: yalnızca dosyanın zaten içerdiği metin alınır.',
    off: 'Kapalı',
    auto: 'Otomatik (yalnız taranmış sayfalar)',
    always: 'Her sayfa',
    autoHint: 'Metni olan sayfalar olduğu gibi alınır; yalnızca metni olmayan sayfalar okunur.',
    alwaysHint: 'Her sayfa resim olarak okunur. Daha yavaştır ve daha pahalıdır; metin katmanı yanlış olduğunda kullanın.',
  },
  engine: {
    label: 'Motor',
    hint: 'Bu projedeki bir model daha iyi okur ve tabloları korur; yerel motor model gerektirmez ve sunucunun işlemcisinde çalışır.',
    local: 'Yerel motor (CPU, Tesseract)',
    groupOcr: 'OCR modelleri',
    groupVision: 'Görsel LLM’ler',
    loading: 'Modeller yükleniyor…',
    failed: 'Model listesi yüklenemedi.',
    missing: '“{key}” modeli bu projede yok veya belge okuyamıyor. Başka bir motor seçin.',
    placeholder: 'Bir motor seçin',
  },
  languages: {
    label: 'Diller',
    hint: 'Tanıma için ipuçları; tr veya en gibi iki harfli kodlar. Boş bırakılırsa Türkçe ve İngilizce kullanılır.',
    placeholder: 'Dil kodu ekleyin',
    invalid: 'tr, en veya de gibi dil kodları kullanın: “{codes}”.',
  },
  maxPages: {
    label: 'Belge başına en çok sayfa',
    hint: 'Bu sayıdan sonraki sayfalar okunmaz. Boş bırakılırsa sunucunun sınırı geçerlidir.',
    placeholder: 'Sunucu varsayılanı',
  },
  images: {
    label: 'Resimleri de oku',
    hint: 'Word ve PowerPoint dosyalarındaki resimlerin ve resim dosyalarının içindeki metni okur.',
  },
  summary: {
    off: 'Kapalı',
    auto: 'Otomatik',
    always: 'Her sayfa',
    local: 'Yerel motor',
    images: 'resimlerle',
  },
  result: {
    pageOne: 'OCR · 1 sayfa',
    pages: 'OCR · {count} sayfa',
    pagesOf: 'OCR · {count}/{total} sayfa',
    images: 'OCR · resimler',
  },
};
