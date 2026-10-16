'use client';

import { useState } from 'react';
import { Alert, Button, Textarea } from '@mantine/core';
import { IconCheck, IconInfoCircle, IconSend } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import { IamApiError } from './client';
import { directoryApi } from './directoryApi';

export const ACCESS_REQUEST_MAX_LENGTH = 500;

export type RequestAccessOutcome = 'sent' | 'rate_limited' | 'has_access' | 'failed';

/** What an access-request answer means for the person (429: one request a day; 409: they already have a project). */
export function outcomeOfError(error: unknown): RequestAccessOutcome {
  const status = error instanceof IamApiError ? error.status : 0;
  if (status === 429) return 'rate_limited';
  if (status === 409) return 'has_access';
  return 'failed';
}

/** "Request access" for a signed-in person who has no project: an optional message, sent to the workspace admins. */
export default function RequestAccess() {
  const t = useTranslations('noProject');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<RequestAccessOutcome | null>(null);

  const send = async () => {
    if (sending) return;
    setSending(true);
    try {
      await directoryApi.requestAccess(message.trim() || undefined);
      setOutcome('sent');
    } catch (error) {
      setOutcome(outcomeOfError(error));
    } finally {
      setSending(false);
    }
  };

  if (outcome === 'sent') {
    return (
      <Alert color="teal" variant="light" icon={<IconCheck size={16} />} data-testid="access-request-sent">
        {t('request.sent')}
      </Alert>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="access-request">
      <p style={{ fontSize: 13, color: 'var(--ds-text-muted)', margin: 0, lineHeight: 1.55 }}>{t('request.hint')}</p>
      <Textarea
        label={t('request.messageLabel')}
        placeholder={t('request.messagePlaceholder')}
        value={message}
        onChange={(event) => setMessage(event.currentTarget.value)}
        maxLength={ACCESS_REQUEST_MAX_LENGTH}
        autosize
        minRows={2}
        maxRows={5}
        disabled={sending}
      />
      {outcome ? (
        <Alert color={outcome === 'failed' ? 'red' : 'blue'} variant="light" icon={<IconInfoCircle size={16} />}>
          {t(outcome === 'rate_limited' ? 'request.alreadyRequested' : outcome === 'has_access' ? 'request.alreadyHasAccess' : 'request.failed')}
        </Alert>
      ) : null}
      <Button variant="light" color="teal" size="md" fullWidth loading={sending} leftSection={<IconSend size={16} stroke={1.7} />} onClick={() => void send()}>
        {t('request.submit')}
      </Button>
    </div>
  );
}
