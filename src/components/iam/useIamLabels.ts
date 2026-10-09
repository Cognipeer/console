'use client';

/**
 * Human labels for the catalog's ids (services, actions, resource types,
 * levels, channels...). The catalog carries i18n keys (`labelKey`); a key that
 * does not resolve falls back to the product's own wording, so a label is never
 * a raw key. Everything else the center prints about an id goes through here.
 */

import { useMemo } from 'react';
import { useTranslations } from '@/lib/i18n';
import type { IamAuthzMode, IamCatalog, IamPolicyEffect, IamPolicyMode } from './api';
import { rbacServiceLabel } from './catalogModel';

type Values = Record<string, string | number | undefined | null>;
export type TranslateFn = (key: string, values?: Values) => string;

export interface IamLabels {
  /** A server-provided i18n key (`iamApi.managed.*`...) when it resolves, else `undefined`. */
  lookup(key: string | undefined): string | undefined;
  /** Plain-language name of a built-in policy (translated when the server's key resolves). */
  managedName(cedarId: string, fallback: string): string;
  service(id: string): string;
  resourceType(type: string): string;
  /** Full label of a catalog action, e.g. "Agents · Read" or "All write actions". */
  action(id: string): string;
  level(level: string): string;
  verb(verb: string): string;
  channel(channel: string): string;
  effect(effect: IamPolicyEffect): string;
  mode(mode: IamPolicyMode): string;
  authzMode(mode: IamAuthzMode): string;
  /** A short description of whatever the server sent as a resource reference. */
  resource(resource: unknown): string;
}

const NS = 'iamCenter';

/** `managed:rbac:user-read` -> `rbac-user-read`: the key segment the server uses for a built-in policy's texts. */
export function managedSlug(cedarId: string): string {
  return cedarId.replace(/^managed:/, '').replace(/[^A-Za-z0-9]+/g, '-');
}

function titleCase(id: string): string {
  const spaced = id.replace(/[-_.]+/g, ' ').trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : id;
}

/** Pure so tests can drive it with a fake translator. `t` is namespaced to `iamCenter`, `root` is not. */
export function buildLabels(t: TranslateFn, root: TranslateFn, catalog: IamCatalog | null): IamLabels {
  const own = (key: string, values?: Values): string | undefined => {
    const v = t(key, values);
    return v === `${NS}.${key}` || v === key ? undefined : v;
  };
  const rooted = (key: string, values?: Values): string | undefined => {
    if (!key) return undefined;
    const v = root(key, values);
    return v === key ? undefined : v;
  };

  const services = new Map((catalog?.services ?? []).map((s) => [s.id, s]));
  const types = new Map((catalog?.resourceTypes ?? []).map((x) => [x.type, x]));
  const actions = new Map((catalog?.actions ?? []).map((a) => [a.id, a]));

  const service = (id: string): string =>
    rooted(services.get(id)?.labelKey ?? '') ?? services.get(id)?.label ?? rbacServiceLabel(id) ?? titleCase(id);
  const resourceType = (type: string): string =>
    rooted(types.get(type)?.labelKey ?? '') ?? rooted(`resources.types.${type}`) ?? titleCase(type);
  const level = (value: string): string => own(`levels.${value}`) ?? titleCase(value);
  const verb = (value: string): string => own(`verbs.${value}`) ?? titleCase(value);

  return {
    lookup: (key) => (key ? rooted(key) : undefined),
    managedName: (cedarId, fallback) => rooted(`iamApi.managed.${managedSlug(cedarId)}.name`) ?? fallback,
    service,
    resourceType,
    level,
    verb,
    action(id) {
      const a = actions.get(id);
      if (!a) return id;
      if (a.kind === 'group') return own(`actionGroups.${a.level}`) ?? id;
      if (a.kind === 'service') return `${service(a.service ?? '')} · ${level(a.level)}`;
      return `${resourceType(a.resourceType ?? '')} · ${verb(a.verb ?? '')}`;
    },
    channel: (c) => own(`channels.${c}`) ?? titleCase(c),
    effect: (e) => own(`effects.${e}`) ?? e,
    mode: (m) => own(`modes.${m}`) ?? m,
    authzMode: (m) => own(`authzModes.${m}`) ?? m,
    resource(resource) {
      if (typeof resource === 'string') return resource;
      if (!resource || typeof resource !== 'object') return '—';
      const r = resource as Record<string, unknown>;
      const s = (v: unknown) => (typeof v === 'string' ? v : '');
      if (r.kind === 'project' || (!r.kind && s(r.projectId))) {
        return `${own('resourceKinds.project') ?? 'Project'}: ${s(r.projectId)}`;
      }
      if (r.kind === 'service' || (!r.kind && s(r.service) && !s(r.type))) return service(s(r.service));
      if (s(r.type)) return `${resourceType(s(r.type))}: ${s(r.id) || s(r.key)}`;
      return '—';
    },
  };
}

export function useIamLabels(catalog: IamCatalog | null): IamLabels {
  const t = useTranslations(NS);
  const root = useTranslations();
  return useMemo(() => buildLabels(t, root, catalog), [t, root, catalog]);
}
