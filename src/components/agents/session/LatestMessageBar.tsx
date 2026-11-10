'use client';

/**
 * The newest message of the session, pinned above the transcript: who wrote it,
 * when, and its first lines. Unfold it to read it all here, or jump to it. See
 * `latestMessageUi.ts` for which message counts as the newest.
 */

import { useState } from 'react';
import { ActionIcon, Box, Button, Group, Loader, ScrollArea, Text, Tooltip } from '@mantine/core';
import { IconArrowDown, IconChevronDown, IconChevronUp, IconMessage } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import { formatRelativeTime } from '@/lib/utils/tracingUtils';
import Markdown from './AgentMarkdown';
import { previewText, type LatestMessageView } from './latestMessageUi';
import classes from './AgentSessionView.module.css';

export default function LatestMessageBar({
    view,
    agentName,
    running,
    framed = false,
    onJump,
}: {
    view: LatestMessageView;
    /** Who "agent" is; the generic word when the surface does not know the agent's name. */
    agentName?: string;
    /** A turn is running: the bar says the message may not be the last one for long. */
    running: boolean;
    /** A bordered card (in a stack of notices) instead of a strip across the transcript's top edge. */
    framed?: boolean;
    onJump: () => void;
}) {
    const t = useTranslations('agents.sessionPage');
    const [open, setOpen] = useState(false);
    const author = view.role === 'user' ? t('latestUser') : view.role === 'error' ? t('latestError') : agentName || t('latestAgent');
    const when = view.live ? t('latestWriting') : view.timestamp ? formatRelativeTime(view.timestamp) : null;

    return (
        <Box px="sm" py={6} className={framed ? classes.latestCard : classes.latestBar} data-testid="agent-session-latest">
            <Group gap="xs" wrap="nowrap" align="flex-start">
                {running ? <Loader size={14} mt={3} /> : <IconMessage size={14} className={classes.latestIcon} />}
                <Box className={classes.flexGrow} miw={0}>
                    <Group gap={6} wrap="nowrap">
                        <Text size="xs" fw={600} c="dimmed" className={classes.noWrap}>{t('latestLabel')}</Text>
                        <Text size="xs" fw={600} truncate>{author}</Text>
                        {when ? <Text size="xs" c="dimmed" className={classes.noWrap}>· {when}</Text> : null}
                    </Group>
                    {open ? (
                        <ScrollArea.Autosize mah="40vh" type="auto" mt={4}>
                            {view.role === 'agent'
                                ? <Box className={classes.chatMarkdown}><Markdown text={view.text} /></Box>
                                : <Text size="sm" className={classes.preWrap}>{view.text}</Text>}
                        </ScrollArea.Autosize>
                    ) : (
                        <Text size="sm" lineClamp={2} c={view.role === 'error' ? 'red' : undefined}>
                            {previewText(view.text)}
                        </Text>
                    )}
                </Box>
                <Tooltip label={open ? t('latestCollapse') : t('latestExpand')} withArrow>
                    <ActionIcon
                        size="sm"
                        variant="subtle"
                        color="gray"
                        aria-label={open ? t('latestCollapse') : t('latestExpand')}
                        aria-expanded={open}
                        onClick={() => setOpen((value) => !value)}
                    >
                        {open ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />}
                    </ActionIcon>
                </Tooltip>
                <Button size="compact-xs" variant="light" rightSection={<IconArrowDown size={12} />} onClick={onJump}>
                    {t('latestGoTo')}
                </Button>
            </Group>
        </Box>
    );
}
