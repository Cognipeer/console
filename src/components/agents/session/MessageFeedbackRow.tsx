'use client';

/**
 * What people said about one answer, under the answer in the session view: the
 * thumbs, the reasons they gave and — for those who may read it — the comment.
 */

import { Badge, Group, Stack, Text } from '@mantine/core';
import { IconThumbDown, IconThumbUp } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import type { SessionMessageFeedback } from '../studio/feedbackUi';

export default function MessageFeedbackRow({ rows }: { rows: readonly SessionMessageFeedback[] }) {
    const t = useTranslations('agents.feedback');
    if (rows.length === 0) return null;
    return (
        <Stack gap={4} mt={6} data-testid="message-feedback">
            {rows.map((row) => (
                <Group key={`${row.userId ?? row.updatedAt}-${row.messageId}`} gap={6} wrap="wrap" align="flex-start">
                    <Badge
                        size="sm"
                        variant="light"
                        color={row.rating === 'up' ? 'teal' : 'red'}
                        leftSection={row.rating === 'up' ? <IconThumbUp size={12} /> : <IconThumbDown size={12} />}
                    >
                        {row.rating === 'up' ? t('ratingUp') : t('ratingDown')}
                    </Badge>
                    {row.reasons.map((reason) => (
                        <Badge key={reason} size="sm" variant="outline" color="gray" tt="none">{t(`reason.${reason}`)}</Badge>
                    ))}
                    {row.comment ? <Text size="xs" c="dimmed" style={{ whiteSpace: 'pre-wrap' }}>“{row.comment}”</Text> : null}
                </Group>
            ))}
        </Stack>
    );
}
