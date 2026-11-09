/**
 * "Who can use it": the access list of a shared resource (an MCP server, a skill), edited on the resource's own form
 * (components/access/AccessListFields.tsx). The `resourceAccess` namespace in `en.ts`.
 */
export const resourceAccessEn = {
  title: 'Who can use it',
  description: 'Decides whose agent runs get this {resource}. It is checked for the person a run is made for, on every channel: the dashboard, the API, portals, Slack and Teams.',
  mode: 'Access',
  everyone: 'Everyone who can run the agent',
  selected: 'Selected people and groups',
  everyoneHint: 'Any agent this {resource} is added to can use it for everyone who can run that agent.',
  selectedHint: 'Only the runs of the people below, and of the members of the groups below, get this {resource}. Other people\'s runs, and runs made for no one (a flow step, a public endpoint), do not.',
  people: 'People',
  groups: 'Groups',
  peoplePlaceholder: 'Search people',
  groupsPlaceholder: 'Search groups',
  addMe: 'Add me',
  you: 'You',
  emptyWarning: 'Nobody is on the list yet, so no agent run will get this {resource}.',
  pickerHint: 'Searching people and groups needs read access to IAM. Without it you can still add yourself.',
  iamNote: 'The list is this {resource}\'s built-in IAM policy. Deny rules in IAM still apply on top.',
  summaryEveryone: 'Everyone who can run the agent',
  summarySelected: '{people} people · {groups} groups',
  badgeRestricted: 'Restricted',
  edit: 'Edit',
  cancel: 'Cancel',
  save: 'Save',
  saveFailed: 'The access list could not be saved.',
  saved: 'Access list saved.',
  resourceMcp: 'MCP server',
  resourceSkill: 'skill',
};
