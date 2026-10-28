/**
 * A crawler stores its OCR option as `markdownOptions.ocr` with an `enabled` flag (the shape it had before OCR
 * models existed); the shared OCR fields edit an `OcrSettings`. These two functions are the way between them, so the
 * Content extraction form can load the stored value, edit it and send it back instead of leaving it out of the save
 * (an update replaces `markdownOptions`, so a value the form does not send is wiped).
 */

import { compactOcr, ocrIsOn, type OcrSettings } from '@/components/extraction/ocrForm';
import type { ICrawler } from '@/lib/database';

export type CrawlerOcr = NonNullable<NonNullable<ICrawler['markdownOptions']>['ocr']>;

/** The stored option as the OCR fields show it. Off, absent and `enabled: false` are all `undefined`. */
export function crawlerOcrToSettings(ocr: CrawlerOcr | null | undefined): OcrSettings | undefined {
  if (!ocr || ocr.enabled !== true) return undefined;
  return compactOcr({
    mode: ocr.mode === 'always' ? 'always' : 'auto',
    ...(ocr.modelKey ? { modelKey: ocr.modelKey } : {}),
    ...(ocr.languages ? { languages: ocr.languages } : {}),
    ...(ocr.maxPages !== undefined ? { maxPages: ocr.maxPages } : {}),
    ...(ocr.images ? { images: true } : {}),
  });
}

/** What the save sends: the option with OCR on, or nothing at all (the crawler then converts files as it always did). */
export function settingsToCrawlerOcr(settings: OcrSettings | null | undefined): CrawlerOcr | undefined {
  const compact = compactOcr(settings);
  if (!compact || !ocrIsOn(compact)) return undefined;
  return {
    enabled: true,
    mode: compact.mode === 'always' ? 'always' : 'auto',
    ...(compact.modelKey ? { modelKey: compact.modelKey } : {}),
    ...(compact.languages ? { languages: compact.languages } : {}),
    ...(compact.maxPages !== undefined ? { maxPages: compact.maxPages } : {}),
    ...(compact.images ? { images: true } : {}),
  };
}
