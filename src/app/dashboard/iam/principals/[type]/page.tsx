import { redirect } from 'next/navigation';
import { principalsListHref } from '@/components/iam/links';

/**
 * `/dashboard/iam/principals/<type>` leads to the principals tab narrowed to that kind
 * (an unknown kind to the plain tab).
 */
export default async function PrincipalsTypePage({ params }: { params: Promise<{ type: string }> }) {
  const { type } = await params;
  redirect(principalsListHref(type));
}
