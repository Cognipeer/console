import { redirect } from 'next/navigation';
import { policiesListHref } from '@/components/iam/links';

/** `/dashboard/iam/policies` has no page of its own - the list is a tab of the IAM center. */
export default function PoliciesIndexPage() {
  redirect(policiesListHref());
}
