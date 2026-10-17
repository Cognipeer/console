/**
 * The digest that matches a chat-completions client back to its session: what a turn leaves behind
 * (`transcriptDigestAfterTurn`) must equal what the client's next request says came before its last user
 * message (`priorTranscriptDigest`), however it spells and pads its history.
 */
import { describe, expect, it } from 'vitest';
import { priorTranscriptDigest, transcriptDigestAfterTurn } from '@/lib/services/agents/chatTranscript';

const u = (content: unknown) => ({ role: 'user', content });
const a = (content: unknown) => ({ role: 'assistant', content });

describe('transcript digest', () => {
  it('the next request\'s history digests to what the last turn left', () => {
    const left = transcriptDigestAfterTurn([u('q1')], 'a1');
    expect(priorTranscriptDigest([u('q1'), a('a1'), u('q2')])).toBe(left);
  });

  it('a first turn has nothing to match', () => {
    expect(priorTranscriptDigest([u('q1')])).toBeNull();
    expect(priorTranscriptDigest([{ role: 'system', content: 'be brief' }, u('q1')])).toBeNull();
    expect(priorTranscriptDigest(undefined)).toBeNull();
  });

  it('system and developer messages never take part', () => {
    const left = transcriptDigestAfterTurn([{ role: 'system', content: 'one prompt' }, u('q1')], 'a1');
    expect(transcriptDigestAfterTurn([u('q1'), { role: 'developer', content: 'x' }], 'a1')).toBe(left);
    expect(priorTranscriptDigest([{ role: 'system', content: 'another prompt' }, u('q1'), a('a1'), u('q2')])).toBe(left);
  });

  it('the string and the content-part spellings, and padding, are the same message', () => {
    const left = transcriptDigestAfterTurn([u('q1')], 'a1');
    expect(priorTranscriptDigest([u([{ type: 'text', text: ' q1 ' }]), a([{ type: 'text', text: 'a1\n' }]), u('q2')])).toBe(left);
  });

  it('the files and images a message carried take part: the same question about another image is another transcript', () => {
    const withImage = (url: string) => u([{ type: 'text', text: 'what is this?' }, { type: 'image_url', image_url: { url } }]);
    const left = transcriptDigestAfterTurn([withImage('data:image/png;base64,AA')], 'a cat');
    expect(priorTranscriptDigest([withImage('data:image/png;base64,AA'), a('a cat'), u('q2')])).toBe(left);
    expect(priorTranscriptDigest([withImage('data:image/png;base64,BB'), a('a cat'), u('q2')])).not.toBe(left);
    expect(priorTranscriptDigest([withImage('https://img.example.com/1.png'), a('a cat'), u('q2')])).not.toBe(left);
    expect(priorTranscriptDigest([u('what is this?'), a('a cat'), u('q2')])).not.toBe(left);
    // a file by id, in either spelling
    const fileLeft = transcriptDigestAfterTurn([u([{ type: 'text', text: 'sum it' }, { type: 'file', file: { file_id: 'file-1' } }])], 'done');
    expect(priorTranscriptDigest([u([{ type: 'text', text: 'sum it' }, { type: 'file', file: { file_id: 'file-2' } }]), a('done'), u('q2')])).not.toBe(fileLeft);
    expect(priorTranscriptDigest([u([{ type: 'text', text: 'sum it' }, { type: 'file', file: { file_id: 'file-1' } }]), a('done'), u('q2')])).toBe(fileLeft);
  });

  it('the OpenAI user field takes part when it is sent', () => {
    const left = transcriptDigestAfterTurn([u('hi')], 'Hello! How can I help you today?', 'end-user-a');
    expect(priorTranscriptDigest([u('hi'), a('Hello! How can I help you today?'), u('q2')], 'end-user-a')).toBe(left);
    expect(priorTranscriptDigest([u('hi'), a('Hello! How can I help you today?'), u('q2')], 'end-user-b')).not.toBe(left);
    expect(priorTranscriptDigest([u('hi'), a('Hello! How can I help you today?'), u('q2')])).not.toBe(left);
    // without it a text transcript digests as it always did
    expect(priorTranscriptDigest([u('hi'), a('Hello! How can I help you today?'), u('q2')])).toBe(transcriptDigestAfterTurn([u('hi')], 'Hello! How can I help you today?'));
  });

  it('a different history, role or answer is a different digest', () => {
    const left = transcriptDigestAfterTurn([u('q1')], 'a1');
    expect(priorTranscriptDigest([u('q1'), a('other answer'), u('q2')])).not.toBe(left);
    expect(priorTranscriptDigest([u('other question'), a('a1'), u('q2')])).not.toBe(left);
    expect(priorTranscriptDigest([u('q1'), u('a1'), u('q2')])).not.toBe(left);
  });

  it('only what precedes the LAST user message counts', () => {
    const left = transcriptDigestAfterTurn([u('q1'), a('a1'), u('q2')], 'a2');
    expect(priorTranscriptDigest([u('q1'), a('a1'), u('q2'), a('a2'), u('q3')])).toBe(left);
    expect(priorTranscriptDigest([u('q1'), a('a1'), u('q2'), a('a2'), u('a different third question')])).toBe(left);
  });
});
