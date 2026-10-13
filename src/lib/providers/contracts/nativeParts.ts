/**
 * Small helpers for callers that talk to a native chat client directly (the
 * guardrail judge, the structured decider, VLM OCR): images as native content
 * parts and token usage read from the native shape.
 */
import type { UnifiedMessage } from '@cognipeer/agent-sdk';

export type ContentPart = Exclude<UnifiedMessage['content'], string>[number];

const DATA_URL = /^data:([^;,]*)((?:;[^;,=]+=[^;,]+)*)(;base64)?,([\s\S]*)$/i;

/** An image URL or data URL as a native image part. */
export function imageUrlToPart(url: string, fallbackMediaType = 'image/png'): ContentPart {
  const data = DATA_URL.exec(url);
  if (data) {
    const base64 = data[3] ? data[4] : Buffer.from(decodeURIComponent(data[4]), 'utf8').toString('base64');
    return { type: 'image', source: { type: 'base64', mediaType: data[1] || fallbackMediaType, data: base64 } };
  }
  return { type: 'image', source: { type: 'url', url } };
}

/** Base64 bytes as a native image part. */
export function base64ImagePart(base64: string, mediaType: string): ContentPart {
  return { type: 'image', source: { type: 'base64', mediaType, data: base64 } };
}
