/**
 * Traffic Snapshot wizard route — full-screen FormShell overlay that samples
 * production traffic into an evaluation dataset (mandatory PII anonymization).
 * Entry points: Evaluations → Datasets ("Create from traffic") and
 * Tracing → Sessions ("Create snapshot from traffic", prefills ?source=tracing).
 */

import SnapshotWizard from '@/components/snapshots/SnapshotWizard';

export default function NewSnapshotPage() {
  return <SnapshotWizard />;
}
