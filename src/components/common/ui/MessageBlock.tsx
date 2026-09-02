'use client';

import { ReactNode } from 'react';
import { Stack, Text } from '@mantine/core';
import CollapsibleText from './CollapsibleText';

const ROLE_LABELS: Record<string, string> = {
  system: 'Developer',
  developer: 'Developer',
  user: 'User',
  assistant: 'Assistant',
  tool: 'Tool',
};

/** Flattens an OpenAI-style message `content` (string or content-part array) to display text. */
export function messageContentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          const p = part as Record<string, unknown>;
          if (typeof p.text === 'string') return p.text;
          if (p.type === 'image_url' || p.type === 'input_image') return '[image]';
          try {
            return JSON.stringify(part);
          } catch {
            return String(part);
          }
        }
        return String(part);
      })
      .filter((part) => part.length > 0)
      .join('\n\n');
  }
  if (content === null || content === undefined) return '';
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

export interface MessageBlockProps {
  /** The chat message's role (system/user/assistant/tool) — named `messageRole`,
   *  not `role`, so linters don't mistake it for the HTML/ARIA `role` attribute. */
  messageRole: string;
  content: unknown;
  roleLabel?: ReactNode;
}

/**
 * One chat message — role label (mapped to "Developer"/"User"/"Assistant")
 * plus its content, collapsed past a few lines. Shared by the Model Hub log
 * modal and the Agent Observability event panel's message-kind sections.
 */
export default function MessageBlock({ messageRole, content, roleLabel }: MessageBlockProps) {
  const text = messageContentToText(content);
  if (!text.trim()) return null;
  const label = roleLabel ?? ROLE_LABELS[messageRole.toLowerCase()] ?? messageRole;
  return (
    <Stack gap={6}>
      <Text size="sm" fw={700}>
        {label}
      </Text>
      <CollapsibleText>{text}</CollapsibleText>
    </Stack>
  );
}
