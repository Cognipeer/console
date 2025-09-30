'use client';

import { createContext, ReactNode, useContext, useMemo } from 'react';
import { Locale, messages } from './messages';

type TranslationValues = Record<string, string | number | undefined | null>;

type I18nContextValue = {
  locale: Locale;
};

const I18nContext = createContext<I18nContextValue>({
  locale: 'en',
});

function resolveMessage(locale: Locale, key: string): string | undefined {
  const segments = key.split('.');
  let current: unknown = messages[locale];

  for (const segment of segments) {
    if (typeof current !== 'object' || current === null) {
      return undefined;
    }

    current = (current as Record<string, unknown>)[segment];
  }

  return typeof current === 'string' ? current : undefined;
}

function interpolate(message: string, values?: TranslationValues): string {
  if (!values) {
    return message;
  }

  return message.replace(/\{(\w+)\}/g, (match, token) => {
    const replacement = values[token];

    if (replacement === undefined || replacement === null) {
      return match;
    }

    return String(replacement);
  });
}

export function I18nProvider({ locale = 'en', children }: { locale?: Locale; children: ReactNode }) {
  const value = useMemo<I18nContextValue>(() => ({ locale }), [locale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useTranslations(namespace?: string) {
  const { locale } = useContext(I18nContext);

  return (key: string, values?: TranslationValues) => {
    const fullKey = namespace ? `${namespace}.${key}` : key;
    const message = resolveMessage(locale, fullKey) ?? fullKey;
    return interpolate(message, values);
  };
}

export function useLocale() {
  const { locale } = useContext(I18nContext);
  return locale;
}
