/**
 * The colours of an attachment chip and of the Files panel's small text, as design-system tokens (`globals.css`),
 * not Mantine's "light gray" badge.
 *
 * That variant drew the file name in the palette's faint grey (#98a1ad) on a
 * pale wash — 2.4:1, under the 4.5:1 WCAG AA asks of small text — and the
 * expired chip was dimmed further with `opacity: 0.7`. The tokens below switch
 * with the colour scheme, and `CHIP_CONTRAST_PAIRS` names every text/background
 * pair a chip uses so a test can hold each of them to AA in both schemes.
 */

/** Text on a chip, on the surface behind it. */
export const CHIP_TEXT = 'var(--ds-text-soft)';
export const CHIP_SURFACE = 'var(--ds-surface-2)';
/** A small caption under a thumbnail or next to a file name (on the card or the chip). */
export const CHIP_CAPTION = 'var(--ds-text-soft)';
/** A small link beside those lines (the bucket a file is stored in): Mantine's own blue is 3.5:1 on white. */
export const CHIP_LINK = 'var(--ds-link-text)';
/** A chip that warns (an image the model cannot read, a file with no readable text). */
export const CHIP_WARN_TEXT = 'var(--ds-warn-text)';
export const CHIP_WARN_SURFACE = 'var(--ds-warn-wash)';

const LABEL = { textTransform: 'none', fontWeight: 500 } as const;

/** A file chip: soft text on the chip wash, a hairline so it still reads as a chip on a tinted bubble. */
export const CHIP_STYLES = {
    root: { background: CHIP_SURFACE, color: CHIP_TEXT, border: '1px solid var(--ds-border-strong)' },
    label: LABEL,
} as const;

/** A file that is gone: dashed and transparent, not dimmed — the text keeps its contrast. */
export const EXPIRED_CHIP_STYLES = {
    root: { background: 'transparent', color: CHIP_TEXT, border: '1px dashed var(--ds-border-strong)' },
    label: LABEL,
} as const;

export const WARN_CHIP_STYLES = {
    root: { background: CHIP_WARN_SURFACE, color: CHIP_WARN_TEXT, border: '1px solid var(--ds-warn-text)' },
    label: LABEL,
} as const;

/** Every text/background token pair a chip draws, for the contrast test. */
export const CHIP_CONTRAST_PAIRS: ReadonlyArray<{ name: string; text: string; background: string }> = [
    { name: 'chip', text: '--ds-text-soft', background: '--ds-surface-2' },
    { name: 'chip on a card', text: '--ds-text-soft', background: '--ds-surface-raised' },
    { name: 'expired chip', text: '--ds-text-soft', background: '--ds-surface-raised' },
    { name: 'warning chip', text: '--ds-warn-text', background: '--ds-warn-wash' },
    { name: 'warning line', text: '--ds-warn-text', background: '--ds-surface-raised' },
    { name: 'thumbnail caption', text: '--ds-text-soft', background: '--ds-surface-raised' },
    { name: 'Files panel title', text: '--ds-text-soft', background: '--ds-surface-raised' },
    { name: 'Files panel title on the page', text: '--ds-text-soft', background: '--ds-surface-0' },
    { name: 'Files panel location link', text: '--ds-link-text', background: '--ds-surface-raised' },
    { name: 'Files panel location link on the page', text: '--ds-link-text', background: '--ds-surface-0' },
    { name: 'Files panel location link on a soft surface', text: '--ds-link-text', background: '--ds-surface-2' },
    { name: 'expired line in the Files panel', text: '--ds-err-text', background: '--ds-surface-raised' },
];
