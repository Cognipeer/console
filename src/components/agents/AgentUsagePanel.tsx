'use client';

import { Fragment, useMemo, type MouseEvent, type ReactNode } from 'react';
import { Anchor, Code, Divider, Group, Stack, Text } from '@mantine/core';
import LoadingState from '@/components/common/LoadingState';
import SectionCard from '@/components/common/SectionCard';
import { useTranslations } from '@/lib/i18n';
import type { IAgentVariable } from '@/lib/database/provider/types.domain';
import CopyableCode from './CopyableCode';
import { buildAgentUsageSnippets, type SdkReuse } from './agentUsageSnippets';

export interface AgentUsagePanelProps {
  agentName: string;
  agentKey: string;
  /** The published version number; none while the agent was never published. */
  publishedVersion?: number | null;
  /** The variables a call has to supply: the published snapshot's, the draft's only while nothing is published. */
  variables?: ReadonlyArray<IAgentVariable> | null;
  /** The published snapshot is still being fetched, so the variables are not known yet: show no samples. */
  variablesLoading?: boolean;
  /** Scheme and host of this console. */
  origin: string;
  a2aEnabled: boolean;
  /** The JSON-RPC endpoint of the agent (the token route, or the public one while it is exposed publicly). */
  a2aEndpointUrl: string;
  /** The agent is exposed publicly: its endpoint takes no token. */
  a2aIsPublic: boolean;
}

/** The sections of the tab, in page order: the links of the nav at the top and the `id` of each section. */
export const USAGE_SECTIONS = ['runs', 'sdk', 'openai', 'a2a', 'docs'] as const;
type UsageSection = (typeof USAGE_SECTIONS)[number];

export const usageSectionId = (section: UsageSection): string => `agent-usage-${section}`;

/** A sentence with `code` spans: what sits between backticks is drawn as code. */
export function withInlineCode(text: string): ReactNode {
  return text.split('`').map((part, index) => (
    <Fragment key={index}>{index % 2 === 1 ? <Code>{part}</Code> : part}</Fragment>
  ));
}

function Caption({ text }: { text: string }) {
  return <Text size="sm" c="dimmed">{withInlineCode(text)}</Text>;
}

/** What a snippet is for, and the snippet to copy. `reuses` is what it uses from the snippets above it. */
function Snippet({ caption, reuses, code }: { caption?: string; reuses?: string; code: string }) {
  const text = [caption, reuses].filter(Boolean).join(' ');
  return (
    <Stack gap={6}>
      {text ? <Caption text={text} /> : null}
      <CopyableCode value={code} align="start" />
    </Stack>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <Text size="sm" fw={600}>{children}</Text>;
}

/** One section of the tab: the address its link in the nav jumps to, then its title and its content. */
function Section({ section, title, children }: { section: UsageSection; title: string; children: ReactNode }) {
  return (
    <Stack gap="md" id={usageSectionId(section)} style={{ scrollMarginTop: 16 }}>
      <SectionTitle>{title}</SectionTitle>
      {children}
    </Stack>
  );
}

/** A plain anchor (it works without script); with script the jump is smooth. */
function jumpTo(event: MouseEvent<HTMLAnchorElement>, section: UsageSection) {
  const target = document.getElementById(usageSectionId(section));
  if (!target) return;
  event.preventDefault();
  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
  variables,
  variablesLoading,
  origin,
  a2aEnabled,
  a2aEndpointUrl,
  a2aIsPublic,
}: AgentUsagePanelProps) {
  const t = useTranslations('agents.usage');
  const snippets = useMemo(
    () => buildAgentUsageSnippets({ origin, agentKey, publishedVersion, variables, a2aEnabled, a2aEndpointUrl, a2aIsPublic }),
    [origin, agentKey, publishedVersion, variables, a2aEnabled, a2aEndpointUrl, a2aIsPublic],
  );
  // What an SDK example uses from the ones above it, named in its caption (`client`, `done`, ...).
  const reuses = (names: SdkReuse[]) => t('sdk.reuses', { names: names.map((name) => `\`${name}\``).join(', ') });

  if (variablesLoading) {
    return (
      <SectionCard p="md">
        <LoadingState minHeight={320} />
      </SectionCard>
    );
  }

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

        <nav aria-label={t('nav.label')}>
          <Group gap="md">
            {USAGE_SECTIONS.map((section) => (
              <Anchor key={section} href={`#${usageSectionId(section)}`} size="sm" onClick={(event) => jumpTo(event, section)}>
                {t(`nav.${section}`)}
              </Anchor>
            ))}
          </Group>
        </nav>

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
        {snippets.hasVariables ? <Text size="sm">{withInlineCode(t('variablesNote'))}</Text> : null}
        <Anchor href={snippets.referenceUrl} target="_blank" rel="noopener noreferrer" size="sm">
          {t('referenceLink')}
        </Anchor>

        <Divider />

        {/* ── Runs API (REST) ────────────────────────────────── */}
        <Section section="runs" title={t('runs.title')}>
          <Caption text={t('runs.description')} />
          <Snippet caption={t('runs.start')} code={snippets.runs.start} />
          <Snippet caption={t('runs.answers')} code={snippets.runs.answers} />
          <Snippet caption={t('runs.poll')} code={snippets.runs.poll} />
          <Snippet caption={t('runs.events')} code={snippets.runs.events} />
          <Snippet caption={t('runs.cancel')} code={snippets.runs.cancel} />
          <Snippet caption={t('runs.session')} code={snippets.runs.session} />
          <Snippet caption={t('runs.stream')} code={snippets.runs.stream} />
          <Snippet caption={t('runs.later')} code={snippets.runs.later} />
          <Snippet caption={t('runs.version')} code={snippets.runs.version} />
          <Snippet caption={t('runs.structured')} code={snippets.runs.structured} />
          <Snippet caption={t('runs.list')} code={snippets.runs.list} />
        </Section>

        <Divider />

        {/* ── TypeScript SDK ─────────────────────────────────── */}
        <Section section="sdk" title={t('sdk.title')}>
          <Caption text={t('sdk.description')} />
          <Snippet caption={t('sdk.install')} code={snippets.sdk.install} />
          <Snippet caption={t('sdk.start')} code={snippets.sdk.start} />
          <Snippet caption={t('sdk.options')} reuses={reuses(snippets.sdkReuses.options)} code={snippets.sdk.options} />
          <Snippet caption={t('sdk.later')} reuses={reuses(snippets.sdkReuses.later)} code={snippets.sdk.later} />
          <Snippet caption={t('sdk.structured')} reuses={reuses(snippets.sdkReuses.structured)} code={snippets.sdk.structured} />
          <Snippet caption={t('sdk.follow')} reuses={reuses(snippets.sdkReuses.follow)} code={snippets.sdk.follow} />
          <Snippet caption={t('sdk.manage')} reuses={reuses(snippets.sdkReuses.manage)} code={snippets.sdk.manage} />
          <Snippet caption={t('sdk.chat')} reuses={reuses(snippets.sdkReuses.chat)} code={snippets.sdk.chat} />
          <Snippet caption={t('sdk.trigger')} reuses={reuses(snippets.sdkReuses.trigger)} code={snippets.sdk.trigger} />
        </Section>

        <Divider />

        {/* ── OpenAI-compatible ──────────────────────────────── */}
        <Section section="openai" title={t('openai.title')}>
          <Caption text={t('openai.description', { key: agentKey })} />
          <Snippet caption={t('openai.responses')} code={snippets.openai.responses} />
          <Snippet caption={t('openai.background')} code={snippets.openai.background} />
          <Snippet caption={t('openai.chat')} code={snippets.openai.chat} />
          <Snippet caption={t('openai.chatCurl')} code={snippets.openai.chatCurl} />
          <Snippet caption={t('openai.models')} code={snippets.openai.models} />
        </Section>

        <Divider />

        {/* ── A2A ────────────────────────────────────────────── */}
        <Section section="a2a" title={t('a2a.title')}>
          <Caption text={snippets.a2a.enabled ? t('a2a.enabled') : t('a2a.disabled')} />
          <Snippet caption={t('a2a.card')} code={snippets.a2a.card} />
          {snippets.a2a.send ? (
            <Snippet caption={snippets.hasVariables ? t('a2a.sendVariables') : t('a2a.send')} code={snippets.a2a.send} />
          ) : null}
        </Section>

        <Divider />

        {/* ── Docs ───────────────────────────────────────────── */}
        <Section section="docs" title={t('docs.title')}>
          <Caption text={t('docs.description')} />
          <Stack gap={4}>
            {snippets.docs.map((link) => (
              <Anchor key={link.id} href={link.url} target="_blank" rel="noopener noreferrer" size="sm">
                {t(`docs.${link.id}`)}
              </Anchor>
            ))}
          </Stack>
        </Section>
      </Stack>
    </SectionCard>
  );
}
