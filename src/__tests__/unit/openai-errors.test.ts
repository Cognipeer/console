import { describe, expect, it } from 'vitest';
import {
  normalizeInferenceError,
  OutputTokenLimitError,
} from '@/lib/services/models/openaiErrors';

describe('normalizeInferenceError', () => {
  it('normalizes output token exhaustion', () => {
    expect(normalizeInferenceError(new OutputTokenLimitError(512))).toEqual({
      status: 422,
      error: {
        message: expect.stringContaining('512 tokens'),
        type: 'output_token_limit_exceeded',
        param: 'max_completion_tokens',
        code: 'output_token_limit_exceeded',
      },
    });
  });

  it('reads nested provider context-length details', () => {
    const error = {
      response: {
        status: 400,
        data: {
          error: {
            message: 'Maximum context length is 8192 tokens',
            code: 'context_length_exceeded',
            param: 'messages',
          },
        },
      },
    };

    expect(normalizeInferenceError(error)).toEqual({
      status: 400,
      error: {
        message: 'Maximum context length is 8192 tokens',
        type: 'invalid_request_error',
        param: 'messages',
        code: 'context_length_exceeded',
      },
    });
  });

  it('normalizes provider quota errors', () => {
    const error = Object.assign(new Error('You exceeded your current quota'), {
      status: 429,
      code: 'insufficient_quota',
    });

    expect(normalizeInferenceError(error)).toMatchObject({
      status: 429,
      error: {
        type: 'rate_limit_error',
        code: 'insufficient_quota',
      },
    });
  });

  it('does not expose provider credentials in authentication errors', () => {
    const error = Object.assign(new Error('Unauthorized for Bearer sk-secretvalue123'), {
      status: 401,
    });

    expect(normalizeInferenceError(error)).toEqual({
      status: 401,
      error: {
        message: 'Model provider authentication failed. Verify the configured provider credentials.',
        type: 'authentication_error',
        code: 'invalid_api_key',
      },
    });
  });

  it('redacts provider-specific secrets from returned messages', () => {
    const error = new Error(
      'Request failed with api_key=AIza1234567890abcdefghijklmnop and session_token:abc123secret',
    );

    const result = normalizeInferenceError(error);

    expect(result.error.message).not.toContain('AIza1234567890abcdefghijklmnop');
    expect(result.error.message).not.toContain('abc123secret');
    expect(result.error.message).toContain('[REDACTED]');
  });

  it('reads provider error details nested in arrays', () => {
    const error = {
      response: {
        status: 400,
        data: {
          errors: [{
            message: 'Prompt exceeds the context window',
            code: 'context_length_exceeded',
          }],
        },
      },
    };

    expect(normalizeInferenceError(error)).toMatchObject({
      status: 400,
      error: {
        message: 'Prompt exceeds the context window',
        type: 'invalid_request_error',
        code: 'context_length_exceeded',
      },
    });
  });

  it('distinguishes provider timeout and availability failures', () => {
    expect(normalizeInferenceError(new Error('Request timed out after 30s'))).toMatchObject({
      status: 504,
      error: { type: 'server_error', code: 'provider_timeout' },
    });
    expect(normalizeInferenceError(new Error('APIConnectionError: ECONNREFUSED'))).toMatchObject({
      status: 503,
      error: { type: 'server_error', code: 'provider_unavailable' },
    });
  });

  it('maps invalid input and missing models to client errors', () => {
    expect(normalizeInferenceError(new Error('`messages` array is required'))).toMatchObject({
      status: 400,
      error: { type: 'invalid_request_error', code: 'invalid_request' },
    });
    expect(normalizeInferenceError(new Error('Model not found: missing-model'))).toMatchObject({
      status: 404,
      error: { type: 'not_found_error', code: 'model_not_found', param: 'model' },
    });
  });

  it('keeps unknown errors structured', () => {
    expect(normalizeInferenceError(new Error('Unexpected provider response'))).toEqual({
      status: 500,
      error: {
        message: 'Unexpected provider response',
        type: 'server_error',
        code: 'inference_error',
      },
    });
  });
});