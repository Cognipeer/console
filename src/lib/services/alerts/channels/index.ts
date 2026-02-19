/**
 * Channel registry — maps channel types to their dispatchers.
 *
 * To add a new channel (Slack, webhook, …):
 *  1. Create a new dispatcher class implementing IAlertDispatcher
 *  2. Register it here with `registerChannel()`
 */

import type { IAlertDispatcher } from './types';
import { EmailAlertChannel } from './emailChannel';

const registry = new Map<string, IAlertDispatcher>();

export function registerChannel(dispatcher: IAlertDispatcher): void {
  registry.set(dispatcher.type, dispatcher);
}

export function getChannel(type: string): IAlertDispatcher | undefined {
  return registry.get(type);
}

export function getAllChannels(): IAlertDispatcher[] {
  return Array.from(registry.values());
}

// Auto-register built-in channels
registerChannel(new EmailAlertChannel());

export type { IAlertDispatcher, AlertContext, DispatchResult } from './types';
