/**
 * The entries of the browser forms' "Artifact bucket" picker, from what
 * `GET /api/files/buckets` returns. Pure, so the list rules are tested without
 * rendering the dropdown.
 */

/** The fields of one `GET /api/files/buckets` row the picker reads. */
export interface ArtifactBucketRow {
  key: string;
  name: string;
  status?: string;
}

export interface ArtifactBucketOption {
  value: string;
  label: string;
  disabled: boolean;
}

/**
 * A disabled bucket is listed but cannot be chosen, unless it is the one
 * already stored (re-saving the form keeps it). A stored key the project no
 * longer has stays in the list as "<key> (not found)" so the field shows what
 * is stored instead of silently emptying. While the list is still loading
 * (`buckets` null) the stored key shows as it is.
 */
export function artifactBucketOptions(
  buckets: ArtifactBucketRow[] | null,
  storedKey: string,
): ArtifactBucketOption[] {
  const options = (buckets ?? []).map((bucket) => {
    const inactive = bucket.status !== undefined && bucket.status !== 'active';
    return {
      value: bucket.key,
      label: inactive ? `${bucket.name} (disabled)` : bucket.name,
      disabled: inactive && bucket.key !== storedKey,
    };
  });
  if (storedKey && !options.some((option) => option.value === storedKey)) {
    options.unshift({
      value: storedKey,
      label: buckets ? `${storedKey} (not found)` : storedKey,
      disabled: false,
    });
  }
  return options;
}
