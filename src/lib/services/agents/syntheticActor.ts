/** Actors that are not user rows (the system, an agent, a public A2A caller): nothing to attribute spend or usage to. */
export function isSyntheticActor(userId: string): boolean {
  return userId.startsWith('system:') || userId.startsWith('agent:') || userId === 'a2a-public';
}
