/**
 * The Knowledge Engine modules that keep their documents' sources in a bucket.
 *
 * A module with a bucket stores the original file and the extracted text of every document in it, as ordinary files
 * (`services/rag/ragSource.ts`), and reads them back to re-index. A module's bucket is chosen when it is created and
 * does not change, so emptying the bucket leaves a module that can no longer rebuild its documents from what they
 * were. Deleting a bucket together with its files is refused while a module of the project keeps its sources there.
 */

import { getDatabase } from '@/lib/database';

/** A Knowledge Engine module whose `fileBucketKey` names a bucket. */
export interface BucketModuleUse {
  key: string;
  name: string;
}

/** The modules of a project whose sources are kept in this bucket, by name and then key (the order the message names them in). */
export async function findModulesKeepingSourcesIn(
  tenantDbName: string,
  projectId: string,
  bucketKey: string,
): Promise<BucketModuleUse[]> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const modules = await db.listRagModules({ projectId });
  return modules
    .filter((ragModule) => ragModule.fileBucketKey === bucketKey)
    .map((ragModule) => ({ key: ragModule.key, name: ragModule.name }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}

/** The 409 body for deleting a bucket together with its files while modules keep their sources in it. */
export function bucketHoldsSourcesBody(bucketKey: string, modules: BucketModuleUse[]) {
  const names = modules.map((ragModule) => ragModule.name || ragModule.key).join(', ');
  return {
    error: `The bucket "${bucketKey}" holds the source files of ${modules.length === 1 ? 'this Knowledge Engine module' : 'these Knowledge Engine modules'}: ${names}. `
      + 'Deleting its files would remove the originals and the extracted text that re-indexing reads. '
      + `Delete ${modules.length === 1 ? 'the module' : 'the modules'} first, or delete the bucket without its files.`,
    type: 'bucket_in_use',
    code: 'bucket_in_use',
    modules,
  };
}
