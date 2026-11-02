'use client';

/** The detail of a template: what it is for, what using it creates, what the project still lacks. */

import { Alert, Badge, Button, Drawer, Loader, Table } from '@mantine/core';
import { IconAlertTriangle, IconCheck } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import styles from './AgentTemplatesPage.module.css';
import { TemplateIcon } from './templateIcons';
import { connectorPackages, describeContents, describeTrigger, isUsable } from './templatesModel';
import { useTemplateDetail } from './useTemplateDetail';

export interface TemplateDetailDrawerProps {
  templateKey: string | null;
  onClose: () => void;
  onUse: (templateKey: string) => void;
}

export default function TemplateDetailDrawer({ templateKey, onClose, onUse }: TemplateDetailDrawerProps) {
  const t = useTranslations('agentTemplates');
  const { template, loading, failed } = useTemplateDetail(templateKey);
  const contents = template ? describeContents(template) : null;
  const usable = template ? isUsable(template) : false;

  return (
    <Drawer
      opened={Boolean(templateKey)}
      onClose={onClose}
      position="right"
      size="lg"
      padding="lg"
      title={
        template ? (
          <span className="ds-row ds-gap-sm">
            <TemplateIcon name={template.icon} />
            <strong>{t(`items.${template.key}.name`)}</strong>
            <span className="ds-muted" style={{ fontSize: 12 }}>
              {t(`categories.${template.category}`)} · {t('ui.drawer.version', { version: template.version })}
            </span>
            <Badge size="xs" variant="light" color={template.availability.status === 'ready' ? 'teal' : template.availability.status === 'unavailable' ? 'gray' : 'yellow'}>
              {t(`availability.status.${template.availability.status}`)}
            </Badge>
          </span>
        ) : ''
      }
    >
      {loading ? <div className="ds-empty"><Loader size="sm" aria-label={t('ui.drawer.loading')} /></div> : null}
      {failed ? <Alert color="red">{t('ui.drawer.loadFailed')}</Alert> : null}
      {template && contents ? (
        <div>
          <p style={{ fontSize: 13.5, lineHeight: 1.55 }}>{t(`items.${template.key}.description`)}</p>
          <ul style={{ fontSize: 13, paddingLeft: 18, margin: '8px 0 16px' }} aria-label={t('ui.drawer.useCases')}>
            {[0, 1, 2].map((i) => <li key={i}>{t(`items.${template.key}.useCases.${i}`)}</li>)}
          </ul>

          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>{t('ui.drawer.whatYouGet')}</h3>
            <div className={styles.kv}>
              <span className={styles.kvLabel}>{t('ui.drawer.model')}</span>
              <span>{t('ui.drawer.modelLine', { hint: t(`modelHints.${template.modelHint}`) })}</span>
              {contents.tools.length > 0 ? (
                <>
                  <span className={styles.kvLabel}>{t('ui.drawer.tools')}</span>
                  <span>{contents.tools.join(', ')}</span>
                </>
              ) : null}
              {template.requires.knowledge ? (
                <>
                  <span className={styles.kvLabel}>{t('ui.drawer.knowledge')}</span>
                  <span>{template.requires.knowledge === 'required' ? t('ui.drawer.knowledgeRequired') : t('ui.drawer.knowledgeOptional')}</span>
                </>
              ) : null}
              {template.requires.webSearch ? (
                <>
                  <span className={styles.kvLabel}>{t('ui.drawer.webSearch')}</span>
                  <span>{t('capabilities.web_search')}</span>
                </>
              ) : null}
              {contents.needsSandbox ? (
                <>
                  <span className={styles.kvLabel}>{t('ui.drawer.sandbox')}</span>
                  <span>{t('ui.drawer.sandboxRequired')}</span>
                </>
              ) : null}
              {contents.guardrailsRecommended ? (
                <>
                  <span className={styles.kvLabel}>{t('ui.drawer.guardrails')}</span>
                  <span>{t('ui.drawer.guardrailsRecommended')}</span>
                </>
              ) : null}
              {contents.skills.length > 0 ? (
                <>
                  <span className={styles.kvLabel}>{t('ui.drawer.skills')}</span>
                  <span>{contents.skills.map((skill) => skill.title).join(', ')}</span>
                </>
              ) : null}
              {contents.subagents.length > 0 ? (
                <>
                  <span className={styles.kvLabel}>{t('ui.drawer.subagents')}</span>
                  <span>
                    {contents.subagents.map((sub) => (
                      <div key={sub.name}><strong>{sub.title}</strong>{sub.header ? <span className="ds-muted"> — {sub.header}</span> : null}</div>
                    ))}
                  </span>
                </>
              ) : null}
              {contents.outputFields.length > 0 ? (
                <>
                  <span className={styles.kvLabel}>{t('ui.drawer.structuredOutput')}</span>
                  <span>{contents.outputFields.join(', ')}</span>
                </>
              ) : null}
              <span className={styles.kvLabel}>{t('ui.drawer.surfaces')}</span>
              <span>{template.surfaces.map((surface) => t(`surfaces.${surface}`)).join(' · ')}</span>
            </div>
          </section>

          {contents.variables.length > 0 ? (
            <section className={styles.section}>
              <h3 className={styles.sectionTitle}>{t('ui.drawer.variables')}</h3>
              <Table withTableBorder fz="xs">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t('ui.drawer.variableName')}</Table.Th>
                    <Table.Th>{t('ui.drawer.variableType')}</Table.Th>
                    <Table.Th>{t('ui.drawer.variableDefault')}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {contents.variables.map((variable) => (
                    <Table.Tr key={variable.name}>
                      <Table.Td><code>{variable.name}</code></Table.Td>
                      <Table.Td>{variable.type}</Table.Td>
                      <Table.Td>{variable.default ?? t('ui.drawer.noDefault')}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </section>
          ) : null}

          {template.triggers.length > 0 ? (
            <section className={styles.section}>
              <h3 className={styles.sectionTitle}>{t('ui.drawer.triggers')}</h3>
              <ul style={{ fontSize: 13, paddingLeft: 18, margin: 0 }}>
                {template.triggers.map((trigger) => {
                  const line = describeTrigger(trigger);
                  return (
                    <li key={trigger.name}>
                      <strong>{trigger.name}</strong>
                      <span className="ds-muted"> — {line.kind === 'schedule'
                        ? t('ui.trigger.schedule', { cron: line.cron })
                        : line.kind === 'webhook'
                          ? t('ui.trigger.webhook', { preset: line.preset }) + (line.events.length ? ` (${t('ui.trigger.events', { events: line.events.join(', ') })})` : '')
                          : line.kind === 'connector'
                            ? t('ui.trigger.connector', { package: line.package, trigger: line.trigger }) + (line.events.length ? ` (${t('ui.trigger.events', { events: line.events.join(', ') })})` : '')
                            : t('ui.trigger.manual')}</span>
                    </li>
                  );
                })}
              </ul>
              <p className="ds-muted" style={{ fontSize: 12, marginTop: 6 }}>{t('ui.drawer.triggersNote')}</p>
              {connectorPackages(template).length > 0 ? (
                <p className="ds-muted" style={{ fontSize: 12, marginTop: 4 }}>{t('ui.drawer.triggersConnectorNote')}</p>
              ) : null}
            </section>
          ) : null}

          {contents.clientTools.length > 0 ? (
            <Alert color="blue" mb="md" variant="light">
              {t('hints.clientTools', { tools: contents.clientTools.join(', ') })}
            </Alert>
          ) : null}

          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>{t('ui.drawer.setup')}</h3>
            {template.availability.items.length === 0 ? (
              <div className="ds-row ds-gap-sm" style={{ fontSize: 13 }}><IconCheck size={14} color="var(--mantine-color-teal-6)" />{t('ui.drawer.setupReady')}</div>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: 13 }}>
                {template.availability.items.map((item) => (
                  <li key={item.code} className="ds-row ds-gap-sm" style={{ alignItems: 'flex-start', marginBottom: 4 }}>
                    <IconAlertTriangle size={14} color={item.severity === 'blocker' ? 'var(--mantine-color-red-6)' : 'var(--mantine-color-yellow-7)'} style={{ flex: 'none', marginTop: 2 }} />
                    <span>
                      {t(`availability.items.${item.code}`)}
                      {item.code === 'sandbox_unavailable' && item.detail ? ` ${t(`availability.sandboxReasons.${item.detail}`)}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <details className={styles.section}>
            <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>{t('ui.drawer.systemPrompt')}</summary>
            <pre className={styles.prompt}>{(template.spec as { systemPrompt?: string }).systemPrompt ?? ''}</pre>
          </details>

          <div className="ds-row ds-gap-sm" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
            {!usable ? <span className="ds-muted" style={{ fontSize: 12 }}>{t('ui.drawer.unavailable')}</span> : null}
            <Button variant="default" onClick={onClose}>{t('ui.drawer.close')}</Button>
            <Button color="teal" disabled={!usable} onClick={() => onUse(template.key)}>{t('ui.drawer.useTemplate')}</Button>
          </div>
        </div>
      ) : null}
    </Drawer>
  );
}
