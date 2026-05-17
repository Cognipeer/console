import { en } from './en';
import { tr } from './tr';

export const messages = {
  en,
  tr,
};

export type Locale = keyof typeof messages;
export const SUPPORTED_LOCALES: Locale[] = ['en', 'tr'];
