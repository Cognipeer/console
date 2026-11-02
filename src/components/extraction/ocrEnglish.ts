import { en } from '@/lib/i18n/messages/en';

/**
 * The OCR strings in English whatever the viewer's language is, for the screens that are written in literal English
 * (the Knowledge Engine and Crawler pages): a section in the viewer's language between English labels reads as a
 * mistake. Same signature as `useTranslations('ocrSettings')`.
 */
export function englishOcrText(key: string, values?: Record<string, string | number | undefined | null>): string {
  let node: unknown = en.ocrSettings;
  for (const part of key.split('.')) {
    node = typeof node === 'object' && node !== null ? (node as Record<string, unknown>)[part] : undefined;
  }
  if (typeof node !== 'string') return key;
  return node.replace(/\{(\w+)\}/g, (match, token: string) => {
    const value = values?.[token];
    return value === undefined || value === null ? match : String(value);
  });
}
