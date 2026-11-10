/**
 * Builds the agent-sdk's `Skill[]` directly from console-managed `IAgentSkill`
 * records — NOT via the SDK's `loadSkillsFromDisk`/`SkillFs` file loader.
 *
 * There is no filesystem here to scan: a skill is authored in the dashboard
 * (Settings → Skills) like a Prompt, stored as a DB record, and referenced by
 * key from `IAgentConfig.skills`. The SDK's `Skill` shape (`header` always in
 * the catalog, `prompt` disclosed only once opened) is honored exactly —
 * console just supplies the two strings instead of parsing them out of a
 * SKILL.md file.
 *
 * Bundled scripts-as-tools (the SDK loader's third disclosure level) are not
 * supported: that needs a `SkillExecutionContext` wired to sandbox execution,
 * a materially bigger feature than "author and open a text skill". Every
 * skill built here has `listToolIndex`/`bindTools` return empty.
 */

import type { Skill } from '@cognipeer/agent-sdk';
import { getDatabase, type IAgentSkill } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import { mayUseSharedResource, type SharedResourceRun } from './sharedResourceAccess';
import { isUsableByAgent } from './agentOwnedResources';

const logger = createLogger('agent-skills');

/** Exported for direct testing — the field mapping is the whole contract with the SDK. */
export function toSdkSkill(skill: IAgentSkill): Skill {
    return {
        key: skill.key,
        title: skill.title,
        header: skill.header,
        prompt: skill.body,
        ...(skill.minModelTier ? { minModelTier: skill.minModelTier } : {}),
        listToolIndex: () => [],
        bindTools: () => [],
    };
}

/**
 * Resolves `config.skills` (a list of keys) into SDK `Skill` objects.
 *
 * A key that no longer resolves (deleted skill, wrong project) is dropped
 * with a warning rather than failing the run — the same tolerance
 * `buildAgentSubagents` applies to a `ref` sub-agent that can't be found.
 *
 * With `run`, a skill whose access list keeps the run's person out is
 * dropped too (`mayUseSharedResource`): the model never sees it in its catalog.
 */
export async function buildAgentSkills(
    tenantDbName: string,
    projectId: string,
    skillKeys: string[] | undefined,
    /** Who the run is made for: required, so no caller can put a skill in a run without asking its access list. */
    run: SharedResourceRun,
    /** The agent the skills belong to: its own skills load, another agent's do not (`IAgentResourceOwner`). */
    agentId?: string,
): Promise<Skill[]> {
    if (!skillKeys || skillKeys.length === 0) return [];

    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);

    const skills: Skill[] = [];
    for (const key of skillKeys) {
        try {
            const record = await db.findSkillByKey(key, projectId);
            // Another agent's own skill does not exist for this one.
            if (!record || !isUsableByAgent(record, agentId)) {
                logger.warn('Skill key does not resolve; skipping', { key });
                continue;
            }
            if (record.status !== 'active') continue;
            if (!(await mayUseSharedResource(run, {
                type: 'skill',
                id: String(record._id ?? ''),
                key: record.key,
                projectId: record.projectId,
                access: record.access,
            }))) {
                logger.info('Skill is not open to the person this run is made for; left out', { key });
                continue;
            }
            skills.push(toSdkSkill(record));
        } catch (error) {
            logger.warn('Failed to load skill; skipping', {
                key,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    return skills;
}
