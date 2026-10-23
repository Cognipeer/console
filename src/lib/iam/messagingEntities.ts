/**
 * Entities of the messaging rules: a ChannelDeployment that carries its ACCESS LIST, and an Agent that is
 * run through one (Slack / Microsoft Teams, enterprise).
 *
 * The same design as the portal's (portalEntities.ts), minus what a deployment does not have (networks, embed):
 * nothing is stored per deployment, the managed messaging policies (managedPolicies.ts) read three attributes of
 * the ChannelDeployment entity,
 *
 *   mode          'all' (everyone in the workspace) | 'selected'
 *   allowedUsers  Set<User>   the people named on the list
 *   allowedGroups Set<Group>  the groups named on the list
 *
 * and an Agent run through the deployment is `in` it and names it in `channelDeployment`. The list is built by the
 * portal's own `accessAttrs`, so the typed-reference rule and the slicing of a long list to the requester (above
 * PORTAL_ENTITY_SLICE_THRESHOLD entries) are the same code, not a copy. Pure and synchronous: reading the list from
 * the channels feature is the resolver seam (@/enterprise/iam-messaging) or the caller's.
 */

import { resourceEntityTypeName } from './actions';
import type { CedarEntity } from './cedar';
import { resourceEntities, type IamResource } from './entities';
import { accessAttrs, type PortalRequester } from './portalEntities';

const DEPLOYMENT_TYPE = 'channel-deployment';
const AGENT_TYPE = 'agent';
const DEPLOYMENT_SERVICE = 'channels';
const AGENT_SERVICE = 'agents';

const entityRef = (type: string, id: string) => ({ __entity: { type, id } });

/** Whoever asks: enough to cut a list down to what concerns them (the same shape the portal uses). */
export type MessagingRequester = PortalRequester;

/** A deployment's access list (the engine facts of the seam: `IamMessagingAccessFacts`). */
export interface MessagingAccessInput {
  mode: 'all' | 'selected';
  userIds: readonly string[];
  groupIds: readonly string[];
}

export interface MessagingDeploymentSubject {
  id: string;
  access: MessagingAccessInput;
}

export interface MessagingAgentSubject {
  /** The agent's resource id (the registry id, the same one `agent.get` is asked about). */
  id: string;
  key?: string;
  projectId?: string | null;
}

/** The ChannelDeployment as a Cedar entity (what an agent resource sends along as `extra`). */
export function messagingDeploymentEntity(deployment: MessagingDeploymentSubject, requester?: MessagingRequester): CedarEntity {
  const { entities } = resourceEntities({
    kind: 'resource',
    type: DEPLOYMENT_TYPE,
    id: deployment.id,
    service: DEPLOYMENT_SERVICE,
    attrs: accessAttrs({ mode: deployment.access.mode, userIds: [...deployment.access.userIds], groupIds: [...deployment.access.groupIds] }, requester),
  });
  return entities[0];
}

/**
 * The resource of `agent.invoke` in the messaging channel: the agent, `in` the deployment it is run through and naming
 * it, with the deployment (and its access list) sent along.
 */
export function messagingAgentResource(
  agent: MessagingAgentSubject,
  deployment: MessagingDeploymentSubject,
  requester?: MessagingRequester,
): IamResource {
  const deploymentType = resourceEntityTypeName(DEPLOYMENT_TYPE);
  return {
    kind: 'resource',
    type: AGENT_TYPE,
    id: agent.id,
    service: AGENT_SERVICE,
    projectId: agent.projectId ?? null,
    ...(agent.key ? { key: agent.key } : {}),
    parents: [{ type: deploymentType, id: deployment.id }],
    attrs: { channelDeployment: entityRef(deploymentType, deployment.id) },
    extra: [messagingDeploymentEntity(deployment, requester)],
  };
}
