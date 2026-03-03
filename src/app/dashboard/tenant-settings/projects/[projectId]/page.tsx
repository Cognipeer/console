import { redirect } from 'next/navigation';

// Redirect to the standalone project detail page
export default async function TenantProjectSettingsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  redirect(`/dashboard/projects/${projectId}`);
}
