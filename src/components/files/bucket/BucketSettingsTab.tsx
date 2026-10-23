'use client';

import type { BucketDetail } from '../filesApi';
import SettingsDangerCard from './SettingsDangerCard';
import SettingsGeneralCard from './SettingsGeneralCard';
import SettingsStorageCard from './SettingsStorageCard';
import SettingsUsageCard from './SettingsUsageCard';
import styles from './bucket.module.css';

export interface BucketSettingsTabProps {
  bucket: BucketDetail;
  /** Draw the controls that change the bucket (a hint: the server decides). */
  canWrite: boolean;
}

/**
 * The Settings tab of a bucket page: General (name, description, status), Storage (provider and its health, prefix,
 * where the files are, key), Usage (files, size, project limits) and the danger zone. Someone who may only read sees
 * the same cards with the fields locked and without the danger zone; a bucket being deleted takes no changes.
 */
export function BucketSettingsTab({ bucket, canWrite }: BucketSettingsTabProps) {
  const editable = canWrite && bucket.deleting !== true;
  return (
    <div className={styles.stack}>
      <SettingsGeneralCard bucket={bucket} editable={editable} />
      <SettingsStorageCard bucket={bucket} editable={editable} />
      <SettingsUsageCard bucket={bucket} />
      {canWrite ? <SettingsDangerCard bucket={bucket} /> : null}
    </div>
  );
}
