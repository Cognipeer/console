/**
 * Saving a downloaded body to disk from the browser.
 */

/**
 * Offers `blob` to the browser as a download named `fileName`. The temporary address is released a little later:
 * revoking it at once can cut a large download short in some browsers.
 */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  link.hidden = true;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => window.URL.revokeObjectURL(url), 10_000);
}
