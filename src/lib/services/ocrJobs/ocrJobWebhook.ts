/**
 * Outbound webhook delivery for OCR jobs.
 *
 * Best-effort POST with HMAC signature and in-process retry (3 attempts,
 * 1s/2s/4s backoff). Mirrors the crawler webhook contract.
 */

import crypto from 'node:crypto';
import axios from 'axios';
import { createLogger } from '@/lib/core/logger';
import type { IOcrJob, OcrJobWebhookEvent } from '@/lib/database';

const log = createLogger('ocr-job:webhook');

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_EVENTS: OcrJobWebhookEvent[] = ['item.succeeded', 'item.failed'];

export interface OcrWebhookPayload<T = unknown> {
  id: string;
  event: `ocr.${OcrJobWebhookEvent}`;
  createdAt: string;
  tenantId: string;
  projectId?: string;
  jobId: string;
  data: T;
}

/** Returns true when the webhook was delivered, false when it failed/skipped. */
export async function sendOcrJobWebhook<T>(input: {
  job: Pick<IOcrJob, 'tenantId' | 'projectId' | 'callbackUrl' | 'callbackSecret' | 'callbackEvents'> & {
    _id?: unknown;
  };
  event: OcrJobWebhookEvent;
  data: T;
}): Promise<boolean> {
  const url = input.job.callbackUrl;
  if (!url) return false;

  const events = input.job.callbackEvents ?? DEFAULT_EVENTS;
  if (!events.includes(input.event)) return false;

  const secret = input.job.callbackSecret;
  const jobId = input.job._id ? String(input.job._id) : '';

  const body: OcrWebhookPayload<T> = {
    id: `evt_${crypto.randomUUID().replace(/-/g, '')}`,
    event: `ocr.${input.event}`,
    createdAt: new Date().toISOString(),
    tenantId: input.job.tenantId,
    projectId: input.job.projectId,
    jobId,
    data: input.data,
  };

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'cognipeer-ocr/1.0',
  };
  if (secret) {
    const t = Math.floor(Date.now() / 1000);
    const bodyJson = JSON.stringify(body);
    const sig = crypto.createHmac('sha256', secret).update(`${t}.${bodyJson}`).digest('hex');
    headers['x-cognipeer-signature'] = `t=${t},v1=${sig}`;
  }

  let lastErr: unknown;
  for (let attempt = 0; attempt < DEFAULT_ATTEMPTS; attempt++) {
    try {
      await axios.post(url, body, {
        headers,
        timeout: DEFAULT_TIMEOUT_MS,
        validateStatus: (s) => s >= 200 && s < 300,
      });
      return true;
    } catch (err) {
      lastErr = err;
      if (attempt < DEFAULT_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
      }
    }
  }
  log.warn('OCR webhook delivery failed after retries', {
    url,
    event: body.event,
    jobId,
    error: lastErr instanceof Error ? lastErr.message : String(lastErr),
  });
  return false;
}
