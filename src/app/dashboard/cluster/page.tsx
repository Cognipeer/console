import { redirect } from 'next/navigation';

export default function ClusterIndexPage() {
  redirect('/dashboard/cluster/nodes');
}
