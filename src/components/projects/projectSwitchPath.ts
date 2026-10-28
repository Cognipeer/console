/**
 * Where the dashboard goes after the active project changes.
 *
 * A page that names one record (`/dashboard/agents/<id>`, `/dashboard/agents/tools/<id>`,
 * `/dashboard/vector/<provider>/<index>`) shows something of the project being left, so it
 * goes back to the list it was opened from: the path up to its first dynamic segment. Any
 * other page (a list, an overview, settings) stays where it is and just reloads.
 *
 * `params` are the route's dynamic values (Next's `useParams()`). Only segments after
 * `/dashboard/<module>` are compared, so a record keyed like its module (`/dashboard/rag/rag`)
 * still lands on the module's list; a value is matched encoded or not. The query is dropped
 * with the record: its filters and tabs belonged to the record or to the old project.
 *
 * Returns null when the page should only reload.
 */
export function pathAfterProjectSwitch(
  pathname: string,
  params: Record<string, string | string[] | undefined> | null | undefined,
): string | null {
  const values = new Set(
    Object.values(params ?? {})
      .flatMap((value) => (Array.isArray(value) ? value : [value]))
      .filter((value): value is string => typeof value === 'string' && value.length > 0),
  );
  if (values.size === 0) return null;

  const segments = pathname.split('/').filter(Boolean);
  const decoded = segments.map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
  if (decoded[0] !== 'dashboard') return null;

  for (let index = 2; index < decoded.length; index += 1) {
    if (values.has(decoded[index]) || values.has(segments[index])) {
      return `/${segments.slice(0, index).join('/')}`;
    }
  }
  return null;
}
