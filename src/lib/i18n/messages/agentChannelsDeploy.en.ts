/**
 * Agent channels: editing where a channel answers and who may use it (the `access` form of a channel's page).
 * Spread into the `agentChannels` namespace in `en.ts`; the shared words are in agentChannels.en.ts (`common`).
 * The file keeps its old name (`Deploy`): `en.ts` imports it by that name.
 *
 * "Channel" in a title is the Slack app / Teams bot a workspace connected (Agents › Channels); the channels people
 * pick inside it (#sales) are the platform's own.
 */
export const agentChannelsDeployEn = {
  access: {
    editTitle: 'Where and who · {name}',
    subtitle: '{platform} · {workspace}',
    save: 'Save changes',
    saved: 'Changes saved',
    ready: '{done} of {total} ready',

    where: {
      title: 'Where does it answer?',
      description: 'The channel answers in these places, for the people who may use it.',
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
      description: 'Everyone else is told to ask an admin.',
      mode: 'Access',
      everyone: 'Everyone',
      selected: 'Selected groups and people',
      everyoneHint: 'Everyone = every person whose verified email matches a Console user.',
      groups: 'Groups',
      groupsPlaceholder: 'Search groups',
      users: 'People',
      usersPlaceholder: 'Search people by name or email',
      nobody: 'No group or person selected: nobody can use this channel.',
      tooMany: 'At most {max} groups and people can be on the list.',
      policyNote: 'The list is the agent’s built-in access rule on this channel, as with portals. Deny rules in IAM can still block people.',
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

    summary: {
      title: 'Summary',
      where: 'Where',
      who: 'Who',
      dm: 'DM',
      allChannels: 'Every channel',
      everyone: 'Everyone',
      nobody: 'Nobody yet',
      more: '+{count} more',
    },
    checks: {
      title: 'Checklist',
      where: 'Somewhere to answer',
      who: 'Who can use it',
    },
  },
};
