import { redirect } from 'next/navigation';
import { DEFAULT_DOC, isDocId } from '@/lib/docs/docsLinks';

type DocsPageProps = {
  searchParams?: Promise<{ doc?: string }>;
};

/**
 * The docs open in the panel beside the page. This address, kept for older links and bookmarks,
 * opens the panel over the dashboard overview (`?doc=` names a docs-links page).
 */
export default async function DashboardDocsPage({ searchParams }: DocsPageProps) {
  const doc = (await searchParams)?.doc;
  redirect(`/dashboard/overview?docs=${encodeURIComponent(doc && isDocId(doc) ? doc : DEFAULT_DOC)}`);
}
