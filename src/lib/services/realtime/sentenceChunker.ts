/**
 * Incremental sentence chunker for streaming TTS.
 *
 * Feeds on text deltas and yields complete sentences as soon as they close,
 * so speech synthesis can start while the chat model is still generating —
 * the single biggest perceived-latency win for voice sessions.
 */

const SENTENCE_END = /[.!?…]["')\]]?\s|\n+/;

/** Minimum flushable chunk — avoids synthesizing "Ok." style fragments alone
 * when more text is arriving right behind them. */
const MIN_CHUNK_CHARS = 16;

/** Force a flush even mid-sentence beyond this length (long enumerations). */
const MAX_CHUNK_CHARS = 400;

export class SentenceChunker {
  private buffer = '';

  /** Add a delta; returns any sentences that completed with this delta. */
  push(delta: string): string[] {
    this.buffer += delta;
    const out: string[] = [];
    for (;;) {
      if (this.buffer.length >= MAX_CHUNK_CHARS) {
        // Hard flush at a word boundary near the cap.
        const cut = this.buffer.lastIndexOf(' ', MAX_CHUNK_CHARS);
        const index = cut > MIN_CHUNK_CHARS ? cut : MAX_CHUNK_CHARS;
        out.push(this.buffer.slice(0, index).trim());
        this.buffer = this.buffer.slice(index);
        continue;
      }
      const match = SENTENCE_END.exec(this.buffer);
      if (!match) break;
      const end = match.index + match[0].length;
      if (end < MIN_CHUNK_CHARS && this.buffer.length < MAX_CHUNK_CHARS) {
        // Sentence closed but it's tiny — wait for more text unless the
        // buffer has clearly moved past it.
        const rest = this.buffer.slice(end);
        if (!SENTENCE_END.test(rest) && rest.length < MIN_CHUNK_CHARS) break;
      }
      const sentence = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end);
      if (sentence) out.push(sentence);
    }
    return out;
  }

  /** Return any trailing text (end of stream). */
  flush(): string | null {
    const rest = this.buffer.trim();
    this.buffer = '';
    return rest.length > 0 ? rest : null;
  }
}
