/**
 * A token counter for the agent SDK that does not bill an image's bytes as text.
 *
 * The SDK estimates a request by flattening every message to text and counting
 * characters (chars / 4). An image that reaches it as inline base64 is read as
 * text too: a 55 KB photo came out at ~18,000 tokens against ~425 for the
 * provider, and the SDK compacted a conversation that was nowhere near its
 * window — summarising away the very picture it had just been shown. Session
 * images are references now (`sessionImages.ts`), but any other image source
 * (a caller's own base64 part, a data URL) would do the same, so the counter
 * sees through both: a base64 payload costs `IMAGE_TOKENS`, not its length, and
 * so does a `session-file://` reference — the model is shown the picture when
 * the request is sent, which is what the estimate is for.
 *
 * Installed per agent through `createSmartAgent({ tokenCounter })`. The SDK sets
 * it for the length of one invoke and restores its default afterwards.
 */

/** About what a provider bills for one ordinary image (OpenAI-style tiles, Anthropic's ~w*h/750 at typical sizes). */
export const IMAGE_TOKENS = 850;

const INLINE_BASE64 = /"base64":"[A-Za-z0-9+/=]{256,}"/g;
const DATA_URL = /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]{256,}/gi;
const SESSION_FILE_REFERENCE = /session-file:\/\//g;

/** The SDK's own heuristic (`defaultTokenCounter`): ASCII at 4 characters a token, everything else at 1.5. */
export function approximateTokens(text: string): number {
    if (!text) return 0;
    const nonAscii = (text.match(/[^\x00-\x7F]/g) || []).length;
    return Math.ceil((text.length - nonAscii) / 4 + nonAscii / 1.5);
}

export function createImageAwareTokenCounter(base: (text: string) => number = approximateTokens): (text: string) => number {
    return (text: string): number => {
        if (!text) return 0;
        let images = 0;
        let stripped = text;
        if (stripped.includes('base64')) {
            stripped = stripped
                .replace(INLINE_BASE64, () => {
                    images += 1;
                    return '"base64":"<image>"';
                })
                .replace(DATA_URL, () => {
                    images += 1;
                    return 'data:image;base64,<image>';
                });
        }
        if (stripped.includes('session-file://')) {
            images += stripped.match(SESSION_FILE_REFERENCE)?.length ?? 0;
        }
        return base(stripped) + images * IMAGE_TOKENS;
    };
}
