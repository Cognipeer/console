/**
 * Form model of the Access check tab: the editable form, its conversion to the
 * `/simulate` request (and back, for decision and deep-link prefills) and the
 * validation. Pure (no React); covered by unit tests.
 */

import type {
  CatalogAction,
  IamChannel,
  SimulateContext,
  SimulateRequest,
  SimulateResource,
} from '../api';
import { isValidIp } from '../ipRanges';
import type { PrincipalRef, ResourceRef } from '../policies/specModel';

export type CheckPrincipalType = 'user' | 'token';
export type CheckResourceKind = 'service' | 'resource' | 'project';

export interface CheckForm {
  principalType: CheckPrincipalType;
  principal: PrincipalRef | null;
  action: string | null;
  resourceKind: CheckResourceKind;
  /** Resource kind `service`. */
  service: string | null;
  /** Resource kind `resource`. */
  resourceType: string | null;
  resource: ResourceRef | null;
  /** Resource kind `project`. */
  projectResource: string | null;
  /** Request context. */
  ctxProjectId: string | null;
  channel: IamChannel | null;
  ip: string;
  /** ISO timestamp; `null` = now. */
  at: string | null;
}

/** The channel a request normally arrives on: a person uses the dashboard, a token calls the API. */
export function defaultChannel(type: CheckPrincipalType): IamChannel {
  return type === 'token' ? 'api' : 'dashboard';
}

export function emptyForm(type: CheckPrincipalType = 'user'): CheckForm {
  return {
    principalType: type,
    principal: null,
    action: null,
    resourceKind: 'service',
    service: null,
    resourceType: null,
    resource: null,
    projectResource: null,
    ctxProjectId: null,
    channel: defaultChannel(type),
    ip: '',
    at: null,
  };
}

export type CheckIssue = 'principal' | 'action' | 'service' | 'resourceType' | 'resource' | 'project' | 'ip';

export function validateForm(form: CheckForm): CheckIssue[] {
  const issues: CheckIssue[] = [];
  if (!form.principal) issues.push('principal');
  if (!form.action) issues.push('action');
  if (form.resourceKind === 'service' && !form.service) issues.push('service');
  if (form.resourceKind === 'resource') {
    if (!form.resourceType) issues.push('resourceType');
    else if (!form.resource) issues.push('resource');
  }
  if (form.resourceKind === 'project' && !form.projectResource) issues.push('project');
  if (form.ip.trim() !== '' && !isValidIp(form.ip)) issues.push('ip');
  return issues;
}

export function formToResource(form: CheckForm): SimulateResource | null {
  if (form.resourceKind === 'service') {
    return form.service ? { kind: 'service', service: form.service } : null;
  }
  if (form.resourceKind === 'resource') {
    return form.resourceType && form.resource
      ? { kind: 'resource', type: form.resourceType, id: form.resource.id }
      : null;
  }
  return form.projectResource ? { kind: 'project', projectId: form.projectResource } : null;
}

/** `null` while the form is incomplete or invalid. */
export function formToRequest(form: CheckForm): SimulateRequest | null {
  if (validateForm(form).length > 0 || !form.principal || !form.action) return null;
  const resource = formToResource(form);
  if (!resource) return null;
  const context: SimulateContext = {
    ...(form.ctxProjectId ? { projectId: form.ctxProjectId } : {}),
    ...(form.channel ? { channel: form.channel } : {}),
    ...(form.ip.trim() ? { ip: form.ip.trim() } : {}),
    ...(form.at ? { at: form.at } : {}),
  };
  return {
    principal: { type: form.principalType, id: form.principal.id },
    action: form.action,
    resource,
    ...(Object.keys(context).length ? { context } : {}),
  };
}

/** Rebuilds the form from a request (a decision's `simulateInput`). Labels are the best known names. */
export function requestToForm(
  request: SimulateRequest,
  labels: { principal?: string; resource?: string } = {},
): CheckForm {
  const form = emptyForm(request.principal.type);
  form.principal = { id: request.principal.id, label: labels.principal || request.principal.id };
  form.action = request.action;
  const r = request.resource;
  if (r.kind === 'service') {
    form.resourceKind = 'service';
    form.service = r.service;
  } else if (r.kind === 'resource') {
    form.resourceKind = 'resource';
    form.resourceType = r.type;
    form.resource = { type: r.type, id: r.id, label: labels.resource || r.id };
  } else {
    form.resourceKind = 'project';
    form.projectResource = r.projectId;
  }
  const c = request.context ?? {};
  form.ctxProjectId = c.projectId ?? null;
  form.channel = c.channel ?? null;
  form.ip = c.ip ?? '';
  form.at = c.at ?? null;
  return form;
}

/**
 * Choosing an action implies what it is checked on (the access check refuses
 * any other pairing): a service action on the service it is named after, a
 * resource action on a resource of its type (an existing one, or a new one in a
 * project). Returns the form with the target adjusted; a resource that still
 * fits the new action is kept.
 */
export function applyAction(form: CheckForm, action: CatalogAction | undefined): CheckForm {
  const next: CheckForm = { ...form, action: action?.id ?? null };
  if (!action) return next;
  if (action.kind === 'service') {
    next.resourceKind = 'service';
    next.service = action.service ?? form.service;
    // A project target of a service action is just the project context of the whole-service check.
    if (form.resourceKind === 'project' && form.projectResource) {
      next.ctxProjectId = form.ctxProjectId ?? form.projectResource;
      next.projectResource = null;
    }
  } else if (action.kind === 'resource' && action.resourceType) {
    next.resourceKind = form.resourceKind === 'project' ? 'project' : 'resource';
    if (form.resourceType !== action.resourceType) {
      next.resourceType = action.resourceType;
      next.resource = null;
    }
  }
  return next;
}

/** Changing the principal type keeps the action and resource but drops the (now wrong) principal. */
export function applyPrincipalType(form: CheckForm, type: CheckPrincipalType): CheckForm {
  if (form.principalType === type) return form;
  const channelWasDefault = form.channel === defaultChannel(form.principalType);
  return {
    ...form,
    principalType: type,
    principal: null,
    channel: channelWasDefault ? defaultChannel(type) : form.channel,
  };
}
