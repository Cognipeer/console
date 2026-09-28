import { PageSkeleton } from '@/components/common/ui/Skeletons';

// Keeps the edit form from inheriting the model detail placeholder.
export default function ModelEditLoading() {
  return <PageSkeleton body="card" />;
}
