import type { ComponentProps } from 'react';

/**
 * Links inside chat messages — the person's own words and the agent's
 * answers — always open in a new tab, so following one never navigates away
 * from the transcript being read. Only an in-page jump (`#…`, such as a
 * Markdown footnote) stays in the page.
 */

/** The attributes every message link carries. */
export const NEW_TAB_LINK_PROPS = { target: '_blank', rel: 'noopener noreferrer' } as const;

type MarkdownAnchorProps = ComponentProps<'a'> & { node?: unknown };

/** The `a` renderer for react-markdown (`components={{ a: MarkdownLink }}`). */
export function MarkdownLink({ href, children, ...anchor }: MarkdownAnchorProps) {
    // react-markdown also passes its syntax-tree `node`, which is not an HTML attribute.
    const rest = { ...anchor };
    delete rest.node;
    if (href?.startsWith('#')) {
        return <a {...rest} href={href}>{children}</a>;
    }
    return <a {...rest} href={href} {...NEW_TAB_LINK_PROPS}>{children}</a>;
}

/** react-markdown components that send every link of a message to a new tab. */
export const MARKDOWN_LINK_COMPONENTS = { a: MarkdownLink };

export type TextPart = { kind: 'text'; text: string } | { kind: 'link'; text: string; href: string };

// `[^\s<>"'`]+` cannot backtrack into itself, so the scan stays linear on any input.
const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
const TRAILING_PUNCTUATION = '.,;:!?\'"';
const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

/** Drops the sentence punctuation a URL is written next to ("see https://x.com/a." / "(https://x.com)"). */
function trimUrl(raw: string): string {
    const tally: Record<string, number> = {};
    for (const c of raw) tally[c] = (tally[c] ?? 0) + 1;
    let end = raw.length;
    while (end > 0) {
        const last = raw[end - 1];
        if (TRAILING_PUNCTUATION.includes(last)) {
            end -= 1;
            continue;
        }
        const opener = CLOSERS[last];
        // A closing bracket belongs to the URL only when the URL opened it (Wikipedia-style paths).
        if (opener && (tally[last] ?? 0) > (tally[opener] ?? 0)) {
            tally[last] -= 1;
            end -= 1;
            continue;
        }
        break;
    }
    return raw.slice(0, end);
}

/** The address a written URL points at, or null when it names no host ("https://", "www."). */
function hrefOf(url: string): string | null {
    const bare = /^www\./i.test(url);
    const href = bare ? `https://${url}` : url;
    try {
        const { hostname } = new URL(href);
        if (!hostname) return null;
        // "www.example" needs a dot after the "www." to be read as an address.
        if (bare && !hostname.slice(4).includes('.')) return null;
        return href;
    } catch {
        return null;
    }
}

/** Splits plain text into its prose and the web addresses written in it. */
export function linkifyText(text: string): TextPart[] {
    const parts: TextPart[] = [];
    let cursor = 0;
    for (const match of text.matchAll(URL_PATTERN)) {
        const start = match.index ?? 0;
        const url = trimUrl(match[0]);
        const href = hrefOf(url);
        if (!href) continue;
        if (start > cursor) parts.push({ kind: 'text', text: text.slice(cursor, start) });
        parts.push({ kind: 'link', text: url, href });
        cursor = start + url.length;
    }
    if (cursor < text.length) parts.push({ kind: 'text', text: text.slice(cursor) });
    return parts;
}

/**
 * Plain message text with its web addresses made clickable (each opening in a
 * new tab). Line breaks and spacing are left to the surrounding element.
 */
export function LinkifiedText({ text }: { text: string | null | undefined }) {
    if (!text) return null;
    return (
        <>
            {linkifyText(text).map((part, i) =>
                part.kind === 'link' ? (
                    <a key={i} href={part.href} {...NEW_TAB_LINK_PROPS} style={{ wordBreak: 'break-all' }}>
                        {part.text}
                    </a>
                ) : (
                    part.text
                ),
            )}
        </>
    );
}
