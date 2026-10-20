/**
 * Addresses the Files screens link to.
 */

/** The page of a provider (Providers area). `_id` is the provider record's id, as the views carry it. */
export function providerHref(provider: { _id?: unknown } | null | undefined): string | null {
  const id = provider?._id;
  if (id === undefined || id === null || id === '') return null;
  return `/dashboard/providers/${encodeURIComponent(String(id))}`;
}
