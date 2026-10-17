/**
 * Files an agent wrote to its sandbox `/outputs/` on every response surface
 * (chat completions, A2A, session events, transcript). All additive.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return { ...actual, getDatabase: vi.fn().mockResolvedValue({ switchToTenant: vi.fn() }) };
});

import { toChatChunk, toChatCompletion } from '@/server/api/plugins/agent-openai-bridge';
import { a2aFileArtifacts } from '@/server/api/plugins/client-a2a';
import { outputFileEventData, toClientOutputFiles, toClientTranscriptMessage } from '@/lib/services/agents/clientWire';

const attachments = [
  { fileId: 'f1', name: 'report.pdf', mimeType: 'application/pdf', size: 1234, origin: 'agent_output' as const },
  { fileId: 'u1', name: 'in.csv', mimeType: 'text/csv', size: 10 },
];
const files = toClientOutputFiles('c1', attachments);
const url = '/client/v1/agents/sessions/c1/files/f1/content';

describe('chat completions', () => {
  it('carries output_files and file_path annotations, nothing when there are none', () => {
    const body = toChatCompletion({ id: 'x', model: 'a', content: 'see report.pdf', conversationId: 'c1', outputFiles: files });
    expect(body.output_files).toEqual([{ id: 'f1', name: 'report.pdf', mime_type: 'application/pdf', size: 1234, download_url: url }]);
    expect(body.choices[0].message).toMatchObject({ annotations: [{ type: 'file_path', file_id: 'f1', filename: 'report.pdf' }] });
    const plain = toChatCompletion({ id: 'x', model: 'a', content: 'hi', conversationId: 'c1' });
    expect(plain).not.toHaveProperty('output_files');
    expect(plain.choices[0].message).not.toHaveProperty('annotations');
  });

  it('puts files on the closing stream chunk only', () => {
    expect(toChatChunk({ id: 'x', model: 'a', finish: true, files })).toMatchObject({ files: [{ id: 'f1' }] });
    expect(toChatChunk({ id: 'x', model: 'a', delta: 'hi', files })).not.toHaveProperty('files');
    expect(toChatChunk({ id: 'x', model: 'a', finish: true })).not.toHaveProperty('files');
  });
});

describe('A2A', () => {
  it('adds one file artifact per output with an absolute uri', () => {
    expect(a2aFileArtifacts('task_c1_1', files, 'https://api.example.com')).toEqual([{
      artifactId: 'task_c1_1_file_1',
      name: 'report.pdf',
      parts: [{ kind: 'file', file: { name: 'report.pdf', mimeType: 'application/pdf', uri: `https://api.example.com/api${url}` } }],
      metadata: { fileId: 'f1', size: 1234 },
    }]);
    expect(a2aFileArtifacts('t', [], 'https://x')).toEqual([]);
  });
});

describe('session events and transcript', () => {
  it('emits the event data, snake-cased on the client wire later', () => {
    expect(outputFileEventData(files[0])).toEqual({ fileId: 'f1', name: 'report.pdf', mimeType: 'application/pdf', size: 1234, downloadUrl: url });
  });

  it('transcript messages keep each file origin and download url', () => {
    const m = toClientTranscriptMessage('c1', 3, { role: 'assistant', content: 'x', timestamp: '2026-10-01T00:00:00.000Z', attachments }, 'msg_1');
    expect(m.attachments.map((a) => [a.id, a.origin])).toEqual([['f1', 'agent_output'], ['u1', 'user_upload']]);
    expect(m.attachments[0].download_url).toBe(url);
    expect(m.output_files).toHaveLength(1);
    expect(toClientTranscriptMessage('c1', 0, { role: 'user', content: 'x', timestamp: new Date() }, 'm').attachments).toEqual([]);
  });
});
