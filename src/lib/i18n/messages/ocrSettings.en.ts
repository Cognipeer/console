/**
 * The shared OCR settings fields (`components/extraction/OcrSettingsFields`) used by Files, agent attachments,
 * knowledge bases and crawlers. Registered in `en.ts` as `ocrSettings`; the twin is `ocrSettings.tr.ts`.
 */
export const ocrSettingsEn = {
  mode: {
    label: 'Read scanned pages (OCR)',
    hint: 'Text recognition for scanned PDFs and pictures. Off keeps today’s behaviour: only the text a file already contains.',
    off: 'Off',
    auto: 'Auto (scanned pages only)',
    always: 'Every page',
    autoHint: 'Pages that already have text are kept as they are; only pages without text are read.',
    alwaysHint: 'Every page is read as a picture. Slower and costs more; use it when the text layer is wrong.',
  },
  engine: {
    label: 'Engine',
    hint: 'A model of this project reads better and keeps tables; the local engine needs no model and runs on the server’s CPU.',
    local: 'Local engine (CPU, Tesseract)',
    groupOcr: 'OCR models',
    groupVision: 'Vision LLMs',
    loading: 'Loading models…',
    failed: 'The model list could not be loaded.',
    missing: 'The model “{key}” is not in this project or cannot read documents. Choose another engine.',
    placeholder: 'Choose an engine',
  },
  languages: {
    label: 'Languages',
    hint: 'Hints for the recognition, as two-letter codes such as tr or en. Empty uses Turkish and English.',
    placeholder: 'Add a language code',
    invalid: 'Use language codes such as tr, en or de: “{codes}”.',
  },
  maxPages: {
    label: 'Maximum pages per document',
    hint: 'Pages after this number are not read. Empty uses the server’s limit.',
    placeholder: 'Server default',
  },
  images: {
    label: 'Also read images',
    hint: 'Read the text in pictures inside Word and PowerPoint files, and in image files.',
  },
  summary: {
    off: 'Off',
    auto: 'Auto',
    always: 'Every page',
    local: 'Local engine',
    images: 'with images',
  },
  result: {
    pageOne: 'OCR · 1 page',
    pages: 'OCR · {count} pages',
    pagesOf: 'OCR · {count}/{total} pages',
    images: 'OCR · images',
  },
};
