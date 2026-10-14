'use client';

import { useParams } from 'next/navigation';
import PolicyPage from '@/components/iam/policies/PolicyPage';

/** One policy of the IAM center, on a page of its own. */
export default function IamPolicyPage() {
  const params = useParams<{ policyId: string }>()!;
  return <PolicyPage policyId={decodeURIComponent(params.policyId)} />;
}
