import type { LicenseType } from '@/lib/license/license-manager';

/** Caller context resolved from the API token at connection time. */
export interface RealtimeContext {
  tenantDbName: string;
  tenantId: string;
  projectId?: string;
  userId?: string;
  licenseType?: LicenseType;
  tokenId?: string;
}

/**
 * Mutable per-connection session configuration (set via `session.update`).
 * `model` is the only required field before `response.create` works.
 */
export interface RealtimeSessionConfig {
  /** Chat model key responses are generated with. */
  model?: string;
  /** System prompt prepended to the conversation. */
  instructions?: string;
  temperature?: number;
  maxOutputTokens?: number;
  /** STT model key used by `input_audio_buffer.commit`. */
  transcriptionModel?: string;
  /** Audio MIME type of appended input chunks (default audio/webm). */
  inputAudioFormat?: string;
  /** TTS model key; when set, responses are also synthesized to audio. */
  ttsModel?: string;
  /** TTS voice id (required by most providers when ttsModel is set). */
  voice?: string;
  /** TTS output format (default mp3). */
  ttsFormat?: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm';
}

export interface RealtimeMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Events the client may send over the socket. */
export type RealtimeClientEvent =
  | { type: 'session.update'; session: Record<string, unknown> }
  | { type: 'conversation.item.create'; item: Record<string, unknown> }
  | { type: 'input_audio_buffer.append'; audio: string }
  | { type: 'input_audio_buffer.clear' }
  | { type: 'input_audio_buffer.commit' }
  | { type: 'response.create'; response?: Record<string, unknown> }
  | { type: 'response.cancel' };

/** Transport-agnostic sender: the plugin wires this to the websocket. */
export type RealtimeSender = (event: Record<string, unknown>) => void;
