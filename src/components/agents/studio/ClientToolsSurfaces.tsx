'use client';

/**
 * Where the agent's client tools are offered — one switch per surface, all on
 * by default. The list under the switches is the whole truth: no other surface
 * ever gets them.
 */

import { Stack, Switch, Text } from '@mantine/core';
import type { IAgentClientToolSurfaces } from '@/lib/database/provider/types.domain';
import { useTranslations } from '@/lib/i18n';
import { ConfigBlock } from './ConfigSection';

export interface ClientToolsSurfacesProps {
    value: IAgentClientToolSurfaces | undefined;
    onChange: (next: IAgentClientToolSurfaces | undefined) => void;
}

const SURFACES = ['api', 'playground', 'portal'] as const;

/** Only a surface switched OFF is stored; none off = no object at all. */
export function setSurface(
    value: IAgentClientToolSurfaces | undefined,
    surface: (typeof SURFACES)[number],
    on: boolean,
): IAgentClientToolSurfaces | undefined {
    const next: IAgentClientToolSurfaces = { ...(value ?? {}) };
    if (on) delete next[surface];
    else next[surface] = false;
    return Object.keys(next).length > 0 ? next : undefined;
}

export default function ClientToolsSurfaces({ value, onChange }: ClientToolsSurfacesProps) {
    const t = useTranslations('agents.clientTools');
    return (
        <ConfigBlock title={t('surfacesTitle')}>
            <Stack gap="sm">
                {SURFACES.map((surface) => (
                    <Switch
                        key={surface}
                        label={t(`surface_${surface}`)}
                        description={t(`surface_${surface}_description`)}
                        checked={value?.[surface] !== false}
                        onChange={(event) => onChange(setSurface(value, surface, event.currentTarget.checked))}
                    />
                ))}
                <Text size="xs" c="dimmed">{t('surfacesNever')}</Text>
            </Stack>
        </ConfigBlock>
    );
}
