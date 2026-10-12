import { redirect } from 'next/navigation';

/**
 * Editing happens in an overlay on the detail page now; this keeps old links
 * working by sending them there with the overlay open.
 */
export default async function EditModelRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/dashboard/models/${encodeURIComponent(id)}?edit=1`);
}
