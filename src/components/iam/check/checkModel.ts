/**
 * Form model of the Access check tab: the editable form, its conversion to the
 * `/simulate` request (and back, for decision and deep-link prefills) and the
 * validation. Pure (no React); covered by unit tests.
 */

import type {
  AgentApprovers,
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
  /** The portal an agent is run through (`agent.invoke` / `agent.approve` in the portal channel); `portal.use` names its portal as the resource. */
  portal: ResourceRef | null;
  /** A session action: the person who started the session. */
  sessionOwner: PrincipalRef | null;
  /** A session action about a pending request: which answerers the agent accepts (`null` = its default). */
  approvers: AgentApprovers | null;
  /** Request context. */
  ctxProjectId: string | null;
  channel: IamChannel | null;
  ip: string;
  /** ISO timestamp; `null` = now. */
  at: string | null;
}

/** The action that runs an agent; in the portal channel it is asked about an agent run through a portal. */
export const INVOKE_ACTION = 'agent.invoke';

/** Answering a pending request of a session. */
export const APPROVE_ACTION = 'agent.approve';

/** The actions asked about the agent of a SESSION: who started it is part of the question. */
const SESSION_ACTIONS: readonly string[] = [APPROVE_ACTION, 'agent.session_view_others', 'agent.session_manage_others'];

export const isSessionAction = (id: string | null | undefined): boolean => !!id && SESSION_ACTIONS.includes(id);

/** The actions the portal runtime asks about in the portal channel: a token cannot be the principal of either. */
const PORTAL_RUNTIME_ACTIONS: readonly string[] = ['portal.use', INVOKE_ACTION, APPROVE_ACTION];

/** Actions that name the portal they are asked through when asked in the portal channel. */
const asksThroughPortal = (id: string | null | undefined): boolean => id === INVOKE_ACTION || id === APPROVE_ACTION;

/** Opening a portal: only ever asked in the portal channel, about the portal itself. */
const isPortalOnlyAction = (action: CatalogAction | undefined): boolean =>
  !!action && !!action.enforcedIn && action.enforcedIn.length > 0 && action.enforcedIn.every((c) => c === 'portal') && !asksThroughPortal(action.id);

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
    portal: null,
    sessionOwner: null,
    approvers: null,
    ctxProjectId: null,
    channel: defaultChannel(type),
    ip: '',
    at: null,
  };
}

export type CheckIssue = 'principal' | 'action' | 'service' | 'resourceType' | 'resource' | 'project' | 'portal' | 'ip';

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
  // Running an agent (or answering its request) in the portal channel is asked about the portal it is run through.
  if (asksThroughPortal(form.action) && form.channel === 'portal' && !form.portal) issues.push('portal');
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
    ...(asksThroughPortal(form.action) && form.channel === 'portal' && form.portal ? { portalId: form.portal.id } : {}),
    ...(isSessionAction(form.action) && form.sessionOwner ? { ownerId: form.sessionOwner.id } : {}),
    ...(form.action === APPROVE_ACTION && form.approvers ? { approvers: form.approvers } : {}),
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
  labels: { principal?: string; resource?: string; portal?: string } = {},
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
  form.portal = c.portalId ? { type: 'portal', id: c.portalId, label: labels.portal || c.portalId } : null;
  form.sessionOwner = c.ownerId ? { id: c.ownerId, label: c.ownerId } : null;
  form.approvers = c.approvers ?? null;
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
 *
 * Opening a portal is only ever asked in the portal channel, by a person: choosing
 * it moves a still-default channel there, and choosing something else moves it
 * back. A portal picked for running an agent belongs to that action alone.
 */
export function applyAction(form: CheckForm, action: CatalogAction | undefined, previous?: CatalogAction): CheckForm {
  const next: CheckForm = { ...form, action: action?.id ?? null };
  if (!asksThroughPortal(action?.id)) next.portal = null;
  if (!isSessionAction(action?.id)) next.sessionOwner = null;
  if (action?.id !== APPROVE_ACTION) next.approvers = null;
  if (isPortalOnlyAction(action)) {
    const wasDefault = form.channel === null || form.channel === defaultChannel(form.principalType);
    if (form.principalType === 'user' && wasDefault) next.channel = 'portal';
  } else if (form.channel === 'portal' && (isPortalOnlyAction(previous) || (asksThroughPortal(previous?.id) && form.portal && !asksThroughPortal(action?.id)))) {
    // The portal channel came with the previous action: it goes with it.
    next.channel = defaultChannel(form.principalType);
  }
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

/**
 * Choosing the portal an agent is run through puts the check in the portal channel
 * (while the channel was still the default); clearing it puts the channel back.
 */
export function applyPortal(form: CheckForm, portal: ResourceRef | null): CheckForm {
  const next: CheckForm = { ...form, portal };
  if (portal && form.principalType === 'user' && (form.channel === null || form.channel === defaultChannel(form.principalType))) {
    next.channel = 'portal';
  } else if (!portal && form.channel === 'portal') {
    next.channel = defaultChannel(form.principalType);
  }
  return next;
}

/**
 * Changing the principal type keeps the action and resource but drops the (now
 * wrong) principal. A token cannot open portals or run agents through them, so
 * for those two actions it leaves the portal channel (and the portal) behind.
 */
export function applyPrincipalType(form: CheckForm, type: CheckPrincipalType): CheckForm {
  if (form.principalType === type) return form;
  const channelWasDefault = form.channel === defaultChannel(form.principalType);
  const leavesPortal = type === 'token' && form.channel === 'portal' && !!form.action && PORTAL_RUNTIME_ACTIONS.includes(form.action);
  return {
    ...form,
    principalType: type,
    principal: null,
    channel: channelWasDefault || leavesPortal ? defaultChannel(type) : form.channel,
    portal: leavesPortal ? null : form.portal,
  };
}
