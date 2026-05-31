/**
 * Public surface of the GPU fleet wire protocol.
 *
 * Both the console (publisher of desired state) and the agent (consumer +
 * reporter of actual state) import from this entry point.
 */

export const GPU_FLEET_PROTOCOL_VERSION = '1';

export * from './auth';
export * from './command';
export * from './deployment';
export * from './event';
export * from './inventory';
export * from './slice';
export * from './terminal';
export * from './wire';
