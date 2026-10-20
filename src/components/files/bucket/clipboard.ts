/**
 * Putting text on the clipboard from a menu item or a button that is not a `CopyButton` (the row menu's "Copy key").
 */

/** Copies `text`; false when the browser refuses (no permission, an insecure page, no clipboard at all). */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the older route */
  }
  try {
    if (typeof document === 'undefined') return false;
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const copied = typeof document.execCommand === 'function' ? document.execCommand('copy') : false;
    area.remove();
    return copied;
  } catch {
    return false;
  }
}
