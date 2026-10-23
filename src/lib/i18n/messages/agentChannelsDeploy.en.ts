/**
 * Agent channels: adding / editing an agent on a channel (where it answers, who may use it).
 * Spread into the `agentChannels` namespace in `en.ts`; the shared words are in agentChannels.en.ts (`common`).
 *
 * "Channel" in a title is the Slack app / Teams bot a workspace connected (Agents › Channels); the channels people
 * pick inside it (#sales) are the platform's own.
 */
export const agentChannelsDeployEn = {
  deploy: {
    createTitle: 'Add an agent to {name}',
    editTitle: 'Edit the agent on {name}',
    subtitle: '{platform} · {workspace}',
    create: 'Add agent',
    save: 'Save changes',
    added: 'Agent added',
    updated: 'Changes saved',
    ready: '{done} of {total} ready',

    agent: {
      title: 'Agent',
      description: 'Published agents only. They can come from any project.',
      search: 'Find an agent',
      searchPlaceholder: 'Name or project',
      list: 'Published agents',
      published: 'v{version} published',
      alreadyHere: 'Already on this channel',
      publishedOnly: 'The agent always runs its published version here.',
      loading: 'Loading agents…',
      loadFailed: 'The agents could not be loaded.',
      none: 'No agent is published yet. Publish one first, then add it here.',
      openAgents: 'Open agents',
      noMatch: 'No agent matches “{query}”.',
      fixed: 'The agent cannot be changed. To use another agent, add it to this channel and remove this one.',
    },

    where: {
      title: 'Where does it answer?',
      description: 'In each place, people are offered the agents that answer there and that they may use.',
      dm: 'Direct messages (DM)',
      dmHint: 'People can write to the bot in a private chat.',
      channels: 'Channels (when someone @mentions the bot)',
      all: 'Every channel the bot was added to',
      selected: 'Only selected channels',
      none: 'No channels (direct messages only)',
      pick: 'Channels',
      pickPlaceholder: 'Search channels',
      refresh: 'Refresh the list',
      loadingChannels: 'Loading channels…',
      nothingFound: 'No channel found',
      private: 'Private',
      truncated: 'Only the first {count} channels are listed.',
      hintSlack: 'Slack lists only the channels the bot is a member of. Invite the bot first:',
      hintTeams: 'Teams lists the channels of the teams the bot was added to. Add the app to a team first.',
      botFallback: 'bot',
      problems: {
        nowhere: 'Choose at least one place: direct messages or channels.',
        noChannels: 'Pick at least one channel, or choose another option.',
        tooMany: 'At most {max} channels can be selected.',
      },
    },

    who: {
      title: 'Who can use it?',
      description: 'Everyone else is told that no agent is available to them here.',
      mode: 'Access',
      everyone: 'Everyone',
      selected: 'Selected groups and people',
      everyoneHint: 'Everyone = every person whose chat account is linked to Console.',
      groups: 'Groups',
      groupsPlaceholder: 'Search groups',
      users: 'People',
      usersPlaceholder: 'Search people by name or email',
      nobody: 'No group or person selected: nobody can use this agent.',
      tooMany: 'At most {max} groups and people can be on the list.',
      policyNote: 'The list is this agent’s built-in access rule on the channel, as with portals. Deny rules in IAM can still block people.',
      openIam: 'Open IAM',
      missing: 'No longer exist: {names}.',
      dropMissing: 'Remove them from the list',
    },

    publicWarning: {
      title: 'Careful',
      body: 'Answers in a channel are seen by everyone who can see that channel, including people who are not on the list above. Keep sensitive agents (HR, for example) to direct messages.',
    },
    approvals: {
      body: 'Tools that need approval follow the agent’s rule for runs nobody can answer. With “Pause”, the approval is given in Studio and the result is posted to the thread.',
      link: 'Change in agent settings',
    },
    enabled: {
      label: 'Enabled',
      description: 'Switch off to keep the settings but stop answering for now.',
    },

    summary: {
      title: 'Summary',
      agent: 'Agent',
      agentVersion: '{name} (v{version})',
      where: 'Where',
      who: 'Who',
      status: 'Status',
      dm: 'DM',
      allChannels: 'Every channel',
      everyone: 'Everyone',
      nobody: 'Nobody yet',
      on: 'Enabled',
      off: 'Off',
      offNote: 'Switched off: the agent answers nowhere until you enable it.',
      more: '+{count} more',
    },
    overlap: {
      title: 'Shared with other agents',
      dm: 'direct messages',
      allChannels: 'every channel',
      note: 'People who can use both agents are asked which one should answer. Their choice is remembered for the thread.',
    },
    checks: {
      title: 'Checklist',
      agent: 'Agent chosen',
      where: 'Somewhere to answer',
      who: 'Who can use it',
    },
  },
};
