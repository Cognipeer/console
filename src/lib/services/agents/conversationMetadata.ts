/**
 * What a client may and may not write into `conversation.metadata`.
 *
 * The column is shared: the server keeps its own bookkeeping in it next to whatever a
 * client attached. Several of those keys configure a run (`hitlAllowedTools` is the
 * "don't ask again for this tool" list a person's approval builds, `sandbox` names the
 * session's machine, `runtimeContext` is what the tools see), so they are not the
 * client's to set. A route that stores client-supplied metadata at the top level of the
 * column therefore goes through `mergeClientConversationMetadata`, which keeps every
 * server-owned key exactly as stored.
 */

/** Keys of `conversation.metadata` that only the server writes. */
export const SERVER_OWNED_CONVERSATION_METADATA_KEYS: readonly string[] = Object.freeze([
    // The session allow-list - written only by resolving a pending tool approval (agentActionResolution.ts).
    'hitlAllowedTools',
    // Where the conversation came from, and the context its turns run with.
    'source',
    'runtimeContext',
    'portalId',
    'channel',
    // The session's machine.
    'sandbox',
    // The Assistants API's own bookkeeping (pending messages, run history).
    'assistantsApi',
    // The Sessions API's namespace for what its clients attach (a flat map of short strings).
    'clientMetadata',
]);

/**
 * `current` with the client's `patch` laid over it, except for the server-owned keys: those keep
 * what is stored (or stay absent), whatever the patch says.
 */
export function mergeClientConversationMetadata(
    current: Record<string, unknown> | undefined,
    patch: Record<string, unknown>,
): Record<string, unknown> {
    const stored = current ?? {};
    const merged: Record<string, unknown> = { ...stored, ...patch };
    for (const key of SERVER_OWNED_CONVERSATION_METADATA_KEYS) {
        if (Object.prototype.hasOwnProperty.call(stored, key)) merged[key] = stored[key];
        else delete merged[key];
    }
    return merged;
}
