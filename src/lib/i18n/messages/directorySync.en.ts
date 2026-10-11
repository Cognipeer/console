/**
 * The directory-sync part of the SSO (OIDC) and LDAP settings screens: whether a
 * sign-in decides the role of the person, and how directory groups feed console
 * groups. Kept in its own file and spread into `en.ts`.
 */
export const directorySyncEn = {
  role: {
    label: 'Sync role from the directory',
    descriptionOidc:
      'Recomputes the role from the admin claim (or the default role) at every sign-in: people are promoted when they gain it and demoted when they lose it. The workspace owner is never changed. The role of SSO accounts then follows the directory and cannot be edited by hand. With no admin claim set above, administrators made in the console are kept. A token that does not carry the admin claim at all counts as not an admin, so check the claim in the IdP before turning this on.',
    descriptionLdap:
      'Recomputes the role from the admin groups (or the default role) at every sign-in: people are promoted when they join an admin group and demoted when they leave it. The workspace owner is never changed. The role of LDAP accounts then follows the directory and cannot be edited by hand. With no admin groups set above, administrators made in the console are kept.',
  },
  groups: {
    title: 'Group sync',
    switchLabel: 'Sync groups from the directory',
    description:
      'At every sign-in the person is placed in the console groups mapped to the IdP groups they hold, and removed from synced groups they no longer hold. Console groups are created on first use. Groups created by hand are never changed, and a hand-made group with the same name is never taken over. What a synced group grants is still set in the Groups screen.',
    claimLabel: 'Groups claim',
    claimDescription:
      'The claim that lists the IdP groups of the person. When the IdP does not send it (for example Entra ID groups overage), memberships are left as they are.',
    claimPlaceholder: 'groups',
    idpGroupLabel: 'IdP group',
    idpGroupPlaceholder: 'engineers',
    consoleGroupLabel: 'Console group',
    consoleGroupPlaceholder: 'Engineers',
    addMapping: 'Add mapping',
    removeMapping: 'Remove mapping',
    emptyMappings: 'No mappings yet. Without a mapping nothing is synced.',
  },
};
