/**
 * Public surface of the sandbox wire protocol.
 *
 * Independent of `@cognipeer/gpu-fleet-protocol` — shares no types and must
 * never import from it.
 */

export const SANDBOX_PROTOCOL_VERSION = '1';

export * from './template';
export * from './terminal';
export * from './command';
export * from './event';
export * from './toolbox';
