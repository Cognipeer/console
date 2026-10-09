'use client';

/**
 * A human message for any failed call. The server answers `{ error, code }` in
 * English; for a known `code` the localized text (`iamApi.errors.<code>`) is
 * used instead, except `validation`, whose details name exactly what is wrong.
 */

import { useCallback } from 'react';
import { useTranslations } from '@/lib/i18n';
import { IamApiError, errorMessage } from './api';

export type ErrorText = (error: unknown, fallback?: string) => string;

export function localizedErrorMessage(
  error: unknown,
  lookup: (key: string) => string | undefined,
  fallback = '',
): string {
  if (error instanceof IamApiError && error.code && error.code !== 'validation') {
    const localized = lookup(`iamApi.errors.${error.code}`);
    if (localized) return localized;
  }
  return errorMessage(error, fallback);
}

export function useErrorText(): ErrorText {
  const root = useTranslations();
  return useCallback(
    (error, fallback = '') =>
      localizedErrorMessage(
        error,
        (key) => {
          const value = root(key);
          return value === key ? undefined : value;
        },
        fallback,
      ),
    [root],
  );
}
