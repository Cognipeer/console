/**
 * `useTranslations(ns)` echoes the NAMESPACED key (`resources.some.path`) when a
 * message is missing, so "is it missing?" must compare against that, not against
 * the bare path. Returns undefined for a missing key so callers can fall back.
 */
export function tryTranslate(
  t: (key: string) => string,
  path: string,
  namespace = 'resources',
): string | undefined {
  const value = t(path);
  return value === `${namespace}.${path}` || value === path ? undefined : value;
}
