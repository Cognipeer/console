'use client';

import { Fragment, useMemo, type ReactNode } from 'react';
import { Anchor, Code, Divider, Stack, Text } from '@mantine/core';
import SectionCard from '@/components/common/SectionCard';
import { useTranslations } from '@/lib/i18n';
import type { IAgentInputField } from '@/lib/database/provider/types.domain';
import CopyableCode from './CopyableCode';
import { AGENT_DOCS_BASE_URL, buildAgentUsageSnippets, type AgentDocId } from './agentUsageSnippets';

export interface AgentUsagePanelProps {
  agentName: string;
  agentKey: string;
  /** The published version number; none while the agent was never published. */
  publishedVersion?: number | null;
  /** The inputs the agent declares (`config.inputs`). */
  inputs?: ReadonlyArray<IAgentInputField> | null;
  /** Scheme and host of this console. */
  origin: string;
  a2aEnabled: boolean;
  a2aCardUrl: string;
}

/** A sentence with `code` spans: what sits between backticks is drawn as code. */
export function withInlineCode(text: string): ReactNode {
  return text.split('`').map((part, index) => (
    <Fragment key={index}>{index % 2 === 1 ? <Code>{part}</Code> : part}</Fragment>
  ));
}

function Caption({ text }: { text: string }) {
  return <Text size="sm" c="dimmed">{withInlineCode(text)}</Text>;
}

/** What a snippet is for, and the snippet to copy. */
function Snippet({ caption, code }: { caption?: string; code: string }) {
  return (
    <Stack gap={6}>
      {caption ? <Caption text={caption} /> : null}
      <CopyableCode value={code} align="start" />
    </Stack>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <Text size="sm" fw={600}>{children}</Text>;
}

/**
 * The agent's Usage tab: how to call it from code. Runs API first (it is the one every other surface is a dialect
 * of), then the SDK, the OpenAI-compatible endpoints, A2A and the docs. The code itself comes from
 * `buildAgentUsageSnippets`; this component only lays it out.
 */
export default function AgentUsagePanel({
  agentName,
  agentKey,
  publishedVersion,
  inputs,
  origin,
  a2aEnabled,
  a2aCardUrl,
}: AgentUsagePanelProps) {
  const t = useTranslations('agents.usage');
  const snippets = useMemo(
    () => buildAgentUsageSnippets({ origin, agentKey, publishedVersion, inputs, a2aEnabled, a2aCardUrl }),
    [origin, agentKey, publishedVersion, inputs, a2aEnabled, a2aCardUrl],
  );
  const docUrl = (id: AgentDocId) => snippets.docs.find((link) => link.id === id)?.url ?? AGENT_DOCS_BASE_URL;

  return (
    <SectionCard p="md">
      <Stack gap="md">
        {/* ── Header ─────────────────────────────────────────── */}
        <Text size="lg" fw={600}>
          {t('title')}
        </Text>
        <Text size="sm" c="dimmed">
          {t('description', { name: agentName })}
        </Text>

        <Stack gap={6}>
          <Text size="sm" c="dimmed">{t('baseUrl')}</Text>
          <CopyableCode value={snippets.baseUrl} />
        </Stack>
        <Stack gap={6}>
          <Text size="sm" c="dimmed">{t('agentKey')}</Text>
          <CopyableCode value={snippets.agentKey} />
        </Stack>
        <Text size="sm">
          {withInlineCode(
            snippets.defaultVersion === null
              ? t('versionDraft')
              : t('versionPublished', { version: snippets.defaultVersion }),
          )}
        </Text>
        <Text size="sm">{withInlineCode(t('token'))}</Text>
        {snippets.hasInputs ? <Text size="sm">{withInlineCode(t('inputsNote'))}</Text> : null}
        <Anchor href={docUrl('runsApi')} target="_blank" rel="noopener noreferrer" size="sm">
          {t('referenceLink')}
        </Anchor>

        <Divider />

        {/* ── Runs API (REST) ────────────────────────────────── */}
        <SectionTitle>{t('runs.title')}</SectionTitle>
        <Caption text={t('runs.description')} />
        <Snippet caption={t('runs.start')} code={snippets.runs.start} />
        <Snippet caption={t('runs.answers')} code={snippets.runs.answers} />
        <Snippet caption={t('runs.follow')} code={snippets.runs.follow} />
        <Snippet caption={t('runs.session')} code={snippets.runs.session} />
        <Snippet caption={t('runs.stream')} code={snippets.runs.stream} />
        <Snippet caption={t('runs.later')} code={snippets.runs.later} />
        <Snippet caption={t('runs.version')} code={snippets.runs.version} />
        <Snippet caption={t('runs.structured')} code={snippets.runs.structured} />
        <Snippet caption={t('runs.list')} code={snippets.runs.list} />

        <Divider />

        {/* ── TypeScript SDK ─────────────────────────────────── */}
        <SectionTitle>{t('sdk.title')}</SectionTitle>
        <Caption text={t('sdk.description')} />
        <Snippet caption={t('sdk.install')} code={snippets.sdk.install} />
        <Snippet caption={t('sdk.start')} code={snippets.sdk.start} />
        <Snippet caption={t('sdk.options')} code={snippets.sdk.options} />
        <Snippet caption={t('sdk.later')} code={snippets.sdk.later} />
        <Snippet caption={t('sdk.structured')} code={snippets.sdk.structured} />
        <Snippet caption={t('sdk.follow')} code={snippets.sdk.follow} />
        <Snippet caption={t('sdk.chat')} code={snippets.sdk.chat} />
        <Snippet caption={t('sdk.routine')} code={snippets.sdk.routine} />

        <Divider />

        {/* ── OpenAI-compatible ──────────────────────────────── */}
        <SectionTitle>{t('openai.title')}</SectionTitle>
        <Caption text={t('openai.description', { key: agentKey })} />
        <Snippet caption={t('openai.responses')} code={snippets.openai.responses} />
        <Snippet caption={t('openai.background')} code={snippets.openai.background} />
        <Snippet caption={t('openai.chat')} code={snippets.openai.chat} />
        <Snippet caption={t('openai.chatCurl')} code={snippets.openai.chatCurl} />
        <Snippet caption={t('openai.models')} code={snippets.openai.models} />

        <Divider />

        {/* ── A2A ────────────────────────────────────────────── */}
        <SectionTitle>{t('a2a.title')}</SectionTitle>
        <Caption text={snippets.a2a.enabled ? t('a2a.enabled') : t('a2a.disabled')} />
        <Snippet caption={t('a2a.card')} code={snippets.a2a.card} />
        {snippets.a2a.send ? (
          <Snippet caption={snippets.hasInputs ? t('a2a.sendInputs') : t('a2a.send')} code={snippets.a2a.send} />
        ) : null}

        <Divider />

        {/* ── Docs ───────────────────────────────────────────── */}
        <SectionTitle>{t('docs.title')}</SectionTitle>
        <Caption text={t('docs.description')} />
        <Stack gap={4}>
          {snippets.docs.map((link) => (
            <Anchor key={link.id} href={link.url} target="_blank" rel="noopener noreferrer" size="sm">
              {t(`docs.${link.id}`)}
            </Anchor>
          ))}
        </Stack>
      </Stack>
    </SectionCard>
  );
}
