import { redirect } from 'next/navigation';
import { principalsListHref } from '@/components/iam/links';

/**
 * `/dashboard/iam/principals` has no page of its own - the list is a tab of the IAM center.
 * The address is still a crumb of every principal's page, so it leads to the tab.
 */
export default function PrincipalsIndexPage() {
  redirect(principalsListHref());
}
